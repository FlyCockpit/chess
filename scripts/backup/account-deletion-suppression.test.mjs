import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  accountDeletionSubjectHash,
  accountDeletionSuppressionSql,
  appendAccountDeletionSuppression,
  assertAccountDeletionRegisterAvailable,
  assertAccountDeletionRegisterHead,
  EMPTY_REGISTER_HEAD,
  readAccountDeletionRegister,
  readAccountDeletionSuppressions,
} from "./account-deletion-suppression.mjs";

const requestedAt = new Date("2026-11-28T03:00:00.000Z");
const input = { userId: "fixture-user", requestedAt, now: requestedAt };

// Independent implementation pins the canonical payload and its purpose domain.
function digest(record) {
  return createHash("sha256")
    .update("cockpit-chess:account-deletion-register:v2:")
    .update(
      JSON.stringify({
        version: record.version,
        sequence: record.sequence,
        previousDigest: record.previousDigest,
        subjectHash: record.subjectHash,
        requestedAt: record.requestedAt,
        expiresAt: record.expiresAt,
      }),
    )
    .digest("hex");
}

const entryName = (sequence) => `${String(sequence).padStart(12, "0")}.json`;
const trustedError = /trusted.*--expected-register-head.*independent protected copy/;

function runNode(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

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
    assert.equal(records[0].version, 2);
    assert.equal(records[0].sequence, 1);
    assert.equal(records[0].previousDigest, "0".repeat(64));
    assert.equal(records[0].digest, digest(records[0]));
    assert.equal(records[0].requestedAt, requestedAt.toISOString());
    assert.equal(records[0].expiresAt, "2026-12-29T03:00:00.000Z");
    assert.equal(records[0].subjectHash, accountDeletionSubjectHash(input.userId));
    assert.equal(
      records[0].subjectHash,
      "b092453a9aebc3e363594357d856ec769c16d2d5c9541b2dc62be00bc03b0cd4",
    );
    const files = await readdir(directory);
    assert.deepEqual(files, ["000000000001.json"]);
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

test("distinct concurrent processes serialize and repeated subjects remain idempotent", async () => {
  await withDirectory(async (directory) => {
    const moduleUrl = new URL("./account-deletion-suppression.mjs", import.meta.url).href;
    const users = Array.from({ length: 12 }, (_, index) => `concurrent-${index}`);
    const results = await Promise.all(
      users.map((userId) =>
        runNode([
          "--input-type=module",
          "-e",
          `import { appendAccountDeletionSuppression as append } from ${JSON.stringify(moduleUrl)};
       await Promise.all(Array.from({length: 3}, () => append({
         directory: ${JSON.stringify(directory)}, userId: ${JSON.stringify(userId)},
         requestedAt: new Date(${JSON.stringify(requestedAt.toISOString())}),
         now: new Date(${JSON.stringify(requestedAt.toISOString())})
       })));`,
        ]),
      ),
    );
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const snapshot = await readAccountDeletionRegister(directory);
    assert.equal(snapshot.records.length, users.length);
    assert.deepEqual(
      new Set(snapshot.records.map((record) => record.subjectHash)),
      new Set(users.map(accountDeletionSubjectHash)),
    );
    assert.deepEqual(
      (await readdir(directory)).sort(),
      users.map((_, index) => entryName(index + 1)),
    );
    assert.equal(snapshot.head, `12:${snapshot.records[11].digest}`);
    assertAccountDeletionRegisterHead(snapshot, snapshot.head);
    for (const record of snapshot.records) {
      assert.equal(record.digest, digest(record));
      assert.equal((await stat(join(directory, entryName(record.sequence)))).mode & 0o777, 0o600);
    }
  });
});

test("CAS retry fsyncs the winning file and parent before idempotent success", {
  timeout: 10_000,
}, async () => {
  await withDirectory(async (directory) => {
    const handle = await open(directory);
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const originalSync = prototype.sync;
    const synced = [];
    let staged = 0;
    let release;
    const bothStaged = new Promise((resolve) => {
      release = resolve;
    });
    const syncMock = mock.method(prototype, "sync", async function () {
      const info = await this.stat();
      await originalSync.call(this);
      synced.push({ inode: info.ino, directory: info.isDirectory() });
      // Both workers saw the empty chain. Hold their staged writes until each
      // reaches fsync, forcing one hard-link CAS to lose with EEXIST.
      if (!info.isDirectory() && staged < 2) {
        staged += 1;
        if (staged === 2) release();
        await bothStaged;
      }
    });
    try {
      await Promise.all(
        Array.from({ length: 2 }, () => appendAccountDeletionSuppression({ ...input, directory })),
      );
      const winner = await stat(join(directory, entryName(1)));
      assert.equal(synced.filter((event) => event.inode === winner.ino).length, 2);
      assert.equal(synced.filter((event) => event.directory).length, 2);
      assert.equal(synced.at(-1).directory, true);
    } finally {
      syncMock.mock.restore();
    }
    // An already committed subject still cannot authorize cleanup when either
    // its file fsync or the parent fsync fails.
    for (const failDirectory of [false, true]) {
      const failure = mock.method(prototype, "sync", async function () {
        if ((await this.stat()).isDirectory() === failDirectory)
          throw new Error("injected fsync failure");
        return originalSync.call(this);
      });
      try {
        await assert.rejects(
          () => appendAccountDeletionSuppression({ ...input, directory }),
          /injected fsync failure/,
        );
      } finally {
        failure.mock.restore();
      }
    }
  });
});

test("trusted checkpoints reject empty registers and valid old subsets, and accept verified ancestry", async () => {
  await withDirectory(async (directory) => {
    const empty = await readAccountDeletionRegister(directory);
    assert.deepEqual(empty, { head: EMPTY_REGISTER_HEAD, records: [] });
    assertAccountDeletionRegisterHead(empty, EMPTY_REGISTER_HEAD);
    await appendAccountDeletionSuppression({ ...input, directory });
    const first = await readAccountDeletionRegister(directory);
    await appendAccountDeletionSuppression({ ...input, directory, userId: "second-user" });
    const second = await readAccountDeletionRegister(directory);
    assertAccountDeletionRegisterHead(first, first.head);
    assertAccountDeletionRegisterHead(second, second.head);
    assertAccountDeletionRegisterHead(second, first.head);
    assertAccountDeletionRegisterHead(second, EMPTY_REGISTER_HEAD);
    assert.throws(() => assertAccountDeletionRegisterHead(empty, first.head), trustedError);
    assert.throws(() => assertAccountDeletionRegisterHead(first, second.head), trustedError);
    await withDirectory(async (oldDirectory) => {
      await writeFile(
        join(oldDirectory, entryName(1)),
        await readFile(join(directory, entryName(1))),
        { mode: 0o600 },
      );
      const old = await readAccountDeletionRegister(oldDirectory);
      assert.throws(() => assertAccountDeletionRegisterHead(old, second.head), trustedError);
    });
    for (const token of [
      undefined,
      null,
      1,
      "",
      "1",
      `01:${"a".repeat(64)}`,
      `-1:${"a".repeat(64)}`,
      `1:${"A".repeat(64)}`,
      `0:${"a".repeat(64)}`,
      `100001:${"a".repeat(64)}`,
      `1:${"a".repeat(63)}`,
      `${first.head}\n`,
      ` ${first.head}`,
    ])
      assert.throws(() => assertAccountDeletionRegisterHead(second, token), trustedError);
    assert.throws(
      () => assertAccountDeletionRegisterHead(second, `100000:${"a".repeat(64)}`),
      trustedError,
    );
    assert.throws(
      () => assertAccountDeletionRegisterHead({ ...second, head: first.head }, first.head),
      trustedError,
    );
  });
});

test("valid equal and newer forks cannot satisfy a trusted checkpoint", async () => {
  await withDirectory(async (directory) => {
    await appendAccountDeletionSuppression({ ...input, directory });
    const first = await readAccountDeletionRegister(directory);
    await appendAccountDeletionSuppression({ ...input, directory, userId: "trusted-second" });
    const trusted = await readAccountDeletionRegister(directory);
    await withDirectory(async (forkDirectory) => {
      await writeFile(
        join(forkDirectory, entryName(1)),
        await readFile(join(directory, entryName(1))),
        { mode: 0o600 },
      );
      await appendAccountDeletionSuppression({
        ...input,
        directory: forkDirectory,
        userId: "fork-second",
      });
      const equalFork = await readAccountDeletionRegister(forkDirectory);
      assertAccountDeletionRegisterHead(equalFork, first.head);
      assert.throws(() => assertAccountDeletionRegisterHead(equalFork, trusted.head), trustedError);
      await appendAccountDeletionSuppression({
        ...input,
        directory: forkDirectory,
        userId: "fork-third",
      });
      const newerFork = await readAccountDeletionRegister(forkDirectory);
      assert.throws(() => assertAccountDeletionRegisterHead(newerFork, trusted.head), trustedError);
    });
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

test("only exact random staging names are ignored; old format and all unknown names refuse", async () => {
  const hash = accountDeletionSubjectHash(input.userId);
  for (const name of [
    `${hash}.json`,
    "1.json",
    "000000000000.json",
    "000000100001.json",
    "000000000001.json\n",
    ".pending",
    `.pending-${hash}-not-a-uuid`,
    `.pending-${hash}-00000000-0000-0000-0000-000000000000`,
    `.pending-${hash}-00000000-0000-4000-8000-000000000000\n`,
  ]) {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, name), "{}", { mode: 0o600 });
      await assert.rejects(() => readAccountDeletionRegister(directory), undefined, name);
      await assert.rejects(
        () => appendAccountDeletionSuppression({ ...input, directory }),
        undefined,
        name,
      );
    });
  }
});

test("strict v2 shape, digest, sequence, chain, uniqueness and size are enforced", async () => {
  const mutations = {
    "old version": (record) => {
      record.version = 1;
    },
    "old shape": (record) => {
      for (const key of ["sequence", "previousDigest", "digest"]) delete record[key];
      record.version = 1;
    },
    "extra property": (record) => {
      record.extra = "unexpected";
    },
    "missing property": (record) => {
      delete record.expiresAt;
    },
    "tampered subject": (record) => {
      record.subjectHash = "a".repeat(64);
    },
    "tampered request": (record) => {
      record.requestedAt = "2026-11-27T03:00:00.000Z";
    },
    "noncanonical date": (record) => {
      record.requestedAt = "2026-11-28";
      record.digest = digest(record);
    },
    "short retention": (record) => {
      record.expiresAt = record.requestedAt;
      record.digest = digest(record);
    },
    "bad digest": (record) => {
      record.digest = "a".repeat(64);
    },
    "uppercase digest": (record) => {
      record.digest = record.digest.toUpperCase();
    },
    "hash suffix": (record) => {
      record.subjectHash += "\n";
      record.digest = digest(record);
    },
    "sequence mismatch": (record) => {
      record.sequence = 1;
      record.digest = digest(record);
    },
    "fractional sequence": (record) => {
      record.sequence = 2.5;
      record.digest = digest(record);
    },
    "broken chain": (record) => {
      record.previousDigest = "0".repeat(64);
      record.digest = digest(record);
    },
    "duplicate subject": (record, first) => {
      record.subjectHash = first.subjectHash;
      record.digest = digest(record);
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await withDirectory(async (directory) => {
      await appendAccountDeletionSuppression({ ...input, directory });
      await appendAccountDeletionSuppression({ ...input, directory, userId: "second-user" });
      const snapshot = await readAccountDeletionRegister(directory);
      const record = { ...snapshot.records[1] };
      mutate(record, snapshot.records[0]);
      await writeFile(join(directory, entryName(2)), JSON.stringify(record));
      await assert.rejects(() => readAccountDeletionRegister(directory), undefined, name);
      await assert.rejects(
        () => appendAccountDeletionSuppression({ ...input, directory }),
        undefined,
        name,
      );
      assert.throws(
        () =>
          assertAccountDeletionRegisterHead(
            { ...snapshot, records: [snapshot.records[0], record] },
            snapshot.head,
          ),
        trustedError,
        name,
      );
    });
  }
  for (const kind of ["gap", "oversized", "directory", "array", "null"]) {
    await withDirectory(async (directory) => {
      await appendAccountDeletionSuppression({ ...input, directory });
      const path = join(directory, entryName(1));
      if (kind === "gap") await rename(path, join(directory, entryName(2)));
      if (kind === "oversized") await writeFile(path, " ".repeat(513));
      if (kind === "array") await writeFile(path, "[]");
      if (kind === "null") await writeFile(path, "null");
      if (kind === "directory") {
        await rm(path);
        await mkdir(path, { mode: 0o700 });
      }
      await assert.rejects(() => readAccountDeletionRegister(directory), undefined, kind);
      await assert.rejects(
        () => appendAccountDeletionSuppression({ ...input, directory }),
        undefined,
        kind,
      );
    });
  }
});

test("head CLI prints only the token and refuses errors without exposing paths or record data", async () => {
  const script = fileURLToPath(new URL("./account-deletion-suppression.mjs", import.meta.url));
  await withDirectory(async (directory) => {
    const env = { ACCOUNT_DELETION_REGISTER_DIR: directory };
    assert.deepEqual(await runNode([script, "head"], env), {
      code: 0,
      stdout: `${EMPTY_REGISTER_HEAD}\n`,
      stderr: "",
    });
    await appendAccountDeletionSuppression({ ...input, directory });
    const snapshot = await readAccountDeletionRegister(directory);
    assert.deepEqual(await runNode([script, "head"], env), {
      code: 0,
      stdout: `${snapshot.head}\n`,
      stderr: "",
    });
    await writeFile(join(directory, entryName(1)), "sensitive-malformed-record");
    for (const [args, environment] of [
      [[script, "head"], env],
      [[script, "head"], {}],
      [
        [script, "head"],
        { ACCOUNT_DELETION_REGISTER_DIR: join(directory, "private-configured-path") },
      ],
      [[script], env],
      [[script, "other"], env],
      [[script, "head", "extra"], env],
    ]) {
      const result = await runNode(args, environment);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Unable to read account deletion register head/);
      assert.ok(!result.stderr.includes(directory));
      assert.doesNotMatch(result.stderr, /sensitive-malformed-record|private-configured-path/);
    }
  });
});

test("corrupt, unexpected, permissive, mismatched and symlink records refuse restore", async () => {
  for (const mode of ["corrupt", "unexpected", "permissive", "mismatch", "symlink"]) {
    await withDirectory(async (directory) => {
      await appendAccountDeletionSuppression({ ...input, directory });
      const path = join(directory, "000000000001.json");
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
