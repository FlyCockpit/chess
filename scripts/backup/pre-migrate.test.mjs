import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendAccountDeletionSuppression,
  EMPTY_REGISTER_HEAD,
  readAccountDeletionRegister,
} from "./account-deletion-suppression.mjs";
import { linuxOnlyTest } from "./linux-only.mjs";
import { sealBackupArchive, unsealBackupArchive } from "./register-backup.mjs";

// pre-migrate.sh is Linux-only (the app image): see linux-only.mjs.
const test = linuxOnlyTest(import.meta.url);

// Exercise the real shell hook with a private, unmounted placeholder directory
// (so /backups never counts as a destination). No inherited database
// credentials, provider settings or external IO.
function hookIn(dir) {
  const hook = path.join(dir, "pre-migrate.sh");
  const source = readFileSync(new URL("./pre-migrate.sh", import.meta.url), "utf8");
  writeFileSync(
    hook,
    source
      .replace('LOCAL_DIR="/backups"', `LOCAL_DIR="${dir}"`)
      .replace(
        'node "$HERE/lib.mjs" pg-env',
        `node "${fileURLToPath(new URL("./lib.mjs", import.meta.url))}" pg-env`,
      ),
  );
  // The hook resolves its configuration and checkpoint helpers beside itself.
  for (const module of [
    "s3.mjs",
    "lib.mjs",
    "account-deletion-suppression.mjs",
    "register-backup.mjs",
  ])
    writeFileSync(path.join(dir, module), readFileSync(new URL(`./${module}`, import.meta.url)));
  const register = path.join(dir, "account-deletions");
  mkdirSync(register, { mode: 0o700 });
  return (args, extra = {}) =>
    spawnSync("bash", [hook, ...args], {
      env: { PATH: process.env.PATH, ACCOUNT_DELETION_REGISTER_DIR: register, ...extra },
      encoding: "utf8",
    });
}

const S3 = {
  BACKUP_S3_BUCKET: "test-bucket",
  BACKUP_S3_ACCESS_KEY_ID: "test-backup-key",
  BACKUP_S3_SECRET_ACCESS_KEY: "test-backup-secret",
  BACKUP_S3_ENDPOINT: "http://127.0.0.1:9",
};

