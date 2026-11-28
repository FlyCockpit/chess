/** Atomic late-publication acceptance; run only on the owned PG/Valkey fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function chessDeletionPublicationCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "account-deletion-cleanup");
  const [database, queues, chess, requests, cleanup, registry, publication, guard, catalog] =
    await Promise.all([
      import("../../packages/db/src/index.ts"),
      import("../../packages/queue/src/index.ts"),
      import("../../packages/chess/src/index.ts"),
      import("../../packages/api/src/lib/account-deletion.ts"),
      import("../../packages/api/src/lib/account-deletion-cleanup.ts"),
      import("../../packages/queue/src/chess-job-registry.ts"),
      import("../../packages/api/src/lib/chess-jobs.ts"),
      import("../../packages/queue/src/chess-job-publication.ts"),
      import("../../packages/api/src/lib/chess-models.ts"),
    ]);
  const prisma = database.default;
  const redis = queues.redisConnection;
  const users = [];
  const games = [];
  const ownedJobs = [];
  const controlEvents = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/v1/models")) return Response.json({ data: [] });
    throw new Error("Late-publication fixture never makes provider or external requests");
  };
  catalog.resetModelCatalogCache();
  const until = async (read, message, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    do {
      if (await read()) return;
      await delay(20);
    } while (Date.now() < deadline);
    assert.fail(message);
  };

  // A real retained BullMQ result, not a fabricated terminal-state mock.
  async function completeJob(queue, expectedId, resultMarker) {
    const connection = queues.createRedisConnection();
    const worker = new queues.Worker(queue.name, async () => resultMarker, {
      connection,
      concurrency: 1,
      autorun: false,
    });
    worker.on("error", () => {});
    const running = worker.run();
    // Observe rejection immediately, including during teardown after an assertion.
    const observedRun = running.catch((error) => error);
    let originalError;
    let closeError;
    try {
      await until(
        async () => (await (await queue.getJob(expectedId))?.getState()) === "completed",
        `Owned fixture job ${expectedId} did not complete`,
      );
      assert.equal((await queue.getJob(expectedId)).returnvalue, resultMarker);
    } catch (error) {
      originalError = error;
    } finally {
      await worker.close().catch((error) => {
        closeError = error;
      });
      connection.disconnect();
    }
    const result = await observedRun;
    if (originalError) throw originalError;
    if (closeError) throw closeError;
    if (result instanceof Error) throw result;
  }

  async function fixture(published, queued) {
    const user = await prisma.user.create({
      data: {
        name: `late-publisher-${randomUUID()}`,
        email: `${randomUUID()}@example.test`,
        emailVerified: true,
      },
    });
    users.push(user.id);
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        token: randomUUID(),
        origin: "sign-in",
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const archive = chess.createMatch(
      {
        title: user.name,
        white: { name: user.name, protocol: "random", model: "random" },
        black: { name: user.name, protocol: "random", model: "random" },
        rules: {},
      },
      "hosted",
    );
    chess.finishMatch(archive, "*", "cancelled", "stopped");
    const game = await prisma.chessMatch.create({
      data: {
        ownerId: user.id,
        slug: `late-publication-${randomUUID()}`,
        title: user.name,
        whiteName: user.name,
        blackName: user.name,
        source: "hosted",
        status: queued ? "queued" : "stopped",
        published,
        rulesKey: `late-${randomUUID().slice(0, 8)}`,
        rulesVersion: archive.config.rules.version,
        promptVersion: archive.config.prompt.version,
        promptHash: archive.config.prompt.hash,
        contextMode: archive.config.rules.context,
        identityMode: archive.config.rules.opponentIdentity,
        whiteModel: "random",
        whiteProtocol: "random",
        blackModel: "random",
        blackProtocol: "random",
        archive,
      },
    });
    games.push(game.id);
    return { user, session, game };
  }

  async function erase({ user, session }) {
    const accepted = await requests.requestAccountDeletion(user.id, {
      kind: "self",
      sessionId: session.id,
    });
    assert.equal(accepted.complete, false);
    assert.equal(accepted.status, "pending");
    // Advance only this disposable marker, preserving real production phases.
    await prisma.user.update({
      where: { id: user.id },
      data: { deletionRequestedAt: new Date(Date.now() - 181_000) },
    });
    let complete = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await cleanup.cleanupAccountDeletion(user.id)).complete) {
        complete = true;
        break;
      }
    }
    assert.equal(complete, true, "Real bounded cleanup must complete before late Redis execution");
    assert.equal(await prisma.user.count({ where: { id: user.id } }), 0);
  }

  async function race(kind, targetCommand, missingEpoch = false) {
    const own = await fixture(kind !== "run", kind === "run");
    const access = { purpose: "owner", ownerId: own.user.id };
    const surface = kind === "run" ? "run" : "spectator";
    const queue = surface === "run" ? queues.chessRunQueue : queues.chessReconcileQueue;
    const jobId =
      surface === "run"
        ? `chess-run-${own.game.id}`
        : queues.chessSpectatorJobId(own.game.id, 0, access);
    const data =
      surface === "run"
        ? { matchId: own.game.id }
        : { reason: "spectator", matchId: own.game.id, fromPly: 0, access };
    const publish = () =>
      publication.withChessJobPublication(
        own.game.id,
        surface === "run" ? "run" : access,
        (assertFresh) =>
          registry.publishRegisteredChessJob(
            own.game.id,
            surface,
            surface === "run" ? "chess-run" : "chess-spectator",
            data,
            jobId,
            assertFresh,
            surface === "spectator" ? { priority: queues.CHESS_SPECTATOR_JOB_PRIORITY } : {},
          ),
      );
    ownedJobs.push({ queue, jobId });
    if (kind === "update" || kind === "retry") {
      await publish();
      await completeJob(queue, jobId, own.user.id);
    }

    const backend = queue.getBackend();
    const originalExec = backend.execCommand;
    const late = [];
    backend.execCommand = (client, command, values) => {
      if (command !== targetCommand) return originalExec.call(backend, client, command, values);
      const intercepted = new Proxy(client, {
        get(target, property) {
          if (property === "runCommand")
            return (name, args) => {
              assert.equal(name, `cockpit-chess-retirement-v1:${targetCommand}`);
              const run = target.runCommand.bind(target);
              const captured = [...args];
              // The original epoch and packed BullMQ arguments are frozen now.
              // Resume the actual native Lua after the publisher has timed out.
              late.push(() => run(name, captured));
              return Promise.reject(new Error("synthetic underlying Redis command timeout"));
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return originalExec.call(backend, intercepted, command, values);
    };
    try {
      await assert.rejects(publish());
      assert.ok(
        late.length > 0,
        `The real ${targetCommand} Lua must reach the native command boundary`,
      );
    } finally {
      backend.execCommand = originalExec;
    }
    const peerJobId = `d2b-peer-control-${randomUUID()}`;
    const peerKey = queue.toKey("events");
    const peerId = await redis.xadd(peerKey, "*", "event", "peer-control", "jobId", peerJobId);
    controlEvents.push({ key: peerKey, id: peerId });
    const assertEventsErased = async () => {
      for (const streamQueue of [queues.chessRunQueue, queues.chessReconcileQueue]) {
        const rows = await redis.xrange(streamQueue.toKey("events"), "-", "+", "COUNT", 10_000);
        assert.ok(rows.length < 10_000, "Owned test event inventory must fit its explicit bound");
        const serialized = JSON.stringify(rows);
        assert.equal(serialized.includes(own.user.id), false, "No erased owner in queue events");
        assert.equal(serialized.includes(jobId), false, "No erased job reference in queue events");
      }
      assert.deepEqual(await redis.xrange(peerKey, peerId, peerId), [
        [peerId, ["event", "peer-control", "jobId", peerJobId]],
      ]);
    };
    await erase(own);
    await assertEventsErased();
    assert.equal(await redis.scard(guard.chessJobRegistryKey(own.game.id)), 0);
    assert.equal(await queue.getJob(jobId), undefined);
    if (missingEpoch) {
      // Simulate a restart losing this purpose-bound key only; never flush shared state.
      await redis.del(guard.chessJobEpochKey(own.game.id));
      assert.equal(await redis.get(guard.chessJobEpochKey(own.game.id)), null);
    }
    for (const executeLate of late)
      await assert.rejects(executeLate, /Chess job publication retired/);
    assert.equal(await queue.getJob(jobId), undefined);
    assert.equal(await redis.exists(queue.toKey(jobId)), 0);
    assert.equal(await redis.scard(guard.chessJobRegistryKey(own.game.id)), 0);
    assert.equal(await prisma.user.count({ where: { id: own.user.id } }), 0);
    await assertEventsErased();

    if (kind !== "run") {
      const retained = await prisma.chessMatch.findUniqueOrThrow({ where: { id: own.game.id } });
      assert.equal(retained.ownerId, null);
      assert.match(retained.slug, /^replay-[a-f0-9]{32}$/);
      const publicAccess = { purpose: "public", version: retained.moderationVersion };
      const publicId = queues.chessSpectatorJobId(retained.id, 0, publicAccess);
      ownedJobs.push({ queue, jobId: publicId });
      const publicJob = await publication.withChessJobPublication(
        retained.id,
        publicAccess,
        (assertFresh) =>
          registry.publishRegisteredChessJob(
            retained.id,
            "spectator",
            "chess-spectator",
            { reason: "spectator", matchId: retained.id, fromPly: 0, access: publicAccess },
            publicId,
            assertFresh,
            { priority: queues.CHESS_SPECTATOR_JOB_PRIORITY },
          ),
      );
      assert.ok(publicJob, "Sanitized detached public replays retain valid new publication");
      assert.ok(await queue.getJob(publicId));
      assert.equal(
        JSON.stringify((await queue.getJob(publicId)).data).includes(own.user.id),
        false,
      );
      // New public epoch creation still cannot revive an earlier private frame.
      for (const executeLate of late)
        await assert.rejects(executeLate, /Chess job publication retired/);
      await assertEventsErased();
      assert.deepEqual(await redis.smembers(guard.chessJobRegistryKey(retained.id)), [
        `spectator|${publicId}`,
      ]);
      assert.equal(await registry.purgeChessJobs(retained.id), true);
    }
    console.log(
      `D2b atomic Redis publication: ${kind}/${targetCommand}${missingEpoch ? "/missing-epoch" : ""} timed out, erased User, rejected ${late.length} late native commands; no resurrected owner payload or registry`,
    );
  }

  try {
    await until(
      async () => Number(/^uptime_in_seconds:(\d+)/m.exec(await redis.info("server"))?.[1]) >= 31,
      "Disposable Valkey must pass the existing key-lease restart uncertainty window",
      35_000,
    );
    await race("run", "addStandardJob");
    await race("spectator", "addPrioritizedJob");
    await race("update", "updateData");
    await race("retry", "reprocessJob");
    await race("spectator", "addPrioritizedJob", true);
  } finally {
    for (const { queue, jobId } of ownedJobs) await (await queue.getJob(jobId))?.remove();
    for (const id of games) {
      assert.equal(await registry.purgeChessJobs(id), true);
      await redis.del(guard.chessJobRegistryKey(id), guard.chessJobEpochKey(id));
    }
    for (const { key, id } of controlEvents) await redis.xdel(key, id);
    await prisma.chessMatch.deleteMany({ where: { id: { in: games } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    catalog.resetModelCatalogCache();
    globalThis.fetch = originalFetch;
  }
}
