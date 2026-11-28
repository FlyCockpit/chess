#!/usr/bin/env node
/**
 * End-to-end test for scripts/backup/pre-migrate.sh and restore.sh against
 * disposable postgres:18 containers. Needs Docker; touches nothing else.
 *
 *   node scripts/backup/test-backup-restore.mjs [--container-prefix <name>]
 *
 * `--container-prefix` (or TEST_CONTAINER_PREFIX; the flag wins) names every
 * container, the network and the tools image `<name>-...` (default
 * `cockpit-chess-backup-test`; see e2e-names.mjs), so parallel runs stay in
 * their own namespace. The run removes its own tools image at the end.
 *
 * pg_dump/pg_restore/psql are not assumed on the host: the scripts run inside
 * a throwaway "tools" image (postgres:18 + the node binary from node:26.13.1-slim),
 * mirroring the app image (node + postgresql-client-18), on a private Docker
 * network. The server uses a Docker-assigned free loopback port.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAccountDeletionSuppression } from "./account-deletion-suppression.mjs";
import { containerPrefix, e2eNames } from "./e2e-names.mjs";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let hostPort;
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const names = e2eNames(containerPrefix(process.argv.slice(2)), suffix);
const TOOLS_IMAGE = names.toolsImage;
const NETWORK = names.network;
const PG = names.pg;
/** Named tool containers, removed at teardown. */
const toolContainers = new Set();
let toolNumber = 0;
const work = mkdtempSync(join(tmpdir(), "backup-restore-test-"));
const backups = join(work, "backups");
const suppressionDirectory = join(work, "account-deletions");
const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;

/**
 * @param {string[]} args
 * @param {{ input?: string, allowFail?: boolean }} [options]
 */
function docker(args, { input, allowFail = false } = {}) {
  // Every container is named: a tool container that was started without
  // --name gets the next prefixed name.
  if (args[0] === "run" && !args.includes("--name")) {
    const name = names.tool(++toolNumber);
    toolContainers.add(name);
    args = [args[0], "--name", name, ...args.slice(1)];
  }
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFail && result.status !== 0) {
    throw new Error(
      `docker ${args.slice(0, 3).join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return {
    code: result.status ?? 1,
    out: `${result.stdout}${result.stderr}`,
    stdout: result.stdout,
  };
}

/** @param {string} db @param {string} sql */
function sql(db, sql) {
  return docker(
    [
      "exec",
      "-i",
      PG,
      "psql",
      "-X",
      "-q",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      db,
    ],
    {
      input: sql,
    },
  ).stdout.trim();
}

/**
 * Run a command in the tools image the way the app image would: scripts under
 * /app/scripts, an optional /backups volume, DATABASE_URL for the target.
 * @param {string} db
 * @param {string[]} command
 * @param {{ mount?: "rw" | "ro" | "none" }} [options]
 */
function tool(db, command, { mount = "rw" } = {}) {
  const volume =
    mount === "none" ? [] : ["-v", `${backups}:/backups${mount === "ro" ? ":ro" : ""}`];
  return docker(
    [
      "run",
      "--rm",
      "--network",
      NETWORK,
      "--user",
      uid,
      "-v",
      `${SCRIPTS}:/app/scripts:ro`,
      "-v",
      `${suppressionDirectory}:/account-deletions:ro`,
      ...volume,
      "-e",
      "ACCOUNT_DELETION_REGISTER_DIR=/account-deletions",
      "-e",
      `DATABASE_URL=postgresql://postgres@${PG}:5432/${db}?schema=public`,
      // For direct pg_dump/pg_restore calls in tests; the scripts derive their
      // own settings from DATABASE_URL.
      "-e",
      `PGHOST=${PG}`,
      "-e",
      "PGUSER=postgres",
      "-e",
      `PGDATABASE=${db}`,
      TOOLS_IMAGE,
      ...command,
    ],
    { allowFail: true },
  );
}

/** @param {string} db @param {...string} args */
const restore = (db, ...args) => {
  const result = tool(db, ["bash", "/app/scripts/backup/restore.sh", "restore", ...args]);
  if (process.env.BACKUP_TEST_VERBOSE)
    console.log(`--- restore ${args.join(" ")} → ${result.code}\n${result.out}`);
  return result;
};

/** A content fingerprint of everything the seed creates. */
function fingerprint(db) {
  return sql(
    db,
    `SELECT md5(
       (SELECT string_agg(u::text, '|' ORDER BY u.id) FROM "User" u) ||
       (SELECT string_agg(p::text, '|' ORDER BY p.id) FROM "BackupFixture" p) ||
       (SELECT string_agg(migration_name, '|' ORDER BY migration_name) FROM "_prisma_migrations") ||
       (SELECT last_value::text FROM "BackupFixture_id_seq"))`,
  );
}

