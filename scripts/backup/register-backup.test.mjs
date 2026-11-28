import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendAccountDeletionSuppression,
  assertAccountDeletionRegisterHead,
  EMPTY_REGISTER_HEAD,
  readAccountDeletionRegister,
} from "./account-deletion-suppression.mjs";
import { sealBackupArchive, unsealBackupArchive } from "./register-backup.mjs";

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "register-backup-test-"));
  const path = join(directory, "archive");
  // Keep the archive outside the register's strict directory.
  const register = await mkdtemp(join(tmpdir(), "register-backup-chain-"));
  try {
    await writeFile(path, "PGDMP-disposable-test-bytes");
    await run({ directory, register, path });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(register, { recursive: true, force: true });
  }
}

test("deletion racing the dump is recorded consistently in the backup head", async () => {
  await fixture(async ({ directory, register, path }) => {
    const beforeDump = await readAccountDeletionRegister(register);
    // pg_dump's snapshot/body is already written. A deletion accepted during
    // that dump must be covered by its post-dump checkpoint.
    await appendAccountDeletionSuppression({
      directory: register,
      userId: "during-dump",
      requestedAt: new Date(),
    });
    const head = await sealBackupArchive(path, register, beforeDump.head);
    assert.notEqual(head, beforeDump.head);
    const output = join(directory, "unsealed");
    assert.equal(await unsealBackupArchive(path, output), head);
    assert.equal(await readFile(output, "utf8"), "PGDMP-disposable-test-bytes");
    assert.throws(() => assertAccountDeletionRegisterHead(beforeDump, head));
    assertAccountDeletionRegisterHead(await readAccountDeletionRegister(register), head);
  });
});

test("raw, truncated, malformed and tampered archives fail closed", async () => {
  for (const damage of ["raw", "short", "body", "head"]) {
    await fixture(async ({ directory, register, path }) => {
      if (damage !== "raw") await sealBackupArchive(path, register, EMPTY_REGISTER_HEAD);
      const bytes = await readFile(path);
      if (damage === "short") await writeFile(path, bytes.subarray(0, 200));
      if (damage === "body") {
        bytes[bytes.length - 1] ^= 1;
        await writeFile(path, bytes);
      }
      if (damage === "head") {
        await writeFile(path, bytes.toString().replace('"version":1', '"version":2'));
      }
      const output = join(directory, "unsealed");
      await assert.rejects(() => unsealBackupArchive(path, output), undefined, damage);
      await assert.rejects(() => readFile(output));
    });
  }
});

test("backup refuses a register rolled back during the dump", async () => {
  await fixture(async ({ register, path }) => {
    const missing = `1:${"f".repeat(64)}`;
    await assert.rejects(() => sealBackupArchive(path, register, missing));
    assert.equal(await readFile(path, "utf8"), "PGDMP-disposable-test-bytes");
  });
});

test("sealing never removes a staging file it did not create", async () => {
  await fixture(async ({ register, path }) => {
    await writeFile(`${path}.sealed`, "another-operation");
    await assert.rejects(() => sealBackupArchive(path, register, EMPTY_REGISTER_HEAD), /EEXIST/);
    assert.equal(await readFile(`${path}.sealed`, "utf8"), "another-operation");
    assert.equal(await readFile(path, "utf8"), "PGDMP-disposable-test-bytes");
  });
});
