import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountDeletionSubjectHash,
  accountDeletionSuppressionSql,
  appendAccountDeletionSuppression,
  assertAccountDeletionRegisterAvailable,
  readAccountDeletionSuppressions,
} from "./account-deletion-suppression.mjs";

const requestedAt = new Date("2026-11-28T03:00:00.000Z");
const input = { userId: "fixture-user", requestedAt, now: requestedAt };

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "account-deletion-register-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("register append is durable, purpose-bound, idempotent and contains no raw identity", async () => {
  await withDirectory(async (directory) => {
    await assertAccountDeletionRegisterAvailable(directory);
    await Promise.all(
      Array.from({ length: 5 }, () => appendAccountDeletionSuppression({ ...input, directory })),
    );
    const records = await readAccountDeletionSuppressions(directory);
    assert.equal(records.length, 1);
    assert.equal(records[0].version, 1);
    assert.equal(records[0].requestedAt, requestedAt.toISOString());
    assert.equal(records[0].expiresAt, "2026-12-29T03:00:00.000Z");
    assert.equal(records[0].subjectHash, accountDeletionSubjectHash(input.userId));
    assert.equal(
      records[0].subjectHash,
      "b092453a9aebc3e363594357d856ec769c16d2d5c9541b2dc62be00bc03b0cd4",
    );
    const files = await readdir(directory);
    assert.deepEqual(files, [`${records[0].subjectHash}.json`]);
    assert.doesNotMatch(
      await readFile(join(directory, files[0]), "utf8"),
      /fixture-user|email|name/,
    );
    await appendAccountDeletionSuppression({
      ...input,
      directory,
      now: new Date("2026-12-01T00:00:00.000Z"),
    });
    assert.deepEqual(await readAccountDeletionSuppressions(directory), records);
  });
});

test("missing, relative, permissive and symlink register paths fail closed", async () => {
  await assert.rejects(
    () => readAccountDeletionSuppressions(undefined),
    /ACCOUNT_DELETION_REGISTER_DIR/,
  );
  await assert.rejects(() => readAccountDeletionSuppressions("relative"), /absolute/);
  await withDirectory(async (directory) => {
    await assert.rejects(() => readAccountDeletionSuppressions(join(directory, "missing")));
    await chmod(directory, 0o755);
    await assert.rejects(
      () => appendAccountDeletionSuppression({ ...input, directory }),
      /mode 0700/,
    );
    await chmod(directory, 0o700);
    const target = join(directory, "target");
    await mkdir(target, { mode: 0o700 });
    const linked = join(directory, "linked");
    await symlink(target, linked);
    await assert.rejects(() => readAccountDeletionSuppressions(linked), /mode 0700/);
  });
});

test("expired records are still enforced and staging crashes safely retry", async () => {
  await withDirectory(async (directory) => {
    const hash = accountDeletionSubjectHash(input.userId);
    const pending = `.pending-${hash}-00000000-0000-4000-8000-000000000000`;
    await writeFile(join(directory, pending), "incomplete", { mode: 0o600 });
    assert.deepEqual(await readAccountDeletionSuppressions(directory), []);
    await appendAccountDeletionSuppression({ ...input, directory });
    const records = await readAccountDeletionSuppressions(directory);
    assert.equal(records.length, 1);
    assert.ok(accountDeletionSuppressionSql(records).includes(hash));
    // There is deliberately no current-time filter in the reader or SQL.
    assert.equal(records[0].expiresAt, "2026-12-29T03:00:00.000Z");
  });
});

test("corrupt, unexpected, permissive, mismatched and symlink records refuse restore", async () => {
  for (const mode of ["corrupt", "unexpected", "permissive", "mismatch", "symlink"]) {
    await withDirectory(async (directory) => {
      await appendAccountDeletionSuppression({ ...input, directory });
      const hash = accountDeletionSubjectHash(input.userId);
      const path = join(directory, `${hash}.json`);
      if (mode === "corrupt") await writeFile(path, "{bad");
      if (mode === "unexpected") await writeFile(join(directory, "other"), "{}", { mode: 0o600 });
      if (mode === "permissive") await chmod(path, 0o644);
      if (mode === "mismatch") {
        const record = JSON.parse(await readFile(path, "utf8"));
        record.subjectHash = "f".repeat(64);
        await writeFile(path, JSON.stringify(record));
      }
      if (mode === "symlink") {
        await rm(path);
        await symlink(join(directory, "missing"), path);
      }
      await assert.rejects(() => readAccountDeletionSuppressions(directory), undefined, mode);
      if (mode !== "unexpected")
        await assert.rejects(
          () => appendAccountDeletionSuppression({ ...input, directory }),
          undefined,
          mode,
        );
    });
  }
});

test("suppression SQL fences exact hashes and durable credentials before admission", async () => {
  await withDirectory(async (directory) => {
    await appendAccountDeletionSuppression({ ...input, directory });
    const records = await readAccountDeletionSuppressions(directory);
    const sql = accountDeletionSuppressionSql(records, 'odd"schema');
    assert.match(sql, /"odd""schema"\."user"/);
    assert.match(
      sql,
      /sha256\(convert_to\('cockpit-chess:account-deletion:v1:' \|\| u.id, 'UTF8'\)\)/,
    );
    assert.match(sql, /"deletionState" = 'pending'/);
    for (const table of [
      "session",
      "apikey",
      "device_code",
      "account",
      "two_factor",
      "openrouter_connection",
      "runner_machine",
      "chess_match",
      "runner_command",
    ])
      assert.ok(sql.includes(`"${table}"`), table);
    assert.match(sql, /AND status IN \('queued', 'running'\)/);
    assert.doesNotMatch(sql, /chess_official_entry|fixture-user/);
    assert.equal(accountDeletionSuppressionSql([]), "");
    assert.throws(() =>
      accountDeletionSuppressionSql([{ ...records[0], subjectHash: "'injection" }]),
    );
    assert.throws(() =>
      accountDeletionSuppressionSql([{ ...records[0], expiresAt: requestedAt.toISOString() }]),
    );
  });
});