const SEED = `
CREATE TABLE "_prisma_migrations" (
  id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
  migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0);
INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count)
  VALUES ('m0', 'c0', now(), '0_init', 1), ('m1', 'c1', now(), '20261101000000_add_fixture', 1);
CREATE TYPE "Role" AS ENUM ('user', 'admin');
CREATE TABLE "User" (id text PRIMARY KEY, email text NOT NULL UNIQUE, role "Role" NOT NULL DEFAULT 'user', bio text);
INSERT INTO "User"
  SELECT 'u' || g, 'u' || g || '@example.com', (CASE WHEN g % 2 = 0 THEN 'admin' ELSE 'user' END)::"Role",
         CASE WHEN g % 3 = 0 THEN NULL ELSE E'line\\nwith \\\\ backslash, \\t tab; SET statement_timeout = 0; COMMIT;' END
  FROM generate_series(1, 500) g;
CREATE TABLE "BackupFixture" (id serial PRIMARY KEY, owner_id text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE, name text NOT NULL);
INSERT INTO "BackupFixture" (owner_id, name) SELECT 'u' || (g % 500 + 1), 'fixture ' || g FROM generate_series(1, 1200) g;
CREATE INDEX "BackupFixture_owner_id_idx" ON "BackupFixture"(owner_id);
`;

let failures = 0;
/** @param {string} name @param {() => void} fn */
function step(name, fn) {
  try {
    fn();
    console.log(`ok   - ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL - ${name}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {string} name @param {() => Promise<void>} fn */
async function stepAsync(name, fn) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL - ${name}\n${error instanceof Error ? error.stack : String(error)}`);
  }
}

function setup() {
  docker(["build", "-q", "-t", TOOLS_IMAGE, "-"], {
    input: `FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS node
FROM postgres:18
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /lib/x86_64-linux-gnu/libatomic.so.1 /usr/local/lib/libatomic.so.1
RUN ldconfig && node --version
`,
  });
  docker(["network", "create", NETWORK]);
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    PG,
    "--network",
    NETWORK,
    "-e",
    // Disposable test server: trust auth, so no credential appears anywhere.
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-p",
    "127.0.0.1::5432",
    "postgres:18",
  ]);
  hostPort = docker(["port", PG, "5432/tcp"]).stdout.trim().split(":").at(-1);
  assert.match(hostPort, /^\d+$/);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      docker(["exec", PG, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"], { allowFail: true })
        .code === 0
    ) {
      // pg_isready can succeed during the image's init restart; confirm a real query.
      if (
        docker(["exec", PG, "psql", "-U", "postgres", "-h", "127.0.0.1", "-c", "SELECT 1"], {
          allowFail: true,
        }).code === 0
      )
        break;
    }
    spawnSync("sleep", ["1"]);
  }
  for (const db of ["app", "restored_raw", "restored_gz", "restored_misc"])
    sql("postgres", `CREATE DATABASE ${db};`);
  sql("app", SEED);
  mkdirSync(backups);
  mkdirSync(suppressionDirectory, { mode: 0o700 });
}

function teardown() {
  // -v: a force-removed --rm container keeps its anonymous PGDATA volume.
  for (const name of [...toolContainers, PG]) docker(["rm", "-f", "-v", name], { allowFail: true });
  docker(["network", "rm", NETWORK], { allowFail: true });
  // The tools image is this run's own (its tag carries the run suffix).
  docker(["image", "rm", TOOLS_IMAGE], { allowFail: true });
  rmSync(work, { recursive: true, force: true });
}

function dumps(prefix) {
  return readdirSync(backups)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".dump"))
    .sort();
}

