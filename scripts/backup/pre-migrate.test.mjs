import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./pre-migrate.sh", import.meta.url));

// Every database executable is inert. No inherited database/backup settings
// enter this fixture, and mountpoint treats /backups as an image placeholder.
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "cockpit-chess-backup-policy-"));
  try {
    for (const [name, body] of Object.entries({
      mountpoint: "exit 1",
      psql: "printf '180000\\n'",
      pg_dump: `if [ "$1" = --version ]; then printf 'pg_dump (PostgreSQL) 18.0\\n'; exit 0; fi
while [ "$1" != -f ]; do shift; done
printf PGDMP > "$2"`,
      pg_restore: "exit 0",
    })) {
      await writeFile(join(directory, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    const env = {
      PATH: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin`,
      DATABASE_URL: "postgresql://localhost/disposable_fixture",
      BACKUP_ENABLED: "false",
    };
    await run((args = [], overrides = {}) => {
      const result = spawnSync("bash", [script, ...args], {
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      return { code: result.status, output: `${result.stdout}${result.stderr}` };
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("no destination warns and succeeds, while --required fails", async () => {
  await fixture(async (run) => {
    const optional = run();
    assert.equal(optional.code, 0, optional.output);
    assert.match(optional.output, /WARNING:.*No pre-migration backup/);
    const required = run(["--required"]);
    assert.equal(required.code, 1, required.output);
    assert.match(required.output, /no backup destination/);
  });
});

test("configured upload failure blocks even with BACKUP_ENABLED=false", async () => {
  await fixture(async (run) => {
    const result = run([], { BACKUP_S3_BUCKET: "inert-backups", BACKUP_S3_REGION: "us-east-1" });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /\[backup\] Verified/);
    assert.match(result.output, /BACKUP_S3_ACCESS_KEY_ID.*missing/);
    assert.match(result.output, /S3 upload failed/);
  });
});
