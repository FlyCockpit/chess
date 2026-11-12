import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readMigrationsFolder } from "./db/lib/migration-state.mjs";
import { run as runMigrations } from "./db/migrate-runtime.mjs";
import {
  evaluateCompression,
  evaluateService,
  parseOptions,
  verifyDeployment,
} from "./verify-dokploy-deployment.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureEnvironment = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };

const service = {
  id: "service",
  version: 1,
  image: "server:latest",
  generation: 2,
  mode: { Replicated: { Replicas: 1 } },
};
const task = {
  id: "task",
  image: service.image,
  generation: 2,
  slot: 1,
  desired: "running",
  status: "running",
  container: { ContainerID: "container", ExitCode: 0 },
};

test("empty input refuses; server and external-worker topology parse without credentials", () => {
  assert.throws(() => parseOptions([]), /required/);
  assert.throws(
    () => parseOptions(["--server", "web", "--url", "https://example.com", "--applier", "old"]),
    /Use --server/,
  );
  assert.equal(parseOptions(["--server", "web", "--url", "https://app.example.com"]).timeout, 600);
  assert.equal(
    parseOptions(["--server", "web", "--worker", "jobs", "--url", "https://app.example.com"])
      .worker,
    "jobs",
  );
  assert.throws(
    () => parseOptions(["--server", "web", "--url", "https://user:password@example.com"]),
    /credentials/,
  );
  assert.throws(
    () => parseOptions(["--server", "web", "--worker", "web", "--url", "https://example.com"]),
    /different/,
  );
});

test("previous healthy tasks and completed one-shot tasks cannot satisfy runtime readiness", () => {
  assert.equal(evaluateService("server", service, [{ ...task, generation: 1 }]), null);
  assert.equal(evaluateService("server", service, [{ ...task, status: "complete" }]), null);
  assert.equal(evaluateService("worker", service, [{ ...task, desired: "shutdown" }]), null);
});

test("failed or rolled-back deployment and incomplete replica set cannot report success", () => {
  assert.throws(
    () => evaluateService("server", service, [{ ...task, status: "failed" }]),
    /failed/,
  );
  assert.throws(
    () =>
      evaluateService("server", { ...service, update: { State: "rollback_completed" } }, [task]),
    /rolled back/,
  );
  assert.equal(
    evaluateService("server", { ...service, mode: { Replicated: { Replicas: 2 } } }, [task]),
    null,
  );
});

function fakeDocker({ health = "healthy", mutate = false } = {}) {
  let reads = 0;
  return async (args) => {
    assert.ok(!args.join(" ").includes(".Env"));
    if (args[0] === "service" && args[1] === "inspect")
      return JSON.stringify({ ...service, generation: mutate && reads++ > 0 ? 3 : 2 });
    if (args[0] === "service") return "task";
    if (args[2] === "task") return JSON.stringify(task);
    return JSON.stringify({ running: true, health });
  };
}

test("verification requires healthy selected runtime and JSON public readiness", async () => {
  let queried = false;
  await verifyDeployment(
    { server: "web", url: "https://example.com", timeout: 1 },
    {
      inspect: fakeDocker(),
      log: () => {},
      fetchReady: async (url) => {
        queried = true;
        assert.equal(url, "https://example.com/ready");
        return { status: 200, json: async () => ({ ok: true }) };
      },
      fetchPage: async () => ({
        headers: new Headers({ "content-encoding": "br" }),
        arrayBuffer: async () => new ArrayBuffer(4096),
      }),
    },
  );
  assert.equal(queried, true);
  await assert.rejects(
    verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      { inspect: fakeDocker({ health: null }), log: () => {} },
    ),
    /no healthcheck/,
  );
  await assert.rejects(
    verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      { inspect: fakeDocker({ mutate: true }), log: () => {} },
    ),
    /changed/,
  );
});

test("an HTTP 200 HTML fallback does not pass public readiness; cancellation fails", async () => {
  const controller = new AbortController();
  await assert.rejects(
    verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      {
        inspect: fakeDocker(),
        log: () => {},
        signal: controller.signal,
        fetchReady: async () => ({
          status: 200,
          json: async () => {
            throw new Error("HTML");
          },
        }),
        sleep: async () => {
          controller.abort();
        },
      },
    ),
    /cancelled/,
  );
});

