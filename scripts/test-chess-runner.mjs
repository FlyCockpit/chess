/**
 * E4b runner gameplay, recovery and source acceptance on disposable PG/Valkey.
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
  const machineIds = new Set();
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
      runnerLimits,
      authority,
      transportModule,
      leaseModule,
      slots,
      gameModule,
      policyModule,
      connectionModule,
      accountDeletion,
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
      import("../packages/auth/src/runner-limits.ts"),
      import("../apps/server/src/runner-ws-authority.ts"),
      import("../apps/server/src/runner-ws.ts"),
      import("../apps/server/src/runner-ws-store.ts"),
      import("../packages/auth/src/lock-slots.ts"),
      import("../apps/cli/src/runner-game.ts"),
      import("../apps/cli/src/runner-policy.ts"),
      import("../apps/cli/src/runner-connection.ts"),
      import("../packages/api/src/lib/account-deletion.ts"),
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
    const advertisedLimits = {
      operatingLimits: {
        matchMicros: 1_000_000,
        dayMicros: 10_000_000,
        concurrency: 2,
        revision: 0,
      },
      hardLimits: { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
    };
    const advertise = (identity) =>
      runnerLimits.runnerLimitsService.hello(identity, advertisedLimits);
    const machine = async (person = owner, limits = advertisedLimits) => {
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
      machineIds.add(row.id);
      const resolver = authority.createRunnerAuthority(async (id) => id === person.id);
      const identity = await resolver.claim(`Bearer ${secret}`);
      assert.ok(identity);
      await runnerLimits.runnerLimitsService.hello(identity, limits);
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
    const resumeFor = async (row, local = firstMachine) => {
      const resume = (await outbox(local)).find(
        (message) => message.type === "resume" && message.matchId === row.id,
      );
      assert.ok(resume, "the durable outbox supplies authoritative reconciliation");
      return resume;
    };
    const ackResume = async (row, local = firstMachine) => {
      const resume = await resumeFor(row, local);
      const message = frame(local, "ack", undefined, { commandId: resume.payload.commandId });
      assert.deepEqual(await control.handleRunnerControl(local.identity, message), [
        { type: "ack", payload: { commandId: message.id } },
      ]);
      return resume;
    };
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
      assert.equal(
        reply.length,
        1,
        "handlers acknowledge input; durable delivery uses only the outbox",
      );
      const resume = await resumeFor(row, local);
      assert.equal((await status(row)).state, "accepted");
      return { message, offer, resume };
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
      "chess-runner: durable semantic acceptance, exact event IDs and explicit gameplay start",
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
    const startable = await create(request(secondMachine));
    await accept(startable, secondMachine);
    const startableStatus = await status(startable);
    const started = await owner.api.startRunner({
      slug: startable.slug,
      commandId: randomUUID(),
      expectedRevision: startableStatus.revision,
    });
    assert.equal(started.status, "running");
    await ackResume(startable, secondMachine);
    assert.equal(
      (await outbox(secondMachine)).some(
        (message) => message.matchId === startable.id && message.type === "start",
      ),
      true,
      "only an explicit owner start produces an executable command",
    );
    await stop(startable);
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
    await advertise(firstMachine.identity);
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
    assert.deepEqual(
      resumed.map((message) => message.type),
      ["ack"],
    );
    const resume = await resumeFor(row);
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
      "chess-runner: authoritative legal moves, sequence, duplicate receipts and evaluations",
    );
    const gameplayOwner = await person();
    const gameplayMachine = await machine(gameplayOwner);
    const randomPlayer = { name: "Local baseline", model: "random", protocol: "random" };
    const gameplayConfig = (overrides = {}) => ({
      ...config(),
      white: randomPlayer,
      black: randomPlayer,
      ...overrides,
    });
    const readyGame = async (
      settings = gameplayConfig(),
      local = gameplayMachine,
      person = gameplayOwner,
    ) => {
      const match = await create({ ...request(local), config: settings }, person);
      const offer = await offerFor(match, local);
      await control.handleRunnerControl(
        local.identity,
        frame(local, "accept", match.id, { commandId: offer.payload.commandId }),
      );
      const state = await status(match, person);
      const commandId = randomUUID();
      const start = { slug: match.slug, commandId, expectedRevision: state.revision };
      const value = await person.api.startRunner(start);
      assert.deepEqual(await person.api.startRunner(start), value, "lost start ACK is idempotent");
      await ackResume(match, local);
      assert.equal((await read(match)).status, "running");
      return match;
    };
    const moveFrame = async (match, uci, local = gameplayMachine) => {
      const current = await status(match, gameplayOwner);
      const board = new chess.Chess(current.fen);
      chess.applyUci(board, uci);
      return frame(local, "move", match.id, {
        uci,
        ply: current.acceptedSeq + 1,
        fen: board.fen(),
      });
    };
    const legal = await readyGame();
    const legalBefore = await read(legal);
    for (const claim of [
      { result: "1-0", termination: "checkmate" },
      { result: "0-1", termination: "illegal-forfeit" },
      { result: "1-0", termination: "resignation" },
    ]) {
      const bogus = frame(gameplayMachine, "event", legal.id, {
        kind: "completed",
        ...claim,
        ply: 0,
        fen: legal.fen,
        rejectedAttempts: [],
      });
      await assert.rejects(control.handleRunnerControl(gameplayMachine.identity, bogus));
      assert.deepEqual(
        await read(legal),
        legalBefore,
        "unsupported result claims cannot end a live board",
      );
      assert.equal(await prisma.runnerEvent.count({ where: { id: bogus.id } }), 0);
    }
    const legalWhite = await moveFrame(legal, "e2e4");
    const illegalFrames = [
      { ...legalWhite, id: randomUUID(), payload: { ...legalWhite.payload, ply: 2 } },
      { ...legalWhite, id: randomUUID(), payload: { ...legalWhite.payload, uci: "e7e5" } },
      { ...legalWhite, id: randomUUID(), payload: { ...legalWhite.payload, uci: "e2e5" } },
      { ...legalWhite, id: randomUUID(), payload: { ...legalWhite.payload, fen: legal.fen } },
    ];
    for (const input of illegalFrames) {
      await assert.rejects(control.handleRunnerControl(gameplayMachine.identity, input));
      assert.deepEqual(
        await read(legal),
        legalBefore,
        "invalid input cannot change archive or clocks",
      );
      assert.equal(await prisma.runnerEvent.count({ where: { id: input.id } }), 0);
    }
    await Promise.all([
      control.handleRunnerControl(gameplayMachine.identity, legalWhite),
      control.handleRunnerControl(gameplayMachine.identity, legalWhite),
    ]);
    const afterWhite = await read(legal);
    assert.equal(afterWhite.runnerAcceptedSeq, 1);
    assert.equal(chess.matchStats(chess.validateArchive(afterWhite.archive)).moves, 1);
    assert.equal(await prisma.runnerEvent.count({ where: { id: legalWhite.id } }), 1);
    await control.handleRunnerControl(gameplayMachine.identity, {
      ...legalWhite,
      id: randomUUID(),
    });
    assert.deepEqual(
      await read(legal),
      afterWhite,
      "a semantic retry with a new wire ID cannot apply an accepted move twice",
    );
    const black = await moveFrame(legal, "e7e5");
    await control.handleRunnerControl(gameplayMachine.identity, black);
    const evalState = await status(legal, gameplayOwner);
    const evaluation = frame(gameplayMachine, "evaluation", legal.id, {
      ply: 2,
      fen: evalState.fen,
      score: { cp: 21 },
      nodes: config().rules.engineNodes,
      purpose: "spectator",
    });
    const beforeBogusEval = await read(legal);
    await assert.rejects(
      control.handleRunnerControl(gameplayMachine.identity, {
        ...evaluation,
        id: randomUUID(),
        payload: { ...evaluation.payload, fen: legal.fen },
      }),
    );
    assert.deepEqual(await read(legal), beforeBogusEval);
    await assert.rejects(
      control.handleRunnerControl(gameplayMachine.identity, {
        ...evaluation,
        id: randomUUID(),
        payload: { ...evaluation.payload, ply: 3 },
      }),
    );
    await control.handleRunnerControl(gameplayMachine.identity, evaluation);
    await control.handleRunnerControl(gameplayMachine.identity, evaluation);
    assert.equal(await prisma.runnerEvent.count({ where: { id: evaluation.id } }), 1);
    assert.equal((await read(legal)).runnerAcceptedSeq, 2, "scores cannot advance accepted moves");

    console.log(
      "chess-runner: replacement replica resumes the accepted board without replaying inference",
    );
    const priorGameplayIdentity = gameplayMachine.identity;
    const anotherReplica = authority.createRunnerAuthority(async (id) => id === gameplayOwner.id);
    gameplayMachine.identity = await anotherReplica.claim(`Bearer ${gameplayMachine.secret}`);
    assert.ok(gameplayMachine.identity);
    await advertise(gameplayMachine.identity);
    assert.equal(
      gameplayMachine.identity.connectionGeneration,
      priorGameplayIdentity.connectionGeneration + 1,
    );
    await assert.rejects(control.handleRunnerControl(priorGameplayIdentity, black), {
      code: "UNAUTHORIZED",
    });
    await assert.rejects(
      control.handleRunnerControl(gameplayMachine.identity, {
        ...evaluation,
        generation: gameplayMachine.identity.connectionGeneration,
        id: randomUUID(),
      }),
      "new machine generation cannot write an active old-generation match before rebinding",
    );
    const resumedOffer = await offerFor(legal, gameplayMachine);
    const resumedReplies = await control.handleRunnerControl(
      gameplayMachine.identity,
      frame(gameplayMachine, "accept", legal.id, { commandId: resumedOffer.payload.commandId }),
    );
    assert.deepEqual(
      resumedReplies.map((message) => message.type),
      ["ack"],
    );
    const legalResume = await resumeFor(legal, gameplayMachine);
    assert.deepEqual(
      {
        acceptedSeq: legalResume.payload.acceptedSeq,
        fen: legalResume.payload.fen,
        ply: legalResume.payload.ply,
      },
      { acceptedSeq: 2, fen: evalState.fen, ply: 2 },
    );
    const afterResume = await read(legal);
    await assert.rejects(
      control.handleRunnerControl(
        gameplayMachine.identity,
        frame(gameplayMachine, "snapshot", legal.id, {
          acceptedSeq: 1,
          fen: legal.fen,
          ply: 1,
        }),
      ),
    );
    assert.deepEqual(
      await read(legal),
      afterResume,
      "client snapshots cannot overwrite accepted state",
    );

    console.log("chess-runner: human turn is browser-owned, legal and forwarded exactly once");
    const human = await readyGame(gameplayConfig({ white: config().white, black: config().black }));
    const humanState = await status(human, gameplayOwner);
    const humanMoveId = randomUUID();
    const humanInput = {
      slug: human.slug,
      commandId: humanMoveId,
      expectedRevision: humanState.revision,
      expectedSeq: 0,
      fen: humanState.fen,
      move: "e2e4",
    };
    const humanBefore = await read(human);
    const unsolicited = await moveFrame(human, "e2e4");
    await assert.rejects(control.handleRunnerControl(gameplayMachine.identity, unsolicited));
    assert.deepEqual(await read(human), humanBefore, "machine cannot impersonate a browser human");
    await assert.rejects(stranger.api.moveRunner(humanInput), { code: "NOT_FOUND" });
    const humanMoved = await gameplayOwner.api.moveRunner(humanInput);
    assert.deepEqual(await gameplayOwner.api.moveRunner(humanInput), humanMoved);
    await assert.rejects(gameplayOwner.api.moveRunner({ ...humanInput, commandId: randomUUID() }));
    assert.equal((await read(human)).runnerAcceptedSeq, 1);
    const humanCommands = await prisma.runnerCommand.findMany({
      where: { matchId: human.id, kind: "human-move" },
      take: 4,
    });
    assert.equal(humanCommands.length, 1, "duplicate tabs deliver one human command");
    assert.equal(humanCommands[0].payload.expectedSeq, 0);
    const humanEchoReplica = authority.createRunnerAuthority(async (id) => id === gameplayOwner.id);
    gameplayMachine.identity = await humanEchoReplica.claim(`Bearer ${gameplayMachine.secret}`);
    assert.ok(gameplayMachine.identity);
    await advertise(gameplayMachine.identity);
    const reboundEcho = {
      ...unsolicited,
      generation: gameplayMachine.identity.connectionGeneration,
    };
    await assert.rejects(
      control.handleRunnerControl(gameplayMachine.identity, reboundEcho),
      "a new generation cannot acknowledge pending human input before rebind",
    );
    const humanReoffer = await offerFor(human, gameplayMachine);
    await control.handleRunnerControl(
      gameplayMachine.identity,
      frame(gameplayMachine, "accept", human.id, { commandId: humanReoffer.payload.commandId }),
    );
    await control.handleRunnerControl(gameplayMachine.identity, reboundEcho);
    assert.equal(
      (await read(human)).runnerAcceptedSeq,
      1,
      "CLI echo does not apply the human move twice",
    );
    const promotion = await readyGame(
      gameplayConfig({
        white: config().white,
        black: config().black,
        initialFen: "7k/P7/8/8/8/8/8/7K w - - 0 1",
      }),
    );
    const promotionState = await status(promotion, gameplayOwner);
    await gameplayOwner.api.moveRunner({
      slug: promotion.slug,
      commandId: randomUUID(),
      expectedRevision: promotionState.revision,
      expectedSeq: 0,
      fen: promotionState.fen,
      move: "a7a8q",
    });
    const promotedArchive = chess.validateArchive((await read(promotion)).archive);
    assert.equal(chess.boardAt(promotedArchive).get("a8")?.type, "q");
    assert.equal((await read(promotion)).runnerAcceptedSeq, 1);
    const resigning = await readyGame(
      gameplayConfig({ white: config().white, black: config().black }),
    );
    const resigningState = await status(resigning, gameplayOwner);
    await gameplayOwner.api.moveRunner({
      slug: resigning.slug,
      commandId: randomUUID(),
      expectedRevision: resigningState.revision,
      expectedSeq: 0,
      fen: resigningState.fen,
      move: "resign",
    });
    const resignedArchive = chess.validateArchive((await read(resigning)).archive);
    assert.equal(resignedArchive.termination, "resignation");
    assert.equal(resignedArchive.result, "0-1");

    console.log(
      "chess-runner: legal terminal board settles once without trusting a claimed outcome",
    );
    const mating = await readyGame();
    for (const uci of ["f2f3", "e7e5", "g2g4", "d8h4"])
      await control.handleRunnerControl(gameplayMachine.identity, await moveFrame(mating, uci));
    const mated = await read(mating);
    const terminalArchive = chess.validateArchive(mated.archive);
    assert.equal(terminalArchive.termination, "checkmate");
    assert.equal(terminalArchive.result, "0-1");
    assert.equal(mated.status, "completed");
    assert.equal(mated.runnerGeneration, null);
    assert.equal(await prisma.chessOfficialEntry.count({ where: { matchId: mating.id } }), 0);
    await assert.rejects(
      control.handleRunnerControl(
        gameplayMachine.identity,
        frame(gameplayMachine, "event", mating.id, {
          kind: "completed",
          result: "1-0",
          termination: "checkmate",
          ply: 4,
          fen: chess.boardAt(terminalArchive).fen(),
          rejectedAttempts: [],
        }),
      ),
    );
    assert.deepEqual(await read(mating), mated, "bogus victory cannot replace a settled loss");

    console.log(
      "chess-runner: real PG interruption and credential expiry settle the constrained error state",
    );
    const interrupted = await readyGame();
    const interruptedMessage = frame(gameplayMachine, "event", interrupted.id, {
      kind: "interrupted",
      result: "*",
      termination: "interrupted",
      ply: 0,
      fen: interrupted.fen,
      rejectedAttempts: [],
    });
    await control.handleRunnerControl(gameplayMachine.identity, interruptedMessage);
    const interruptedRow = await read(interrupted);
    assert.equal(interruptedRow.status, "error");
    assert.equal(interruptedRow.runnerState, "error");
    assert.equal(interruptedRow.runnerGeneration, null);
    assert.equal(interruptedRow.runnerResumeDeadline, null);
    assert.equal(chess.validateArchive(interruptedRow.archive).termination, "interrupted");
    assert.equal(await prisma.chessOfficialEntry.count({ where: { matchId: interrupted.id } }), 0);
    assert.equal(
      await prisma.runnerCommand.count({
        where: { matchId: interrupted.id, kind: "stop", cancelledAt: null },
      }),
      1,
    );
    const expiredMachineOwner = await person();
    const expiredGameplayMachine = await machine(expiredMachineOwner);
    const expiredCredentialMatch = await readyGame(
      gameplayConfig(),
      expiredGameplayMachine,
      expiredMachineOwner,
    );
    await prisma.runnerMachine.update({
      where: { id: expiredGameplayMachine.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await control.reconcileRunnerMatches();
    const expiredCredentialRow = await read(expiredCredentialMatch);
    assert.equal(expiredCredentialRow.status, "error");
    assert.equal(expiredCredentialRow.runnerState, "error");
    assert.equal(expiredCredentialRow.runnerGeneration, null);
    assert.equal(expiredCredentialRow.runnerResumeDeadline, null);
    assert.equal(
      chess.validateArchive(expiredCredentialRow.archive).termination,
      "credential-revoked",
    );
    assert.equal(
      await prisma.chessOfficialEntry.count({ where: { matchId: expiredCredentialMatch.id } }),
      0,
    );

    console.log(
      "chess-runner: clocks continue during disconnect and grace expiry wins the move race",
    );
    const timed = await readyGame(
      gameplayConfig({
        rules: { ...config().rules, turnTimeoutMs: 1000 },
      }),
    );
    await delay(1050);
    await control.reconcileRunnerMatches();
    const clockSettled = await read(timed);
    assert.equal(clockSettled.status, "completed");
    assert.equal(chess.validateArchive(clockSettled.archive).termination, "move-timeout");
    assert.equal(chess.validateArchive(clockSettled.archive).result, "0-1");
    const delayedClock = await readyGame(
      gameplayConfig({
        rules: { ...config().rules, turnTimeoutMs: 60_000, clock: { w: 120_000, b: 120_000 } },
      }),
    );
    const delayedClockRow = await read(delayedClock);
    const delayedClockArchive = chess.validateArchive(delayedClockRow.archive);
    assert.equal(delayedClockArchive.turn.type, "model");
    const delayedStart = Date.now() - 130_000;
    const authoritativeExpiry = new Date(delayedStart + 60_000).toISOString();
    delayedClockArchive.createdAt = new Date(delayedStart).toISOString();
    delayedClockArchive.turn = {
      ...delayedClockArchive.turn,
      startedAt: new Date(delayedStart).toISOString(),
      deadline: authoritativeExpiry,
    };
    await prisma.chessMatch.update({
      where: { id: delayedClock.id },
      data: {
        archive: delayedClockArchive,
        runnerResumeDeadline: new Date(delayedStart + 120_000),
      },
    });
    await control.reconcileRunnerMatches();
    const lateSettledArchive = chess.validateArchive((await read(delayedClock)).archive);
    assert.equal(
      lateSettledArchive.termination,
      "move-timeout",
      "the first expiry is the 60s turn limit, not the 120s clock",
    );
    const charged = lateSettledArchive.events.filter((event) => event.type === "timing");
    assert.equal(charged.length, 1);
    assert.equal(
      charged[0].elapsedMs,
      60_000,
      "a late sweep charges only through the authoritative deadline",
    );
    assert.equal(charged[0].at, authoritativeExpiry);
    assert.equal(chess.clockLeftMs(lateSettledArchive, "w"), 60_000);

    const humanMateConfig = () =>
      gameplayConfig({
        white: config().white,
        black: config().black,
        rules: { ...config().rules, turnTimeoutMs: 300_000 },
        initialFen: "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1",
      });
    const expiredHuman = await readyGame(humanMateConfig());
    await prisma.chessMatch.update({
      where: { id: expiredHuman.id },
      data: { runnerResumeDeadline: new Date(Date.now() - 1) },
    });
    const expiredHumanState = await status(expiredHuman, gameplayOwner);
    await gameplayOwner.api.moveRunner({
      slug: expiredHuman.slug,
      commandId: randomUUID(),
      expectedRevision: expiredHumanState.revision,
      expectedSeq: 0,
      fen: expiredHumanState.fen,
      move: "f7g7",
    });
    const refusedMate = await read(expiredHuman);
    assert.equal(
      refusedMate.runnerState,
      "abandoned",
      "a browser mate cannot bypass expired reconnect grace before the sweep",
    );
    assert.equal(refusedMate.runnerAcceptedSeq, 0);
    assert.equal(chess.matchStats(chess.validateArchive(refusedMate.archive)).moves, 0);
    assert.equal(chess.validateArchive(refusedMate.archive).result, "*");

    const graceRace = await readyGame();
    const raceMove = await moveFrame(graceRace, "e2e4");
    await prisma.chessMatch.update({
      where: { id: graceRace.id },
      data: { runnerResumeDeadline: new Date(Date.now() - 1) },
    });
    const raceResults = await Promise.all([
      control.handleRunnerControl(gameplayMachine.identity, raceMove).then(
        () => ({ ok: true }),
        () => ({ ok: false }),
      ),
      control.reconcileRunnerMatches(),
    ]);
    assert.equal(raceResults[0].ok, false);
    const graceTerminal = await read(graceRace);
    assert.equal(graceTerminal.runnerState, "abandoned");
    assert.equal(graceTerminal.runnerAcceptedSeq, 0);
    assert.equal(graceTerminal.runnerGeneration, null);
    assert.equal(await prisma.runnerEvent.count({ where: { id: raceMove.id } }), 0);

    console.log("chess-runner: revoked or deleting owner cannot submit after dispatch starts");
    for (const cancellation of ["revoked", "deleting"]) {
      const fencedOwner = await person();
      const fencedMachine = await machine(fencedOwner);
      const fenced = await readyGame(gameplayConfig(), fencedMachine, fencedOwner);
      const fencedState = await status(fenced, fencedOwner);
      const board = new chess.Chess(fencedState.fen);
      chess.applyUci(board, "e2e4");
      const lateMove = frame(fencedMachine, "move", fenced.id, {
        uci: "e2e4",
        ply: 1,
        fen: board.fen(),
      });
      if (cancellation === "revoked")
        await prisma.$transaction((tx) =>
          machines.revokeRunnerMachinesInTransaction(tx, fencedOwner.id, fencedMachine.id),
        );
      else
        await prisma.user.update({
          where: { id: fencedOwner.id },
          data: { deletionState: "pending", deletionRequestedAt: new Date(), deletionAttempts: 0 },
        });
      if (cancellation === "revoked") {
        const revokedSnapshot = await status(fenced, fencedOwner);
        assert.equal(revokedSnapshot.status, "stopped");
        assert.deepEqual(revokedSnapshot.turn, { type: "idle" });
        assert.equal(revokedSnapshot.termination, "cancelled");
        assert.equal(revokedSnapshot.result, "*");
      }
      await assert.rejects(control.handleRunnerControl(fencedMachine.identity, lateMove), {
        code: "UNAUTHORIZED",
      });
      await control.reconcileRunnerMatches();
      const fencedRow = await read(fenced);
      assert.equal(fencedRow.runnerAcceptedSeq, 0);
      assert.equal(fencedRow.status, "stopped");
      assert.equal(fencedRow.runnerState, "stopped");
      if (cancellation === "deleting")
        assert.equal(chess.validateArchive(fencedRow.archive).termination, "cancelled");
      if (cancellation === "deleting")
        assert.equal(
          fencedRow.terminalCause,
          "owner-delete",
          "a pending-owner sweep preserves deletion's terminal cause",
        );
      assert.equal(fencedRow.runnerGeneration, null);
      assert.equal(
        fencedRow.runnerResumeDeadline,
        null,
        "credential cancellation never receives grace",
      );
    }
    const actualDeletionOwner = await person();
    const actualDeletionMachine = await machine(actualDeletionOwner);
    const actualDeletionMatch = await readyGame(
      gameplayConfig(),
      actualDeletionMachine,
      actualDeletionOwner,
    );
    const beforeDeletion = await read(actualDeletionMatch);
    const deletionAccepted = await accountDeletion.requestAccountDeletion(actualDeletionOwner.id, {
      kind: "admin",
      userId: owner.id,
      sessionId: owner.context.session.session.id,
    });
    assert.equal(deletionAccepted.complete, false);
    const afterDeletion = await read(actualDeletionMatch);
    assert.equal(afterDeletion.status, "stopped");
    assert.equal(afterDeletion.runnerState, "stopped");
    assert.equal(afterDeletion.runnerGeneration, null);
    assert.equal(afterDeletion.runnerResumeDeadline, null);
    assert.equal(afterDeletion.runnerRevision, beforeDeletion.runnerRevision + 1);
    assert.equal(afterDeletion.runnerAcceptedSeq, 0);
    assert.equal(
      afterDeletion.terminalCause,
      "owner-delete",
      "actual deletion preserves its first terminal cause",
    );
    assert.equal(
      (await prisma.runnerMachine.findUniqueOrThrow({ where: { id: actualDeletionMachine.id } }))
        .revokedAt !== null,
      true,
    );

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
    console.log(
      "chess-runner: sixteen replacement offers make progress behind thirty-two older executable commands",
    );
    const backlogOwner = await person();
    const backlogLimits = {
      operatingLimits: { ...advertisedLimits.operatingLimits, concurrency: 16 },
      hardLimits: { ...advertisedLimits.hardLimits, concurrency: 16 },
    };
    const backlogMachine = await machine(backlogOwner, backlogLimits);
    const backlogMatches = [];
    for (let index = 0; index < 16; index++) {
      const pending = await readyGame(humanMateConfig(), backlogMachine, backlogOwner);
      const state = await status(pending, backlogOwner);
      await backlogOwner.api.moveRunner({
        slug: pending.slug,
        commandId: randomUUID(),
        expectedRevision: state.revision,
        expectedSeq: 0,
        fen: state.fen,
        move: "f7f6",
      });
      backlogMatches.push(pending);
    }
    const backlogIds = backlogMatches.map((match) => match.id);
    const olderExecutable = await prisma.runnerCommand.findMany({
      where: {
        matchId: { in: backlogIds },
        kind: { in: ["start", "human-move"] },
        ackedAt: null,
        cancelledAt: null,
      },
      take: 40,
    });
    assert.equal(olderExecutable.length, 32);
    const backlogReplica = authority.createRunnerAuthority(async (id) => id === backlogOwner.id);
    backlogMachine.identity = await backlogReplica.claim(`Bearer ${backlogMachine.secret}`);
    assert.ok(backlogMachine.identity);
    await runnerLimits.runnerLimitsService.hello(backlogMachine.identity, backlogLimits);
    const replacementOffers = await outbox(backlogMachine);
    assert.equal(
      replacementOffers.length,
      16,
      "eligible offers are selected before the bounded delivery page",
    );
    assert.ok(replacementOffers.every((message) => message.type === "offer"));
    assert.equal(new Set(replacementOffers.map((message) => message.matchId)).size, 16);
    assert.ok(replacementOffers.length <= control.RUNNER_OUTBOX_LIMIT);
    for (const offer of replacementOffers) {
      const accepted = frame(backlogMachine, "accept", offer.matchId, {
        commandId: offer.payload.commandId,
      });
      assert.deepEqual(await control.handleRunnerControl(backlogMachine.identity, accepted), [
        { type: "ack", payload: { commandId: accepted.id } },
      ]);
    }
    const humanFrontier = await outbox(backlogMachine);
    assert.equal(humanFrontier.length, 16);
    assert.ok(
      humanFrontier.every((message) => message.type === "human-move"),
      "pending human input precedes an advanced resume",
    );
    for (const command of humanFrontier) {
      const row = await prisma.chessMatch.findUniqueOrThrow({ where: { id: command.matchId } });
      await control.handleRunnerControl(
        backlogMachine.identity,
        frame(backlogMachine, "move", command.matchId, {
          uci: command.payload.uci,
          ply: 1,
          fen: chess.boardAt(chess.validateArchive(row.archive)).fen(),
        }),
      );
    }
    const resumeFrontier = await outbox(backlogMachine);
    assert.equal(resumeFrontier.length, 16);
    assert.ok(resumeFrontier.every((message) => message.type === "resume"));
    for (const command of resumeFrontier)
      await control.handleRunnerControl(
        backlogMachine.identity,
        frame(backlogMachine, "ack", undefined, { commandId: command.payload.commandId }),
      );
    const startFrontier = await outbox(backlogMachine);
    assert.equal(startFrontier.length, 16);
    assert.ok(
      startFrontier.every(
        (message) => message.type === "start" && message.payload.expectedSeq === 1,
      ),
      "only the reconciled current turn becomes executable",
    );
    for (const match of backlogMatches)
      await backlogOwner.api.stopRunner({
        slug: match.slug,
        commandId: randomUUID(),
        expectedRevision: (await status(match, backlogOwner)).revision,
      });

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

    console.log(
      "chess-runner: reconnect grace crossing during a real awaited browser write rolls back",
    );
    for (const expiresDuringWrite of [true, false]) {
      const graceWriteOwner = await person();
      const graceWriteMachine = await machine(graceWriteOwner);
      const graceWriteMatch = await readyGame(
        humanMateConfig(),
        graceWriteMachine,
        graceWriteOwner,
      );
      const graceWriteDeadline = Date.now() + (expiresDuringWrite ? 1500 : 30_000);
      await prisma.chessMatch.update({
        where: { id: graceWriteMatch.id },
        data: { runnerResumeDeadline: new Date(graceWriteDeadline) },
      });
      const beforeGraceWrite = await read(graceWriteMatch);
      const graceWriteState = await status(graceWriteMatch, graceWriteOwner);
      const graceWriteCommandId = randomUUID();
      const graceWriteBlocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
      let graceWriteAction;
      let graceWriteOutcome;
      try {
        await graceWriteBlocker.connect();
        await graceWriteBlocker.query("BEGIN");
        await graceWriteBlocker.query("SELECT id FROM chess_match WHERE id = $1 FOR UPDATE", [
          graceWriteMatch.id,
        ]);
        graceWriteAction = graceWriteOwner.api
          .moveRunner({
            slug: graceWriteMatch.slug,
            commandId: graceWriteCommandId,
            expectedRevision: graceWriteState.revision,
            expectedSeq: 0,
            fen: graceWriteState.fen,
            move: "f7g7",
          })
          .then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          );
        await waitFor(
          "browser move reached its real pending command write while grace is still live",
          async () => {
            const waiting =
              await prisma.$queryRaw`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%runner_command%' AND query NOT LIKE '%pg_stat_activity%'`;
            return waiting.length > 0;
          },
        );
        assert.ok(
          Date.now() < graceWriteDeadline,
          "the browser authorized the move before grace expired",
        );
        if (expiresDuringWrite) await delay(Math.max(0, graceWriteDeadline - Date.now() + 25));
        else await delay(25);
        await graceWriteBlocker.query("ROLLBACK");
        graceWriteOutcome = await graceWriteAction;
      } finally {
        await graceWriteBlocker.query("ROLLBACK").catch(() => {});
        await graceWriteBlocker.end();
        await graceWriteAction;
      }
      if (expiresDuringWrite) {
        assert.equal(
          graceWriteOutcome.ok,
          false,
          "a once-live grant cannot survive an awaited write past its deadline",
        );
        assert.equal(graceWriteOutcome.error.code, "CONFLICT");
        assert.deepEqual(
          await read(graceWriteMatch),
          beforeGraceWrite,
          "board, accepted ply and revision roll back together",
        );
        assert.equal(
          await prisma.runnerCommand.findUnique({ where: { id: graceWriteCommandId } }),
          null,
        );
        const receiptId = createHash("sha256")
          .update(JSON.stringify(["runner-browser", graceWriteCommandId]))
          .digest("hex");
        assert.equal(
          await prisma.runnerEvent.findUnique({ where: { id: receiptId } }),
          null,
          "expired browser write leaves no acceptance receipt",
        );
        await control.reconcileRunnerMatches();
        const abandonedWrite = await read(graceWriteMatch);
        assert.equal(abandonedWrite.runnerState, "abandoned");
        assert.equal(abandonedWrite.runnerAcceptedSeq, 0);
      } else {
        assert.equal(
          graceWriteOutcome.ok,
          true,
          "equally real contention succeeds while the original grant remains live",
        );
        const validMate = await read(graceWriteMatch);
        assert.equal(validMate.status, "completed");
        assert.equal(validMate.runnerAcceptedSeq, 1);
        assert.equal(chess.validateArchive(validMate.archive).result, "1-0");
      }
    }

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
      limits: runnerLimits.runnerLimitsService,
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
    const gameLimits = {
      operatingLimits: { ...advertisedLimits.operatingLimits, concurrency: 16 },
      hardLimits: { ...advertisedLimits.hardLimits, concurrency: 16 },
    };
    const gameMachine = await machine(gameOwner, gameLimits);
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
    let gameRecords = new Map();
    const gameWire = [];
    const gameClientWire = [];
    const gameActive = [];
    let spendRequests = 0;
    let allowGameExecution = false;
    let localModelTurns = 0;
    let heldStartGeneration;
    let heldStartMatch;
    let pauseGameOutbox = false;
    let modelResultGate;
    let tiedTurnMatch;
    let blockTiedFrontier = false;
    let tiedTurnCommands;
    const heldTerminalCommands = new Set();
    const heldTerminalDeliveries = new Map();
    const burstMatchIds = new Set();
    const burstModelCalls = new Set();
    const burstMoveFrames = new Set();
    let burstModelGate;
    let burstAuthorityGate;
    let holdBurstAuthority = false;
    let burstAuthorityHeld = false;
    let transportTimeOffset = 0;
    const parkedLostStartIds = new Set();
    const parkedMatchIds = new Set();
    const parkedWireAcks = new Set();
    let holdParkedStarts = false;
    let parkedDropGeneration;
    let parkedAckGate;
    let parkedAckHeld = false;
    const createActualPolicy = async () => {
      const policy = await policyModule.RunnerPolicy.open(
        {
          baseUrl: "http://127.0.0.1:8765/v1",
          allowModels: ["fixture/local-model"],
          maxConcurrent: 16,
        },
        {
          env: {},
          spend: {
            assertDispatchable: () => {},
            reserve: async () => {
              ++spendRequests;
              throw new Error("handshake never authorizes spend");
            },
            captureUsage: async () => {
              ++spendRequests;
              throw new Error("handshake never incurs spend");
            },
            close: async () => {},
          },
        },
      );
      policy.restoreOperatingLimits(gameLimits.operatingLimits);
      return policy;
    };
    let localPolicy = await createActualPolicy();
    const realGameLeases = leaseModule.createRunnerLeaseStore(queues.redisConnection);
    let admittedGameActions = 0;
    const gameTransport = transportModule.createRunnerTransport({
      authority: {
        ...gameMachine.resolver,
        resolve: async (authorization) => {
          if (holdBurstAuthority && !burstAuthorityHeld) {
            burstAuthorityHeld = true;
            await burstAuthorityGate;
          }
          return gameMachine.resolver.resolve(authorization);
        },
      },
      now: () => performance.now() + transportTimeOffset,
      leases: {
        ...realGameLeases,
        async validate(...args) {
          const allowed = await realGameLeases.validate(...args);
          if (allowed && (args[1] ?? true)) ++admittedGameActions;
          return allowed;
        },
      },
      isAvailable: () => queues.redisConnection.status === "ready",
      limits: runnerLimits.runnerLimitsService,
      controls: {
        outbox: async (identity, ...args) => {
          if (pauseGameOutbox) return [];
          const pending = await control.runnerOutbox(identity, ...args);
          // Hold this old socket's start to deterministically model lost delivery.
          // A replacement generation uses the unfiltered production outbox.
          return pending
            .filter(
              (message) =>
                !(
                  holdParkedStarts &&
                  parkedMatchIds.has(message.matchId) &&
                  message.type === "start"
                ),
            )
            .filter(
              (message) =>
                !(
                  blockTiedFrontier &&
                  message.matchId === tiedTurnMatch &&
                  ((message.type === "resume" && message.payload.acceptedSeq === 2) ||
                    (message.type === "start" && message.payload.expectedSeq === 2))
                ),
            )
            .filter(
              (message) =>
                !(
                  identity.connectionGeneration === heldStartGeneration &&
                  message.matchId === heldStartMatch &&
                  message.type === "start"
                ),
            );
        },
        handle: async (identity, message) => {
          if (
            identity.connectionGeneration === parkedDropGeneration &&
            message.type === "ack" &&
            parkedLostStartIds.has(message.payload.commandId)
          ) {
            // Simulate delivery loss after local journal fsync and before the
            // durable server receipt; closing this old session releases the wait.
            parkedAckHeld = true;
            await parkedAckGate;
            return [{ type: "ack", payload: { commandId: message.id } }];
          }
          const replies = await control.handleRunnerControl(identity, message);
          assert.ok(
            replies.every((reply) => reply.type === "ack"),
            "durable commands have one delivery path",
          );
          if (
            message.type === "move" &&
            message.matchId === tiedTurnMatch &&
            message.payload.ply === 2
          ) {
            const pending = await prisma.runnerCommand.findMany({
              where: {
                matchId: tiedTurnMatch,
                kind: { in: ["resume", "start"] },
                ackedAt: null,
                cancelledAt: null,
              },
              orderBy: { revision: "desc" },
              take: 2,
            });
            assert.equal(pending.length, 2);
            const tiedAt = new Date();
            const ids = {};
            for (const command of pending) {
              const id = `${command.kind === "start" ? "a" : "z"}_tied_${randomUUID()}`;
              ids[command.kind] = id;
              await prisma.runnerCommand.update({
                where: { id: command.id },
                data: { id, createdAt: tiedAt, payload: { ...command.payload, commandId: id } },
              });
            }
            assert.ok(ids.start < ids.resume, "the adversarial FIFO tie puts start before resume");
            tiedTurnCommands = ids;
            blockTiedFrontier = false;
          }
          return replies;
        },
      },
    });
    ownedTransports.push(gameTransport);
    let cliConnection;
    const createActualLoop = (policy, records) =>
      new gameModule.RunnerGameLoop({
        policy,
        engine: true,
        journal: {
          load: async (id) => {
            const saved = records.get(id);
            return saved ? structuredClone(saved) : undefined;
          },
          save: async (id, record) => {
            records.set(id, structuredClone(record));
          },
          close: async () => {},
        },
        send: (action, signal) => cliConnection.send(action, signal),
        advance: async (archive, options) => {
          assert.equal(allowGameExecution, true, "handshake never authorizes game execution");
          if (archive.config.title.startsWith("Burst admission ")) {
            assert.equal(
              burstModelCalls.has(archive.id),
              false,
              "a held model call is never repeated",
            );
            burstModelCalls.add(archive.id);
            await burstModelGate;
            chess.submitMove(archive, chess.boardAt(archive), "e2e4");
            return archive;
          }
          if (archive.config.title.startsWith("Fast baseline ")) {
            if (chess.matchStats(archive).moves >= 64) {
              if (!options.signal.aborted)
                await new Promise((resolve) =>
                  options.signal.addEventListener("abort", resolve, { once: true }),
                );
              options.signal.throwIfAborted();
            }
            const move = chess.legalMoves(chess.boardAt(archive)).find((candidate) => {
              const next = chess.boardAt(archive);
              chess.applyUci(next, candidate);
              return !next.isGameOver();
            });
            assert.ok(move, "the fast baseline retains a legal nonterminal continuation");
            chess.submitMove(archive, chess.boardAt(archive), move);
            return archive;
          }
          ++localModelTurns;
          assert.equal(chess.boardAt(archive).turn(), "b");
          await modelResultGate;
          chess.submitMove(archive, chess.boardAt(archive), "e7e5");
          return archive;
        },
        evaluate: async (fen, nodes) => {
          assert.equal(allowGameExecution, true, "handshake never authorizes an engine");
          return {
            engine: "stockfish-19-lite-single",
            fen,
            nodes,
            depth: 1,
            cp: 3,
            mate: null,
            bestMove: null,
          };
        },
      });
    let gameLoop = createActualLoop(localPolicy, gameRecords);
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
          const frame = JSON.parse(text);
          gameClientWire.push(frame);
          if (frame.type === "ack" && parkedLostStartIds.has(frame.payload.commandId))
            parkedWireAcks.add(frame.payload.commandId);
          if (frame.type === "move" && burstMatchIds.has(frame.matchId)) {
            burstMoveFrames.add(frame.matchId);
            holdBurstAuthority = true;
          }
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
                ping() {
                  attached?.pong();
                },
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
    const createActualConnection = () =>
      new connectionModule.RunnerConnection({
        url: "ws://127.0.0.1/api/cli/runner/ws",
        allowLocalhostWs: true,
        credential: gameMachine.secret,
        socketFactory,
        hello: gameLoop.hello,
        random: () => 0,
        sleep: async () => {},
        onMessage: (message, signal) => {
          if (message.type === "stop" && heldTerminalCommands.has(message.payload.commandId)) {
            heldTerminalDeliveries.set(message.payload.commandId, { message, signal });
            return Promise.resolve();
          }
          return gameLoop.handle(message, signal);
        },
      });
    cliConnection = createActualConnection();
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
            (await prisma.runnerEvent.count({ where: { matchId: gameMatch.id } })) >= 3
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
            (await prisma.runnerEvent.count({ where: { matchId: gameMatch.id } })) >= 6
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
      console.log("chess-runner: real browser-to-server-to-CLI human/model sequence and stop");
      allowGameExecution = true;
      heldStartGeneration = gameMachine.identity.connectionGeneration;
      heldStartMatch = afterCapMatch.id;
      await gameOwner.api.startRunner({
        slug: afterCapMatch.slug,
        commandId: randomUUID(),
        expectedRevision: (await status(afterCapMatch, gameOwner)).revision,
      });
      const undeliveredStart = await prisma.runnerCommand.findFirstOrThrow({
        where: { matchId: afterCapMatch.id, kind: "start" },
      });
      assert.equal(undeliveredStart.ackedAt, null);
      assert.equal(
        gameWire.some(
          (message) => message.type === "start" && message.matchId === afterCapMatch.id,
        ),
        false,
      );
      const beforeStartReconnect = await read(afterCapMatch);
      const restartWireOffset = gameWire.length;
      // The browser committed a start, but this transport has not delivered it.
      // Restore/rebind and authoritative resume must precede that pending work.
      gameActive.at(-1).close(1012, "RESTART");
      await waitFor(
        "actual CLI parks for the human before any model call",
        () => gameRecords.get(afterCapMatch.id)?.archive.turn.type === "human",
        8000,
      );
      const restartCommands = gameWire
        .slice(restartWireOffset)
        .filter((message) => message.matchId === afterCapMatch.id);
      assert.deepEqual(restartCommands.map((message) => message.type).slice(0, 3), [
        "offer",
        "resume",
        "start",
      ]);
      assert.equal(
        restartCommands.find((message) => message.type === "start").payload.commandId,
        undeliveredStart.id,
      );
      assert.equal(
        (await read(afterCapMatch)).runnerGeneration,
        beforeStartReconnect.runnerGeneration + 1,
      );
      assert.equal(localModelTurns, 0);
      let releaseModelResult;
      modelResultGate = new Promise((resolve) => {
        releaseModelResult = resolve;
      });
      releaseBarriers.push(releaseModelResult);
      tiedTurnMatch = afterCapMatch.id;
      blockTiedFrontier = true;
      const humanTurn = await status(afterCapMatch, gameOwner);
      await gameOwner.api.moveRunner({
        slug: afterCapMatch.slug,
        commandId: randomUUID(),
        expectedRevision: humanTurn.revision,
        expectedSeq: humanTurn.acceptedSeq,
        fen: humanTurn.fen,
        move: "e2e4",
      });
      await gameActive.at(-1).deliver();
      await waitFor(
        "the local model is in flight before saturating the command window",
        () => localModelTurns === 1,
      );
      console.log(
        "chess-runner: saturated four-command window preserves resume dependency despite adversarial FIFO ties",
      );
      pauseGameOutbox = true;
      try {
        for (let index = 0; index < 4; index++) {
          const held = await create(request(gameMachine), gameOwner);
          const commandId = randomUUID();
          await gameOwner.api.stopRunner({
            slug: held.slug,
            commandId,
            expectedRevision: held.revision,
          });
          heldTerminalCommands.add(commandId);
        }
      } finally {
        pauseGameOutbox = false;
      }
      await gameActive.at(-1).deliver();
      await waitFor(
        "all four command credits are occupied by delivered, unacknowledged stops",
        () => heldTerminalDeliveries.size === 4,
      );
      assert.equal(
        await prisma.runnerCommand.count({
          where: { id: { in: [...heldTerminalCommands] }, ackedAt: null },
        }),
        4,
      );
      const fullWindowWireOffset = gameWire.length;
      releaseModelResult();
      await waitFor(
        "the model result commits while all command credits remain occupied",
        async () =>
          (await read(afterCapMatch)).runnerAcceptedSeq === 2 && tiedTurnCommands !== undefined,
      );
      await gameActive.at(-1).deliver();
      await gameTransport.idle();
      assert.equal(gameRecords.get(afterCapMatch.id)?.confirmedPly, 1);
      assert.equal(
        gameWire
          .slice(fullWindowWireOffset)
          .some(
            (message) =>
              message.matchId === afterCapMatch.id && ["resume", "start"].includes(message.type),
          ),
        false,
        "no command bypasses the full delivery window",
      );
      const [firstHeldId, firstHeld] = [...heldTerminalDeliveries][0];
      heldTerminalCommands.delete(firstHeldId);
      await gameLoop.handle(firstHeld.message, firstHeld.signal);
      await waitFor(
        "actual local model reply passes authoritative server legality",
        async () => {
          const current = await read(afterCapMatch);
          return (
            current.runnerAcceptedSeq === 2 && gameRecords.get(afterCapMatch.id)?.confirmedPly === 2
          );
        },
        8000,
      );
      await waitFor("resume ACK releases the tied next-turn start", () =>
        gameWire.some(
          (message) =>
            message.type === "start" && message.payload.commandId === tiedTurnCommands.start,
        ),
      );
      const nextTurnWire = gameWire
        .slice(fullWindowWireOffset)
        .filter(
          (message) =>
            message.matchId === afterCapMatch.id && ["resume", "start"].includes(message.type),
        );
      assert.deepEqual(
        nextTurnWire.map((message) => message.type),
        ["resume", "start"],
      );
      assert.equal(nextTurnWire[0].payload.commandId, tiedTurnCommands.resume);
      assert.equal(nextTurnWire[1].payload.commandId, tiedTurnCommands.start);
      for (const [id, delivery] of heldTerminalDeliveries) {
        if (!heldTerminalCommands.delete(id)) continue;
        await gameLoop.handle(delivery.message, delivery.signal);
      }
      await waitFor(
        "all held terminal command credits settle after the dependency proof",
        async () =>
          (await prisma.runnerCommand.count({
            where: { id: { in: [...heldTerminalDeliveries.keys()] }, ackedAt: null },
          })) === 0,
      );
      const realGame = await read(afterCapMatch);
      assert.equal(localModelTurns, 1, "one human action causes one local model turn");
      assert.equal(chess.matchStats(chess.validateArchive(realGame.archive)).moves, 2);
      assert.equal(
        await prisma.chessOfficialEntry.count({ where: { matchId: afterCapMatch.id } }),
        0,
      );
      assert.equal(spendRequests, 0, "the local stub makes no paid request");
      const realStopId = randomUUID();
      await gameOwner.api.stopRunner({
        slug: afterCapMatch.slug,
        commandId: realStopId,
        expectedRevision: (await status(afterCapMatch, gameOwner)).revision,
      });
      await gameActive.at(-1).deliver();
      await waitFor(
        "actual CLI acknowledges final durable stop",
        async () =>
          (await prisma.runnerCommand.findUniqueOrThrow({ where: { id: realStopId } })).ackedAt !==
          null,
      );
      assert.equal((await read(afterCapMatch)).runnerGeneration, null);
      assert.equal(gameRecords.get(afterCapMatch.id)?.phase, "terminal");
      assert.equal(localModelTurns, 1, "stop cannot dispatch another local call");
      const connectActualGame = async (settings) => {
        const row = await create({ ...request(gameMachine), config: settings }, gameOwner);
        await gameActive.at(-1).deliver();
        await waitFor(
          "the real CLI accepts and acknowledges its initial authoritative resume",
          async () => {
            const resume = await prisma.runnerCommand.findFirst({
              where: { matchId: row.id, kind: "resume", cancelledAt: null },
              orderBy: { revision: "desc" },
              select: { ackedAt: true },
            });
            return resume?.ackedAt !== undefined && resume.ackedAt !== null;
          },
          8000,
        );
        return row;
      };
      const startActualGame = async (row) => {
        await gameOwner.api.startRunner({
          slug: row.slug,
          commandId: randomUUID(),
          expectedRevision: (await status(row, gameOwner)).revision,
        });
        await gameActive.at(-1).deliver();
      };
      const stopActualGame = async (row) => {
        const commandId = randomUUID();
        await gameOwner.api.stopRunner({
          slug: row.slug,
          commandId,
          expectedRevision: (await status(row, gameOwner)).revision,
        });
        await gameActive.at(-1).deliver();
        await waitFor(
          "the real CLI acknowledges the current terminal stop",
          async () =>
            (await prisma.runnerCommand.findUniqueOrThrow({ where: { id: commandId } })).ackedAt !==
            null,
          8000,
        );
      };

      console.log(
        "chess-runner: live zero-match polling renews old contact without replacing the connection",
      );
      assert.equal(
        await prisma.chessMatch.count({
          where: { runnerMachineId: gameMachine.id, status: { in: ["queued", "running"] } },
        }),
        0,
      );
      const liveGeneration = gameMachine.identity.connectionGeneration;
      const oldContact = new Date(Date.now() - 61_000);
      await prisma.runnerMachine.update({
        where: { id: gameMachine.id },
        data: { lastSeenAt: oldContact },
      });
      let renewedMachine;
      await waitFor(
        "authenticated zero-match polling renews contact on the same generation",
        async () => {
          await gameActive.at(-1).deliver();
          renewedMachine = await prisma.runnerMachine.findUniqueOrThrow({
            where: { id: gameMachine.id },
          });
          return (
            renewedMachine.connectionGeneration === liveGeneration &&
            renewedMachine.lastSeenAt > oldContact
          );
        },
        8000,
      );
      assert.equal(renewedMachine.connectionGeneration, liveGeneration);
      assert.ok(renewedMachine.lastSeenAt > oldContact);
      const contactProbe = await connectActualGame({
        ...config(),
        title: `Live contact ${randomUUID()}`,
      });
      await stopActualGame(contactProbe);
      pauseGameOutbox = true;
      // Drain a current-generation poll already in progress before backdating.
      // The transport keeps its real authority/lease checks while this adapter
      // briefly isolates the retired generation's attempted contact write.
      try {
        await gameTransport.idle();
        await prisma.runnerMachine.update({
          where: { id: gameMachine.id },
          data: { lastSeenAt: oldContact },
        });
        await assert.rejects(
          control.runnerOutbox({
            ...gameMachine.identity,
            connectionGeneration: liveGeneration - 1,
          }),
          { code: "UNAUTHORIZED" },
        );
        assert.deepEqual(
          (await prisma.runnerMachine.findUniqueOrThrow({ where: { id: gameMachine.id } }))
            .lastSeenAt,
          oldContact,
          "a retired generation cannot renew contact",
        );
      } finally {
        pauseGameOutbox = false;
      }
      let renewedAfterRefusal;
      await waitFor(
        "current-generation polling renews contact after the isolated retired-generation refusal",
        async () => {
          await gameActive.at(-1).deliver();
          renewedAfterRefusal = await prisma.runnerMachine.findUniqueOrThrow({
            where: { id: gameMachine.id },
          });
          return (
            renewedAfterRefusal.connectionGeneration === liveGeneration &&
            renewedAfterRefusal.lastSeenAt > oldContact
          );
        },
        8000,
      );
      assert.equal(renewedAfterRefusal.connectionGeneration, liveGeneration);
      assert.ok(
        renewedAfterRefusal.lastSeenAt > oldContact,
        "the current generation renews contact after the isolated refusal",
      );

      console.log(
        "chess-runner: fresh CLI loop recovers four parked human starts whose durable ACKs were lost",
      );
      const parkedGames = [];
      for (let index = 0; index < 4; index++) {
        const row = await connectActualGame({
          ...config(),
          title: `Parked human receipt ${index} ${randomUUID()}`,
          rules: { ...config().rules, turnTimeoutMs: 300_000 },
        });
        parkedGames.push(row);
        parkedMatchIds.add(row.id);
      }
      let releaseParkedAck;
      parkedAckGate = new Promise((resolve) => {
        releaseParkedAck = resolve;
      });
      releaseBarriers.push(releaseParkedAck);
      parkedDropGeneration = gameMachine.identity.connectionGeneration;
      holdParkedStarts = true;
      const parkedResumeIds = [];
      for (const row of parkedGames) {
        const commandId = randomUUID();
        parkedLostStartIds.add(commandId);
        await gameOwner.api.startRunner({
          slug: row.slug,
          commandId,
          expectedRevision: (await status(row, gameOwner)).revision,
        });
        const resume = await prisma.runnerCommand.findFirstOrThrow({
          where: { matchId: row.id, kind: "resume", cancelledAt: null },
          orderBy: { revision: "desc" },
          select: { id: true },
        });
        parkedResumeIds.push(resume.id);
      }
      await gameActive.at(-1).deliver();
      await waitFor(
        "all four current resumes settle before their withheld human starts",
        async () =>
          (await prisma.runnerCommand.count({
            where: { id: { in: parkedResumeIds }, ackedAt: { not: null } },
          })) === 4,
        8000,
      );
      holdParkedStarts = false;
      await gameActive.at(-1).deliver();
      await waitFor(
        "all four human starts are journaled ready and their ACK frames leave the CLI",
        () =>
          parkedAckHeld &&
          parkedWireAcks.size === 4 &&
          parkedGames.every(
            (row) =>
              gameRecords.get(row.id)?.phase === "ready" &&
              gameRecords.get(row.id)?.archive.turn.type === "human",
          ),
        3500,
      );
      assert.equal(
        await prisma.runnerCommand.count({
          where: { id: { in: [...parkedLostStartIds] }, ackedAt: null },
        }),
        4,
        "no human-start receipt reached durable server state",
      );
      const parkedLocalTurns = new Map(
        parkedGames.map((row) => [row.id, structuredClone(gameRecords.get(row.id).archive.turn)]),
      );
      const parkedServerTurns = new Map();
      for (const row of parkedGames)
        parkedServerTurns.set(
          row.id,
          structuredClone(chess.validateArchive((await read(row)).archive).turn),
        );
      const oldLoop = gameLoop;
      const oldJournal = gameRecords;
      const restoredJournal = new Map(
        [...oldJournal].map(([id, record]) => [id, structuredClone(record)]),
      );
      const modelCallsBeforeRestore = localModelTurns;
      cliConnection.stop();
      releaseParkedAck();
      await gameTransport.idle();
      // A fresh policy/loop recreates every command Set. Captured ready records
      // are detached before old-loop cleanup, exactly as after process loss.
      gameRecords = restoredJournal;
      localPolicy = await createActualPolicy();
      gameLoop = createActualLoop(localPolicy, restoredJournal);
      ownedGameLoops.push(gameLoop);
      await oldLoop.close();
      for (const row of parkedGames) {
        assert.equal(gameRecords.get(row.id).phase, "ready");
        assert.deepEqual(
          gameRecords.get(row.id).archive.turn,
          parkedLocalTurns.get(row.id),
          "old-loop cleanup cannot rewrite the restored journal",
        );
      }
      const beforeParkedReplacement = gameMachine.identity.connectionGeneration;
      const parkedReplacementClientOffset = gameClientWire.length;
      cliConnection = createActualConnection();
      ownedCliConnections.push(cliConnection);
      cliConnection.start();
      await waitFor(
        "replacement offers, exact resumes and all four recovered start ACKs commit",
        async () =>
          (await prisma.runnerCommand.count({
            where: { id: { in: [...parkedLostStartIds] }, ackedAt: { not: null } },
          })) === 4,
        12_000,
      );
      assert.equal(gameMachine.identity.connectionGeneration, beforeParkedReplacement + 1);
      assert.equal(cliConnection.getState(), "connected");
      assert.equal(
        new Set(
          gameClientWire
            .slice(parkedReplacementClientOffset)
            .filter(
              (message) =>
                message.type === "ack" && parkedLostStartIds.has(message.payload.commandId),
            )
            .map((message) => message.payload.commandId),
        ).size,
        4,
        "the fresh CLI emits each recovered semantic start ACK",
      );
      for (const row of parkedGames) {
        assert.deepEqual(
          gameRecords.get(row.id).archive.turn,
          parkedLocalTurns.get(row.id),
          "restored human starts preserve every local turn/clock field",
        );
        assert.deepEqual(
          chess.validateArchive((await read(row)).archive).turn,
          parkedServerTurns.get(row.id),
          "server turn deadlines never restart during receipt recovery",
        );
      }
      assert.equal(
        localModelTurns,
        modelCallsBeforeRestore,
        "parked-human recovery performs no inference",
      );
      assert.equal(spendRequests, 0);
      const fifthParkedOffer = await connectActualGame({
        ...config(),
        title: `Fifth offer after parked recovery ${randomUUID()}`,
      });
      assert.equal(
        (await status(fifthParkedOffer, gameOwner)).state,
        "accepted",
        "four recovered ACKs free the delivery window for a fifth offer",
      );
      await stopActualGame(fifthParkedOffer);
      for (const row of parkedGames) await stopActualGame(row);
      assert.equal(localModelTurns, modelCallsBeforeRestore);

      console.log(
        "chess-runner: sixteen simultaneous model results survive a held real authority read exactly once",
      );
      let releaseBurstModels;
      let releaseBurstAuthority;
      burstModelGate = new Promise((resolve) => {
        releaseBurstModels = resolve;
      });
      burstAuthorityGate = new Promise((resolve) => {
        releaseBurstAuthority = resolve;
      });
      releaseBarriers.push(releaseBurstModels, releaseBurstAuthority);
      const burstGames = [];
      const burstConnectionsBefore = gameActive.length;
      for (let index = 0; index < 16; index++) {
        const row = await connectActualGame({
          ...config(),
          title: `Burst admission ${index} ${randomUUID()}`,
          white: config().black,
          black: config().white,
          rules: { ...config().rules, turnTimeoutMs: 300_000 },
        });
        burstGames.push(row);
        burstMatchIds.add(row.id);
        await startActualGame(row);
      }
      await waitFor(
        "all sixteen authorized model calls are held in flight",
        () => burstModelCalls.size === 16,
        15_000,
      );
      releaseBurstModels();
      await waitFor(
        "all sixteen results queue behind the first actual authority read",
        () => burstAuthorityHeld && burstMoveFrames.size === 16,
        3500,
      );
      await delay(25);
      releaseBurstAuthority();
      await waitFor(
        "all sixteen accepted results reconcile back to the real CLI",
        async () =>
          (await prisma.chessMatch.count({
            where: { id: { in: burstGames.map((row) => row.id) }, runnerAcceptedSeq: 1 },
          })) === 16 && burstGames.every((row) => gameRecords.get(row.id)?.confirmedPly === 1),
        20_000,
      );
      assert.equal(burstModelCalls.size, 16);
      assert.equal(
        gameActive.length,
        burstConnectionsBefore,
        "valid result pressure never closes or replaces the transport",
      );
      assert.equal(cliConnection.getState(), "connected");
      for (const row of burstGames) await stopActualGame(row);

      console.log(
        "chess-runner: fast legal baseline crosses the old 240-frame budget with evaluations and heartbeat",
      );
      const fastGame = await connectActualGame({
        ...gameplayConfig(),
        title: `Fast baseline ${randomUUID()}`,
        rules: { ...config().rules, turnTimeoutMs: 300_000 },
      });
      const fastStartedAt = Date.now();
      const fastClientOffset = gameClientWire.length;
      const fastActionOffset = admittedGameActions;
      await startActualGame(fastGame);
      await waitFor(
        "the fast nonterminal baseline reaches thirty-two accepted plies",
        async () => (await read(fastGame)).runnerAcceptedSeq >= 32,
        20_000,
      );
      const pongOffset = gameClientWire.filter((message) => message.type === "pong").length;
      transportTimeOffset += 25_001;
      await gameActive.at(-1).tick();
      await waitFor(
        "the real CLI answers the server's bounded heartbeat",
        () => gameClientWire.filter((message) => message.type === "pong").length > pongOffset,
      );
      await waitFor(
        "the fast baseline reaches sixty-four legal nonterminal plies",
        async () =>
          (await read(fastGame)).runnerAcceptedSeq >= 64 &&
          gameRecords.get(fastGame.id)?.confirmedPly === 64,
        20_000,
      );
      const fastArchive = chess.validateArchive((await read(fastGame)).archive);
      assert.equal(fastArchive.status, "running");
      assert.equal(chess.matchStats(fastArchive).moves, 64);
      assert.ok(Date.now() - fastStartedAt < 60_000);
      const fastTraffic = gameClientWire.slice(fastClientOffset);
      assert.ok(
        fastTraffic.filter(
          (message) => message.type === "evaluation" && message.matchId === fastGame.id,
        ).length >= 50,
      );
      assert.ok(
        fastTraffic.length > 240,
        "the actual protocol emits more than the former one-minute frame allowance",
      );
      assert.ok(
        admittedGameActions - fastActionOffset > 240,
        "the real Redis action limiter admits normal paced gameplay",
      );
      // Redis's fixed minute bucket may roll over during this phase. Count only
      // successful real action admissions above, while retaining its live bounds.
      const currentActionBucket = await queues.redisConnection.get(
        `runner:ws:actions:${gameMachine.id}`,
      );
      const currentActionCount = Number(currentActionBucket);
      assert.ok(
        currentActionBucket === null ||
          (Number.isSafeInteger(currentActionCount) &&
            currentActionCount > 0 &&
            currentActionCount <= leaseModule.RUNNER_ACTIONS_PER_MINUTE),
      );
      assert.equal(cliConnection.getState(), "connected");
      assert.equal(gameActive.length, burstConnectionsBefore);
      await stopActualGame(fastGame);
      assert.equal(spendRequests, 0);
      assert.equal(engine.enginePoolStats().started, beforeEngine);

      cliConnection.stop();
      await gameTransport.idle();
      const offlineContact = new Date(Date.now() - 61_000);
      await prisma.runnerMachine.update({
        where: { id: gameMachine.id },
        data: { lastSeenAt: offlineContact },
      });
      await assert.rejects(
        create(request(gameMachine), gameOwner),
        { code: "NOT_FOUND" },
        "genuine contact loss refuses new admission",
      );
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

    console.log(
      "chess-runner: credential expiry after final real authorization reads rolls back every write",
    );
    for (const credential of ["session", "machine"]) {
      for (const crossesExpiry of [true, false]) {
        const temporalOwner = await person();
        const temporalMachine = await machine(temporalOwner);
        const temporalMatch = await readyGame(humanMateConfig(), temporalMachine, temporalOwner);
        const shortExpiry = new Date(Date.now() + 1200);
        const liveExpiry = new Date(Date.now() + 30_000);
        await prisma.session.update({
          where: { id: temporalOwner.context.session.session.id },
          data: { expiresAt: crossesExpiry && credential === "session" ? shortExpiry : liveExpiry },
        });
        await prisma.runnerMachine.update({
          where: { id: temporalMachine.id },
          data: { expiresAt: crossesExpiry && credential === "machine" ? shortExpiry : liveExpiry },
        });
        const beforeTemporal = await read(temporalMatch);
        const temporalState = await status(temporalMatch, temporalOwner);
        const beforeTemporalCommands = await prisma.runnerCommand.findMany({
          where: { matchId: temporalMatch.id },
          orderBy: { id: "asc" },
          take: 64,
        });
        const beforeTemporalEvents = await prisma.runnerEvent.findMany({
          where: { matchId: temporalMatch.id },
          orderBy: { id: "asc" },
          take: 64,
        });
        const temporalCommandId = randomUUID();
        const originalTransaction = prisma.$transaction;
        let matchingReads = 0;
        let heldFinalRead = false;
        let temporalOutcome;
        try {
          // Transaction callbacks receive real PG delegates. Proxy only this
          // owned machine's final findFirst: execute its original SQL first,
          // then delay returning the unchanged, still-valid captured result.
          prisma.$transaction = (operation, options) => {
            if (typeof operation !== "function")
              return originalTransaction.call(prisma, operation, options);
            return originalTransaction.call(
              prisma,
              async (tx) => {
                const realMachine = tx.runnerMachine;
                const wrappedMachine = new Proxy(realMachine, {
                  get(target, property, receiver) {
                    if (property !== "findFirst") return Reflect.get(target, property, receiver);
                    return async (input) => {
                      const result = await target.findFirst(input);
                      if (input?.where?.id !== temporalMachine.id) return result;
                      ++matchingReads;
                      if (matchingReads === 2) {
                        assert.ok(
                          result,
                          "the final machine SQL result is valid before the delayed return",
                        );
                        assert.ok(
                          Date.now() < (crossesExpiry ? shortExpiry : liveExpiry).getTime(),
                          "credential authority is still live when the final real query resolves",
                        );
                        heldFinalRead = true;
                        await delay(1500);
                        if (crossesExpiry)
                          assert.ok(
                            Date.now() >= shortExpiry.getTime(),
                            "the real credential expires while its final result is awaited",
                          );
                      }
                      return result;
                    };
                  },
                });
                return operation(
                  new Proxy(tx, {
                    get(target, property, receiver) {
                      return property === "runnerMachine"
                        ? wrappedMachine
                        : Reflect.get(target, property, receiver);
                    },
                  }),
                );
              },
              options,
            );
          };
          temporalOutcome = await temporalOwner.api
            .moveRunner({
              slug: temporalMatch.slug,
              commandId: temporalCommandId,
              expectedRevision: temporalState.revision,
              expectedSeq: 0,
              fen: temporalState.fen,
              move: "f7g7",
            })
            .then(
              (value) => ({ ok: true, value }),
              (error) => ({ ok: false, error }),
            );
        } finally {
          prisma.$transaction = originalTransaction;
        }
        assert.equal(heldFinalRead, true, "the regression crossed the final machine-query await");
        assert.equal(
          matchingReads,
          2,
          "initial and final authority use the real owned-machine query",
        );
        if (crossesExpiry) {
          assert.equal(
            temporalOutcome.ok,
            false,
            `${credential} expiry after the final SQL read must reject commit`,
          );
          assert.equal(temporalOutcome.error.code, "UNAUTHORIZED");
          assert.deepEqual(
            await read(temporalMatch),
            beforeTemporal,
            "board, accepted sequence, revision and clock state roll back",
          );
          assert.deepEqual(
            await prisma.runnerCommand.findMany({
              where: { matchId: temporalMatch.id },
              orderBy: { id: "asc" },
              take: 64,
            }),
            beforeTemporalCommands,
            "command creation and cancellation roll back",
          );
          assert.deepEqual(
            await prisma.runnerEvent.findMany({
              where: { matchId: temporalMatch.id },
              orderBy: { id: "asc" },
              take: 64,
            }),
            beforeTemporalEvents,
            "no browser acceptance receipt survives expired authority",
          );
          assert.equal(
            await prisma.runnerCommand.findUnique({ where: { id: temporalCommandId } }),
            null,
          );
        } else {
          assert.equal(
            temporalOutcome.ok,
            true,
            `equally delayed final ${credential} authorization commits while still live`,
          );
          const validTemporal = await read(temporalMatch);
          assert.equal(validTemporal.runnerAcceptedSeq, 1);
          assert.equal(validTemporal.status, "completed");
          assert.equal(chess.validateArchive(validTemporal.archive).termination, "checkmate");
          assert.equal(chess.validateArchive(validTemporal.archive).result, "1-0");
          assert.ok(await prisma.runnerCommand.findUnique({ where: { id: temporalCommandId } }));
        }
        assert.equal(
          await prisma.chessOfficialEntry.count({ where: { matchId: temporalMatch.id } }),
          0,
        );
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
    console.log(
      "chess-runner: E4b disposable PostgreSQL/Valkey gameplay, recovery and source fences passed",
    );
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
      if (prisma && machineIds.size)
        await prisma.verification.deleteMany({
          where: { id: { in: [...machineIds].map((id) => `runner-limits:v1:${id}`) } },
        });
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