try {
  setup();
  const sourcePrint = fingerprint("app");

  step("pre-migrate: no destination → silent exit 0; --required → non-zero", () => {
    const result = tool("app", ["bash", "/app/scripts/backup/pre-migrate.sh"], { mount: "none" });
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /Verified/);
    const required = tool("app", ["bash", "/app/scripts/backup/pre-migrate.sh", "--required"], {
      mount: "none",
    });
    assert.notEqual(required.code, 0, required.out);
    assert.match(required.out, /no backup destination/);
  });

  step("pre-migrate: unwritable /backups → non-zero", () => {
    const result = tool("app", ["bash", "/app/scripts/backup/pre-migrate.sh"], { mount: "ro" });
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.out, /not writable/);
  });

  step("pre-migrate: unreachable database with /backups → non-zero", () => {
    const result = tool("does_not_exist", ["bash", "/app/scripts/backup/pre-migrate.sh"]);
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.out, /FATAL/);
  });

  step("pre-migrate: dumps, verifies, and keeps the newest 5", () => {
    for (let i = 1; i <= 6; i += 1)
      writeFileSync(join(backups, `pre-migrate-20200101T00000${i}Z.dump`), "old");
    const result = tool("app", ["bash", "/app/scripts/backup/pre-migrate.sh"]);
    assert.equal(result.code, 0, result.out);
    const kept = dumps("pre-migrate-");
    assert.equal(kept.length, 5, kept.join(", "));
    assert.ok(!kept.includes("pre-migrate-20200101T000001Z.dump"));
    assert.match(
      result.out,
      /restore \/backups\/pre-migrate-\d{8}T\d{6}Z\.dump --confirm RESTORE:app/,
    );
    const fresh = /** @type {string} */ (kept.at(-1));
    assert.match(fresh, /^pre-migrate-\d{8}T\d{6}Z\.dump$/);
    const list = tool("app", ["pg_restore", "--list", `/backups/${fresh}`]);
    assert.equal(list.code, 0, list.out);
    for (const old of kept.slice(0, -1)) rmSync(join(backups, old));
  });
  const raw = `/backups/${dumps("pre-migrate-").at(-1)}`;

  step("restore: no --confirm → preview only, nothing changed", () => {
    const result = restore("restored_raw", raw);
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /preview only/);
    assert.match(result.out, /--confirm RESTORE:restored_raw/);
    assert.equal(
      sql(
        "restored_raw",
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'",
      ),
      "0",
    );
  });

  step("restore: wrong --confirm is refused", () => {
    const result = restore("restored_raw", raw, "--confirm", "RESTORE:app");
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /--confirm must be exactly RESTORE:restored_raw/);
    assert.equal(sql("restored_raw", "SELECT to_regclass('public.\"User\"') IS NULL"), "t");
  });

  step("restore: raw pg_dump -Fc archive round-trips into an empty database", () => {
    const result = restore("restored_raw", raw, "--confirm", "RESTORE:restored_raw");
    assert.equal(result.code, 0, result.out);
    assert.match(
      result.out,
      /Restore complete\. 2 applied migration\(s\); latest: 20261101000000_add_fixture/,
    );
    assert.equal(fingerprint("restored_raw"), sourcePrint);
  });

  // Scheduled deletions (scripts/db/lib/contracts.mjs) never run in the 7 days
  // after a restore: the restore writes a 'restore' hold in its own transaction.
  const holdDays = (db, reason) =>
    Number(
      sql(
        db,
        `SELECT round(extract(epoch FROM until - now()) / 86400) FROM "_cockpit_chess_hold" WHERE reason = '${reason}'`,
      ),
    );
  step("restore: writes a 7-day 'restore' hold for scheduled deletions", () => {
    assert.equal(
      sql("restored_raw", `SELECT string_agg(reason, ',') FROM "_cockpit_chess_hold"`),
      "restore",
    );
    assert.equal(holdDays("restored_raw", "restore"), 7);
  });

  step("restore: a longer hold carried in the dump is never shortened (greatest)", () => {
    sql("postgres", "CREATE DATABASE hold_src");
    sql("postgres", "CREATE DATABASE hold_dst");
    assert.equal(restore("hold_src", raw, "--confirm", "RESTORE:hold_src").code, 0);
    sql("hold_src", `UPDATE "_cockpit_chess_hold" SET until = now() + interval '30 days'`);
    const dump = tool("hold_src", ["pg_dump", "-Fc", "-f", "/backups/hold.dump"]);
    assert.equal(dump.code, 0, dump.out);
    const result = restore("hold_dst", "/backups/hold.dump", "--confirm", "RESTORE:hold_dst");
    assert.equal(result.code, 0, result.out);
    assert.equal(holdDays("hold_dst", "restore"), 30);
  });

  await stepAsync(
    "restore --replace in place: the next identity check adds a cluster-changed hold (two holds)",
    async () => {
      const { checkClusterIdentity, ensureRuntimeTables } = await import("../db/lib/contracts.mjs");
      const { loadPg } = await import("../db/lib/prisma.mjs");
      const pg = loadPg();
      const connect = async () => {
        const client = new pg.Client({
          connectionString: `postgresql://postgres@127.0.0.1:${hostPort}/cluster_db`,
        });
        await client.connect();
        return client;
      };
      sql("postgres", "CREATE DATABASE cluster_db");
      assert.equal(restore("cluster_db", raw, "--confirm", "RESTORE:cluster_db").code, 0);
      let client = await connect();
      try {
        await ensureRuntimeTables(client, "public");
        const first = await checkClusterIdentity(client, { schema: "public", fresh: true });
        assert.deepEqual(first, { skipContracts: false, held: false });
      } finally {
        await client.end();
      }
      const dump = tool("cluster_db", ["pg_dump", "-Fc", "-f", "/backups/cluster.dump"]);
      assert.equal(dump.code, 0, dump.out);
      const result = restore(
        "cluster_db",
        "/backups/cluster.dump",
        "--replace",
        "--skip-snapshot",
        "--confirm",
        "RESTORE:cluster_db",
      );
      assert.equal(result.code, 0, result.out);
      client = await connect();
      const lines = [];
      try {
        const next = await checkClusterIdentity(client, {
          schema: "public",
          fresh: false,
          log: (line) => lines.push(line),
        });
        assert.deepEqual(next, { skipContracts: false, held: true });
      } finally {
        await client.end();
      }
      assert.match(lines.join("\n"), /restored from a logical backup \(registry table recreated\)/);
      assert.equal(
        sql(
          "cluster_db",
          `SELECT string_agg(reason, ',' ORDER BY reason) FROM "_cockpit_chess_hold"`,
        ),
        "cluster-changed,restore",
      );
      assert.equal(holdDays("cluster_db", "restore"), 7);
      assert.equal(holdDays("cluster_db", "cluster-changed"), 7);
    },
  );

  step("restore: gzip-wrapped (Dokploy-style) dump round-trips", () => {
    const dump = tool("app", [
      "bash",
      "-o",
      "pipefail",
      "-c",
      "pg_dump -Fc --no-acl --no-owner | gzip > /backups/dokploy-app.sql.gz",
    ]);
    assert.equal(dump.code, 0, dump.out);
    const result = restore(
      "restored_gz",
      "/backups/dokploy-app.sql.gz",
      "--confirm",
      "RESTORE:restored_gz",
    );
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /gzip-wrapped/);
    assert.equal(fingerprint("restored_gz"), sourcePrint);
  });

  step("restore: non-empty target without --replace is refused", () => {
    const result = restore("restored_raw", raw, "--confirm", "RESTORE:restored_raw");
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /is not empty/);
    assert.equal(fingerprint("restored_raw"), sourcePrint);
  });

  step("restore: --replace snapshots, then replaces the contents exactly", () => {
    sql(
      "restored_raw",
      `INSERT INTO "User" (id, email) VALUES ('extra', 'extra@example.com'); CREATE TABLE "Newer" (id int); CREATE SCHEMA side; CREATE TABLE side.t (id int);`,
    );
    const result = restore("restored_raw", raw, "--replace", "--confirm", "RESTORE:restored_raw");
    assert.equal(result.code, 0, result.out);
    assert.equal(fingerprint("restored_raw"), sourcePrint);
    assert.equal(
      sql(
        "restored_raw",
        "SELECT to_regclass('public.\"Newer\"') IS NULL AND to_regnamespace('side') IS NULL",
      ),
      "t",
    );
    const snapshots = dumps("pre-restore-");
    assert.equal(snapshots.length, 1, snapshots.join(", "));
    const list = tool("restored_raw", [
      "sh",
      "-c",
      `pg_restore --list /backups/${snapshots[0]} | grep -c 'TABLE public Newer'`,
    ]);
    assert.equal(list.stdout.trim(), "1", list.out);
  });

  step("restore: refuses while another session is connected", () => {
    const sleeper = docker([
      "exec",
      "-d",
      PG,
      "psql",
      "-U",
      "postgres",
      "-d",
      "restored_gz",
      "-c",
      "SELECT pg_sleep(60)",
    ]);
    assert.equal(sleeper.code, 0);
    spawnSync("sleep", ["1"]);
    const result = restore("restored_gz", raw, "--replace", "--confirm", "RESTORE:restored_gz");
    sql(
      "postgres",
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'restored_gz' AND pid <> pg_backend_pid()",
    );
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /other connection\(s\)/);
    assert.equal(dumps("pre-restore-").length, 1, "a refused restore must not snapshot");
  });

  step("restore: refuses while a Prisma migration holds its advisory lock", () => {
    const holder = docker([
      "exec",
      "-d",
      PG,
      "psql",
      "-U",
      "postgres",
      "-d",
      "restored_gz",
      "-c",
      "SELECT pg_advisory_lock(72707369), pg_sleep(60)",
    ]);
    assert.equal(holder.code, 0);
    spawnSync("sleep", ["1"]);
    const result = restore("restored_gz", raw, "--replace", "--confirm", "RESTORE:restored_gz");
    sql(
      "postgres",
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'restored_gz' AND pid <> pg_backend_pid()",
    );
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /Prisma migration is running/);
  });

  step("restore: refuses while a migration runner holds its lock", () => {
    const holder = docker([
      "exec",
      "-d",
      PG,
      "psql",
      "-U",
      "postgres",
      "-d",
      "restored_gz",
      "-c",
      "SELECT pg_advisory_lock(72707370), pg_sleep(60)",
    ]);
    assert.equal(holder.code, 0);
    spawnSync("sleep", ["1"]);
    const result = restore("restored_gz", raw, "--replace", "--confirm", "RESTORE:restored_gz");
    sql(
      "postgres",
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'restored_gz' AND pid <> pg_backend_pid()",
    );
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /migration runner .* is working on this database/);
  });

  step("restore: plain-SQL dumps are refused", () => {
    const dump = tool("app", ["sh", "-c", "pg_dump > /backups/plain.sql"]);
    assert.equal(dump.code, 0, dump.out);
    const result = restore(
      "restored_misc",
      "/backups/plain.sql",
      "--confirm",
      "RESTORE:restored_misc",
    );
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /plain-SQL dump/);
  });

  step("restore: a truncated archive is refused before anything changes", () => {
    const copy = tool("app", ["cp", raw, "/backups/truncated.dump"]);
    assert.equal(copy.code, 0, copy.out);
    const path = join(backups, "truncated.dump");
    truncateSync(path, Math.floor(statSync(path).size * 0.6));
    const result = restore(
      "restored_misc",
      "/backups/truncated.dump",
      "--confirm",
      "RESTORE:restored_misc",
    );
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /incomplete or corrupt|rejected the archive/);
    assert.equal(
      sql(
        "restored_misc",
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'",
      ),
      "0",
    );
  });

  step("restore: a statement failing mid-restore rolls the whole replace back", () => {
    const seed = restore("restored_misc", raw, "--confirm", "RESTORE:restored_misc");
    assert.equal(seed.code, 0, seed.out);
    // A source whose data violates its own CHECK constraint (catalog marked
    // validated), so pg_dump emits the constraint inline and the COPY fails
    // after the schema drop and earlier tables have already run.
    sql("postgres", "CREATE DATABASE broken_src");
    sql(
      "broken_src",
      `CREATE TABLE ok (id int); INSERT INTO ok VALUES (1);
       CREATE TABLE later (v text); INSERT INTO later VALUES ('x');
       ALTER TABLE later ADD CONSTRAINT later_check CHECK (v <> 'x') NOT VALID;
       UPDATE pg_constraint SET convalidated = true WHERE conname = 'later_check';`,
    );
    const dump = tool("broken_src", ["pg_dump", "-Fc", "-f", "/backups/broken.dump"]);
    assert.equal(dump.code, 0, dump.out);
    const result = restore(
      "restored_misc",
      "/backups/broken.dump",
      "--replace",
      "--skip-snapshot",
      "--confirm",
      "RESTORE:restored_misc",
    );
    // psql stops at the failing COPY (ON_ERROR_STOP, exit 3) before the
    // confirmation after COMMIT: provably rolled back, whether or not COMMIT
    // had already been written (it never ran). Exit 4, ROLLED_BACK_EXIT.
    assert.equal(result.code, 4, result.out);
    assert.match(
      result.out,
      /ROLLED BACK: restore failed \(psql exit 3, pg_restore exit 0\)\. (COMMIT was never sent|psql stopped on an SQL error \(ON_ERROR_STOP\) before confirming COMMIT), so the transaction was rolled back; "restored_misc" is unchanged/,
    );
    assert.doesNotMatch(result.out, /Restore complete|uncertain/i);
    // It failed where intended (the COPY that violates later_check), not at
    // some unrelated earlier step that would leave the same state behind.
    assert.match(result.out, /later_check/);
    assert.equal(fingerprint("restored_misc"), sourcePrint);
    assert.equal(sql("restored_misc", "SELECT to_regclass('public.ok') IS NULL"), "t");
  });

  step("restore: --replace over a populated database with no migration history", () => {
    sql("postgres", "CREATE DATABASE untracked_target");
    sql("untracked_target", 'CREATE TABLE "Old" (id int); INSERT INTO "Old" VALUES (1);');
    const result = restore(
      "untracked_target",
      raw,
      "--replace",
      "--skip-snapshot",
      "--confirm",
      "RESTORE:untracked_target",
    );
    assert.equal(result.code, 0, result.out);
    assert.equal(fingerprint("untracked_target"), sourcePrint);
  });

  step("restore: one session holds the locks from the checks through the restore", () => {
    // The archive pauses inside a CHECK function only in the restoring session.
    // Observe from postgres so no target session exists during no-writers checks.
    // Once the restore transaction is applying data, a target probe must NOT take
    // Prisma's migration lock; terminating the restore then rolls everything back.
    sql("postgres", "CREATE DATABASE restore_lock_src;");
    const seeded = restore("restore_lock_src", raw, "--confirm", "RESTORE:restore_lock_src");
    assert.equal(seeded.code, 0, seeded.out);
    sql(
      "restore_lock_src",
      `
      CREATE FUNCTION restore_lock_pause() RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('application_name') = 'cockpit-chess-restore-lock' THEN
          PERFORM pg_sleep(30);
        END IF;
        RETURN true;
      END $$;
      ALTER TABLE "User" ADD CONSTRAINT restore_lock_pause_check CHECK (restore_lock_pause());
    `,
    );
    const pauseDump = tool("restore_lock_src", [
      "pg_dump",
      "-Fc",
      "-f",
      "/backups/restore-lock-pause.dump",
    ]);
    assert.equal(pauseDump.code, 0, pauseDump.out);
    sql("postgres", "CREATE TABLE IF NOT EXISTS lock_probe (got boolean)");
    const q = (db, text) => `psql -X -q -At -h ${PG} -U postgres -d ${db} -c "${text}"`;
    const waiting =
      "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'cockpit-chess-restore-lock' AND wait_event = 'PgSleep' AND xact_start IS NOT NULL";
    const helper = [
      "for i in $(seq 1 300); do",
      `  n=$(${q("postgres", waiting)})`,
      '  if [ "$n" -gt 0 ]; then',
      // Advisory locks are per database: probe the restore target itself.
      `    got=$(${q("restored_misc", "SELECT pg_try_advisory_lock(72707369)")})`,
      `    ${q("postgres", "INSERT INTO lock_probe SELECT '$got'::boolean")}`,
      `    ${q("postgres", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'cockpit-chess-restore-lock'")}`,
      "    break",
      "  fi",
      "  sleep 0.1",
      "done",
      "sleep 1",
    ].join("\n");
    // The helper runs in its own container: inside the server container it
    // would be reparented to the postmaster, which treats any exiting child
    // as a crashed backend and restarts the cluster.
    assert.equal(
      docker(["run", "-d", "--rm", "--network", NETWORK, TOOLS_IMAGE, "bash", "-c", helper]).code,
      0,
    );
    const result = restore(
      "restored_misc",
      "/backups/restore-lock-pause.dump",
      "--replace",
      "--skip-snapshot",
      "--confirm",
      "RESTORE:restored_misc",
    );
    // The terminated backend aborted the transaction: rolled back (exit 4),
    // because COMMIT was never sent or because the server reports the aborted
    // transaction after pg_restore finished streaming into the paused session.
    assert.equal(result.code, 4, result.out);
    assert.match(
      result.out,
      /ROLLED BACK: restore failed \(psql exit 2, pg_restore exit -?\d+\)\. (COMMIT was never sent|the server reports the restore transaction aborted), so the transaction was rolled back; "restored_misc" is unchanged/,
    );
    assert.doesNotMatch(result.out, /Restore complete|uncertain/);
    spawnSync("sleep", ["3"]);
    assert.equal(sql("postgres", "SELECT string_agg(got::text, ',') FROM lock_probe"), "false");
    assert.equal(fingerprint("restored_misc"), sourcePrint);
  });

  await stepAsync(
    "restore: a pre-erasure dump cannot restore erased account authority",
    async () => {
      for (const db of ["erasure_src", "erasure_dst"]) sql("postgres", `CREATE DATABASE ${db};`);
      // This current-column fixture isolates the actual guarded restore path. The
      // runtime deletion harness separately exercises full Prisma FK/ledger triggers.
      sql(
        "erasure_src",
        `
      CREATE TABLE "user" (id text PRIMARY KEY, "deletionRequestedAt" timestamptz, "deletionState" text NOT NULL DEFAULT 'active', "deletionCursor" text);
      INSERT INTO "user" (id) VALUES ('erase-victim'), ('keep-peer');
      CREATE TABLE "session" (id text PRIMARY KEY, "userId" text REFERENCES "user" ON DELETE CASCADE, "impersonatedBy" text);
      CREATE TABLE "apikey" (id text PRIMARY KEY, "referenceId" text REFERENCES "user" ON DELETE CASCADE);
      CREATE TABLE "device_code" (id text PRIMARY KEY, "userId" text REFERENCES "user" ON DELETE CASCADE);
      CREATE TABLE "account" (id text PRIMARY KEY, "userId" text REFERENCES "user" ON DELETE CASCADE);
      CREATE TABLE "two_factor" (id text PRIMARY KEY, "userId" text REFERENCES "user" ON DELETE CASCADE);
      CREATE TABLE "openrouter_connection" (id text PRIMARY KEY, "userId" text REFERENCES "user" ON DELETE CASCADE);
      CREATE TABLE "runner_machine" (id text PRIMARY KEY, "userId" text REFERENCES "user" ON DELETE CASCADE, "revokedAt" timestamptz, "connectionGeneration" integer NOT NULL DEFAULT 7);
      CREATE TABLE "chess_match" (
        id text PRIMARY KEY, "ownerId" text REFERENCES "user" ON DELETE SET NULL, source text, status text, published boolean,
        "runToken" text, "terminalCause" text, ending jsonb, "turnType" text, "turnId" text, "turnSide" text, "turnExpectedSeq" integer,
        "turnStartedAt" timestamptz, "turnDeadline" timestamptz, "pendingMove" jsonb, "runnerState" text, "runnerGeneration" integer,
        "runnerResumeDeadline" timestamptz, "runnerRevision" integer NOT NULL DEFAULT 3
      );
      CREATE TABLE "runner_command" (id text PRIMARY KEY, "matchId" text REFERENCES "chess_match" ON DELETE CASCADE, "ackedAt" timestamptz, "cancelledAt" timestamptz);
      CREATE TABLE "chess_official_entry" (id text PRIMARY KEY, "matchId" text REFERENCES "chess_match" ON DELETE SET NULL, status text, "terminalCause" text);
      INSERT INTO "session" VALUES ('victim-session', 'erase-victim', NULL), ('peer-session', 'keep-peer', NULL), ('impersonated', 'keep-peer', 'erase-victim');
      INSERT INTO "apikey" VALUES ('victim-key','erase-victim'), ('peer-key','keep-peer');
      INSERT INTO "device_code" VALUES ('victim-code','erase-victim'), ('peer-code','keep-peer');
      INSERT INTO "account" VALUES ('victim-sso','erase-victim'), ('peer-sso','keep-peer');
      INSERT INTO "two_factor" VALUES ('victim-2fa','erase-victim'), ('peer-2fa','keep-peer');
      INSERT INTO "openrouter_connection" VALUES ('victim-provider','erase-victim'), ('peer-provider','keep-peer');
      INSERT INTO "runner_machine" (id,"userId") VALUES ('victim-machine','erase-victim'), ('peer-machine','keep-peer');
      INSERT INTO "chess_match" (id,"ownerId",source,status,published,"runToken","runnerState","runnerGeneration") VALUES
        ('active-hosted','erase-victim','hosted','running',true,'old-token',NULL,NULL),
        ('active-runner','erase-victim','runner','running',false,NULL,'running',7),
        ('terminal','erase-victim','hosted','completed',true,NULL,NULL,NULL),
        ('peer-game','keep-peer','runner','running',true,NULL,'running',7);
      UPDATE "chess_match" SET "terminalCause"='board-result', ending='{"kind":"mate"}'::jsonb WHERE id='terminal';
      INSERT INTO "runner_command" (id,"matchId") VALUES ('victim-command','active-runner'), ('peer-command','peer-game');
      INSERT INTO "chess_official_entry" VALUES ('official-sentinel','terminal','completed','board-result');
    `,
      );
      const dump = tool("erasure_src", ["pg_dump", "-Fc", "-f", "/backups/before-erasure.dump"]);
      assert.equal(dump.code, 0, dump.out);
      await appendAccountDeletionSuppression({
        directory: suppressionDirectory,
        userId: "erase-victim",
        requestedAt: new Date(),
      });
      sql("erasure_src", `DELETE FROM "user" WHERE id='erase-victim';`);
      assert.equal(sql("erasure_src", `SELECT count(*) FROM "user" WHERE id='erase-victim'`), "0");
      const result = restore(
        "erasure_dst",
        "/backups/before-erasure.dump",
        "--confirm",
        "RESTORE:erasure_dst",
      );
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /Applied 1 external account-erasure suppression/);
      assert.equal(
        sql(
          "erasure_dst",
          `SELECT "deletionState" || '|' || ("deletionRequestedAt" IS NOT NULL)::text FROM "user" WHERE id='erase-victim'`,
        ),
        "pending|true",
      );
      assert.equal(
        sql(
          "erasure_dst",
          `SELECT "deletionState" || '|' || ("deletionRequestedAt" IS NULL)::text FROM "user" WHERE id='keep-peer'`,
        ),
        "active|true",
      );
      assert.equal(
        sql("erasure_dst", `SELECT string_agg(id, ',' ORDER BY id) FROM "session"`),
        "peer-session",
      );
      for (const table of [
        "apikey",
        "device_code",
        "account",
        "two_factor",
        "openrouter_connection",
      ])
        assert.equal(sql("erasure_dst", `SELECT count(*) FROM "${table}"`), "1", table);
      assert.equal(
        sql(
          "erasure_dst",
          `SELECT ("revokedAt" IS NOT NULL)::text || '|' || "connectionGeneration" FROM "runner_machine" WHERE id='victim-machine'`,
        ),
        "true|8",
      );
      assert.equal(
        sql(
          "erasure_dst",
          `SELECT ("revokedAt" IS NULL)::text || '|' || "connectionGeneration" FROM "runner_machine" WHERE id='peer-machine'`,
        ),
        "true|7",
      );
      assert.equal(
        sql(
          "erasure_dst",
          `SELECT string_agg(status || ':' || "terminalCause" || ':' || ("runToken" IS NULL)::text, ',' ORDER BY id) FROM "chess_match" WHERE id IN ('active-hosted','active-runner')`,
        ),
        "stopped:owner-delete:true,stopped:owner-delete:true",
      );
      assert.equal(
        sql(
          "erasure_dst",
          `SELECT "runnerState" || '|' || ("runnerGeneration" IS NULL)::text || '|' || "runnerRevision" FROM "chess_match" WHERE id='active-runner'`,
        ),
        "stopped|true|4",
      );
      assert.equal(
        sql(
          "erasure_dst",
          `SELECT status || '|' || "terminalCause" FROM "chess_match" WHERE id='terminal'`,
        ),
        "completed|board-result",
      );
      assert.equal(
        sql(
          "erasure_dst",
          `SELECT status || '|' || "runnerGeneration" FROM "chess_match" WHERE id='peer-game'`,
        ),
        "running|7",
      );
      assert.equal(
        sql(
          "erasure_dst",
          `SELECT string_agg(id || ':' || ("cancelledAt" IS NOT NULL)::text, ',' ORDER BY id) FROM "runner_command"`,
        ),
        "peer-command:false,victim-command:true",
      );
      assert.equal(
        sql(
          "erasure_dst",
          `SELECT id || '|' || status || '|' || "terminalCause" FROM "chess_official_entry"`,
        ),
        "official-sentinel|completed|board-result",
      );
    },
  );
  step("restore: suppression failure rolls archive and revocations back together", () => {
    sql("postgres", "CREATE DATABASE erasure_incomplete;");
    // A non-current archive cannot be admitted with a nonempty erasure register.
    sql(
      "erasure_incomplete",
      `CREATE TABLE "user" (id text PRIMARY KEY, "deletionRequestedAt" timestamptz, "deletionState" text, "deletionCursor" text); INSERT INTO "user" (id,"deletionState") VALUES ('erase-victim','active');`,
    );
    const dump = tool("erasure_incomplete", [
      "pg_dump",
      "-Fc",
      "-f",
      "/backups/incomplete-erasure.dump",
    ]);
    assert.equal(dump.code, 0, dump.out);
    const result = restore(
      "erasure_dst",
      "/backups/incomplete-erasure.dump",
      "--replace",
      "--confirm",
      "RESTORE:erasure_dst",
    );
    assert.equal(result.code, 4, result.out);
    assert.match(result.out, /ROLLED BACK/);
    assert.doesNotMatch(result.out, /Restore complete/);
    assert.equal(
      sql("erasure_dst", `SELECT "deletionState" FROM "user" WHERE id='erase-victim'`),
      "pending",
    );
    assert.equal(
      sql("erasure_dst", `SELECT "deletionState" FROM "user" WHERE id='keep-peer'`),
      "active",
    );
    assert.equal(
      sql(
        "erasure_dst",
        `SELECT id || '|' || status || '|' || "terminalCause" FROM "chess_official_entry"`,
      ),
      "official-sentinel|completed|board-result",
    );
  });
} finally {
  teardown();
}

if (failures > 0) {
  console.error(`\n${failures} backup/restore check(s) failed.`);
  process.exit(1);
}
console.log("\nAll backup/restore checks passed.");
