/** Real Redis/PG transport integration; called only by the disposable runtime harness. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

async function until(label, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`Runner integration timeout: ${label}`);
}

export async function runnerTransportCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  const [
    { default: prisma },
    queues,
    runners,
    locks,
    { createRunnerAuthority },
    { createRunnerTransport },
    { createRunnerLeaseStore, RUNNER_IP_CONNECTIONS, RUNNER_ACTIONS_PER_MINUTE },
    { createRunnerInvalidationMonitor },
    { startRunnerMachineNotifications },
  ] = await Promise.all([
    import("../../packages/db/src/index.ts"),
    import("../../packages/queue/src/index.ts"),
    import("../../packages/auth/src/runner-machine.ts"),
    import("../../packages/auth/src/device-redemption-lock.ts"),
    import("../../apps/server/src/runner-ws-authority.ts"),
    import("../../apps/server/src/runner-ws.ts"),
    import("../../apps/server/src/runner-ws-store.ts"),
    import("../../apps/server/src/runner-ws-invalidation.ts"),
    import("../../packages/db/src/runner-machine-notifications.ts"),
  ]);
  const id = `transport-${randomUUID()}`;
  const clients = [];
  const transports = [];
  const monitors = [];
  let ownerActive = true;
  const sockets = [];
  const fixture = async () => {
    const machineId = randomUUID();
    const secret = runners.RUNNER_MACHINE_TOKEN_PREFIX + randomUUID().replaceAll("-", "").repeat(2);
    await prisma.runnerMachine.create({
      data: {
        id: machineId,
        userId: id,
        displayName: "transport fixture",
        credentialDigest: runners.digestRunnerMachineSecret(secret),
        credentialPrefix: "fixture",
        expiresAt: new Date(Date.now() + 120_000),
      },
    });
    return { secret, machineId, authorization: `Bearer ${secret}` };
  };
  try {
    await prisma.user.create({
      data: {
        id,
        name: "Runner transport fixture",
        email: `${id}@example.test`,
        emailVerified: true,
        role: "user",
      },
    });
    const machine = await fixture();
    const authority = createRunnerAuthority(async (userId) => ownerActive && userId === id);
    // A row lock stalls the real generation UPDATE. Its database/transaction
    // deadline must roll back without displacing an already valid generation.
    const { loadPg } = await import("../db/lib/prisma.mjs");
    const pg = loadPg();
    const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
    let unlock;
    try {
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM runner_machine WHERE id = $1 FOR UPDATE", [
        machine.machineId,
      ]);
      const unlocked = new Promise((resolve, reject) => {
        unlock = setTimeout(() => {
          blocker.query("ROLLBACK").then(resolve, reject);
        }, 4500);
      });
      let rejected = false;
      try {
        await authority.claim(machine.authorization);
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true, "Blocked generation claim must expire");
      await unlocked;
      assert.equal(
        (
          await prisma.runnerMachine.findUniqueOrThrow({
            where: { id: machine.machineId },
            select: { connectionGeneration: true },
          })
        ).connectionGeneration,
        0,
      );
    } finally {
      clearTimeout(unlock);
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
    }

    const store = createRunnerLeaseStore(queues.redisConnection);
    const replica = () => {
      const subscriber = queues.createRedisConnection({
        maxRetriesPerRequest: 1,
        commandTimeout: 5000,
      });
      clients.push(subscriber);
      let monitor;
      const transport = createRunnerTransport({
        authority,
        leases: store,
        isAvailable: () => monitor?.isAvailable() ?? false,
      });
      monitor = createRunnerInvalidationMonitor({
        subscriber,
        startNotifications: startRunnerMachineNotifications,
        invalidate: transport.invalidate,
      });
      transports.push(transport);
      monitors.push(monitor);
      return { transport, monitor, subscriber };
    };
    const first = replica();
    const second = replica();
    await until(
      "both replica notification channels",
      () => first.monitor.isAvailable() && second.monitor.isAvailable(),
    );
    const attach = async (transport, authorization = machine.authorization) => {
      const reservation = await transport.reserve(authorization, "203.0.113.200");
      assert.ok(reservation);
      const sent = [];
      const closed = [];
      const socket = {
        bufferedAmount: 0,
        send: (text) => sent.push(JSON.parse(text)),
        ping() {},
        close: (code) => closed.push(code),
        terminate() {},
      };
      const active = await reservation.attach(socket);
      assert.ok(active);
      sockets.push(active);
      const generation = sent[0].generation;
      active.receive(
        JSON.stringify({
          version: 1,
          generation,
          id: randomUUID(),
          seq: 1,
          ack: 1,
          type: "hello",
          payload: {
            models: [],
            engine: false,
            hardLimits: { matchMicros: 25000000, dayMicros: 100000000, concurrency: 8 },
            operatingLimits: {
              matchMicros: 1000000,
              dayMicros: 10000000,
              concurrency: 2,
              revision: 0,
            },
          },
        }),
      );
      await active.idle();
      assert.equal(sent.at(-1).type, "ack");
      return { active, sent, closed, generation };
    };
    const old = await attach(first.transport);
    const replacement = await attach(second.transport);
    assert.equal(replacement.generation, old.generation + 1);
    await until("cross-replica replacement push", () => old.closed.includes(4409));
    assert.equal(await store.validate(old.active.lease), false);
    await store.release(old.active.lease);
    assert.equal(await store.validate(replacement.active.lease), true);
    // The actual Lua rejects delayed acquisition and enforces the action bucket.
    assert.equal(await store.acquire(old.active.lease), false);
    for (let i = 0; i < RUNNER_ACTIONS_PER_MINUTE; i++)
      await store.validate(replacement.active.lease);
    assert.equal(await store.validate(replacement.active.lease), false);
    assert.equal(await store.validate(replacement.active.lease, false), true);
    await queues.redisConnection.del(`runner:ws:actions:${machine.machineId}`);

    // Real PG notification is delivered to both replicas only after commit.
    const beforeRevoke = await attach(first.transport);
    await locks.withCliCredentialLockSlot(() =>
      prisma.$transaction(async (tx) => {
        await locks.lockCliCredentials(id, tx);
        await runners.revokeRunnerMachinesInTransaction(tx, id, machine.machineId);
      }),
    );
    await until("committed PG revocation", () => beforeRevoke.closed.includes(4401));
    assert.equal(await first.transport.reserve(machine.authorization, "203.0.113.200"), null);
    assert.equal(await second.transport.reserve(machine.authorization, "203.0.113.200"), null);

    const pending = await fixture();
    const active = await attach(second.transport, pending.authorization);
    ownerActive = false;
    active.active.receive(
      JSON.stringify({
        version: 1,
        generation: active.generation,
        id: randomUUID(),
        seq: 2,
        ack: 2,
        type: "heartbeat",
        payload: { nonce: randomUUID() },
      }),
    );
    await active.active.idle();
    assert.ok(active.closed.includes(4401));
    ownerActive = true;
    // Distinct machines share a finite per-IP budget across independent stores.
    const quota = [];
    const quotaIp = `quota-${randomUUID()}`;
    for (let i = 0; i < RUNNER_IP_CONNECTIONS; i++) {
      const lease = {
        machineId: randomUUID(),
        userId: id,
        generation: 1,
        connectionId: randomUUID(),
        ip: quotaIp,
      };
      assert.equal(await store.reserveIp(lease.ip, lease.connectionId), true);
      assert.equal(await store.acquire(lease), true);
      quota.push(lease);
    }
    assert.equal(await store.reserveIp(quotaIp, randomUUID()), false);
    assert.equal(
      await store.acquire({
        machineId: randomUUID(),
        userId: id,
        generation: 1,
        connectionId: randomUUID(),
        ip: quotaIp,
      }),
      false,
    );
    await Promise.all(quota.map((lease) => store.release(lease)));
    // Storage channel failure removes all live authority immediately.
    const last = await attach(second.transport, pending.authorization);
    second.subscriber.disconnect();
    await until(
      "subscription loss",
      () => !second.monitor.isAvailable() && last.closed.includes(4401),
    );
    await runnerSocketBoundaryCheck({ fixture, ownerId: id, prisma, runners, locks });
    console.log(
      "Runner transport: real Redis generation/IP/action Lua, two replicas, PG revocation, pending deletion and channel-loss checks passed.",
    );
  } finally {
    for (const socket of sockets) socket.finished();
    await Promise.all(transports.map((transport) => transport.drain()));
    await Promise.all(monitors.map((monitor) => monitor.stop()));
    for (const client of clients) client.disconnect();
    await prisma.user.deleteMany({ where: { id } });
    await prisma.$disconnect();
    queues.redisConnection.disconnect();
  }
}

/** Real Node/Hono/ws boundary with disposable machine authority and no provider calls. */
async function runnerSocketBoundaryCheck({ fixture, ownerId, prisma, runners, locks }) {
  const serverRequire = createRequire(new URL("../../apps/server/package.json", import.meta.url));
  const nodeAdapterEntry = pathToFileURL(serverRequire.resolve("@hono/node-server"));
  const [
    { Hono },
    { serve },
    { createRunnerWebSocketRuntime },
    { mountRunnerWsRoutes },
    { RunnerConnection },
    { createNodeRunnerSocket },
  ] = await Promise.all([
    import(
      createRequire(new URL("../../apps/server/package.json", import.meta.url)).resolve("hono")
    ),
    // The Node adapter stores upgrade state in module-local Symbols. Import the
    // same ESM entry as runner-ws-runtime, never its separate CJS condition.
    import(new URL("index.mjs", nodeAdapterEntry).href),
    import("../../apps/server/src/runner-ws-runtime.ts"),
    import("../../apps/server/src/runner-ws-routes.ts"),
    import("../../apps/cli/src/runner-connection.ts"),
    import("../../apps/cli/src/runner-node-socket.ts"),
  ]);
  const { default: WebSocket } = await import(
    createRequire(new URL("../../apps/cli/package.json", import.meta.url)).resolve("ws")
  );
  const runtime = createRunnerWebSocketRuntime({
    isOwnerActive: async (userId) => userId === ownerId,
  });
  const app = mountRunnerWsRoutes(new Hono(), {
    ipBudget: async (_context, next) => next(),
    machineBudget: async () => {},
    runtime: runtime.runtime,
  });
  let http;
  let connection;
  const peers = [];
  try {
    await until("live socket subscriptions", () => runtime.runtime.isAvailable());
    let fromClientPing = 0;
    let fromClientPong = 0;
    const applicationTypes = new Set();
    runtime.server.on("connection", (peer) => {
      peer.on("ping", () => fromClientPing++);
      peer.on("pong", () => fromClientPong++);
      peer.on("message", (data, binary) => {
        if (!binary) applicationTypes.add(JSON.parse(data.toString()).type);
      });
    });
    const port = await new Promise((resolve) => {
      http = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0, websocket: { server: runtime.server } },
        (info) => resolve(info.port),
      );
    });
    const endpoint = `ws://127.0.0.1:${port}/api/cli/runner/ws`;
    const live = await fixture();
    const observed = [];
    connection = new RunnerConnection({
      url: endpoint,
      allowLocalhostWs: true,
      credential: live.secret,
      socketFactory: createNodeRunnerSocket,
      hello: {
        models: [],
        engine: false,
        hardLimits: { matchMicros: 25000000, dayMicros: 100000000, concurrency: 8 },
        operatingLimits: { matchMicros: 1000000, dayMicros: 10000000, concurrency: 2, revision: 0 },
      },
      onMessage: (message) => {
        observed.push(message.type);
      },
    });
    connection.start();
    await until("real outbound hello acknowledgement", () => observed.includes("ack"));
    assert.equal(connection.getState(), "connected");
    await until(
      "real 25s bidirectional native and application heartbeat",
      () =>
        fromClientPing > 0 &&
        fromClientPong > 0 &&
        applicationTypes.has("heartbeat") &&
        applicationTypes.has("pong"),
      30_000,
    );
    await locks.withCliCredentialLockSlot(() =>
      prisma.$transaction(async (tx) => {
        await locks.lockCliCredentials(ownerId, tx);
        await runners.revokeRunnerMachinesInTransaction(tx, ownerId, live.machineId);
      }),
    );
    await until(
      "real PG revocation permanently stops outbound client",
      () => connection.getState() === "stopped",
    );
    connection.stop();
    const negative = await fixture();
    const rejectUpgrade = (suffix, headers, status) =>
      new Promise((resolve, reject) => {
        const peer = new WebSocket(endpoint + suffix, {
          headers,
          followRedirects: false,
          handshakeTimeout: 3000,
        });
        peers.push(peer);
        const timer = setTimeout(() => {
          peer.terminate();
          reject(new Error("Expected HTTP upgrade refusal"));
        }, 4000);
        peer.on("error", () => {});
        peer.on("open", () => {
          clearTimeout(timer);
          peer.terminate();
          reject(new Error("Unexpected authorized upgrade"));
        });
        peer.on("unexpected-response", (request, response) => {
          clearTimeout(timer);
          try {
            assert.equal(response.statusCode, status);
            resolve();
          } catch (error) {
            reject(error);
          }
          response.destroy();
          request.destroy();
          peer.terminate();
        });
      });
    await rejectUpgrade("", { Cookie: "session=fixture" }, 401);
    await rejectUpgrade("", { Authorization: "Bearer generic-api-key" }, 401);
    await rejectUpgrade("?token=fixture", { Authorization: negative.authorization }, 401);
    await rejectUpgrade(
      "",
      { Authorization: negative.authorization, Origin: "https://app.example.test" },
      401,
    );
    await rejectUpgrade(
      "",
      { Authorization: negative.authorization, "Sec-WebSocket-Protocol": "bearer,fixture" },
      401,
    );
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/cli/runner/ws`)).status, 426);
    const wireClose = async (data, binary, expected) => {
      const machine = await fixture();
      await new Promise((resolve, reject) => {
        const peer = new WebSocket(endpoint, {
          headers: { Authorization: machine.authorization },
          perMessageDeflate: false,
        });
        peers.push(peer);
        const timer = setTimeout(() => {
          peer.terminate();
          reject(new Error("Expected malformed frame close"));
        }, 4000);
        peer.on("error", () => {});
        peer.once("message", () => peer.send(data, { binary }));
        peer.on("close", (code) => {
          clearTimeout(timer);
          try {
            assert.equal(code, expected);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    };
    await wireClose("x".repeat(65_537), false, 1009);
    await wireClose("{}", true, 4400);
    const restart = await fixture();
    const peer = new WebSocket(endpoint, { headers: { Authorization: restart.authorization } });
    peers.push(peer);
    await new Promise((resolve, reject) => {
      peer.once("message", resolve);
      peer.once("error", reject);
    });
    const restarting = new Promise((resolve) => peer.once("close", (code) => resolve(code)));
    await runtime.stop();
    assert.equal(await restarting, 1012);
    console.log(
      "Runner socket: real Hono upgrades, Authorization-only outbound ws, 25s native/application ping/pong, PG revoke, rejected browser/query/API key credentials, binary/64KiB limits and 1012 drain passed.",
    );
  } finally {
    connection?.stop();
    for (const peer of peers) peer.terminate();
    await runtime.stop();
    if (http) {
      http.closeAllConnections?.();
      await new Promise((resolve) => http.close(resolve));
    }
  }
}
