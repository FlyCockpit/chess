/**
 * C1b PostgreSQL/Valkey integration, owned by the runtime-services child only.
 * node scripts/test-runtime-operations.mjs --disposable-services --chess-human-only
 * Included in the full disposable runtime gate. No import-time IO or real HTTP.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

export async function chessHumanCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "chess-human");
  assert.equal(process.argv.length, 4);
  assert.equal(process.env.DATABASE_POOL_MAX, "5");

  const originalFetch = globalThis.fetch;
  const modelId = `fixture/human-opponent-${randomUUID()}`;
  const catalog = {
    data: [
      {
        id: modelId,
        name: "Synthetic human opponent",
        pricing: { prompt: "0", completion: "0" },
        supported_parameters: [],
        context_length: 32768,
        top_provider: { max_completion_tokens: 256 },
      },
    ],
  };
  let httpAllowed = true;
  const requests = [];
  const replies = [];
  const unexpectedRequests = [];
  // The SDK, stream parser and runner are real. Even unexpected requests never
  // fall through to a network implementation (nor print headers/credentials).
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const request = { path: url.pathname, method: init?.method ?? "GET" };
    requests.push(request);
    if (!httpAllowed || url.origin !== "https://openrouter.example.test") {
      unexpectedRequests.push(request);
      throw new Error("Unexpected HTTP in disposable human fixture");
    }
    if (url.pathname === "/api/v1/models") return Response.json(catalog);
    if (url.pathname !== "/api/v1/chat/completions" || !replies.length) {
      unexpectedRequests.push(request);
      throw new Error("No synthetic provider response was scheduled");
    }
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : await input.clone().text(),
    );
    assert.equal(body.model, modelId);
    assert.equal(body.stream, true);
    assert.equal(body.provider?.data_collection, "deny");
    const move = replies.shift();
    const shared = {
      id: `chat-${randomUUID()}`,
      object: "chat.completion.chunk",
      created: 0,
      model: modelId,
      provider: "Synthetic fixture",
    };
    const chunks = [
      {
        ...shared,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: JSON.stringify({ move }),
            },
            finish_reason: null,
          },
        ],
      },
      { ...shared, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      {
        ...shared,
        choices: [],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          cost: 0,
        },
      },
    ];
    return new Response(
      `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  let prisma;
  let queues;
  let observer;
  let consumer;
  let consumerConnection;
  const owners = [];
  const matches = new Set();
  const jobs = new Set();
  try {
    const [database, queueModule] = await Promise.all([
      import("../packages/db/src/index.ts"),
      import("../packages/queue/src/index.ts"),
    ]);
    prisma = database.default;
    queues = queueModule;
    const [
      chess,
      router,
      worker,
      turnColumns,
      human,
      keys,
      connections,
      revocation,
      engine,
      orpc,
      { loadPg },
    ] = await Promise.all([
      import("../packages/chess/src/index.ts"),
      import("../packages/api/src/routers/chess.ts"),
      import("../apps/worker/src/handlers/chess-run.ts"),
      import("../packages/api/src/lib/chess-turn.ts"),
      import("../packages/api/src/lib/chess-human.ts"),
      import("../packages/api/src/lib/provider-key.ts"),
      import("../packages/api/src/routers/openrouter.ts"),
      import("../packages/auth/src/credential-revocation.ts"),
      import("../packages/chess/src/engine.ts"),
      import(
        createRequire(new URL("../packages/api/package.json", import.meta.url)).resolve(
          "@orpc/server",
        )
      ),
      import("./db/lib/prisma.mjs"),
    ]);
    const pg = loadPg();
    observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await observer.connect();
    const client = (context, procedures = router.chessRouter) =>
      orpc.createRouterClient(procedures, { context });
    const person = async (overrides = {}) => {
      const user = await prisma.user.create({
        data: {
          name: "Disposable human fixture",
          email: `${randomUUID()}@example.test`,
          emailVerified: true,
          role: "admin",
          twoFactorEnabled: true,
          // Do not accidentally authorize an unenrolled admin via enrollment grace.
          createdAt: new Date(Date.now() - 7 * 86400_000),
          ...overrides,
        },
      });
      owners.push(user.id);
      const session = await prisma.session.create({
        data: {
          userId: user.id,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      const context = { session: { user, session } };
      return { id: user.id, context, api: client(context) };
    };
    const connect = async (owner) => {
      const key = `synthetic-owner-fixture-${randomUUID()}`;
      await prisma.openRouterConnection.create({
        data: {
          userId: owner.id,
          ...keys.sealProviderKey(owner.id, key, process.env.CHESS_PROVIDER_KEY_SECRET),
          keyHash: keys.hashProviderKey(key),
          keyHint: "test",
        },
      });
    };
    const humanPlayer = { name: "Human", model: "human", protocol: "human" };
    const modelPlayer = { name: "Fixture model", model: modelId, protocol: "openai-chat" };
    const config = (overrides = {}) => ({
      title: `Human integration ${randomUUID()}`,
      white: humanPlayer,
      black: modelPlayer,
      rules: chess.rulesSchema.parse({
        context: "fresh",
        engineEvaluation: "off",
        legalMoves: "hidden",
        remarks: "off",
        turnTimeoutMs: 300_000,
      }),
      billing: "operator",
      official: false,
      creationKey: randomUUID(),
      ...overrides,
    });
    const read = async (row) => {
      const current = await prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
      // Every snapshot, including a last durable running snapshot under a terminal
      // row, must pass the FULL replay validator, not just the shape parser.
      const archive = chess.validateArchive(current.archive);
      jobs.add(human.chessRunJobId(current.id, archive));
      return { ...current, archive };
    };
    const coherent = async (row) => {
      const current = await read(row);
      const columns = turnColumns.chessTurnFromColumns(current);
      const archive = structuredClone(current.archive);
      // Existing stop/reconcile contract: row status is authoritative; readers
      // finish the last durable replay instead of racing an archive rewrite.
      if (current.status === "stopped") chess.finishMatch(archive, "*", "cancelled", "stopped");
      if (current.status === "error" && current.ending?.kind === "credential-revoked")
        chess.finishMatch(archive, "*", "credential-revoked", "error");
      else if (current.status === "error" && archive.status === "running")
        chess.finishMatch(archive, "*", "interrupted", "error");
      chess.validateArchive(archive);
      assert.deepEqual(columns, archive.turn, "row turn columns agree with authoritative replay");
      if (current.status === "queued") {
        assert.equal(archive.status, "running");
        assert.equal(columns.type, "idle");
        assert.equal(current.runToken, null);
      } else assert.equal(archive.status, current.status);
      if (columns.type === "model") assert.ok(current.runToken);
      else assert.equal(current.runToken, null);
      assert.equal(current.pendingMove, null);
      if (current.status === "completed") {
        assert.equal(current.result, archive.result);
        assert.equal(current.terminalCause, archive.termination);
        assert.equal(current.whiteIllegal, chess.matchStats(archive, "w").illegalAttempts);
        assert.equal(current.blackIllegal, chess.matchStats(archive, "b").illegalAttempts);
      }
      assert.equal(await prisma.chessOfficialEntry.count({ where: { matchId: current.id } }), 0);
      return { ...current, archive };
    };
    const create = async (owner, overrides = {}) => {
      const result = await owner.api.create(config(overrides));
      const row = await prisma.chessMatch.findUniqueOrThrow({ where: { slug: result.slug } });
      matches.add(row.id);
      jobs.add(`chess-${row.id}`);
      const checked = await coherent(row);
      assert.equal(checked.status, "queued");
      assert.equal(checked.published, false);
      return checked;
    };
    const moveInput = (row, move = "e2e4") => ({
      slug: row.slug,
      move,
      expectedSeq: row.archive.turn.expectedSeq,
      turnId: row.archive.turn.turnId,
    });
    const run = (row) => worker.handleChessRunJob({ data: { matchId: row.id } });
    const reconcile = () => worker.handleChessReconcileJob({ data: { reason: "cron" } });
    const bounded = async (label, inspect, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await inspect()) return;
        await delay(25);
      }
      throw new Error(`Timed out: ${label}`);
    };
    const park = async (owner, overrides = {}) => {
      const row = await create(owner, overrides);
      const before = requests.length;
      httpAllowed = false;
      try {
        await run(row);
      } finally {
        httpAllowed = true;
      }
      assert.equal(requests.length, before, "human parking never fetches a key catalog/provider");
      const parked = await coherent(row);
      assert.equal(parked.status, "running");
      assert.equal(parked.archive.turn.type, "human");
      return parked;
    };

    console.log("chess-human: real authorization, fresh-only practice admission");
    await assert.rejects(client({ session: null }).create(config()), { code: "UNAUTHORIZED" });
    const unverified = await person({ emailVerified: false });
    await assert.rejects(unverified.api.create(config()), { code: "FORBIDDEN" });
    const unenrolled = await person({ twoFactorEnabled: false });
    await assert.rejects(unenrolled.api.create(config()), { code: "FORBIDDEN" });
    const admin = await person();
    await assert.rejects(client({ ...admin.context, credential: "api-key" }).create(config()), {
      code: "FORBIDDEN",
    });
    const regular = await person({ role: "user", twoFactorEnabled: false });
    await assert.rejects(regular.api.create(config()), { code: "FORBIDDEN" });
    await connect(regular);
    for (const overrides of [
      { official: true },
      { rules: chess.rulesSchema.parse({ context: "persistent" }) },
      { black: humanPlayer },
      { black: { name: "Random baseline", model: "random", protocol: "random" } },
    ])
      await assert.rejects(admin.api.create(config(overrides)), { code: "BAD_REQUEST" });
    assert.equal(await prisma.chessMatch.count({ where: { ownerId: admin.id } }), 0);

    console.log("chess-human: two real BullMQ slots release parked humans; third model progresses");
    const first = await create(admin);
    const second = await create(regular, { billing: "openrouter" });
    // The admitted human must park even when no key can be loaded anymore.
    await prisma.openRouterConnection.deleteMany({ where: { userId: regular.id } });
    const completedJobs = new Set();
    const workerErrors = [];
    const beforeHumanHttp = requests.length;
    const beforeEngines = engine.enginePoolStats().started;
    httpAllowed = false;
    consumerConnection = queues.createRedisConnection({ maxRetriesPerRequest: null });
    consumer = new queues.Worker(
      queues.QUEUE_NAMES.chessRun,
      async (job) => {
        // A live consumer can receive create's job before the caller sees its
        // response. Prove fixture ownership from the committed row, then record it.
        const owned = await prisma.chessMatch.findUniqueOrThrow({
          where: { id: job.data.matchId },
          select: { ownerId: true },
        });
        assert.ok(owners.includes(owned.ownerId), "consume only this fixture's jobs");
        matches.add(job.data.matchId);
        return worker.handleChessRunJob(job);
      },
      { connection: consumerConnection, concurrency: 2 },
    );
    consumer.on("completed", (job) => completedJobs.add(job.data.matchId));
    consumer.on("failed", (_job, error) => workerErrors.push(error));
    consumer.on("error", (error) => workerErrors.push(error));
    await bounded("both human handlers returned and released their BullMQ slots", () => {
      if (workerErrors.length) throw workerErrors[0];
      return completedJobs.has(first.id) && completedJobs.has(second.id);
    });
    assert.equal(requests.length, beforeHumanHttp);
    assert.equal(engine.enginePoolStats().started, beforeEngines);
    for (const row of [first, second]) {
      const parked = await coherent(row);
      assert.equal(parked.archive.turn.type, "human");
      assert.equal(parked.status, "running");
    }
    httpAllowed = true;
    replies.push("e2e4");
    const thirdOwner = await person();
    const thirdAcceptance = await thirdOwner.api.create(
      config({ white: modelPlayer, black: humanPlayer }),
    );
    // With the consumer live, only acceptance is stable here; claim/park may
    // precede this response. Wait for completion before reading archive state.
    const third = await prisma.chessMatch.findUniqueOrThrow({
      where: { slug: thirdAcceptance.slug },
    });
    matches.add(third.id);
    jobs.add(`chess-${third.id}`);
    await bounded("third model job completed with both humans still parked", () => {
      if (workerErrors.length) throw workerErrors[0];
      return completedJobs.has(third.id);
    });
    await consumer.close();
    consumer = undefined;
    consumerConnection.disconnect();
    consumerConnection = undefined;
    assert.equal(replies.length, 0);
    const thirdParked = await coherent(third);
    assert.equal(thirdParked.archive.turn.type, "human");
    assert.equal(thirdParked.archive.turn.side, "b");
    assert.equal(
      thirdParked.archive.events.filter((e) => e.type === "attempt" && e.accepted).length,
      1,
    );
    const parkedTurn = structuredClone(thirdParked.archive.turn);
    await worker.handleChessReconcileJob({
      data: {
        reason: "spectator",
        matchId: third.id,
        fromPly: 0,
        access: { purpose: "owner", ownerId: third.ownerId },
      },
    });
    const scoredParked = await coherent(third);
    assert.equal(
      scoredParked.spectatorEvaluations["1"].fen,
      chess.boardAt(scoredParked.archive).fen(),
    );
    assert.deepEqual(
      scoredParked.archive.turn,
      parkedTurn,
      "spectator handoff completes without resuming a human wait",
    );
    const noRedispatch = requests.length;
    await Promise.all([run(first), run(second), run(third)]);
    assert.equal(requests.length, noRedispatch, "redelivery cannot reclaim a parked turn");

    console.log("chess-human: ownership, stale identities, duplicate tabs and model continuation");
    let parked = await coherent(first);
    const initialTurnId = parked.archive.turn.turnId;
    const outsider = await person();
    await assert.rejects(outsider.api.move(moveInput(parked)), { code: "NOT_FOUND" });
    await assert.rejects(client({ session: null }).move(moveInput(parked)), {
      code: "UNAUTHORIZED",
    });
    await assert.rejects(admin.api.move({ ...moveInput(parked), expectedSeq: 1 }), {
      code: "CONFLICT",
    });
    await assert.rejects(admin.api.move({ ...moveInput(parked), turnId: randomUUID() }), {
      code: "CONFLICT",
    });
    assert.deepEqual((await coherent(first)).archive, parked.archive);
    const tabs = await Promise.allSettled([
      admin.api.move(moveInput(parked)),
      admin.api.move(moveInput(parked, "d2d4")),
    ]);
    assert.equal(tabs.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(tabs.find((result) => result.status === "rejected").reason.code, "CONFLICT");
    const accepted = tabs.find((result) => result.status === "fulfilled").value;
    const queued = await coherent(first);
    assert.equal(accepted.status, "queued");
    assert.equal(accepted.seq, queued.archive.events.length);
    assert.deepEqual(accepted.turn, { type: "idle" });
    const attempts = queued.archive.events.filter((event) => event.type === "attempt");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].accepted, true);
    const continuationId = `chess-${first.id}-turn-${queued.archive.events.length}`;
    assert.equal(human.chessRunJobId(first.id, queued.archive), continuationId);
    assert.ok(await queues.chessRunQueue.getJob(continuationId));
    const liveWakeJobs = await queues.chessRunQueue.getJobs(
      ["wait", "active", "delayed", "prioritized"],
      0,
      200,
    );
    assert.deepEqual(
      liveWakeJobs.filter((job) => job.data.matchId === first.id).map((job) => job.id),
      [continuationId],
      "duplicate tabs publish only one continuation",
    );
    await assert.rejects(admin.api.move(moveInput(parked)), { code: "CONFLICT" });
    replies.push("e7e5");
    const beforeModel = requests.filter((r) => r.path.endsWith("/chat/completions")).length;
    await Promise.all([run(queued), run(queued)]);
    parked = await coherent(first);
    assert.equal(parked.archive.turn.type, "human");
    assert.equal(parked.archive.turn.side, "w");
    assert.notEqual(parked.archive.turn.turnId, initialTurnId);
    assert.equal(parked.archive.events.filter((e) => e.type === "attempt" && e.accepted).length, 2);
    assert.equal(
      requests.filter((r) => r.path.endsWith("/chat/completions")).length,
      beforeModel + 1,
    );
    assert.equal(replies.length, 0);

    console.log("chess-human: illegal retries, resignation and promotion use authoritative rules");
    const illegalOwner = await person();
    let illegal = await park(illegalOwner, { rules: chess.rulesSchema.parse({ maxAttempts: 2 }) });
    const previousTurn = illegal.archive.turn.turnId;
    await illegalOwner.api.move(moveInput(illegal, "e2e5"));
    illegal = await coherent(illegal);
    assert.equal(illegal.archive.turn.type, "human");
    assert.notEqual(illegal.archive.turn.turnId, previousTurn);
    assert.equal(
      illegal.archive.events.filter((e) => e.type === "attempt" && !e.accepted).length,
      1,
    );
    await illegalOwner.api.move(moveInput(illegal, "e2e5"));
    illegal = await coherent(illegal);
    assert.equal(illegal.status, "completed");
    assert.equal(illegal.archive.termination, "illegal-forfeit");
    const resignOwner = await person();
    const resigning = await park(resignOwner);
    await resignOwner.api.move(moveInput(resigning, "resign"));
    const resigned = await coherent(resigning);
    assert.equal(resigned.archive.termination, "resignation");
    assert.equal(resigned.archive.result, "0-1");
    const promotionOwner = await person();
    const promoting = await park(promotionOwner, {
      initialFen: "7k/P7/8/8/8/8/8/7K w - - 0 1",
    });
    await promotionOwner.api.move(moveInput(promoting, "a7a8q"));
    const promoted = await coherent(promoting);
    assert.equal(chess.boardAt(promoted.archive).get("a8")?.type, "q");

    console.log(
      "chess-human: overdue move races expiry; stale heartbeat preserves live human waits",
    );
    const old = new Date(Date.now() - 600_000);
    await prisma.chessMatch.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { heartbeatAt: old },
    });
    await reconcile();
    assert.equal((await coherent(first)).archive.turn.type, "human");
    assert.equal((await coherent(second)).archive.turn.type, "human");
    const timeoutOwner = await person();
    const timeout = await park(timeoutOwner);
    const overdueArchive = structuredClone(timeout.archive);
    overdueArchive.turn = { type: "idle" };
    chess.beginHostedTurn(overdueArchive, new Date(Date.now() - 300_001));
    chess.validateArchive(overdueArchive);
    await prisma.chessMatch.update({
      where: { id: timeout.id },
      data: {
        archive: overdueArchive,
        ...human.chessTurnData(overdueArchive.turn),
        heartbeatAt: old,
      },
    });
    const expiring = await coherent(timeout);
    const expiryRace = await Promise.allSettled([
      timeoutOwner.api.move(moveInput(expiring)),
      reconcile(),
    ]);
    assert.equal(expiryRace[1].status, "fulfilled");
    if (expiryRace[0].status === "rejected") assert.equal(expiryRace[0].reason.code, "CONFLICT");
    const expired = await coherent(timeout);
    assert.equal(expired.status, "completed");
    assert.equal(expired.archive.termination, "move-timeout");
    assert.equal(expired.archive.result, "0-1");
    assert.equal(
      expired.archive.events.some((e) => e.type === "attempt" && e.accepted),
      false,
    );

    console.log("chess-human: stop/move races in both database lock orders");
    const blockedUpdates = async () => {
      const { rows } = await observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query ~* 'UPDATE .*chess_match'`);
      return rows[0].n;
    };
    for (const moveFirst of [true, false]) {
      const raceOwner = await person();
      const racing = await park(raceOwner);
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      const pending = [];
      try {
        await holder.query("BEGIN");
        await holder.query('SELECT id FROM "chess_match" WHERE id = $1 FOR UPDATE', [racing.id]);
        const moving = () => raceOwner.api.move(moveInput(racing));
        const stopping = () => raceOwner.api.stop({ slug: racing.slug });
        // Observe failures immediately, including while the other call is staged.
        pending.push(Promise.allSettled([(moveFirst ? moving : stopping)()]));
        await bounded(
          "first stop/move waits at row CAS",
          async () => (await blockedUpdates()) >= 1,
        );
        pending.push(Promise.allSettled([(moveFirst ? stopping : moving)()]));
        await bounded(
          "second stop/move waits at row CAS",
          async () => (await blockedUpdates()) >= 2,
        );
        await holder.query("COMMIT");
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
        await Promise.all(pending);
      }
      const results = (await Promise.all(pending)).flat();
      const stopResult = results[moveFirst ? 1 : 0];
      const moveResult = results[moveFirst ? 0 : 1];
      assert.equal(stopResult.status, "fulfilled");
      if (!moveFirst) {
        assert.equal(moveResult.status, "rejected");
        assert.equal(moveResult.reason.code, "CONFLICT");
      }
      const stopped = await coherent(racing);
      assert.equal(stopped.status, "stopped");
      assert.ok(
        stopped.archive.events.filter((e) => e.type === "attempt" && e.accepted).length <= 1,
      );
      const before = requests.length;
      await run(stopped);
      assert.equal(requests.length, before);
    }

    console.log("chess-human: lost continuation hint repairs past a full page of live queued jobs");
    const repairOwner = await person();
    const repair = await park(repairOwner);
    await repairOwner.api.move(moveInput(repair));
    const lost = await coherent(repair);
    const lostId = human.chessRunJobId(lost.id, lost.archive);
    await (await queues.chessRunQueue.getJob(lostId)).remove();
    // Filler rows have coherent idle archives, owned IDs and live deterministic
    // jobs. Fifty older rows force repair to advance the bounded scan cursor.
    const filler = Array.from({ length: 50 }, () => ({
      id: randomUUID(),
      ownerId: repairOwner.id,
      slug: `human-repair-${randomUUID()}`,
      title: lost.title,
      whiteName: lost.whiteName,
      blackName: lost.blackName,
      source: "hosted",
      status: "queued",
      published: false,
      rulesKey: lost.rulesKey,
      rulesVersion: lost.rulesVersion,
      promptVersion: lost.promptVersion,
      promptHash: lost.promptHash,
      contextMode: lost.contextMode,
      identityMode: lost.identityMode,
      credentialSource: "operator",
      archive: lost.archive,
      heartbeatAt: new Date(old.getTime() - 10_000),
    }));
    for (const row of filler) {
      matches.add(row.id);
      jobs.add(human.chessRunJobId(row.id, row.archive));
    }
    await prisma.chessMatch.createMany({ data: filler });
    await queues.chessRunQueue.addBulk(
      filler.map((row) => ({
        name: "chess-run",
        data: { matchId: row.id },
        opts: { jobId: human.chessRunJobId(row.id, row.archive) },
      })),
    );
    await prisma.chessMatch.update({ where: { id: lost.id }, data: { heartbeatAt: old } });
    for (let pass = 0; pass < 4 && !(await queues.chessRunQueue.getJob(lostId)); pass++)
      await reconcile();
    const repairedJob = await queues.chessRunQueue.getJob(lostId);
    assert.ok(repairedJob, "bounded repair advances past live queued jobs to missing continuation");
    assert.equal(await repairedJob.getState(), "waiting");
    await reconcile();
    assert.equal((await coherent(lost)).status, "queued");
    assert.deepEqual(
      (await read(lost)).archive,
      lost.archive,
      "repair never replays the human move",
    );
    for (const row of filler) assert.equal((await coherent(row)).status, "queued");
    replies.push("e7e5");
    await worker.handleChessRunJob(repairedJob);
    const resumed = await coherent(lost);
    assert.equal(resumed.archive.turn.type, "human");
    assert.equal(
      resumed.archive.events.filter((event) => event.type === "attempt" && event.accepted).length,
      2,
    );
    assert.equal(replies.length, 0);

    console.log("chess-human: uncertain running model claim is interrupted without redispatch");
    const crashedOwner = await person();
    const crash = await create(crashedOwner, { white: modelPlayer, black: humanPlayer });
    const crashArchive = structuredClone(crash.archive);
    chess.beginHostedTurn(crashArchive, new Date(Date.now() - 600_000));
    // A durable reservation models the last snapshot before an uncertain request.
    crashArchive.events.push(
      chess.eventSchema.parse({
        seq: 0,
        at: crashArchive.turn.startedAt,
        ply: 0,
        side: "w",
        type: "reservation",
        dispatch: 0,
        tokens: 256,
        costMicros: 0,
      }),
    );
    chess.validateArchive(crashArchive);
    await prisma.chessMatch.update({
      where: { id: crash.id },
      data: {
        status: "running",
        runToken: randomUUID(),
        heartbeatAt: old,
        archive: crashArchive,
        ...human.chessTurnData(crashArchive.turn),
      },
    });
    const beforeCrash = requests.length;
    await run(crash);
    await reconcile();
    const interrupted = await coherent(crash);
    assert.equal(interrupted.status, "error");
    assert.equal(interrupted.terminalCause, "worker-lost");
    assert.equal(interrupted.archive.termination, "interrupted");
    await run(crash);
    assert.equal(requests.length, beforeCrash);

    console.log("chess-human: disconnect and password reset clear parked/queued turn authority");
    const { CHESS_KEY_LEASE_MS } = await import("../packages/queue/src/chess-key-revocation.ts");
    // The real disconnect deliberately refuses to confirm absence of leases
    // during a fresh Valkey process's uncertainty window. Wait; do not bypass it.
    await bounded(
      "Valkey lease uncertainty window elapsed",
      async () => {
        const info = await queues.redisConnection.info("server");
        const uptime = /^uptime_in_seconds:(\d+)/m.exec(info)?.[1];
        return uptime !== undefined && Number(uptime) * 1000 >= CHESS_KEY_LEASE_MS;
      },
      45_000,
    );
    for (const cancellation of ["disconnect", "reset"]) {
      for (const afterMove of [false, true]) {
        const owner = await person({ role: "user", twoFactorEnabled: false });
        await connect(owner);
        const row = await park(owner, { billing: "openrouter" });
        if (afterMove) await owner.api.move(moveInput(row));
        if (cancellation === "disconnect") {
          const result = await client(owner.context, connections.openrouterRouter).disconnect();
          assert.equal(result.disconnected, true);
          assert.notEqual(result.stopped, "pending");
          assert.equal(await prisma.openRouterConnection.count({ where: { userId: owner.id } }), 0);
        } else await revocation.revokeCredentialsAfterPasswordReset(owner.id);
        const cancelled = await coherent(row);
        assert.equal(cancelled.status, cancellation === "disconnect" ? "error" : "stopped");
        assert.equal(
          cancelled.terminalCause,
          cancellation === "disconnect" ? "owner-disconnect" : "owner-reset",
        );
        await assert.rejects(owner.api.move(moveInput(row)), {
          code: cancellation === "disconnect" ? "CONFLICT" : "UNAUTHORIZED",
        });
        const before = requests.length;
        await run(row);
        assert.equal(requests.length, before);
      }
    }
    assert.deepEqual(unexpectedRequests, []);
    assert.equal(replies.length, 0);
    console.log("chess-human: C1b disposable PostgreSQL/Valkey checks passed");
  } finally {
    httpAllowed = false;
    try {
      await consumer?.close();
      consumerConnection?.disconnect();
      await observer?.end();
      if (prisma && queues) {
        // Collect only this fixture's tails, including a commit whose response
        // failed. No drain, prefix deletion or other mode's queue mutation.
        for (const id of matches) {
          const row = await prisma.chessMatch.findUnique({
            where: { id },
            select: { archive: true, ownerId: true, moderationVersion: true },
          });
          const count = row?.archive?.events?.length ?? 0;
          jobs.add(`chess-${id}`);
          for (let tail = 1; tail <= count; tail++) jobs.add(`chess-${id}-turn-${tail}`);
          for (let ply = 0; ply <= count; ply++) {
            const purposes = [
              { purpose: "public", version: row?.moderationVersion ?? 0 },
              ...(row?.ownerId ? [{ purpose: "owner", ownerId: row.ownerId }] : []),
            ];
            for (const access of purposes) {
              const job = await queues.chessReconcileQueue.getJob(
                queues.chessSpectatorJobId(id, ply, access),
              );
              await job?.remove();
            }
          }
        }
        for (const id of jobs) await (await queues.chessRunQueue.getJob(id))?.remove();
      }
      if (prisma && owners.length) await prisma.user.deleteMany({ where: { id: { in: owners } } });
    } finally {
      try {
        if (queues)
          await Promise.all(
            Object.values(queues)
              .filter((value) => value instanceof queues.Queue)
              .map((queue) => queue.close()),
          );
      } finally {
        queues?.redisConnection.disconnect();
        await prisma?.$disconnect();
        globalThis.fetch = originalFetch;
      }
    }
  }
}