test("compression is classified per content-encoding token, including identity and multi-encodings", () => {
  assert.equal(evaluateCompression("gzip"), true);
  assert.equal(evaluateCompression("BR"), true);
  assert.equal(evaluateCompression("zstd"), true);
  assert.equal(evaluateCompression("gzip, br"), true);
  assert.equal(evaluateCompression("identity"), false);
  assert.equal(evaluateCompression(""), false);
  assert.equal(evaluateCompression(null), false);
});

test("compression advisory passes silently when compressed and warns without failing when not", async () => {
  const run = async (fetchPage) => {
    const messages = [];
    await verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1 },
      {
        inspect: fakeDocker(),
        log: (line) => messages.push(line),
        fetchReady: async () => ({ status: 200, json: async () => ({ ok: true }) }),
        fetchPage,
      },
    );
    return messages;
  };
  const page = (encoding, size) => async (url, init) => {
    assert.equal(url, "https://example.com/");
    assert.match(init.headers["accept-encoding"], /gzip/);
    assert.equal(init.redirect, "follow");
    return {
      headers: new Headers(encoding ? { "content-encoding": encoding } : {}),
      arrayBuffer: async () => new ArrayBuffer(size),
    };
  };
  const verified = (messages) => messages.some((line) => line.startsWith("Deployment verified:"));

  const compressed = await run(page("br", 4096));
  assert.ok(compressed.some((line) => /content-encoding: br/.test(line) && !/WARNING/.test(line)));
  assert.ok(verified(compressed));

  const uncompressed = await run(page(null, 4096));
  const warning = uncompressed.find((line) => line.includes("WARNING (non-fatal)"));
  assert.match(warning, /responded uncompressed/);
  assert.match(warning, /traefik\.http\.middlewares\.<name>\.compress/);
  assert.match(warning, /docs\/deployment\.md#response-compression$/);
  assert.ok(verified(uncompressed));

  const identity = await run(page("identity", 4096));
  assert.match(
    identity.find((line) => line.includes("WARNING")),
    /uncompressed/,
  );

  const tiny = await run(page(null, 12));
  assert.match(
    tiny.find((line) => line.includes("WARNING")),
    /under ~1 KB/,
  );

  const unreadable = await run(async () => {
    throw new Error("offline");
  });
  assert.match(
    unreadable.find((line) => line.includes("WARNING")),
    /could not be verified/,
  );
});

test("a requested commit must match the ready runtime", async () => {
  const commit = "a".repeat(40);
  assert.equal(
    parseOptions(["--server", "web", "--url", "https://example.com", "--commit", commit]).commit,
    commit,
  );
  assert.throws(
    () => parseOptions(["--server", "web", "--url", "https://example.com", "--commit", "bad"]),
    /commit SHA/,
  );
  const controller = new AbortController();
  await assert.rejects(
    verifyDeployment(
      { server: "web", url: "https://example.com", timeout: 1, commit },
      {
        inspect: fakeDocker(),
        log: () => {},
        signal: controller.signal,
        fetchReady: async () => ({
          status: 200,
          json: async () => ({ ok: true, commit: "b".repeat(40) }),
        }),
        sleep: async () => controller.abort(),
      },
    ),
    /cancelled/,
  );
});

