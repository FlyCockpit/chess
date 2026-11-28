/**
 * B2 PostgreSQL integration, invoked only by the owned runtime-services child.
 * Run on the disposable test host, never against a development/shared database:
 * node scripts/test-runtime-operations.mjs --disposable-services --chess-official-only
 * The full runtime gate includes this mode. This module has no import-time IO.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

export async function chessOfficialCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "chess-official");

  // Serve a synthetic catalog in memory, and fail any actual HTTP/provider call.
  // No consumer is started; worker fixtures exit before provider setup.
  const originalFetch = globalThis.fetch;
  let modelCatalog = null;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (modelCatalog && url.endsWith("/api/v1/models")) return Response.json(modelCatalog);
    throw new Error("Official integration fixtures must never make HTTP requests");
  };
  let prisma;
  let queues;
  const owners = [];
  const acceptedJobIds = new Set();
  try {
    const [database, queueModule] = await Promise.all([
      import("../packages/db/src/index.ts"),
      import("../packages/queue/src/index.ts"),
    ]);
    prisma = database.default;
    queues = queueModule;
    const [chess, official, stats, router, worker, orpc] = await Promise.all([
      import("../packages/chess/src/index.ts"),
      import("../packages/api/src/lib/chess-official.ts"),
      import("../packages/api/src/lib/chess-stats.ts"),
      import("../packages/api/src/routers/chess.ts"),
      import("../apps/worker/src/handlers/chess-run.ts"),
      import(
        createRequire(new URL("../packages/api/package.json", import.meta.url)).resolve(
          "@orpc/server",
        )
      ),
    ]);
    const [connections, revocation] = await Promise.all([
      import("../packages/api/src/routers/openrouter.ts"),
      import("../packages/auth/src/credential-revocation.ts"),
    ]);
    const { chessDigest, officialCommitment, officialLeaderboard, officialFilterInput } = official;
    const publicClient = orpc.createRouterClient(router.chessRouter, {
      context: { session: null },
    });
    assert.equal("setOfficial" in router.chessRouter, false);
    const fixtureId = randomUUID();
    const model = (side) => ({
      name: `Private ${side} label ${fixtureId}`,
      model: `fixture/${side}-${fixtureId}`,
      protocol: "openai-chat",
    });
    const white = model("white");
    const black = model("black");
    const baseline = { name: "Random baseline", model: "random", protocol: "random" };
    modelCatalog = {
      data: [white, black].map((player) => ({
        id: player.model,
        name: "Synthetic catalog label",
        pricing: { prompt: "0", completion: "0" },
        supported_parameters: [],
      })),
    };
    const archive = (input = {}, source = "hosted") =>
      chess.createMatch(
        { title: `Private title ${fixtureId}`, white, black, rules: {}, ...input },
        source,
      );
    const owner = async () => {
      const row = await prisma.user.create({
        data: {
          name: `Private owner ${fixtureId}`,
          email: `${randomUUID()}@example.test`,
          emailVerified: true,
        },
      });
      owners.push(row.id);
      return row.id;
    };
    const firstOwner = await owner();
    const ownerClient = async (ownerId, procedures = router.chessRouter) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
      const session = await prisma.session.create({
        data: { userId: ownerId, token: randomUUID(), expiresAt: new Date(Date.now() + 600_000) },
      });
      return orpc.createRouterClient(procedures, { context: { session: { user, session } } });
    };
    const makeData = (game, ownerId = firstOwner, billing = "operator") => ({
      ownerId,
      slug: `official-fixture-${randomUUID()}`,
      title: game.config.title,
      whiteName: game.config.white.name,
      blackName: game.config.black.name,
      source: game.source,
      status: "queued",
      published: false,
      rulesKey: chessDigest(game.config.rules).slice(0, 16),
      rulesVersion: game.config.rules.version,
      promptVersion: game.config.prompt.version,
      promptHash: game.config.prompt.hash,
      contextMode: game.config.rules.context,
      identityMode: game.config.rules.opponentIdentity,
      credentialSource: billing,
      heartbeatAt: new Date(),
      archive: game,
    });
    const enroll = (game = archive(), ownerId = firstOwner, billing = "operator") =>
      prisma.chessMatch.create({
        data: {
          ...makeData(game, ownerId, billing),
          OfficialEntry: { create: officialCommitment(game, billing) },
        },
      });
    const entry = (row, tx = prisma) =>
      tx.chessOfficialEntry.findUniqueOrThrow({ where: { matchId: row.id } });
    const readMatch = (row, tx = prisma) =>
      tx.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
    const claim = async (row, token = randomUUID()) => {
      assert.equal(
        (
          await prisma.chessMatch.updateMany({
            where: { id: row.id, status: "queued" },
            data: { status: "running", runToken: token },
          })
        ).count,
        1,
      );
      assert.equal((await entry(row)).state, "pending");
      return token;
    };
    const terminal = (row, data, token, tx = prisma) =>
      tx.chessMatch.updateMany({
        where: {
          id: row.id,
          ...(token ? { status: "running", runToken: token } : { status: "queued" }),
        },
        data: { ...data, runToken: null },
      });
    const stopped = (cause) => ({
      status: "stopped",
      terminalCause: cause,
      ending: { kind: "cancelled" },
    });
    const failed = (cause) => ({
      status: "error",
      terminalCause: cause,
      ending: { kind: "interrupted" },
    });
    const completed = (game, result = "1-0", cause = "resignation") => {
      const finished = structuredClone(game);
      chess.finishMatch(finished, result, cause);
      return { archive: finished, status: "completed", ...stats.chessStatsColumns(finished) };
    };
    const assertOutcome = async (row, state, cause, result = null) => {
      const settled = await entry(row);
      assert.equal(settled.state, state);
      assert.equal(settled.cause, cause);
      assert.equal(settled.result, result);
      assert.ok(settled.settledAt instanceof Date);
      assert.equal((await readMatch(row)).runToken, null);
      return settled;
    };

    console.log("chess-official: concurrent production create, consent and receipt replay");
    await prisma.user.update({
      where: { id: firstOwner },
      data: { role: "admin", twoFactorEnabled: true },
    });
    const firstApi = await ownerClient(firstOwner);
    const callers = new Map([[firstOwner, firstApi]]);
    const key = randomUUID();
    const acceptedArchive = archive();
    const admit = async (ownerId, game, creationKey = key, isOfficial = true) => {
      if (!callers.has(ownerId)) {
        await prisma.user.update({
          where: { id: ownerId },
          data: { role: "admin", twoFactorEnabled: true },
        });
        callers.set(ownerId, await ownerClient(ownerId));
      }
      const result = await callers.get(ownerId).create({
        title: game.config.title,
        white: game.config.white,
        black: game.config.black,
        initialFen: game.config.initialFen,
        rules: game.config.rules,
        promptVersion: game.config.prompt.version,
        billing: "operator",
        official: isOfficial,
        creationKey,
      });
      const row = await prisma.chessMatch.findUniqueOrThrow({ where: { slug: result.slug } });
      acceptedJobIds.add(row.id);
      return row;
    };
    const admitted = await Promise.all(
      Array.from({ length: 4 }, () => admit(firstOwner, acceptedArchive)),
    );
    const accepted = admitted[0];
    assert.equal(new Set(admitted.map((row) => row.id)).size, 1);
    assert.equal(await prisma.chessMatch.count({ where: { ownerId: firstOwner } }), 1);
    assert.equal(await prisma.chessOfficialEntry.count({ where: { matchId: accepted.id } }), 1);
    assert.equal(
      await prisma.chessCreation.count({ where: { id: chessDigest([firstOwner, key]) } }),
      1,
    );
    const pending = await entry(accepted);
    assert.equal(pending.state, "pending");
    assert.equal(pending.result, null);
    assert.equal(pending.settledAt, null);
    assert.equal((await readMatch(accepted)).status, "queued");
    await assert.rejects(admit(firstOwner, acceptedArchive, key, false), { code: "CONFLICT" });
    await assert.rejects(admit(firstOwner, archive({ title: "Different title" })), {
      code: "CONFLICT",
    });
    const otherOwner = await owner();
    assert.notEqual((await admit(otherOwner, acceptedArchive)).id, accepted.id);
    await terminal(accepted, stopped("owner-stop"));
    assert.equal((await admit(firstOwner, acceptedArchive)).id, accepted.id);
    assert.equal((await readMatch(accepted)).archive.config.white.name, white.model);
    assert.equal((await readMatch(accepted)).archive.config.black.name, black.model);
    await assertOutcome(accepted, "withdrawal", "owner-stop");
    await prisma.chessMatch.deleteMany({ where: { id: accepted.id, ownerId: firstOwner } });
    await assert.rejects(admit(firstOwner, acceptedArchive), { code: "NOT_FOUND" });
    const detachedReceipt = await prisma.chessCreation.findUniqueOrThrow({
      where: { id: chessDigest([firstOwner, key]) },
    });
    assert.equal(detachedReceipt.matchId, null);
    assert.equal(await prisma.chessOfficialEntry.count({ where: { id: pending.id } }), 1);

    console.log("chess-official: enrollment rejects untrusted sources and unsafe participants");
    const practice = await admit(firstOwner, archive(), randomUUID(), false);
    assert.equal(await prisma.chessOfficialEntry.count({ where: { matchId: practice.id } }), 0);
    const safe = officialCommitment(archive(), "operator");
    const human = { name: "Human", model: "human", protocol: "human" };
    const forbidden = [
      archive({}, "local"),
      archive({}, "demo"),
      archive({ white: human }),
      archive({ black: human }),
      archive({ white: baseline, black: baseline }),
    ];
    for (const game of forbidden) {
      assert.throws(() => officialCommitment(game, "operator"));
      await assert.rejects(
        prisma.chessMatch.create({
          data: { ...makeData(game), OfficialEntry: { create: safe } },
        }),
      );
    }
    assert.throws(() => officialCommitment(archive(), "local"));
    // Import provenance is forced local by the production import router. A forged
    // archive flag or hosted-looking archive inside a local/import row cannot enroll.
    for (const source of ["local", "import", "runner"]) {
      const game = archive();
      game.official = true;
      await assert.rejects(
        prisma.chessMatch.create({
          data: { ...makeData(game), source, OfficialEntry: { create: safe } },
        }),
      );
    }
    const noPrompt = archive();
    noPrompt.config.prompt.promptApplied = false;
    await assert.rejects(
      prisma.chessMatch.create({
        data: { ...makeData(noPrompt), OfficialEntry: { create: safe } },
      }),
    );
    // All valid fixtures get their real version/hash/system from createMatch().
    // No invented second prompt version/hash is admitted to test grouping.
    const safeKeys = [
      "promptVersion",
      "promptHash",
      "rulesKey",
      "rules",
      "initialFen",
      "initialPositionHash",
      "scopeKey",
      "billingCohort",
      "opponentType",
      "whiteModel",
      "whiteProtocol",
      "blackModel",
      "blackProtocol",
      "moveFormat",
    ];
    assert.deepEqual(Object.keys(safe).sort(), [...safeKeys].sort());
    const immutable = await enroll();
    const initial = await entry(immutable);
    const metadataEdits = {
      promptVersion: "unsupported",
      promptHash: chessDigest("tampered metadata"),
      rulesKey: chessDigest("tampered rules").slice(0, 16),
      rules: { altered: true },
      initialFen: "altered position",
      initialPositionHash: chessDigest("altered position"),
      scopeKey: chessDigest("altered scope"),
      billingCohort: "owner-openrouter",
      opponentType: "model-v-random",
      whiteModel: "altered/model",
      whiteProtocol: "random",
      blackModel: "altered/model",
      blackProtocol: "random",
      moveFormat: "lenient",
      startedAt: new Date(0),
    };
    for (const [field, value] of Object.entries(metadataEdits)) {
      await assert.rejects(
        prisma.chessOfficialEntry.update({
          where: { id: initial.id },
          data: { [field]: value },
        }),
        undefined,
        `pending metadata ${field} must be immutable`,
      );
    }
    assert.deepEqual(await entry(immutable), initial);

    console.log("chess-official: real owner stop, unpublish, disconnect and reset cancellation");
    const controlOwner = await owner();
    const controls = await ownerClient(controlOwner);
    for (const running of [false, true]) {
      const game = archive();
      const row = await enroll(game, controlOwner);
      const token = running ? await claim(row) : undefined;
      await controls.stop({ slug: row.slug });
      await assertOutcome(row, "withdrawal", "owner-stop");
      await controls.stop({ slug: row.slug });
      assert.equal((await terminal(row, completed(game), token)).count, 0);
    }
    for (const running of [false, true]) {
      const row = await enroll(archive(), controlOwner);
      if (running) await claim(row);
      const before = await entry(row);
      assert.equal(
        (
          await prisma.chessMatch.deleteMany({
            where: { id: row.id, ownerId: controlOwner },
          })
        ).count,
        1,
      );
      const after = await prisma.chessOfficialEntry.findUniqueOrThrow({ where: { id: before.id } });
      assert.equal(after.matchId, null);
      assert.equal(after.state, "withdrawal");
      assert.equal(after.cause, "owner-delete");
      assert.equal(after.result, null);
      assert.equal(after.finalFen, before.initialFen);
    }
    const publishedGame = archive();
    const publishedRow = await enroll(publishedGame, controlOwner);
    await terminal(publishedRow, completed(publishedGame));
    const beforePublish = await entry(publishedRow);
    await controls.publish({ slug: publishedRow.slug, published: true });
    await controls.publish({ slug: publishedRow.slug, published: false });
    assert.deepEqual(await entry(publishedRow), beforePublish);
    const disconnectOwner = await owner();
    const disconnectControls = await ownerClient(disconnectOwner, connections.openrouterRouter);
    const disconnectRows = [
      await enroll(archive(), disconnectOwner, "owner-openrouter"),
      await enroll(archive(), disconnectOwner, "owner-openrouter"),
    ];
    const disconnectedToken = await claim(disconnectRows[1]);
    const operatorRow = await enroll(archive(), disconnectOwner);
    // No actual provider connection is required: Disconnect must also cancel
    // accepted own-key runs after a connection row has already disappeared.
    assert.equal((await disconnectControls.disconnect()).disconnected, true);
    for (const row of disconnectRows) await assertOutcome(row, "withdrawal", "owner-disconnect");
    assert.equal(
      (await terminal(disconnectRows[1], completed(archive()), disconnectedToken)).count,
      0,
    );
    assert.equal(
      (await entry(operatorRow)).state,
      "pending",
      "disconnect never cancels operator billing",
    );
    console.log("chess-official: disconnect owns the row before external key revocation");
    const raceOwner = await owner();
    const raceControls = await ownerClient(raceOwner, connections.openrouterRouter);
    const raceGame = archive();
    const raceRow = await enroll(raceGame, raceOwner, "owner-openrouter");
    const raceToken = await claim(raceRow);
    const raceHash = `synthetic-disconnect-${randomUUID()}`;
    await prisma.openRouterConnection.create({
      data: {
        userId: raceOwner,
        keyCiphertext: new Uint8Array([0]),
        keyNonce: new Uint8Array(12),
        keySecretId: "synthetic",
        keyHash: raceHash,
        keyHint: "test",
      },
    });
    let locked;
    let releaseLock;
    const lockReady = new Promise((resolve) => {
      locked = resolve;
    });
    const holdLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "chess_match" WHERE id = ${raceRow.id} FOR UPDATE`;
      locked();
      await holdLock;
    });
    holder.catch(() => undefined);
    await lockReady;
    const disconnecting = raceControls.disconnect();
    disconnecting.catch(() => undefined);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await prisma.$queryRaw`SELECT EXISTS (
          SELECT FROM pg_stat_activity WHERE wait_event_type = 'Lock'
          AND query LIKE '%ORDER BY "id" FOR UPDATE%'
        ) AS waiting`;
        if (rows[0].waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true, "disconnect must block on the existing match row lock");
      assert.equal(
        await queues.redisConnection.zscore(
          `cockpit-chess:openrouter-key-revoked:${raceOwner}`,
          raceHash,
        ),
        null,
        "a worker must not see revocation before disconnect owns the match row",
      );
      const lateWorker = terminal(
        raceRow,
        {
          status: "error",
          ending: { kind: "credential-revoked" },
          terminalCause: "credential-revoked",
        },
        raceToken,
      );
      releaseLock();
      await holder;
      assert.equal((await disconnecting).disconnected, true);
      assert.equal((await lateWorker).count, 0, "revoked worker cannot steal the owner withdrawal");
      await assertOutcome(raceRow, "withdrawal", "owner-disconnect");
    } finally {
      releaseLock();
      await holder;
      await disconnecting;
    }
    const resetOwner = await owner();
    await prisma.user.update({
      where: { id: resetOwner },
      data: { role: "admin", twoFactorEnabled: true },
    });
    const staleResetApi = await ownerClient(resetOwner);
    const resetRows = [await enroll(archive(), resetOwner), await enroll(archive(), resetOwner)];
    const resetToken = await claim(resetRows[1]);
    await revocation.revokeCredentialsBeforeAdminPasswordReset(resetOwner);
    for (const row of resetRows) await assertOutcome(row, "withdrawal", "owner-reset");
    const afterResetKey = randomUUID();
    await assert.rejects(
      staleResetApi.create({
        white,
        black: baseline,
        rules: {},
        billing: "operator",
        official: true,
        creationKey: afterResetKey,
      }),
      { code: "UNAUTHORIZED" },
    );
    assert.equal(
      await prisma.chessCreation.findUnique({
        where: { id: chessDigest([resetOwner, afterResetKey]) },
      }),
      null,
    );
    assert.equal(await prisma.chessMatch.count({ where: { ownerId: resetOwner } }), 2);

    assert.equal((await terminal(resetRows[1], completed(archive()), resetToken)).count, 0);

    console.log("chess-official: stop/complete CAS, stale claims, rollback, immutable settlement");
    for (let attempt = 0; attempt < 8; attempt++) {
      const game = archive();
      const row = await enroll(game);
      const token = await claim(row);
      const writes = [
        terminal(row, stopped("owner-stop"), token),
        terminal(row, completed(game), token),
      ];
      const outcomes = await Promise.all(attempt % 2 ? writes.reverse() : writes);
      assert.equal(
        outcomes.reduce((sum, result) => sum + result.count, 0),
        1,
      );
      const after = await readMatch(row);
      const ledger = await entry(row);
      assert.equal(ledger.state, after.status === "completed" ? "scored" : "withdrawal");
      assert.equal(ledger.result, after.status === "completed" ? "1-0" : null);
      assert.equal((await terminal(row, completed(game, "0-1"), token)).count, 0);
      assert.deepEqual(await entry(row), ledger);
    }
    const reclaimedGame = archive();
    const reclaimed = await enroll(reclaimedGame);
    const oldToken = await claim(reclaimed);
    const newToken = randomUUID();
    assert.equal(
      (
        await prisma.chessMatch.updateMany({
          where: { id: reclaimed.id, status: "running", runToken: oldToken },
          data: { runToken: newToken },
        })
      ).count,
      1,
    );
    assert.equal((await terminal(reclaimed, completed(reclaimedGame), oldToken)).count, 0);
    assert.equal((await entry(reclaimed)).state, "pending");
    assert.equal((await terminal(reclaimed, completed(reclaimedGame, "0-1"), newToken)).count, 1);
    await assertOutcome(reclaimed, "scored", "resignation", "0-1");
    const settledBefore = await entry(reclaimed);
    // A repeated status write cannot resettle the ledger even if its caller lost
    // ownership discipline. Direct edits of settled results/stats also fail.
    await prisma.chessMatch.update({
      where: { id: reclaimed.id },
      data: completed(reclaimedGame, "1-0"),
    });
    assert.deepEqual(await entry(reclaimed), settledBefore);
    for (const data of [
      { result: "1-0" },
      { state: "pending" },
      { cause: "owner-stop" },
      { whiteIllegal: 999 },
      { whiteCostMicros: 999n },
      { finalFen: "altered" },
      { settledAt: new Date(0) },
    ])
      await assert.rejects(
        prisma.chessOfficialEntry.update({ where: { id: settledBefore.id }, data }),
      );
    const rollbackGame = archive();
    const rollback = await enroll(rollbackGame);
    const rollbackToken = await claim(rollback);
    const beforeRollback = await entry(rollback);
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        assert.equal(
          (await terminal(rollback, completed(rollbackGame), rollbackToken, tx)).count,
          1,
        );
        assert.equal((await entry(rollback, tx)).state, "scored");
        throw new Error("deliberate settlement rollback");
      }),
      /deliberate settlement rollback/,
    );
    assert.equal((await readMatch(rollback)).status, "running");
    assert.equal((await readMatch(rollback)).runToken, rollbackToken);
    assert.deepEqual(await entry(rollback), beforeRollback);

    console.log("chess-official: terminal cause matrix and real worker failure paths");
    for (const cause of [
      "enqueue-failed",
      "archive-invalid",
      "worker-lost",
      "queue-lost",
      "engine-error",
      "event-limit",
      "interrupted",
    ]) {
      const row = await enroll();
      await terminal(row, failed(cause));
      await assertOutcome(row, "infrastructure-error", cause);
    }
    for (const [cause, category] of [
      ["provider-error", "provider-error"],
      ["account-limit", "account-error"],
      ["credential-revoked", "account-error"],
    ]) {
      const row = await enroll();
      // Even result-shaped data cannot manufacture earned points for an error.
      await terminal(row, { ...failed(cause), result: "1-0" });
      await assertOutcome(row, category, cause);
    }
    for (const cause of [
      "owner-stop",
      "owner-disconnect",
      "owner-reset",
      "owner-delete",
      "cancelled",
    ]) {
      for (const running of [false, true]) {
        const row = await enroll();
        const token = running ? await claim(row) : undefined;
        await terminal(row, stopped(cause), token);
        const withdrawn = await assertOutcome(row, "withdrawal", cause);
        assert.equal(
          withdrawn.finalFen,
          withdrawn.initialFen,
          "withdrawal before any move keeps starting board",
        );
      }
    }
    for (const cause of [
      "checkmate",
      "draw",
      "illegal-forfeit",
      "resignation",
      "timeout",
      "move-timeout",
      "token-budget",
      "cost-budget",
    ]) {
      for (const result of ["1-0", "0-1", "1/2-1/2"]) {
        const game = archive();
        const row = await enroll(game);
        const token = await claim(row);
        await terminal(row, completed(game, result, cause), token);
        await assertOutcome(row, "scored", cause, result);
      }
    }
    for (const cause of ["provider-error", "engine-error", "event-limit", "unknown-terminal"]) {
      const row = await enroll();
      await terminal(row, {
        status: "completed",
        result: "1-0",
        ending: { kind: cause },
        terminalCause: cause,
      });
      await assertOutcome(
        row,
        cause === "provider-error" ? "provider-error" : "infrastructure-error",
        cause,
      );
    }
    const unknown = await enroll();
    await terminal(unknown, failed(`Private provider reply ${fixtureId}`));
    await assertOutcome(unknown, "infrastructure-error", "unknown-terminal");
    const invalid = await enroll();
    await prisma.chessMatch.update({ where: { id: invalid.id }, data: { archive: {} } });
    await worker.handleChessRunJob({ data: { matchId: invalid.id } });
    await assertOutcome(invalid, "infrastructure-error", "archive-invalid");
    const lostQueue = await enroll();
    const lostWorker = await enroll();
    await claim(lostWorker);
    const stale = new Date(Date.now() - 600_000);
    await prisma.chessMatch.updateMany({
      where: { id: { in: [lostQueue.id, lostWorker.id] } },
      data: { heartbeatAt: stale },
    });
    assert.ok((await worker.handleChessReconcileJob({ data: { reason: "cron" } })).errored >= 2);
    await assertOutcome(lostQueue, "infrastructure-error", "queue-lost");
    await assertOutcome(lostWorker, "infrastructure-error", "worker-lost");

    console.log("chess-official: stats and last accepted board settle in the match CAS");
    const usageGame = archive({ rules: { maxAttempts: 10 } });
    const usageRow = await enroll(usageGame);
    const usageToken = await claim(usageRow);
    const board = chess.boardAt(usageGame);
    chess.submitMove(usageGame, board, "bad-reply", "", undefined, {
      text: "cut off",
      stopReason: "output-truncated",
    });
    chess.submitMove(usageGame, board, "e2e4");
    const lastFen = board.fen();
    const event = (side, type, extra) =>
      chess.eventSchema.parse({
        seq: usageGame.events.length,
        at: new Date().toISOString(),
        ply: board.history().length,
        side,
        type,
        ...extra,
      });
    usageGame.events.push(event("w", "reservation", { dispatch: 0, tokens: 100, costMicros: 500 }));
    usageGame.events.push(
      event("b", "usage", {
        dispatch: 1,
        inputTokens: 10,
        outputTokens: 5,
        costMicros: 7,
        resolvedModel: null,
        resolvedProvider: null,
      }),
    );
    const columns = completed(usageGame);
    assert.equal(columns.whiteIllegal, 1);
    assert.equal(columns.whiteTruncated, 1);
    assert.equal(columns.whiteCostMicros, null, "unsettled reservation is unknown, never zero");
    assert.equal(columns.blackCostMicros, 7n);
    await terminal(usageRow, columns, usageToken);
    const usageEntry = await assertOutcome(usageRow, "scored", "resignation", "1-0");
    const usageMatch = await readMatch(usageRow);
    assert.equal(usageEntry.finalFen, lastFen);
    for (const field of [
      "result",
      "whiteIllegal",
      "blackIllegal",
      "whiteTruncated",
      "blackTruncated",
      "whiteCostMicros",
      "blackCostMicros",
    ]) {
      assert.equal(
        usageEntry[field],
        usageMatch[field],
        `settled ${field} comes from the same CAS`,
      );
    }

    console.log("chess-official: all-start PostgreSQL aggregate exceeds the old 500-row window");
    const aggregateGame = archive({ rules: { tokenBudget: 8128 } });
    const aggregateSnapshot = officialCommitment(aggregateGame, "operator");
    const aggregateFilter = {
      rulesKey: aggregateSnapshot.rulesKey,
      initialPositionHash: aggregateSnapshot.initialPositionHash,
      promptVersion: aggregateSnapshot.promptVersion,
      billingCohort: "operator",
      opponentType: "model-v-model",
      limit: 100,
    };
    // The loss cohort is older than the win. Every entry is first accepted queued;
    // no directly inserted terminal ledger rows and no archive scans are used.
    const bulkIds = [];
    for (let offset = 0; offset < 502; offset += 50) {
      const ids = await prisma.$transaction(
        async (tx) => {
          const batch = [];
          for (let index = offset; index < Math.min(offset + 50, 502); index++) {
            const row = await tx.chessMatch.create({
              data: { ...makeData(aggregateGame), OfficialEntry: { create: aggregateSnapshot } },
              select: { id: true },
            });
            await terminal(
              row,
              completed(aggregateGame, index === 501 ? "1-0" : "0-1"),
              undefined,
              tx,
            );
            batch.push(row.id);
          }
          return batch;
        },
        { timeout: 20_000 },
      );
      bulkIds.push(...ids);
    }
    const all = await officialLeaderboard(aggregateFilter);
    assert.equal(all.sampleSize, 502);
    assert.equal(all.items.length, 2);
    const whiteAggregate = all.items.find((item) => item.model === white.model);
    assert.ok(whiteAggregate);
    assert.equal(whiteAggregate.games, 502);
    assert.equal(whiteAggregate.losses, 501);
    assert.equal(whiteAggregate.wins, 1);
    assert.equal(whiteAggregate.points, 1);
    assert.equal(whiteAggregate.score, 1 / 502);
    assert.equal(whiteAggregate.estimatedCostMicros, 0);
    await prisma.chessMatch.updateMany({
      where: { id: { in: bulkIds } },
      data: { published: true },
    });
    await prisma.chessMatch.updateMany({
      where: { id: { in: bulkIds } },
      data: { published: false },
    });
    assert.deepEqual(await officialLeaderboard(aggregateFilter), all);
    await prisma.chessMatch.deleteMany({ where: { id: { in: bulkIds }, ownerId: firstOwner } });
    assert.deepEqual(await officialLeaderboard(aggregateFilter), all);
    assert.equal(
      await prisma.chessOfficialEntry.count({
        where: { scopeKey: aggregateSnapshot.scopeKey, matchId: null },
      }),
      502,
    );

    const scopeOf = (game, billing) => officialCommitment(game, billing).scopeKey;
    assert.equal(
      aggregateSnapshot.scopeKey,
      chessDigest([
        aggregateSnapshot.promptVersion,
        aggregateSnapshot.promptHash,
        aggregateSnapshot.rulesKey,
        aggregateSnapshot.initialPositionHash,
        aggregateSnapshot.billingCohort,
        aggregateSnapshot.opponentType,
      ]),
    );
    const shiftedBoard = chess.boardAt(aggregateGame);
    shiftedBoard.move("e4");
    const differentFen = archive({ rules: { tokenBudget: 8128 }, initialFen: shiftedBoard.fen() });
    const differentRules = archive({ rules: { tokenBudget: 8129 } });
    const randomOpponent = archive({ rules: { tokenBudget: 8128 }, black: baseline });
    const variants = [
      [differentFen, "operator"],
      [differentRules, "operator"],
      [aggregateGame, "owner-openrouter"],
      [randomOpponent, "operator"],
    ];
    for (const [game, billing] of variants) {
      assert.notEqual(scopeOf(game, billing), aggregateSnapshot.scopeKey);
      await enroll(game, firstOwner, billing);
    }
    assert.deepEqual(await officialLeaderboard(aggregateFilter), all);
    const baselinePage = await officialLeaderboard({
      ...aggregateFilter,
      opponentType: "model-v-random",
    });
    assert.equal(baselinePage.sampleSize, 1);
    assert.equal(baselinePage.items.length, 1);
    assert.equal(baselinePage.items[0].model, white.model);
    assert.equal(baselinePage.items[0].pending, 1);
    assert.equal(baselinePage.items[0].score, 0);
    assert.equal(
      (await officialLeaderboard({ ...aggregateFilter, promptVersion: "unsupported" })).sampleSize,
      0,
    );
    const mixedGame = archive({ rules: { tokenBudget: 8130 } });
    const mixedFilter = {
      ...aggregateFilter,
      rulesKey: officialCommitment(mixedGame, "operator").rulesKey,
    };
    for (const data of [
      null,
      stopped("owner-stop"),
      failed("provider-error"),
      failed("account-limit"),
      failed("queue-lost"),
      completed(mixedGame, "1/2-1/2"),
    ]) {
      const row = await enroll(mixedGame);
      if (data) await terminal(row, data);
    }
    const mixed = (await officialLeaderboard(mixedFilter)).items.find(
      (item) => item.model === white.model,
    );
    assert.ok(mixed);
    assert.deepEqual(
      [
        mixed.games,
        mixed.wins,
        mixed.draws,
        mixed.losses,
        mixed.pending,
        mixed.withdrawals,
        mixed.providerErrors,
        mixed.accountErrors,
        mixed.infrastructureErrors,
      ],
      [6, 0, 1, 0, 1, 1, 1, 1, 1],
    );
    assert.equal(mixed.score, 0.5 / 6);
    assert.equal(mixed.estimatedCostMicros, null);
    const usageAggregate = await officialLeaderboard({
      ...aggregateFilter,
      rulesKey: officialCommitment(archive({ rules: { maxAttempts: 10 } }), "operator").rulesKey,
    });
    assert.equal(
      usageAggregate.items.find((item) => item.model === white.model)?.estimatedCostMicros,
      null,
    );

    console.log("chess-official: bounded lexical aggregate pages and minimal public entry pages");
    assert.equal(officialFilterInput.safeParse({ limit: 0 }).success, false);
    assert.equal(officialFilterInput.safeParse({ limit: 101 }).success, false);
    assert.equal(officialFilterInput.safeParse({ cursor: "bad" }).success, false);
    await assert.rejects(publicClient.officialEntries({ limit: 101 }));
    const groups = [];
    let cursor;
    for (let pageNumber = 0; ; pageNumber++) {
      assert.ok(pageNumber < 100, "aggregate cursor must advance");
      const page = await officialLeaderboard({ limit: 2, ...(cursor ? { cursor } : {}) });
      assert.ok(page.items.length <= 2);
      groups.push(...page.items);
      if (!page.nextCursor) break;
      assert.notEqual(page.nextCursor, cursor);
      cursor = page.nextCursor;
    }
    const groupKeys = groups.map((item) => item.scopeKey);
    assert.ok(groupKeys.length > 4);
    assert.equal(new Set(groupKeys).size, groupKeys.length);
    assert.deepEqual(groupKeys, [...groupKeys].sort());
    assert.ok(groups.every((item) => item.protocol !== "random" && item.protocol !== "human"));
    const publicKeys = [
      "id",
      "startedAt",
      "promptVersion",
      "promptHash",
      "rulesKey",
      "rules",
      "initialFen",
      "initialPositionHash",
      "billingCohort",
      "opponentType",
      "whiteModel",
      "whiteProtocol",
      "blackModel",
      "blackProtocol",
      "state",
      "cause",
      "settledAt",
      "result",
      "finalFen",
    ].sort();
    const publicIds = [];
    cursor = undefined;
    const totalEntries = await prisma.chessOfficialEntry.count();
    for (let pageNumber = 0; ; pageNumber++) {
      assert.ok(pageNumber < 100, "entry cursor must advance");
      const page = await publicClient.officialEntries({ limit: 17, ...(cursor ? { cursor } : {}) });
      assert.ok(page.items.length <= 17);
      for (const item of page.items) {
        assert.deepEqual(Object.keys(item).sort(), publicKeys);
        const serialized = JSON.stringify(item);
        for (const privateText of [
          "Private owner",
          "Private title",
          "Private white label",
          "Private black label",
          "Private provider reply",
          "@example.test",
        ]) {
          assert.equal(serialized.includes(privateText), false);
        }
        publicIds.push(item.id);
      }
      if (!page.nextCursor) break;
      assert.notEqual(page.nextCursor, cursor);
      cursor = page.nextCursor;
    }
    assert.equal(publicIds.length, totalEntries);
    assert.equal(new Set(publicIds).size, totalEntries);
    const filteredEntries = await publicClient.officialEntries(aggregateFilter);
    assert.equal(filteredEntries.items.length, 100);
    assert.ok(filteredEntries.nextCursor);
    assert.ok(
      filteredEntries.items.every(
        (item) =>
          item.rulesKey === aggregateSnapshot.rulesKey &&
          item.initialPositionHash === aggregateSnapshot.initialPositionHash &&
          item.promptVersion === aggregateSnapshot.promptVersion &&
          item.billingCohort === "operator" &&
          item.opponentType === "model-v-model",
      ),
    );

    console.log(
      "chess-official: deletion fence and explicit private cleanup preserve minimal starts and counts",
    );
    const deletingOwner = await owner();
    const deletionGame = archive({ rules: { tokenBudget: 8131 } });
    const deletedRows = [
      await enroll(deletionGame, deletingOwner),
      await enroll(deletionGame, deletingOwner),
    ];
    const completedToken = await claim(deletedRows[1]);
    await terminal(deletedRows[1], completed(deletionGame), completedToken);
    const scoredBeforeDelete = await entry(deletedRows[1]);
    const pendingBeforeDelete = await entry(deletedRows[0]);
    const deleteFilter = {
      ...aggregateFilter,
      rulesKey: officialCommitment(deletionGame, "operator").rulesKey,
    };
    const beforeDelete = await officialLeaderboard(deleteFilter);
    assert.equal(beforeDelete.sampleSize, 2);
    const { requestAccountDeletion } = await import("../packages/api/src/lib/account-deletion.ts");
    const deletionAdmin = await owner();
    await prisma.user.update({
      where: { id: deletionAdmin },
      data: { role: "admin", twoFactorEnabled: true },
    });
    const deletionAdminSession = await prisma.session.create({
      data: {
        userId: deletionAdmin,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    assert.equal(
      (
        await requestAccountDeletion(deletingOwner, {
          kind: "admin",
          userId: deletionAdmin,
          sessionId: deletionAdminSession.id,
        })
      ).complete,
      false,
    );
    // Disposable D2b choreography fixture: production D2a stops at pending.
    // Private rows are explicitly removed; the nullable User relation cannot cascade.
    await prisma.chessMatch.deleteMany({ where: { ownerId: deletingOwner, published: false } });
    await prisma.user.deleteMany({ where: { id: deletingOwner } });
    assert.equal(await prisma.chessMatch.count({ where: { ownerId: deletingOwner } }), 0);
    const retainedScore = await prisma.chessOfficialEntry.findUniqueOrThrow({
      where: { id: scoredBeforeDelete.id },
    });
    assert.deepEqual(retainedScore, { ...scoredBeforeDelete, matchId: null });
    const retainedWithdrawal = await prisma.chessOfficialEntry.findUniqueOrThrow({
      where: { id: pendingBeforeDelete.id },
    });
    assert.equal(retainedWithdrawal.matchId, null);
    assert.equal(retainedWithdrawal.state, "withdrawal");
    assert.equal(retainedWithdrawal.cause, "owner-delete");
    const afterDelete = await officialLeaderboard(deleteFilter);
    assert.equal(afterDelete.sampleSize, beforeDelete.sampleSize);
    for (const item of afterDelete.items) {
      const before = beforeDelete.items.find((candidate) => candidate.scopeKey === item.scopeKey);
      assert.ok(before);
      assert.equal(item.games, before.games);
      assert.equal(item.score, before.score);
      assert.equal(item.wins, before.wins);
      assert.equal(item.pending, 0);
      assert.equal(item.withdrawals, 1);
    }
    console.log("chess-official: B2 disposable PostgreSQL checks passed");
  } finally {
    // Never remove permanent ledger/receipt rows. The parent destroys only its
    // owned disposable PG container; scoped user deletion also exercises cascades.
    try {
      // Real create enqueues jobs; later runtime modes share this owned Valkey.
      // Remove only this fixture's deterministic jobs, including deleted matches.
      if (queues)
        for (const id of acceptedJobIds) {
          const job = await queues.chessRunQueue.getJob(`chess-${id}`);
          await job?.remove();
        }
      if (prisma && owners.length) {
        await prisma.chessMatch.deleteMany({ where: { ownerId: { in: owners } } });
        await prisma.user.deleteMany({ where: { id: { in: owners } } });
      }
    } finally {
      try {
        if (queues) {
          await Promise.all(
            Object.values(queues)
              .filter((value) => value instanceof queues.Queue)
              .map((queue) => queue.close()),
          );
        }
      } finally {
        queues?.redisConnection.disconnect();
        await prisma?.$disconnect();
        globalThis.fetch = originalFetch;
      }
    }
  }
}