test("BACKUP_ENABLED off (default): one startup notice, plus a warning when a destination is configured", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-defaults-"));
  try {
    const run = hookIn(dir);
    for (const extra of [{}, { BACKUP_ENABLED: "false" }, { BACKUP_ENABLED: "" }, S3]) {
      const startup = run(["--startup-notice"], extra);
      assert.equal(startup.status, 0, startup.stderr);
      assert.equal(startup.stdout, "");
      const withDestination = extra === S3;
      assert.equal(startup.stderr.trim().split("\n").length, withDestination ? 2 : 1);
      assert.equal(
        /WARNING: \[backup\] A backup destination is configured but BACKUP_ENABLED is not true/.test(
          startup.stderr,
        ),
        withDestination,
      );
      assert.doesNotMatch(startup.stderr, /test-backup-secret|test-backup-key/);
      assert.match(startup.stderr, /Backups are OFF \(BACKUP_ENABLED is not true\)/);
      assert.match(
        startup.stderr,
        /BACKUP_ENABLED=true.*\/backups.*BACKUP_S3_BUCKET.*BACKUP_SCHEDULE=daily.*--backups true/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BACKUP_ENABLED=true: startup fails clearly without a destination, passes with one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-enabled-"));
  try {
    const run = hookIn(dir);
    const none = run(["--startup-notice"], { BACKUP_ENABLED: "true" });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /BACKUP_ENABLED=true but no backup destination is configured/);
    const badS3 = run(["--startup-notice"], {
      BACKUP_ENABLED: "true",
      BACKUP_S3_BUCKET: "test-bucket",
    });
    assert.equal(badS3.status, 1);
    assert.match(
      badS3.stderr,
      /BACKUP_S3_ACCESS_KEY_ID \/ BACKUP_S3_SECRET_ACCESS_KEY are missing/,
    );
    const ok = run(["--startup-notice"], { BACKUP_ENABLED: "true", ...S3 });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /Backups are ON \(BACKUP_ENABLED=true\).*BACKUP_S3_BUCKET/);
    assert.doesNotMatch(ok.stdout + ok.stderr, /test-backup-secret|test-backup-key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BACKUP_ENABLED is parsed strictly", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-strict-"));
  try {
    const run = hookIn(dir);
    for (const value of ["TRUE", "1", "yes", "on"]) {
      for (const args of [["--startup-notice"], ["--required"]]) {
        const result = run(args, { BACKUP_ENABLED: value });
        assert.equal(result.status, 1, `${value} ${args}`);
        assert.match(result.stderr, /BACKUP_ENABLED must be true or false/);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit calls: --required fails without a destination; a configured one dumps whatever BACKUP_ENABLED says", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-explicit-"));
  try {
    const run = hookIn(dir);
    for (const enabled of [{}, { BACKUP_ENABLED: "false" }, { BACKUP_ENABLED: "true" }]) {
      const manual = run(["--required"], enabled);
      assert.equal(manual.status, 1);
      assert.match(manual.stderr, /no backup destination/);
      // Configured: it goes on to dump (and stops at the missing DATABASE_URL here).
      const configured = run(["--label", "manual", "--required"], { ...enabled, ...S3 });
      assert.equal(configured.status, 1);
      assert.match(configured.stderr, /DATABASE_URL is not set/);
    }
    // Without --required and without a destination the hook is a silent no-op.
    for (const args of [[], ["--label", "pre-drop", "--keep", "5"]]) {
      const quiet = run(args);
      assert.equal(quiet.status, 0, quiet.stderr);
      assert.equal(quiet.stdout + quiet.stderr, "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a configured S3 upload failure fails the hook after a verified dump (inert database tools)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-upload-"));
  try {
    // The real hook (its imports resolve in the repo). Every database
    // executable is inert; the mountpoint stub makes /backups an unmounted
    // placeholder, so only the (incomplete) S3 destination is configured.
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const register = path.join(dir, "account-deletions");
    mkdirSync(register, { mode: 0o700 });
    for (const [name, body] of Object.entries({
      mountpoint: "exit 1",
      psql: "printf '180000\\n'",
      pg_dump: `if [ "$1" = --version ]; then printf 'pg_dump (PostgreSQL) 18.0\\n'; exit 0; fi
while [ "$1" != -f ]; do shift; done
printf PGDMP > "$2"`,
      pg_restore: "exit 0",
    })) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    for (const enabled of [{ BACKUP_ENABLED: "false" }, { BACKUP_ENABLED: "true" }]) {
      const result = spawnSync(
        "bash",
        [fileURLToPath(new URL("./pre-migrate.sh", import.meta.url)), "--required"],
        {
          env: {
            PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
            DATABASE_URL: "postgresql://localhost/disposable_fixture",
            ACCOUNT_DELETION_REGISTER_DIR: register,
            BACKUP_S3_BUCKET: "inert-backups",
            BACKUP_S3_REGION: "us-east-1",
            ...enabled,
          },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 1, output);
      assert.match(output, /\[backup\] Verified/);
      assert.match(output, /BACKUP_S3_ACCESS_KEY_ID.*missing/);
      assert.match(output, /S3 upload failed/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sealing captures a deletion accepted during the dump and refuses a rolled-back register", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-dump-checkpoint-"));
  try {
    const register = path.join(dir, "account-deletions");
    const empty = path.join(dir, "empty-register");
    mkdirSync(register, { mode: 0o700 });
    mkdirSync(empty, { mode: 0o700 });
    await appendAccountDeletionSuppression({
      directory: register,
      userId: "before-dump",
      requestedAt: new Date("2026-11-28T00:00:00.000Z"),
    });
    const before = (await readAccountDeletionRegister(register)).head;
    const archive = path.join(dir, "dump.dump");
    const body = Buffer.from("PGDMP-inert-dump-snapshot");
    writeFileSync(archive, body);
    // Deterministic interleaving: dump snapshot first, accepted deletion second,
    // completed-dump seal last. A pre-dump-only checkpoint would omit this entry.
    await appendAccountDeletionSuppression({
      directory: register,
      userId: "during-dump",
      requestedAt: new Date("2026-11-28T00:01:00.000Z"),
    });
    const after = (await readAccountDeletionRegister(register)).head;
    assert.notEqual(after, before);
    assert.equal(await sealBackupArchive(archive, register, before), after);
    const unsealed = path.join(dir, "verified.dump");
    assert.equal(await unsealBackupArchive(archive, unsealed), after);
    assert.deepEqual(readFileSync(unsealed), body);

    const refused = path.join(dir, "rolled-back.dump");
    writeFileSync(refused, body);
    assert.equal((await readAccountDeletionRegister(empty)).head, EMPTY_REGISTER_HEAD);
    await assert.rejects(sealBackupArchive(refused, empty, before), /checkpoint|head|register/i);
    assert.deepEqual(readFileSync(refused), body, "refusal leaves the raw dump unsealed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real backup hook captures a deletion committed by the running dump before sealing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-running-dump-"));
  try {
    const run = hookIn(dir);
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const register = path.join(dir, "account-deletions");
    const appendScript = path.join(dir, "during-dump.mjs");
    writeFileSync(
      appendScript,
      `import {appendAccountDeletionSuppression} from "./account-deletion-suppression.mjs";
await appendAccountDeletionSuppression({directory:process.env.ACCOUNT_DELETION_REGISTER_DIR,userId:"during-real-hook",requestedAt:new Date()});
`,
    );
    for (const [name, body] of Object.entries({
      mountpoint: "exit 0",
      psql: "printf '180000\\n'",
      pg_dump: `if [ "$1" = --version ]; then printf 'pg_dump (PostgreSQL) 18.0\\n'; exit 0; fi
while [ "$1" != -f ]; do shift; done
printf PGDMP > "$2"
node "${appendScript}"`,
      pg_restore: "exit 0",
    }))
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const stale = [
      ".manual-20000101T000000Z-fixture.dump.partial",
      ".manual-20000101T000000Z-fixture.dump.partial.sealed",
    ];
    for (const name of stale) {
      const file = path.join(dir, name);
      writeFileSync(file, "interrupted-backup");
      utimesSync(file, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    }
    const fresh = path.join(dir, ".manual-fresh.dump.partial.sealed");
    const completed = path.join(dir, "manual-20000101T000000Z.dump");
    writeFileSync(fresh, "active-backup");
    writeFileSync(completed, "retained-backup");
    const result = run(["--label", "manual", "--required"], {
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      DATABASE_URL: "postgresql://localhost/disposable_fixture",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const name of stale)
      assert.ok(!readdirSync(dir).includes(name), `${name} crash staging was reaped`);
    assert.equal(readFileSync(fresh, "utf8"), "active-backup");
    assert.equal(readFileSync(completed, "utf8"), "retained-backup");
    const snapshot = await readAccountDeletionRegister(register);
    assert.equal(snapshot.records.length, 1);
    const archive = readdirSync(dir).find(
      (name) => name.endsWith(".dump") && name !== path.basename(completed),
    );
    assert.ok(archive);
    const body = path.join(dir, "unsealed");
    assert.equal(await unsealBackupArchive(path.join(dir, archive), body), snapshot.head);
    assert.equal(readFileSync(body, "utf8"), "PGDMP");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