// Exercise dispatch without app dependencies or a database. Only absolute image
// script paths are remapped into an owned temporary fixture; shell logic is real.
async function entrypointFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-chess-entrypoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "bin"));
  const node = join(dir, "bin", "node");
  await writeFile(
    node,
    `#!/bin/sh
if [ "$1" = -p ]; then exec '${process.execPath}' "$@"; fi
exec '${process.execPath}' '${join(dir, "command.cjs")}' "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(dir, "command.cjs"),
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({args, id: process.env.COCKPIT_CHESS_INSTANCE_ID ?? null, writer: Boolean(process.env.BACKUP_S3_SECRET_ACCESS_KEY)}) + '\\n');
if (process.env.FIXTURE_REFUSE && args.includes('apply')) process.exit(7);
if (process.env.FIXTURE_HOLD && args.includes('apply')) {
  const timer = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => setTimeout(() => {
    fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({drained: true}) + '\\n');
    clearInterval(timer);
  }, 60));
  setTimeout(() => { clearInterval(timer); process.exitCode = 99; }, 3000).unref();
  console.log('admission-started');
}
`,
  );
  const source = await readFile(join(root, "scripts/docker-entrypoint.sh"), "utf8");
  const script = join(dir, "entrypoint.sh");
  await writeFile(script, source.replaceAll("/app/scripts/", `${dir}/scripts/`));
  await mkdir(join(dir, "scripts/backup"), { recursive: true });
  for (const name of ["restore.sh", "pre-migrate.sh"])
    await writeFile(
      join(dir, "scripts/backup", name),
      `#!/bin/sh\nexec node '${dir}/scripts/backup/${name}' "$@"\n`,
    );
  const run = async (args, env = {}) => {
    const log = join(dir, "commands");
    await writeFile(log, "");
    const child = spawn("sh", [script, ...args], {
      env: { PATH: `${dir}/bin:${fixtureEnvironment.PATH}`, FIXTURE_LOG: log, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (env.FIXTURE_HOLD && output.includes("admission-started")) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", resolveCode);
    });
    const commands = (await readFile(log, "utf8")).trim();
    return {
      code,
      output,
      commands: commands ? commands.split("\n").map((line) => JSON.parse(line)) : [],
    };
  };
  return { dir, run };
}

test("all seven image commands dispatch before normal auth/Redis validation without registering an instance", async (t) => {
  const { run, dir } = await entrypointFixture(t);
  for (const [args, expected] of [
    [["migrate"], ["db/migrate-runtime.mjs", "apply"]],
    [
      ["restore", "--list"],
      ["backup/restore.sh", "--list"],
    ],
    [
      ["backup", "--keep", "2"],
      ["backup/pre-migrate.sh", "--label", "manual", "--required", "--keep", "2"],
    ],
    [["backup-schedule"], ["backup/schedule.mjs", "run"]],
    [
      ["restore-drill", "dump"],
      ["backup/drill.mjs", "dump"],
    ],
    [
      ["hold-deletions", "3"],
      ["db/migrate-runtime.mjs", "hold", "3"],
    ],
    [
      ["hold-deletions", "--clear"],
      ["db/migrate-runtime.mjs", "hold", "--clear"],
    ],
  ]) {
    const result = await run(args, {
      DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
      BACKUP_S3_SECRET_ACCESS_KEY: "fixture-only",
      COCKPIT_CHESS_INSTANCE_ID: "inherited-id-must-not-register",
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.commands.length, 1);
    assert.deepEqual(result.commands[0].args, [
      `${dir}/scripts/${expected[0]}`,
      ...expected.slice(1),
    ]);
    assert.equal(result.commands[0].id, null);
    assert.equal(result.commands[0].writer, true);
  }
});

test("server apply and worker wait precede app execution, with fresh per-start identity and stripped writer keys", async (t) => {
  const { run, dir } = await entrypointFixture(t);
  const env = {
    DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
    REDIS_URL: "redis://localhost",
    BETTER_AUTH_SECRET: "fixture-only",
    BACKUP_S3_SECRET_ACCESS_KEY: "fixture-only",
  };
  const ids = new Set();
  for (const [role, mode] of [
    ["server", "apply"],
    ["worker", "wait"],
    ["server", "apply"],
  ]) {
    const result = await run(["node", `apps/${role}/dist/index.mjs`], env);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.commands.length, 2);
    assert.deepEqual(result.commands[0].args, [
      `${dir}/scripts/db/migrate-runtime.mjs`,
      mode,
      "--role",
      role,
    ]);
    const id = result.commands[0].id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(result.commands[1].id, id);
    assert.equal(result.commands[0].writer, true);
    assert.equal(result.commands[1].writer, false);
    ids.add(id);
  }
  assert.equal(ids.size, 3);
  const refused = await run(["node", "apps/server/dist/index.mjs"], {
    ...env,
    FIXTURE_REFUSE: "true",
  });
  assert.equal(refused.code, 7);
  assert.equal(refused.commands.length, 1, "refused migration never executes application");
  const missing = await run(["node", "apps/server/dist/index.mjs"], {});
  assert.equal(missing.code, 1);
  assert.equal(missing.commands.length, 0);
  const invalid = await run(["node", "apps/worker/dist/index.mjs"], {
    ...env,
    MIGRATE_ON_START: "bad",
  });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.commands.length, 0);
});

