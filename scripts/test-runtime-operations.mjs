/** Explicit operations smoke; owns disposable services and never loads the root .env. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = fileURLToPath(import.meta.url);

async function runtimeCheck(mode) {
  assert.ok(["embedded", "external"].includes(mode));
  const [{ startWorkerRuntime }, queues, { default: prisma }, health, { serverVars }] =
    await Promise.all([
      import("../apps/worker/src/runtime.ts"),
      import("../packages/queue/src/index.ts"),
      import("../packages/db/src/index.ts"),
      import("../packages/queue/src/consumer-health.ts"),
      import("../packages/env/src/vars/server.ts"),
    ]);
  assert.equal(serverVars.WORKER_MODE.parse(undefined), "embedded");
  const inventory = Object.values(queues.QUEUE_NAMES);
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
  // Adjacent-release regression against actual Valkey Lua: the old inventory
  // stays live while the new server needs an additional queue. Its heartbeat
  // must never admit that server, even after the old worker republishes.
  const old = health.createConsumerHeartbeat(
    queues.redisConnection,
    "external",
    [queues.QUEUE_NAMES.chessRun],
    () => true,
  );
  await old.start();
  assert.equal(
    await health.hasExternalConsumer(queues.redisConnection, [queues.QUEUE_NAMES.chessRun]),
    true,
  );
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
  const replacement = health.createConsumerHeartbeat(
    queues.redisConnection,
    "external",
    [queues.QUEUE_NAMES.chessRun],
    () => true,
  );
  await replacement.start();
  await old.stop();
  assert.equal(
    await health.hasExternalConsumer(queues.redisConnection, [queues.QUEUE_NAMES.chessRun]),
    true,
  );
  await replacement.stop();
  const expiringQueue = `heartbeat-expiry-${randomUUID()}`;
  const expiring = health.createConsumerHeartbeat(
    queues.redisConnection,
    "external",
    [expiringQueue],
    () => true,
  );
  await expiring.start();
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, [expiringQueue]), true);
  const expiryKey = `cockpit-chess:consumers:external:${expiringQueue}`;
  const [replicaId] = await queues.redisConnection.zrange(expiryKey, 0, -1);
  assert.ok(replicaId);
  // Model a crashed publisher's expired score without waiting fifteen seconds.
  // The actual production read Lua must use Redis TIME and reject that score.
  await queues.redisConnection.zadd(expiryKey, 0, replicaId);
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, [expiringQueue]), false);
  await expiring.stop();
  const fatal = [];
  let runtime;
  try {
    runtime = await startWorkerRuntime({
      embedded: mode === "embedded",
      onFatal: (error) => fatal.push(error),
    });
    assert.equal(runtime.isReady(), true);
    assert.equal(
      await health.hasExternalConsumer(queues.redisConnection, inventory),
      mode === "external",
    );
    assert.equal(
      await health.hasExternalConsumer(queues.redisConnection, [
        ...inventory,
        "next-release-queue",
      ]),
      false,
    );
    const id = `runtime-${randomUUID()}`;
    const job = await queues.reapExpiredAuthTokensQueue.add(
      "reap-expired-auth-tokens",
      { reason: "cron" },
      { jobId: id },
    );
    const deadline = Date.now() + 15_000;
    while ((await job.getState()) !== "completed" && Date.now() < deadline) await delay(50);
    assert.equal(await job.getState(), "completed");
    const completed = await queues.reapExpiredAuthTokensQueue.getJob(id);
    assert.ok(completed);
    assert.deepEqual(completed.returnvalue, {
      reason: "cron",
      deleted: { sessions: 0, verifications: 0, deviceCodes: 0, apiKeys: 0 },
    });
    const stopping = runtime.stop();
    assert.equal(runtime.isReady(), false);
    assert.equal(runtime.stop(), stopping);
    await stopping;
    assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
    await assert.rejects(
      startWorkerRuntime({ embedded: mode === "embedded", onFatal: () => {} }),
      /already started/,
    );
    assert.deepEqual(fatal, []);
    console.log(
      `${mode}: auth-token cleanup job, readiness, withdrawal, drain, and re-entry passed.`,
    );
  } finally {
    await runtime?.stop();
    await Promise.all(
      Object.values(queues)
        .filter((value) => value instanceof queues.Queue)
        .map((queue) => queue.close()),
    );
    queues.redisConnection.disconnect();
    await prisma.$disconnect();
  }
}

async function main() {
  if (process.argv[2] === "--runtime-child") {
    assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
    await runtimeCheck(process.argv[3]);
    return;
  }
  if (process.argv[2] !== "--disposable-services") {
    throw new Error("Use node scripts/test-runtime-operations.mjs --disposable-services.");
  }
  const environment = { PATH: process.env.PATH };
  const docker = (...args) =>
    execFileSync("docker", args, {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  for (const image of ["postgres:18-alpine", "valkey/valkey:9.1-alpine"]) {
    docker("image", "inspect", image, "--format", "{{.Id}}");
  }
  const temporary = mkdtempSync(resolve(tmpdir(), "app-runtime-operations-"));
  const containers = [];
  try {
    const password = randomUUID();
    const postgres = docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      `app-runtime-pg-${randomUUID()}`,
      "--memory",
      "256m",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=256m",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "postgres:18-alpine",
    );
    containers.push(postgres);
    const redis = docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      `app-runtime-redis-${randomUUID()}`,
      "--memory",
      "64m",
      "--publish",
      "127.0.0.1::6379",
      "valkey/valkey:9.1-alpine",
      "valkey-server",
      "--save",
      "",
      "--appendonly",
      "no",
      "--maxmemory",
      "32mb",
      "--maxmemory-policy",
      "noeviction",
    );
    containers.push(redis);
    const port = (id, mapping) => {
      const value = docker("port", id, mapping).split(":").at(-1);
      assert.match(value, /^\d+$/);
      return value;
    };
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port(postgres, "5432/tcp")}/postgres`;
    const redisUrl = `redis://127.0.0.1:${port(redis, "6379/tcp")}`;
    for (let attempt = 0; ; attempt++) {
      try {
        docker("exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
        break;
      } catch {
        if (attempt === 49) throw new Error("Disposable PostgreSQL did not become ready.");
        await delay(100);
      }
    }
    // Copy the committed migration closure away from root .env; the disposable
    // fixture never discovers development credentials.
    const prismaCwd = resolve(temporary, "packages/db");
    mkdirSync(prismaCwd, { recursive: true });
    cpSync(resolve(root, "packages/db/prisma.config.ts"), resolve(prismaCwd, "prisma.config.ts"));
    cpSync(resolve(root, "packages/db/prisma/schema"), resolve(prismaCwd, "prisma/schema"), {
      recursive: true,
    });
    cpSync(
      resolve(root, "packages/db/prisma/migrations"),
      resolve(prismaCwd, "prisma/migrations"),
      {
        recursive: true,
      },
    );
    cpSync(resolve(root, "scripts/db"), resolve(temporary, "scripts/db"), { recursive: true });
    mkdirSync(resolve(temporary, "scripts/lib"), { recursive: true });
    cpSync(
      resolve(root, "scripts/lib/bounded-child.mjs"),
      resolve(temporary, "scripts/lib/bounded-child.mjs"),
    );
    cpSync(resolve(root, "packages/db/package.json"), resolve(prismaCwd, "package.json"));
    symlinkSync(
      resolve(root, "packages/db/node_modules"),
      resolve(prismaCwd, "node_modules"),
      "dir",
    );
    const fixtureEnv = {
      ...environment,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      NODE_ENV: "production",
      BACKUP_ENABLED: "false",
      BACKUP_SCHEDULE: "off",
    };
    for (const operation of ["empty database", "unchanged schema"]) {
      execFileSync(
        process.execPath,
        [resolve(temporary, "scripts/db/migrate-runtime.mjs"), "apply"],
        {
          cwd: temporary,
          env: fixtureEnv,
          timeout: 180_000,
          stdio: "pipe",
        },
      );
      console.log(`Canonical apply with real Prisma: ${operation} passed.`);
    }
    for (const mode of ["embedded", "external"]) {
      const result = execFileSync(
        process.execPath,
        ["--import", "tsx", file, "--runtime-child", mode],
        {
          cwd: root,
          env: {
            ...fixtureEnv,
            RUNTIME_OPERATIONS_CHILD: "owned-disposable-services",
          },
          timeout: 45_000,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        },
      );
      process.stdout.write(result);
    }
  } finally {
    const cleanupErrors = [];
    for (const id of containers.reverse()) {
      try {
        docker("stop", "--time", "2", id);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      console.error("Disposable fixture cleanup failed; inspect this run's owned containers.");
      process.exitCode = 1;
    } else {
      console.log("Removed only this smoke run's disposable containers and temporary fixture.");
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Runtime operations check failed.");
  process.exitCode = 1;
}
