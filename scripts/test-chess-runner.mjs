/**
 * E4a durable runner/source acceptance on this harness's disposable PG/Valkey.
 * node scripts/test-runtime-operations.mjs --disposable-services --chess-runner-only
 * No provider requests, browser, live services, or developer env are used.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

export async function chessRunnerCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "chess-runner");
  assert.equal(process.argv.length, 4);
  assert.equal(process.env.DATABASE_POOL_MAX, "5");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async () => {
    requests.push("unexpected provider/network dispatch");
    throw new Error("Runner control fixture never authorizes network dispatch");
  };
  let prisma;
  let queues;
  const ownerIds = [];
  const matchIds = new Set();
  const creationIds = new Set();
  const ownedTransports = [];
  const ownedConnections = [];
  const ownedCliConnections = [];
  const ownedGameLoops = [];
  const releaseBarriers = [];
  try {
    const [
      database,
      queueModule,
      chess,
      control,
      routers,
      moderation,
      hosted,
      admission,
      worker,
      spectator,
      engine,
      machines,
      authority,
      transportModule,
      leaseModule,
      slots,
      gameModule,
      policyModule,
      connectionModule,
      orpc,
    ] = await Promise.all([
      import("../packages/db/src/index.ts"),
      import("../packages/queue/src/index.ts"),
      import("../packages/chess/src/index.ts"),
      import("../packages/api/src/lib/chess-runner.ts"),
      import("../packages/api/src/routers/chess-runner.ts"),
      import("../packages/api/src/routers/chess-moderation.ts"),
      import("../packages/api/src/routers/chess.ts"),
      import("../packages/api/src/lib/chess-locks.ts"),
      import("../apps/worker/src/handlers/chess-run.ts"),
      import("../apps/worker/src/handlers/chess-spectator.ts"),
      import("../packages/chess/src/engine.ts"),
      import("../packages/auth/src/runner-machine.ts"),
      import("../apps/server/src/runner-ws-authority.ts"),
      import("../apps/server/src/runner-ws.ts"),
      import("../apps/server/src/runner-ws-store.ts"),
      import("../packages/auth/src/lock-slots.ts"),
      import("../apps/cli/src/runner-game.ts"),
      import("../apps/cli/src/runner-policy.ts"),
      import("../apps/cli/src/runner-connection.ts"),
      import(
        createRequire(new URL("../packages/api/package.json", import.meta.url)).resolve(
          "@orpc/server",
        )
      ),
    ]);
    prisma = database.default;
    queues = queueModule;
    const client = (context, router) => orpc.createRouterClient(router, { context });
    const person = async (admin = false) => {
      const user = await prisma.user.create({
        data: {
          name: "Disposable runner control fixture",
          email: `${randomUUID()}@example.test`,
          emailVerified: true,
          role: admin ? "admin" : "user",
          twoFactorEnabled: admin,
          createdAt: new Date(Date.now() - 7 * 86_400_000),
        },
      });
      ownerIds.push(user.id);
      const session = await prisma.session.create({
        data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 600_000) },
      });
      const context = { session: { user, session } };
      return {
        id: user.id,
        context,
        api: client(context, routers.chessRunnerRouter),
        chess: client(context, hosted.chessRouter),
      };
    };
    const owner = await person(true);
    const stranger = await person();
    const machine = async (person = owner) => {
      const secret =
        machines.RUNNER_MACHINE_TOKEN_PREFIX + randomUUID().replaceAll("-", "").repeat(2);
      const row = await prisma.runnerMachine.create({
        data: {
          userId: person.id,
          displayName: "Disposable local runner",
          credentialDigest: machines.digestRunnerMachineSecret(secret),
          credentialPrefix: "fixture",
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      const resolver = authority.createRunnerAuthority(async (id) => id === person.id);
      const identity = await resolver.claim(`Bearer ${secret}`);
      assert.ok(identity);
      return { id: row.id, identity, secret, resolver };
    };
    const firstMachine = await machine();
    const secondMachine = await machine();
    const strangerMachine = await machine(stranger);
    const config = () => ({
      title: `Runner integration ${randomUUID()}`,
      white: { name: "Human", model: "human", protocol: "human" },
      black: { name: "Local model", model: "fixture/local-model", protocol: "openai-chat" },
      rules: chess.rulesSchema.parse({
        context: "fresh",
        engineEvaluation: "off",
        legalMoves: "hidden",
        remarks: "off",
      }),
    });
    const request = (local = firstMachine) => ({
      machineId: local.id,
      creationKey: randomUUID(),
      config: config(),
    });
    const create = async (input = request(), person = owner) => {
      creationIds.add(
        createHash("sha256")
          .update(JSON.stringify(["runner", person.id, input.creationKey]))
          .digest("hex"),
      );
      const row = await person.api.createRunner(input);
      matchIds.add(row.id);
      return row;
    };
    const read = (row) => prisma.chessMatch.findUniqueOrThrow({ where: { id: row.id } });
    const status = (row, person = owner) => person.api.runnerStatus({ slug: row.slug });
    const frame = (local, type, matchId, payload, id = randomUUID()) => ({
      version: 1,
      generation: local.identity.connectionGeneration,
      id,
      seq: 1,
      ack: 0,
      type,
      ...(matchId ? { matchId } : {}),
      payload,
    });
    const outbox = async (local = firstMachine) => control.runnerOutbox(local.identity);
    const offerFor = async (row, local = firstMachine) => {
      const offer = (await outbox(local)).find(
        (message) => message.type === "offer" && message.matchId === row.id,
      );
      assert.ok(offer, "durable offer is recovered without Redis delivery");
      return offer;
    };
    const accept = async (row, local = firstMachine) => {
      const offer = await offerFor(row, local);
      const message = frame(local, "accept", row.id, { commandId: offer.payload.commandId });
      const reply = await control.handleRunnerControl(local.identity, message);
      assert.deepEqual(reply[0], { type: "ack", payload: { commandId: message.id } });
      assert.equal(reply.length, 2);
      assert.equal(reply[1].type, "resume");
      assert.equal(reply[1].matchId, row.id);
      assert.equal((await status(row)).state, "accepted");
      return { message, offer, resume: reply[1] };
    };
    const waitFor = async (label, inspect, timeout = 2500) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await inspect()) return;
        await delay(10);
      }
      throw new Error(`Runner fixture timed out: ${label}`);
    };
    const stop = async (row, revision = undefined, commandId = randomUUID()) =>
      owner.api.stopRunner({
        slug: row.slug,
        commandId,
        expectedRevision: revision ?? (await status(row)).revision,
      });

    console.log(
      "chess-runner: strict owner creation, lost wake, immutable source and duplicate receipt",
    );
    assert.equal(
      Number((await queues.redisConnection.pubsub("NUMSUB", control.RUNNER_COMMAND_CHANNEL))[1]),
      0,
    );
    const initial = request();
    const row = await create(initial);
    assert.deepEqual(await create(initial), row, "lost create response returns the same receipt");
    const duplicates = await Promise.all([create(initial), create(initial)]);
    assert.deepEqual(duplicates, [row, row], "concurrent create retries retain one identity");
    assert.equal(await prisma.chessMatch.count({ where: { id: row.id } }), 1);
    assert.equal(await prisma.runnerCommand.count({ where: { matchId: row.id } }), 1);
    assert.equal(await prisma.chessOfficialEntry.count({ where: { matchId: row.id } }), 0);
    let stored = await read(row);
    assert.equal(stored.source, "runner");
    assert.equal(stored.credentialSource, "runner-local");
    assert.equal(chess.validateArchive(stored.archive).source, "local");
    assert.equal(stored.runnerMachineId, firstMachine.id);
    await assert.rejects(
      create({ ...initial, config: { ...initial.config, title: "Different settings" } }),
      { code: "CONFLICT" },
    );
    for (const source of ["hosted", "local", "runner", "forged"]) {
      await assert.rejects(owner.api.createRunner({ ...request(), source }), {
        code: "BAD_REQUEST",
      });
    }
    await assert.rejects(stranger.api.createRunner(request()), { code: "NOT_FOUND" });
    await assert.rejects(status(row, stranger), { code: "NOT_FOUND" });
    await assert.rejects(
      stranger.api.stopRunner({ slug: row.slug, commandId: randomUUID(), expectedRevision: 1 }),
      { code: "NOT_FOUND" },
    );
    await assert.rejects(
      client({ ...owner.context, credential: "api-key" }, routers.chessRunnerRouter).runnerStatus({
        slug: row.slug,
      }),
      { code: "UNAUTHORIZED" },
    );
    await assert.rejects(
      prisma.chessMatch.update({ where: { id: row.id }, data: { source: "hosted" } }),
      /chess_match_runner_partition/i,
    );
    const forgedData = {
      ownerId: owner.id,
      slug: `forged-${randomUUID()}`,
      title: "Forged source fixture",
      whiteName: "White",
      blackName: "Black",
      source: "runner",
      runnerState: "offered",
      credentialSource: "operator",
      rulesKey: stored.rulesKey,
      rulesVersion: stored.rulesVersion,
      contextMode: stored.contextMode,
      identityMode: stored.identityMode,
      archive: stored.archive,
    };
    await assert.rejects(
      prisma.chessMatch.create({ data: forgedData }),
      /chess_match_runner_partition/i,
    );
    await assert.rejects(
      prisma.chessMatch.create({
        data: {
          ...forgedData,
          slug: `forged-${randomUUID()}`,
          credentialSource: "runner-local",
          archive: { ...stored.archive, source: "hosted" },
        },
      }),
      /chess_match_runner_partition/i,
    );
    const firstOffer = await offerFor(row);
    assert.deepEqual(
      (await outbox()).find((item) => item.matchId === row.id),
      firstOffer,
    );
    assert.equal((await read(row)).runnerGeneration, firstMachine.identity.connectionGeneration);
    await assert.rejects(
      control.handleRunnerControl(
        secondMachine.identity,
        frame(secondMachine, "accept", row.id, { commandId: firstOffer.payload.commandId }),
      ),
      { code: "NOT_FOUND" },
    );
    await assert.rejects(
      control.handleRunnerControl(
        strangerMachine.identity,
        frame(strangerMachine, "accept", row.id, { commandId: firstOffer.payload.commandId }),
      ),
      { code: "NOT_FOUND" },
    );

    console.log(
      "chess-runner: durable semantic acceptance, exact event IDs and disabled gameplay start",
    );
    const accepted = await accept(row);
    const acceptedState = await status(row);
    assert.equal(acceptedState.revision, 2);
    await control.handleRunnerControl(firstMachine.identity, accepted.message);
    await control.handleRunnerControl(firstMachine.identity, {
      ...accepted.message,
      id: randomUUID(),
    });
    assert.equal((await status(row)).revision, 2);
    assert.equal(await prisma.runnerEvent.count({ where: { matchId: row.id } }), 2);
    await assert.rejects(
      control.handleRunnerControl(firstMachine.identity, {
        ...accepted.message,
        type: "reject",
        payload: { ...accepted.message.payload, reason: "policy" },
      }),
      { code: "CONFLICT" },
    );
    await assert.rejects(
      owner.api.startRunner({
        slug: row.slug,
        commandId: randomUUID(),
        expectedRevision: acceptedState.revision,
      }),
      { code: "PRECONDITION_FAILED", data: { reason: "runner-gameplay-unavailable" } },
    );
    assert.equal((await read(row)).status, "queued");
    assert.equal(
      (await outbox()).some((message) => message.type === "start"),
      false,
    );
    await assert.rejects(
      control.handleRunnerControl(
        firstMachine.identity,
        frame(firstMachine, "snapshot", row.id, {
          acceptedSeq: 1,
          fen: acceptedState.fen,
          ply: acceptedState.ply,
        }),
      ),
      { code: "CONFLICT" },
    );

    console.log("chess-runner: replacement generations, durable resume and stopped cannot rebind");
    const oldIdentity = firstMachine.identity;
    const replacementAuthority = authority.createRunnerAuthority(async (id) => id === owner.id);
    firstMachine.identity = await replacementAuthority.claim(`Bearer ${firstMachine.secret}`);
    assert.ok(firstMachine.identity);
    assert.equal(firstMachine.identity.connectionGeneration, oldIdentity.connectionGeneration + 1);
    await assert.rejects(control.runnerOutbox(oldIdentity), { code: "UNAUTHORIZED" });
    await assert.rejects(control.handleRunnerControl(oldIdentity, accepted.message), {
      code: "UNAUTHORIZED",
    });
    const reoffer = (await outbox()).find(
      (message) => message.type === "offer" && message.matchId === row.id,
    );
    assert.ok(reoffer, "a replacement socket rebinds local policy/journal through a full offer");
    assert.notEqual(reoffer.payload.commandId, firstOffer.payload.commandId);
    assert.deepEqual(reoffer.payload.config, firstOffer.payload.config);
    assert.equal(reoffer.payload.configDigest, firstOffer.payload.configDigest);
    assert.equal(
      (await status(row)).state,
      "accepted",
      "reoffer preserves the authoritative phase",
    );
    assert.equal(
      (await outbox()).some((message) => message.type === "resume" && message.matchId === row.id),
      false,
    );
    assert.deepEqual(
      (await outbox()).find((message) => message.type === "offer" && message.matchId === row.id),
      reoffer,
    );
    const resumed = await control.handleRunnerControl(
      firstMachine.identity,
      frame(firstMachine, "accept", row.id, { commandId: reoffer.payload.commandId }),
    );
    const resume = resumed.find((message) => message.type === "resume");
    assert.ok(resume);
    assert.equal(resume.payload.acceptedSeq, 0);
    assert.equal(resume.payload.fen, acceptedState.fen);
    assert.deepEqual(
      (await outbox()).find((message) => message.type === "resume" && message.matchId === row.id),
      resume,
    );
    assert.equal(
      await prisma.runnerCommand.count({ where: { matchId: row.id, kind: "resume" } }),
      2,
    );
    assert.ok(
      (
        await prisma.runnerCommand.findUniqueOrThrow({
          where: { id: accepted.resume.payload.commandId },
        })
      ).cancelledAt,
    );
    assert.equal((await read(row)).runnerMachineId, firstMachine.id);
    const stopId = randomUUID();
    const stopRevision = (await status(row)).revision;
    const stopped = await stop(row, stopRevision, stopId);
    assert.equal(stopped.state, "stopped");
    assert.deepEqual(await stop(row, stopRevision, stopId), stopped);
    await assert.rejects(stop(row, stopRevision + 1, stopId), { code: "CONFLICT" });
    await assert.rejects(
      control.handleRunnerControl(
        firstMachine.identity,
        frame(firstMachine, "snapshot", row.id, {
          acceptedSeq: 0,
          fen: stopped.fen,
          ply: stopped.ply,
        }),
      ),
      { code: "CONFLICT" },
    );
    assert.deepEqual(
      (await outbox())
        .filter((message) => message.matchId === row.id)
        .map((message) => message.type),
      ["stop"],
    );
    const stopAck = frame(firstMachine, "ack", undefined, { commandId: stopId });
    await control.handleRunnerControl(firstMachine.identity, stopAck);
    await control.handleRunnerControl(firstMachine.identity, stopAck);
    assert.equal(
      (await outbox()).some((message) => message.matchId === row.id),
      false,
    );
    stored = await read(row);
    assert.equal(stored.runnerGeneration, null);
    assert.equal(stored.runnerResumeDeadline, null);
    assert.equal(stored.runToken, null);

    console.log("chess-runner: stop versus acceptance CAS, decline and expired offers/grace");
    const racing = await create(request(secondMachine));
    const racingOffer = await offerFor(racing, secondMachine);
    await assert.rejects(
      control.handleRunnerControl(
        secondMachine.identity,
        frame(
          secondMachine,
          "accept",
          racing.id,
          { commandId: racingOffer.payload.commandId },
          accepted.message.id,
        ),
      ),
      { code: "CONFLICT" },
      "an event ID cannot move from one match to another",
    );
    const raced = await Promise.allSettled([
      control.handleRunnerControl(
        secondMachine.identity,
        frame(secondMachine, "accept", racing.id, { commandId: racingOffer.payload.commandId }),
      ),
      stop(racing, 1),
    ]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    for (const result of raced)
      if (result.status === "rejected") assert.equal(result.reason.code, "CONFLICT");
    if ((await status(racing)).state !== "stopped") await stop(racing);
    const afterRace = await status(racing);
    const lateAccept = () =>
      control.handleRunnerControl(
        secondMachine.identity,
        frame(secondMachine, "accept", racing.id, { commandId: racingOffer.payload.commandId }),
      );
    if (raced[0].status === "fulfilled") {
      // A receipt for an acceptance committed before stop remains idempotent.
      assert.deepEqual(
        (await lateAccept()).map((message) => message.type),
        ["ack"],
      );
    } else {
      await assert.rejects(lateAccept(), { code: "CONFLICT" }, "stop won before acceptance");
    }
    assert.deepEqual(await status(racing), afterRace, "late acceptance cannot revive a stop");
    assert.equal(
      (await outbox(secondMachine)).some(
        (message) => message.matchId === racing.id && message.type !== "stop",
      ),
      false,
      "no non-stop command survives the race",
    );
    // Exercise both serialized orders deterministically as well as the race.
    for (const order of ["stop-first", "accept-first"]) {
      const ordered = await create(request(secondMachine));
      const orderedOffer = await offerFor(ordered, secondMachine);
      const orderedAccept = frame(secondMachine, "accept", ordered.id, {
        commandId: orderedOffer.payload.commandId,
      });
      if (order === "accept-first")
        await control.handleRunnerControl(secondMachine.identity, orderedAccept);
      await stop(ordered);
      const terminalOrdered = await read(ordered);
      const replay = { ...orderedAccept, id: randomUUID() };
      if (order === "stop-first")
        await assert.rejects(control.handleRunnerControl(secondMachine.identity, replay), {
          code: "CONFLICT",
        });
      else
        assert.deepEqual(
          (await control.handleRunnerControl(secondMachine.identity, replay)).map(
            (message) => message.type,
          ),
          ["ack"],
        );
      assert.deepEqual(
        await read(ordered),
        terminalOrdered,
        `${order} late acceptance never changes terminal state`,
      );
      assert.equal(
        (await outbox(secondMachine)).some(
          (message) => message.matchId === ordered.id && message.type !== "stop",
        ),
        false,
      );
    }
    const declined = await create(request(secondMachine));
    const declinedOffer = await offerFor(declined, secondMachine);
    await control.handleRunnerControl(
      secondMachine.identity,
      frame(secondMachine, "reject", declined.id, {
        commandId: declinedOffer.payload.commandId,
        reason: "policy",
      }),
    );
    assert.equal((await status(declined)).state, "rejected");
    assert.equal((await read(declined)).terminalCause, "runner-declined");
    const expired = await create(request(secondMachine));
    await prisma.runnerCommand.updateMany({
      where: { matchId: expired.id, kind: "offer" },
      data: { createdAt: new Date(Date.now() - 600_000), expiresAt: new Date(Date.now() - 1) },
    });
    assert.equal(
      (await outbox(secondMachine)).some((message) => message.matchId === expired.id),
      false,
    );
    assert.equal((await read(expired)).terminalCause, "runner-offer-expired");
    const abandoned = await create(request(secondMachine));
    await accept(abandoned, secondMachine);
    await prisma.chessMatch.update({
      where: { id: abandoned.id },
      data: { runnerResumeDeadline: new Date(Date.now() - 1) },
    });
    assert.equal(
      (await outbox(secondMachine)).some((message) => message.matchId === abandoned.id),
      false,
    );
    stored = await read(abandoned);
    assert.equal(stored.runnerState, "abandoned");
    assert.equal(stored.terminalCause, "runner-abandoned");
    assert.equal(stored.runnerGeneration, null);

    console.log(
      "chess-runner: source-partition admission, worker/reconcile, public/owner spectator reads",
    );
    const excluded = await create(request(secondMachine));
    const hostedQueued = await prisma.chessMatch.count({
      where: { source: "hosted", status: "queued" },
    });
    await prisma.$transaction((tx) =>
      admission.admitHostedMatch(tx, {
        ownerId: owner.id,
        ownKey: false,
        queueMax: hostedQueued + 1,
        dailyMax: 1,
      }),
    );
    const capacity = await owner.chess.capacity();
    assert.equal(capacity.queued, hostedQueued);
    assert.equal(
      capacity.matches.some((match) => match.slug === excluded.slug),
      false,
    );
    const beforeHostedStop = await read(excluded);
    await assert.rejects(
      owner.chess.stop({ slug: excluded.slug }),
      { code: "NOT_FOUND" },
      "hosted stop refuses runner source",
    );
    assert.deepEqual(await read(excluded), beforeHostedStop);
    const inspected = await owner.chess.inspect({ slug: excluded.slug });
    assert.equal(inspected.queuePosition, null);
    assert.equal(inspected.credentialSource, "runner-local");
    const beforeEngine = engine.enginePoolStats().started;
    await worker.handleChessRunJob({ data: { matchId: excluded.id } });
    assert.equal((await read(excluded)).status, "queued");
    assert.equal((await read(excluded)).runToken, null);
    await prisma.chessMatch.update({
      where: { id: excluded.id },
      data: { status: "running", heartbeatAt: new Date(Date.now() - 600_000) },
    });
    await worker.handleChessReconcileJob({ data: { reason: "cron" } });
    assert.equal((await read(excluded)).status, "running");
    await stop(excluded);
    await prisma.chessMatch.update({ where: { id: excluded.id }, data: { published: true } });
    await owner.chess.inspect({ slug: excluded.slug });
    const publicChess = client({}, hosted.chessRouter);
    const publicModeration = client({}, moderation.chessModerationRouter);
    await publicChess.get({ slug: excluded.slug });
    const visibleRunner = await read(excluded);
    assert.equal(visibleRunner.published, true);
    assert.equal(visibleRunner.hiddenAt, null);
    assert.equal(visibleRunner.ownerId, owner.id);
    const runnerAccesses = [
      { purpose: "public", version: visibleRunner.moderationVersion },
      { purpose: "owner", ownerId: owner.id },
    ];
    // Access has the exact current owner/purpose/visibility generation. Server
    // CPU refusal therefore proves the runner source partition, not bad input.
    for (const access of runnerAccesses) {
      await spectator.requestSpectatorBackfill(excluded.id, 0, access);
      assert.deepEqual(await spectator.backfillSpectatorEvaluations(excluded.id, 0, access), {
        evaluated: false,
      });
    }
    await delay(20);
    assert.equal(await queues.chessRunQueue.getJob(`chess-${excluded.id}`), undefined);
    for (const access of runnerAccesses) {
      assert.equal(
        await queues.chessReconcileQueue.getJob(queues.chessSpectatorJobId(excluded.id, 0, access)),
        undefined,
      );
    }
    assert.equal(engine.enginePoolStats().started, beforeEngine);

    console.log("chess-runner: D3 hidden runner replay and export visibility remain authoritative");
    const visibleBeforeHide = await publicModeration.visibility({ slug: excluded.slug });
    const moderationNote = "Runner replay hidden for the disposable privacy acceptance case.";
    await client(owner.context, moderation.chessModerationRouter).setHidden({
      id: excluded.id,
      hidden: true,
      reason: "privacy",
      note: moderationNote,
    });
    await assert.rejects(publicChess.get({ slug: excluded.slug }), { code: "NOT_FOUND" });
    // This is the actual public export guard used by the browser before download.
    await assert.rejects(publicModeration.visibility({ slug: excluded.slug }), {
      code: "NOT_FOUND",
    });
    assert.equal(
      (await publicChess.list({ limit: 100 })).items.some((match) => match.slug === excluded.slug),
      false,
    );
    const hiddenOwnerView = await owner.chess.inspect({ slug: excluded.slug });
    assert.ok(hiddenOwnerView.hiddenAt);
    assert.equal(hiddenOwnerView.moderationNote, moderationNote);
    assert.equal(hiddenOwnerView.archive.source, "local");
    const hiddenRunner = await read(excluded);
    assert.equal(hiddenRunner.source, "runner");
    assert.equal(hiddenRunner.runnerMachineId, visibleRunner.runnerMachineId);
    assert.equal(hiddenRunner.moderationVersion, visibleBeforeHide.version + 1);
    for (const access of [
      { purpose: "public", version: visibleBeforeHide.version },
      { purpose: "public", version: hiddenRunner.moderationVersion },
      { purpose: "owner", ownerId: owner.id },
    ]) {
      await spectator.requestSpectatorBackfill(excluded.id, 0, access);
      assert.deepEqual(await spectator.backfillSpectatorEvaluations(excluded.id, 0, access), {
        evaluated: false,
      });
      assert.equal(
        await queues.chessReconcileQueue.getJob(queues.chessSpectatorJobId(excluded.id, 0, access)),
        undefined,
      );
    }
    assert.equal(engine.enginePoolStats().started, beforeEngine);

    assert.deepEqual(requests, []);
    console.log("chess-runner: real active-match and pending-outbox admission bounds");
    const cappedOwner = await person();
    const cappedMachine = await machine(cappedOwner);
    const cappedMatches = [];
    for (let index = 0; index < 16; index++)
      cappedMatches.push(await create(request(cappedMachine), cappedOwner));
    await assert.rejects(create(request(cappedMachine), cappedOwner), {
      code: "TOO_MANY_REQUESTS",
    });
    const cappedMatch = cappedMatches[0];
    const capOffer = await offerFor(cappedMatch, cappedMachine);
    const beforeBound = await read(cappedMatch);
    // Seed a bounded, schema-valid backlog directly in this owned test DB. A
    // fresh semantic acceptance needs one resume slot; snapshots create none.
    await prisma.runnerCommand.createMany({
      data: Array.from({ length: 32 }, (_, index) => {
        const commandId = randomUUID();
        return {
          id: commandId,
          matchId: cappedMatch.id,
          kind: "resume",
          revision: 100 + index,
          payload: { commandId, acceptedSeq: 0, fen: cappedMatch.fen, ply: 0 },
          expiresAt: new Date(Date.now() + 300_000),
        };
      }),
    });
    const beforeBoundCommands = await prisma.runnerCommand.findMany({
      where: { matchId: cappedMatch.id },
      orderBy: { id: "asc" },
      take: 64,
    });
    await assert.rejects(
      control.handleRunnerControl(
        cappedMachine.identity,
        frame(cappedMachine, "accept", cappedMatch.id, { commandId: capOffer.payload.commandId }),
      ),
      { code: "TOO_MANY_REQUESTS" },
    );
    assert.deepEqual(await read(cappedMatch), beforeBound);
    assert.deepEqual(
      await prisma.runnerCommand.findMany({
        where: { matchId: cappedMatch.id },
        orderBy: { id: "asc" },
        take: 64,
      }),
      beforeBoundCommands,
    );
    assert.equal(await prisma.runnerEvent.count({ where: { matchId: cappedMatch.id } }), 0);

    console.log("chess-runner: session expiry during stop rolls back every durable control write");
    const expiringOwner = await person();
    const expiringMachine = await machine(expiringOwner);
    const expiringMatch = await create(request(expiringMachine), expiringOwner);
    const stopBeforeExpiry = await read(expiringMatch);
    const expiryStopId = randomUUID();
    const { loadPg } = await import("./db/lib/prisma.mjs");
    const pg = loadPg();
    const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
    let stopOutcome;
    try {
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM chess_match WHERE id = $1 FOR UPDATE", [
        expiringMatch.id,
      ]);
      const stopped = expiringOwner.api
        .stopRunner({
          slug: expiringMatch.slug,
          commandId: expiryStopId,
          expectedRevision: expiringMatch.revision,
        })
        .then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        );
      const lockDeadline = Date.now() + 2500;
      let observedWait = false;
      while (Date.now() < lockDeadline) {
        const waiting =
          await prisma.$queryRaw`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%chess_match%' AND query NOT LIKE '%pg_stat_activity%'`;
        if (waiting.length > 0) {
          observedWait = true;
          break;
        }
        await delay(10);
      }
      assert.equal(
        observedWait,
        true,
        "stop reached its real PG row write after initial browser authorization",
      );
      await prisma.session.update({
        where: { id: expiringOwner.context.session.session.id },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      await blocker.query("ROLLBACK");
      stopOutcome = await stopped;
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
    }
    assert.equal(stopOutcome.ok, false, "expired browser authority cannot commit a delayed stop");
    assert.equal(stopOutcome.error.code, "UNAUTHORIZED");
    assert.deepEqual(
      await read(expiringMatch),
      stopBeforeExpiry,
      "transaction rolls back match state and revision",
    );
    assert.equal(await prisma.runnerCommand.findUnique({ where: { id: expiryStopId } }), null);
    assert.equal(
      (
        await prisma.runnerCommand.findFirstOrThrow({
          where: { matchId: expiringMatch.id, kind: "offer" },
        })
      ).cancelledAt,
      null,
    );

    console.log("chess-runner: stale accept after owner stop keeps the real transport usable");
    const transportOwner = await person();
    const transportMachine = await machine(transportOwner);
    const transportMatch = await create(request(transportMachine), transportOwner);
    let releaseAccept;
    let acceptReached = false;
    const acceptBarrier = new Promise((resolve) => {
      releaseAccept = resolve;
    });
    releaseBarriers.push(releaseAccept);
    const realTransport = transportModule.createRunnerTransport({
      authority: transportMachine.resolver,
      leases: leaseModule.createRunnerLeaseStore(queues.redisConnection),
      isAvailable: () => queues.redisConnection.status === "ready",
      controls: {
        outbox: (identity, ...args) => control.runnerOutbox(identity, ...args),
        handle: async (identity, message) => {
          if (message.type === "accept" && message.matchId === transportMatch.id) {
            acceptReached = true;
            await acceptBarrier;
          }
          return control.handleRunnerControl(identity, message);
        },
      },
    });
    ownedTransports.push(realTransport);
    const sent = [];
    const closed = [];
    const reservation = await realTransport.reserve(
      `Bearer ${transportMachine.secret}`,
      `runner-fixture-${randomUUID()}`,
    );
    assert.ok(reservation);
    const active = await reservation.attach({
      bufferedAmount: 0,
      send: (text) => sent.push(JSON.parse(text)),
      ping() {},
      close: (code) => closed.push(code),
      terminate() {},
    });
    assert.ok(active);
    ownedConnections.push(active);
    transportMachine.identity = active.identity;
    try {
      active.receive(
        JSON.stringify({
          version: 1,
          generation: active.identity.connectionGeneration,
          id: randomUUID(),
          seq: 1,
          ack: sent.at(-1).seq,
          type: "hello",
          payload: {
            models: [{ id: "fixture/local-model", protocol: "openai-chat" }],
            engine: false,
            operatingLimits: {
              matchMicros: 1_000_000,
              dayMicros: 10_000_000,
              concurrency: 2,
              revision: 0,
            },
            hardLimits: { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
          },
        }),
      );
      await active.idle();
      const wireOffer = sent.find(
        (message) => message.type === "offer" && message.matchId === transportMatch.id,
      );
      assert.ok(wireOffer, "production transport delivers the actual durable offer");
      active.receive(
        JSON.stringify({
          ...frame(transportMachine, "accept", transportMatch.id, {
            commandId: wireOffer.payload.commandId,
          }),
          seq: 2,
          ack: sent.at(-1).seq,
        }),
      );
      await waitFor("already-sent accept reached the pre-transaction barrier", () => acceptReached);
      const wireStopId = randomUUID();
      await transportOwner.api.stopRunner({
        slug: transportMatch.slug,
        commandId: wireStopId,
        expectedRevision: 1,
      });
      releaseAccept();
      await active.idle();
      assert.equal((await read(transportMatch)).runnerState, "stopped");
      assert.ok(
        sent.some((message) => message.type === "error" && message.payload.code === "STALE"),
        "ordinary stop/accept race gets a typed STALE reply",
      );
      assert.ok(
        sent.some((message) => message.type === "stop" && message.payload.commandId === wireStopId),
      );
      assert.deepEqual(closed, [], "a still-authorized machine does not get a terminal 4401 close");
      const nextMatch = await create(request(transportMachine), transportOwner);
      await active.deliver();
      const nextOffer = sent.find(
        (message) => message.type === "offer" && message.matchId === nextMatch.id,
      );
      assert.ok(nextOffer);
      active.receive(
        JSON.stringify({
          ...frame(transportMachine, "accept", nextMatch.id, {
            commandId: nextOffer.payload.commandId,
          }),
          seq: 3,
          ack: sent.at(-1).seq,
        }),
      );
      await active.idle();
      assert.equal((await status(nextMatch, transportOwner)).state, "accepted");
      assert.deepEqual(closed, [], "same authorized connection handles another owned match");
    } finally {
      releaseAccept();
      active.finished();
      await realTransport.drain();
    }

    console.log(
      "chess-runner: actual CLI offer/resume/snapshot settles and reconnects without a command loop",
    );
    const gameOwner = await person();
    const gameMachine = await machine(gameOwner);
    // Four stops precede every consumed offer and fill the real delivery window.
    // The actual CLI must durably fence/ACK all four before this fifth offer runs.
    const stoppedBeforeOffer = [];
    for (let index = 0; index < 4; index++) {
      const early = await create(request(gameMachine), gameOwner);
      const commandId = randomUUID();
      await gameOwner.api.stopRunner({ slug: early.slug, commandId, expectedRevision: 1 });
      stoppedBeforeOffer.push({ ...early, commandId });
    }
    const gameMatch = await create(request(gameMachine), gameOwner);
    const gameRecords = new Map();
    const gameWire = [];
    const gameActive = [];
    let spendRequests = 0;
    const localPolicy = await policyModule.RunnerPolicy.open(
      { baseUrl: "http://127.0.0.1:8765/v1", allowModels: ["fixture/local-model"] },
      {
        env: {},
        spend: {
          reserve: async () => {
            ++spendRequests;
            throw new Error("handshake never authorizes spend");
          },
          settle: async () => {
            ++spendRequests;
            throw new Error("handshake never incurs spend");
          },
          close: async () => {},
        },
      },
    );
    const gameTransport = transportModule.createRunnerTransport({
      authority: gameMachine.resolver,
      leases: leaseModule.createRunnerLeaseStore(queues.redisConnection),
      isAvailable: () => queues.redisConnection.status === "ready",
      controls: {
        outbox: (identity, ...args) => control.runnerOutbox(identity, ...args),
        handle: (identity, message) => control.handleRunnerControl(identity, message),
      },
    });
    ownedTransports.push(gameTransport);
    let cliConnection;
    const gameLoop = new gameModule.RunnerGameLoop({
      policy: localPolicy,
      engine: false,
      journal: {
        load: async (id) => {
          const saved = gameRecords.get(id);
          return saved ? structuredClone(saved) : undefined;
        },
        save: async (id, record) => {
          gameRecords.set(id, structuredClone(record));
        },
        close: async () => {},
      },
      send: (action, signal) => cliConnection.send(action, signal),
      advance: async () => {
        throw new Error("handshake never authorizes game execution");
      },
      evaluate: async () => {
        throw new Error("handshake never authorizes an engine");
      },
    });
    ownedGameLoops.push(gameLoop);
    const socketFactory = (_url, options) => {
      let observer;
      let attached;
      let detached = false;
      const earlyFrames = [];
      return {
        bufferedAmount: 0,
        send: (text) => {
          if (detached) throw new Error("fixture socket detached");
          if (attached) attached.receive(text);
          else earlyFrames.push(text);
        },
        close: () => {
          detached = true;
          attached?.finished();
        },
        subscribe: (events) => {
          observer = events;
          void Promise.resolve().then(async () => {
            let reserved;
            try {
              reserved = await gameTransport.reserve(
                options.headers.Authorization,
                `runner-game-${randomUUID()}`,
              );
              if (!reserved) throw new Error("fixture runner reservation refused");
              if (detached) {
                await reserved.release();
                return;
              }
              observer.open();
              const current = await reserved.attach({
                bufferedAmount: 0,
                send: (text) => {
                  gameWire.push(JSON.parse(text));
                  if (!detached) observer.message(text, false);
                },
                ping() {},
                close: (code) => {
                  if (!detached) observer.close(code);
                },
                terminate() {},
              });
              if (!current) throw new Error("fixture runner attachment refused");
              ownedConnections.push(current);
              if (detached) {
                current.finished();
                return;
              }
              attached = current;
              gameActive.push(current);
              gameMachine.identity = current.identity;
              for (const text of earlyFrames) current.receive(text);
              earlyFrames.length = 0;
            } catch {
              await reserved?.release();
              if (!detached) observer.error();
            }
          });
          return () => {
            detached = true;
            attached?.finished();
          };
        },
      };
    };
    cliConnection = new connectionModule.RunnerConnection({
      url: "ws://127.0.0.1/api/cli/runner/ws",
      allowLocalhostWs: true,
      credential: gameMachine.secret,
      socketFactory,
      hello: gameLoop.hello,
      random: () => 0,
      sleep: async () => {},
      onMessage: (message, signal) => gameLoop.handle(message, signal),
    });
    ownedCliConnections.push(cliConnection);
    try {
      cliConnection.start();
      await waitFor(
        "initial actual CLI resume ACK and snapshot settle",
        async () => {
          const resumes = await prisma.runnerCommand.findMany({
            where: { matchId: gameMatch.id, kind: "resume" },
            take: 4,
          });
          return (
            resumes.length === 1 &&
            resumes[0].ackedAt !== null &&
            (await prisma.runnerEvent.count({ where: { matchId: gameMatch.id } })) >= 4
          );
        },
        8000,
      );
      assert.equal(cliConnection.getState(), "connected");
      for (const early of stoppedBeforeOffer) {
        assert.ok(
          (await prisma.runnerCommand.findUniqueOrThrow({ where: { id: early.commandId } }))
            .ackedAt,
        );
        assert.equal((await read(early)).runnerState, "stopped");
        assert.deepEqual(
          gameRecords.get(early.id),
          { phase: "cancelled" },
          "unknown stop is journaled before its ACK",
        );
      }
      assert.equal((await read(gameMatch)).runnerState, "accepted");
      assert.equal(gameRecords.get(gameMatch.id)?.phase, "ready");
      assert.equal(await prisma.runnerCommand.count({ where: { matchId: gameMatch.id } }), 2);
      assert.equal(gameWire.filter((message) => message.type === "resume").length, 1);
      const beforeReconnect = await read(gameMatch);
      gameActive.at(-1).close(1012, "RESTART");
      await waitFor(
        "replacement actual CLI offer acceptance, resume ACK and snapshot settle",
        async () => {
          const resumes = await prisma.runnerCommand.findMany({
            where: { matchId: gameMatch.id, kind: "resume" },
            take: 4,
          });
          return (
            resumes.length === 2 &&
            resumes.every((command) => command.ackedAt !== null) &&
            (await prisma.runnerEvent.count({ where: { matchId: gameMatch.id } })) >= 8
          );
        },
        8000,
      );
      await gameTransport.idle();
      await delay(30);
      assert.equal(cliConnection.getState(), "connected");
      const afterReconnect = await read(gameMatch);
      assert.equal(afterReconnect.runnerMachineId, beforeReconnect.runnerMachineId);
      assert.equal(afterReconnect.runnerGeneration, beforeReconnect.runnerGeneration + 1);
      assert.equal(afterReconnect.runnerAcceptedSeq, beforeReconnect.runnerAcceptedSeq);
      assert.deepEqual(
        chess.boardAt(chess.validateArchive(afterReconnect.archive)).fen(),
        chess.boardAt(chess.validateArchive(beforeReconnect.archive)).fen(),
      );
      assert.equal(
        await prisma.runnerCommand.count({ where: { matchId: gameMatch.id, kind: "offer" } }),
        2,
      );
      assert.equal(
        await prisma.runnerCommand.count({ where: { matchId: gameMatch.id, kind: "resume" } }),
        2,
      );
      assert.equal(gameWire.filter((message) => message.type === "resume").length, 2);
      assert.equal(
        gameWire.some((message) => message.type === "error"),
        false,
      );
      console.log("chess-runner: exact terminal stop ACK settles at the full event receipt bound");
      const matchingSnapshot = frame(gameMachine, "snapshot", gameMatch.id, {
        acceptedSeq: afterReconnect.runnerAcceptedSeq,
        fen: gameMatch.fen,
        ply: 0,
      });
      await control.handleRunnerControl(gameMachine.identity, matchingSnapshot);
      const receiptCount = await prisma.runnerEvent.count({ where: { matchId: gameMatch.id } });
      assert.ok(receiptCount < control.RUNNER_EVENT_LIMIT);
      const snapshotDigest = createHash("sha256")
        .update(
          JSON.stringify({
            type: "snapshot",
            matchId: gameMatch.id,
            payload: matchingSnapshot.payload,
          }),
        )
        .digest("hex");
      // Owned test DB: bulk-seed the exact bounded receipt shape from the valid
      // matching snapshot above, avoiding 4096 duplicate transaction round trips.
      await prisma.runnerEvent.createMany({
        data: Array.from({ length: control.RUNNER_EVENT_LIMIT - receiptCount }, () => ({
          id: randomUUID(),
          matchId: gameMatch.id,
          payloadDigest: snapshotDigest,
        })),
      });
      const eventCapStopId = randomUUID();
      await gameOwner.api.stopRunner({
        slug: gameMatch.slug,
        commandId: eventCapStopId,
        expectedRevision: (await status(gameMatch, gameOwner)).revision,
      });
      await gameActive.at(-1).deliver();
      await waitFor(
        "actual CLI terminal stop ACK settles despite 4096 general receipts",
        async () =>
          (await prisma.runnerCommand.findUniqueOrThrow({ where: { id: eventCapStopId } }))
            .ackedAt !== null,
        8000,
      );
      await gameTransport.idle();
      const terminalAtCap = await read(gameMatch);
      assert.equal(terminalAtCap.runnerState, "stopped");
      assert.equal(terminalAtCap.runnerGeneration, null);
      assert.equal(cliConnection.getState(), "connected");
      assert.equal(
        await prisma.runnerEvent.count({ where: { matchId: gameMatch.id } }),
        control.RUNNER_EVENT_LIMIT + 1,
      );
      assert.equal(
        (await control.runnerOutbox(gameMachine.identity, [eventCapStopId])).some(
          (message) => message.matchId === gameMatch.id,
        ),
        false,
        "settled stop no longer consumes a delivery slot",
      );
      for (let retry = 0; retry < 2; retry++) {
        const retryAck = frame(gameMachine, "ack", undefined, { commandId: eventCapStopId });
        assert.deepEqual(await control.handleRunnerControl(gameMachine.identity, retryAck), [
          { type: "ack", payload: { commandId: retryAck.id } },
        ]);
      }
      assert.equal(
        await prisma.runnerEvent.count({ where: { matchId: gameMatch.id } }),
        control.RUNNER_EVENT_LIMIT + 1,
      );
      assert.deepEqual(
        await read(gameMatch),
        terminalAtCap,
        "stop ACKs do not resurrect board or revision",
      );
      await assert.rejects(
        control.handleRunnerControl(
          strangerMachine.identity,
          frame(strangerMachine, "ack", undefined, { commandId: eventCapStopId }),
        ),
        { code: "NOT_FOUND" },
      );
      await prisma.runnerCommand.update({
        where: { id: eventCapStopId },
        data: { cancelledAt: new Date() },
      });
      await assert.rejects(
        control.handleRunnerControl(
          gameMachine.identity,
          frame(gameMachine, "ack", undefined, { commandId: eventCapStopId }),
        ),
        { code: "CONFLICT" },
      );
      await prisma.runnerCommand.update({
        where: { id: eventCapStopId },
        data: { cancelledAt: null },
      });
      assert.equal(
        await prisma.runnerEvent.count({ where: { matchId: gameMatch.id } }),
        control.RUNNER_EVENT_LIMIT + 1,
      );
      const afterCapMatch = await create(request(gameMachine), gameOwner);
      await gameActive.at(-1).deliver();
      await waitFor(
        "settled event-cap stop frees credit for another real CLI match",
        async () => {
          const resume = await prisma.runnerCommand.findFirst({
            where: { matchId: afterCapMatch.id, kind: "resume" },
            select: { ackedAt: true },
          });
          return resume?.ackedAt != null;
        },
        8000,
      );
      assert.equal((await status(afterCapMatch, gameOwner)).state, "accepted");
      assert.equal(cliConnection.getState(), "connected");
      assert.equal(spendRequests, 0);
    } finally {
      cliConnection.stop();
      await gameLoop.close();
      await gameTransport.drain();
    }

    console.log("chess-runner: machine expiry during accept/snapshot rolls back delayed writes");
    for (const kind of ["accept", "snapshot"]) {
      for (const expire of [true, false]) {
        const machineOwner = await person();
        const delayedMachine = await machine(machineOwner);
        const delayedMatch = await create(request(delayedMachine), machineOwner);
        const delayedOffer = await offerFor(delayedMatch, delayedMachine);
        if (kind === "snapshot") {
          await control.handleRunnerControl(
            delayedMachine.identity,
            frame(delayedMachine, "accept", delayedMatch.id, {
              commandId: delayedOffer.payload.commandId,
            }),
          );
        }
        const beforeDelayed = await read(delayedMatch);
        const beforeCommands = await prisma.runnerCommand.findMany({
          where: { matchId: delayedMatch.id },
          orderBy: { id: "asc" },
          take: 64,
        });
        const beforeEvents = await prisma.runnerEvent.findMany({
          where: { matchId: delayedMatch.id },
          orderBy: { id: "asc" },
          take: 64,
        });
        const delayedMessage = frame(
          delayedMachine,
          kind,
          delayedMatch.id,
          kind === "accept"
            ? { commandId: delayedOffer.payload.commandId }
            : { acceptedSeq: 0, fen: delayedMatch.fen, ply: 0 },
        );
        const machineBlocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
        let delayedOutcome;
        let delayedAction;
        try {
          await machineBlocker.connect();
          await machineBlocker.query("BEGIN");
          await machineBlocker.query("SELECT id FROM chess_match WHERE id = $1 FOR UPDATE", [
            delayedMatch.id,
          ]);
          delayedAction = control.handleRunnerControl(delayedMachine.identity, delayedMessage).then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          );
          await waitFor(
            "machine action reached real row write after initial authority",
            async () => {
              const waiting =
                await prisma.$queryRaw`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%chess_match%' AND query NOT LIKE '%pg_stat_activity%'`;
              return waiting.length > 0;
            },
          );
          if (expire) {
            await prisma.runnerMachine.update({
              where: { id: delayedMachine.id },
              data: { expiresAt: new Date(Date.now() - 1) },
            });
          } else {
            // The inverse retains equally real contention and a finite, live credential.
            await delay(30);
          }
          await machineBlocker.query("ROLLBACK");
          delayedOutcome = await delayedAction;
        } finally {
          await machineBlocker.query("ROLLBACK").catch(() => {});
          await machineBlocker.end();
          await delayedAction;
        }
        if (expire) {
          assert.equal(delayedOutcome.ok, false, `expired machine cannot commit delayed ${kind}`);
          assert.equal(delayedOutcome.error.code, "UNAUTHORIZED");
          assert.deepEqual(await read(delayedMatch), beforeDelayed);
          assert.deepEqual(
            await prisma.runnerCommand.findMany({
              where: { matchId: delayedMatch.id },
              orderBy: { id: "asc" },
              take: 64,
            }),
            beforeCommands,
          );
          assert.deepEqual(
            await prisma.runnerEvent.findMany({
              where: { matchId: delayedMatch.id },
              orderBy: { id: "asc" },
              take: 64,
            }),
            beforeEvents,
          );
        } else {
          assert.equal(
            delayedOutcome.ok,
            true,
            `unexpired machine can commit equally delayed ${kind}`,
          );
          assert.equal(
            (await read(delayedMatch)).runnerRevision,
            beforeDelayed.runnerRevision + (kind === "accept" ? 1 : 0),
          );
          assert.equal(await prisma.runnerEvent.count({ where: { id: delayedMessage.id } }), 1);
          if (kind === "accept") assert.equal((await read(delayedMatch)).runnerState, "accepted");
          assert.equal(
            await prisma.runnerCommand.count({
              where: { matchId: delayedMatch.id, kind: "resume" },
            }),
            1,
            "snapshot does not create another resume",
          );
        }
      }
    }

    console.log("chess-runner: absolute deadline removes queued browser/machine lock-slot work");
    const queuedOwner = await person();
    const queuedMachine = await machine(queuedOwner);
    const queuedMatch = await create(request(queuedMachine), queuedOwner);
    const queuedBefore = await read(queuedMatch);
    const queuedRequest = request(queuedMachine);
    const queuedReceipt = createHash("sha256")
      .update(JSON.stringify(["runner", queuedOwner.id, queuedRequest.creationKey]))
      .digest("hex");
    let releaseSlots;
    let occupied = 0;
    const slotsBarrier = new Promise((resolve) => {
      releaseSlots = resolve;
    });
    releaseBarriers.push(releaseSlots);
    const holders = Array.from({ length: 4 }, () =>
      slots.withLockSlot(async () => {
        ++occupied;
        await slotsBarrier;
      }),
    );
    let queuedBrowser;
    let queuedMachinePoll;
    try {
      await waitFor("all four actual shared lock slots occupied", () => occupied === 4);
      assert.equal(slots.tryAcquireSlots(), false);
      queuedBrowser = create(queuedRequest, queuedOwner).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      queuedMachinePoll = control.runnerOutbox(queuedMachine.identity).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      const results = await Promise.race([
        Promise.all([queuedBrowser, queuedMachinePoll]),
        delay(6500).then(() => {
          throw new Error(
            "runner controls did not leave the actual lock-slot FIFO by their deadline",
          );
        }),
      ]);
      for (const outcome of results) {
        assert.equal(outcome.ok, false);
        assert.equal(outcome.error.code, "SERVICE_UNAVAILABLE");
      }
      assert.equal(await prisma.chessCreation.findUnique({ where: { id: queuedReceipt } }), null);
      assert.deepEqual(await read(queuedMatch), queuedBefore);
    } finally {
      releaseSlots();
      await Promise.all(holders);
      await Promise.all([queuedBrowser, queuedMachinePoll]);
    }
    assert.equal(
      slots.tryAcquireSlots(4),
      true,
      "expired requests were removed instead of retained for late checkout",
    );
    slots.releaseSlots(4);
    assert.equal(await prisma.chessCreation.findUnique({ where: { id: queuedReceipt } }), null);
    assert.deepEqual(
      await read(queuedMatch),
      queuedBefore,
      "no late outbox generation/contact write after slots are released",
    );

    console.log("chess-runner: surviving browser/machine authority is fenced by pending deletion");
    const pendingOwner = await person();
    const pendingMachine = await machine(pendingOwner);
    const pendingMatch = await create(request(pendingMachine), pendingOwner);
    const pendingOffer = await offerFor(pendingMatch, pendingMachine);
    await prisma.user.update({
      where: { id: pendingOwner.id },
      data: { deletionState: "pending", deletionRequestedAt: new Date(), deletionAttempts: 0 },
    });
    assert.ok(
      await prisma.session.findUnique({ where: { id: pendingOwner.context.session.session.id } }),
    );
    assert.equal(
      (await prisma.runnerMachine.findUniqueOrThrow({ where: { id: pendingMachine.id } }))
        .revokedAt,
      null,
    );
    await assert.rejects(control.runnerOutbox(pendingMachine.identity), { code: "UNAUTHORIZED" });
    await assert.rejects(
      control.handleRunnerControl(
        pendingMachine.identity,
        frame(pendingMachine, "accept", pendingMatch.id, {
          commandId: pendingOffer.payload.commandId,
        }),
      ),
      { code: "UNAUTHORIZED" },
    );
    // Deliberately retain the caller's pre-marker session snapshot: the helper
    // must recheck durable eligibility even when the procedure gate saw it live.
    await assert.rejects(status(pendingMatch, pendingOwner), { code: "FORBIDDEN" });
    assert.equal((await read(pendingMatch)).runnerState, "offered");
    assert.equal(await prisma.runnerEvent.count({ where: { matchId: pendingMatch.id } }), 0);
    assert.equal(
      engine.enginePoolStats().started,
      beforeEngine,
      "all runner controls avoid server engines",
    );
    assert.deepEqual(requests, [], "all runner controls avoid provider/network dispatch");
    console.log("chess-runner: E4a disposable PostgreSQL/Valkey controls and source fences passed");
  } finally {
    try {
      for (const release of releaseBarriers) release();
      for (const connection of ownedCliConnections) connection.stop();
      await Promise.all(ownedGameLoops.map((loop) => loop.close()));
      for (const active of ownedConnections) active.finished();
      await Promise.all(ownedTransports.map((transport) => transport.drain()));
      if (queues)
        for (const id of matchIds) {
          await (await queues.chessRunQueue.getJob(`chess-${id}`))?.remove();
          const row = await prisma.chessMatch.findUnique({
            where: { id },
            select: { ownerId: true, moderationVersion: true },
          });
          const accesses = [
            ...Array.from({ length: (row?.moderationVersion ?? 0) + 1 }, (_, version) => ({
              purpose: "public",
              version,
            })),
            ...(row?.ownerId ? [{ purpose: "owner", ownerId: row.ownerId }] : []),
          ];
          for (const access of accesses) {
            await (
              await queues.chessReconcileQueue.getJob(queues.chessSpectatorJobId(id, 0, access))
            )?.remove();
          }
        }
      if (prisma && ownerIds.length)
        await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
      if (prisma && creationIds.size)
        await prisma.chessCreation.deleteMany({ where: { id: { in: [...creationIds] } } });
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