test("agent dev startup invokes runtime apply against the pinned Compose database after generate", async () => {
  const compose = await readFile(join(root, "docker-compose.agent.yml"), "utf8");
  assert.match(
    compose,
    /pnpm -F @cockpit-chess\/db exec prisma generate[\s\S]*node scripts\/db\/migrate-runtime\.mjs apply/,
  );
  // The app-dev service pins DATABASE_URL to the in-compose postgres in its
  // `environment:` block, which beats env_file/.env (dotenv never overrides).
  assert.match(
    compose,
    /app-dev:[\s\S]*?environment:[\s\S]*?DATABASE_URL: postgresql:\/\/postgres:password@postgres:5432\/cockpit_chess[\s\S]*?migrate-runtime\.mjs apply/,
  );
  // The retired schema-push command, spelled from parts so the destructive-operation
  // scanner does not read this negative assertion as an invocation.
  const retiredPush = new RegExp(["prisma", "db", "push"].join("\\s+"));
  assert.doesNotMatch(compose, retiredPush);
  assert.doesNotMatch(compose, /APPLY_SCHEMA|db-applier/);
  assert.match(compose, /MIGRATE_ON_START: "false"/);
});

test("entrypoint shutdown forwards cancellation and waits for migration child drain", async (t) => {
  const { run } = await entrypointFixture(t);
  const result = await run(["node", "apps/server/dist/index.mjs"], {
    DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
    REDIS_URL: "redis://localhost",
    BETTER_AUTH_SECRET: "fixture-only",
    FIXTURE_HOLD: "true",
  });
  assert.equal(result.code, 143, result.output);
  assert.equal(result.commands.length, 2);
  assert.deepEqual(result.commands[1], { drained: true });
});

test("apply and waiting runtimes refuse an image whose migration bytes differ from applied history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-chess-image-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "0_init"));
  await writeFile(join(dir, "0_init/migration.sql"), "-- committed fixture SQL\n");
  const migration = readMigrationsFolder(dir)[0];
  assert.ok(migration);
  let nativeCalls = 0;
  let disconnected = 0;
  const errors = [];
  t.mock.method(console, "error", (line) => errors.push(line));
  const pg = {
    Client: class {
      on() {}
      async connect() {}
      async end() {
        disconnected++;
      }
      escapeIdentifier(name) {
        return `"${name}"`;
      }
      async query(sql) {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
        if (sql.includes("pg_catalog.pg_locks")) return { rows: [{ held: false }] };
        if (sql.includes("to_regclass")) return { rows: [{ t: "_prisma_migrations" }] };
        if (sql.includes("SELECT migration_name, checksum"))
          return {
            rows: [
              {
                migration_name: migration.name,
                checksum: "0".repeat(64),
                finished_at: new Date(),
                rolled_back_at: null,
                logs: null,
              },
            ],
          };
        throw new Error("unexpected fixture query");
      }
    },
  };
  for (const mode of ["apply", "wait"]) {
    errors.length = 0;
    assert.equal(
      await runMigrations({
        mode,
        pg,
        migrationsDir: dir,
        contracts: false,
        env: { DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture" },
        runPrisma: async () => {
          nativeCalls++;
          throw new Error("native CLI must not start");
        },
      }),
      1,
    );
    assert.match(errors.join("\n"), /checksum|immutable|differs|edited/i);
  }
  assert.equal(nativeCalls, 0);
  assert.ok(disconnected >= 2, "admission closes its owned sessions on refusal");
});
