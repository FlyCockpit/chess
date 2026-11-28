/** D2b physical erasure acceptance; only the owned disposable PG/Valkey child runs this. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const syntheticDigest = () => createHash("sha256").update(randomUUID()).digest("hex");

export async function accountDeletionCleanupCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "account-deletion-cleanup");
  const [
    database,
    queues,
    chess,
    cleanup,
    requests,
    jobRegistry,
    publications,
    keys,
    runnerKeys,
    runnerStore,
    suppression,
    catalog,
    official,
    { loadPg },
    orpc,
    router,
  ] = await Promise.all([
    import("../../packages/db/src/index.ts"),
    import("../../packages/queue/src/index.ts"),
    import("../../packages/chess/src/index.ts"),
    import("../../packages/api/src/lib/account-deletion-cleanup.ts"),
    import("../../packages/api/src/lib/account-deletion.ts"),
    import("../../packages/queue/src/chess-job-registry.ts"),
    import("../../packages/api/src/lib/chess-jobs.ts"),
    import("../../packages/queue/src/chess-key-revocation.ts"),
    import("../../packages/queue/src/account-deletion.ts"),
    import("../../apps/server/src/runner-ws-store.ts"),
    import("../backup/account-deletion-suppression.mjs"),
    import("../../packages/api/src/lib/chess-models.ts"),
    import("../../packages/api/src/lib/chess-official.ts"),
    import("../db/lib/prisma.mjs"),
    import(
      createRequire(new URL("../../packages/api/package.json", import.meta.url)).resolve(
        "@orpc/server",
      )
    ),
    import("../../packages/api/src/routers/chess.ts"),
  ]);
  const prisma = database.default;
  const redis = queues.redisConnection;
  const { cleanupAccountDeletion } = cleanup;
  const directory = process.env.ACCOUNT_DELETION_REGISTER_DIR;
  assert.ok(directory, "The disposable fixture supplies its own restricted suppression directory");
  const pg = loadPg();
  const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await observer.connect();
  const ownerIds = [];
  const matchIds = [];
  const verificationIds = [];
  const jobs = [];
  const releases = [];
  const blockers = [];
  const pending = [];
  const marker = `ERASE-PRIVATE-${randomUUID()}`;
  const safeModel = "fixture/d2b-safe-model";
  const originalFetch = globalThis.fetch;
  let worker;
  let workerRun;
  const releaseWorker = deferred();
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/v1/models"))
      return Response.json({
        data: [{ id: safeModel, pricing: { prompt: "0", completion: "0" } }],
      });
    throw new Error("D2b fixture never makes provider or external requests");
  };
  catalog.resetModelCatalogCache();
  const until = async (read, message, milliseconds = 10_000) => {
    const deadline = Date.now() + milliseconds;
    do {
      if (await read()) return;
      await delay(25);
    } while (Date.now() < deadline);
    throw new Error(message);
  };
  const fixture = async (extra = {}) => {
    const user = await prisma.user.create({
      data: { name: marker, email: `${randomUUID()}@example.test`, emailVerified: true, ...extra },
    });
    ownerIds.push(user.id);
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        token: randomUUID(),
        origin: "sign-in",
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return { user, session };
  };
  const makeArchive = (source = "local") => {
    const archive = chess.createMatch(
      {
        title: marker,
        white: { name: marker, model: safeModel, protocol: "openai-chat" },
        black: { name: marker, model: "random", protocol: "random" },
        rules: {},
      },
      source,
    );
    archive.events.push({
      type: "tool",
      seq: 0,
      at: archive.createdAt,
      side: "w",
      ply: 0,
      name: "board",
      input: marker,
      output: marker,
    });
    archive.events.push({
      type: "reservation",
      seq: 1,
      at: archive.createdAt,
      side: "w",
      ply: 0,
      dispatch: 0,
      tokens: 10,
      costMicros: 0,
    });
    archive.events.push({
      type: "reply",
      seq: 2,
      at: archive.createdAt,
      side: "w",
      ply: 0,
      dispatch: 0,
      resolvedModel: marker,
      resolvedProvider: marker,
    });
    chess.submitMove(archive, chess.boardAt(archive), "e2e4", marker);
    chess.submitMove(archive, chess.boardAt(archive), marker, marker, undefined, {
      text: marker,
      stopReason: "completed",
    });
    chess.finishMatch(archive, "*", "cancelled", "stopped");
    return chess.validateArchive(archive);
  };
  const createMatch = async (ownerId, overrides = {}, archive = makeArchive()) => {
    const row = await prisma.chessMatch.create({
      data: {
        ownerId,
        slug: `d2b-${randomUUID()}`,
        title: marker,
        whiteName: marker,
        blackName: marker,
        source: archive.source,
        status: "stopped",
        published: true,
        rulesKey: official.chessDigest(archive.config.rules).slice(0, 16),
        rulesVersion: archive.config.rules.version,
        promptVersion: archive.config.prompt.version,
        promptHash: archive.config.prompt.hash,
        contextMode: archive.config.rules.context,
        identityMode: archive.config.rules.opponentIdentity,
        whiteModel: safeModel,
        whiteProtocol: "openai-chat",
        blackModel: "random",
        blackProtocol: "random",
        archive,
        ...overrides,
      },
    });
    matchIds.push(row.id);
    return row;
  };
  const age = (id) =>
    prisma.user.update({
      where: { id },
      data: { deletionRequestedAt: new Date(Date.now() - 181_000) },
      select: { id: true },
    });
  const phase = (id) =>
    prisma.user.findUniqueOrThrow({
      where: { id },
      select: { deletionState: true, deletionCursor: true, deletionRequestedAt: true },
    });
  const semanticPhase = async (id) => {
    const stored = await phase(id);
    if (stored.deletionState === "pending") return "pending";
    assert.equal(stored.deletionState, "cleaning");
    return JSON.parse(stored.deletionCursor).phase;
  };
  const setPhase = (id, value) =>
    prisma.user.update({
      where: { id },
      data: {
        deletionState: value === "pending" ? "pending" : "cleaning",
        deletionCursor:
          value === "pending" ? null : JSON.stringify({ phase: value, afterId: null }),
      },
    });
  const finish = async (id) => {
    const phases = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await cleanupAccountDeletion(id);
      phases.push(result.phase);
      if (result.complete) return phases;
      assert.ok(
        await prisma.user.findUnique({ where: { id } }),
        "Incomplete cleanup retains its tombstone",
      );
    }
    assert.fail(`Bounded cleanup failed to advance: ${phases.join(",")}`);
  };
  const observedEffects = {
    record: (user) =>
      suppression.appendAccountDeletionSuppression({
        directory,
        userId: user.id,
        requestedAt: user.deletionRequestedAt,
      }),
    keyUseStopped: async (id) => !(await keys.chessKeyLeasesBlocking(redis, id, [], null)),
    runnerUseStopped: async (ids) => !(await runnerKeys.runnerDeletionLeasesBlocking(redis, ids)),
    purgeJobs: jobRegistry.purgeChessJobs,
    retireKeyState: (id) => keys.forgetChessKeyRevocations(redis, id),
  };
  const track = (promise) => {
    pending.push(promise.catch(() => {}));
    return promise;
  };
  const waitForLock = async (count) =>
    until(async () => {
      const rows = await observer.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'",
      );
      return rows.rows[0].n >= count;
    }, "Expected real PostgreSQL advisory-lock contention");
  try {
    // Explicitly seed trusted public metadata. Erasure itself never refreshes
    // the catalog; an unprimed process uses the neutral model-label fallback.
    await catalog.getModelCatalog();
    // A store just started cannot prove former leases ended. Mature only this
    // owned Valkey; the complete gate normally reaches this mode after 60s.
    const started = Date.now();
    for (;;) {
      const info = await redis.info("server");
      const uptime = Number(/^uptime_in_seconds:(\d+)/m.exec(info)?.[1] ?? 0);
      if (uptime >= 60) break;
      assert.ok(Date.now() - started < 65_000, "Disposable lease store must mature within65s");
      await delay(1000);
    }
    const actor = await fixture({ role: "admin", twoFactorEnabled: true });
    const peer = await fixture();
    const target = await fixture();
    const machine = await prisma.runnerMachine.create({
      data: {
        userId: target.user.id,
        displayName: marker,
        credentialDigest: syntheticDigest(),
        credentialPrefix: "synthetic-d2b",
        expiresAt: new Date(Date.now() + 600_000),
        connectionGeneration: 1,
      },
    });
    const malformedMachine = await prisma.runnerMachine.create({
      data: {
        userId: target.user.id,
        displayName: marker,
        credentialDigest: syntheticDigest(),
        credentialPrefix: "synthetic-d2b",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const peerMachine = await prisma.runnerMachine.create({
      data: {
        userId: peer.user.id,
        displayName: "Unrelated machine",
        credentialDigest: syntheticDigest(),
        credentialPrefix: "synthetic-peer",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await prisma.account.create({
      data: {
        userId: target.user.id,
        accountId: randomUUID(),
        providerId: "credential",
        password: `synthetic-password-${marker}`,
      },
    });
    await prisma.account.create({
      data: {
        userId: target.user.id,
        accountId: randomUUID(),
        providerId: "fixture-idp",
        issuer: "https://idp.example.test",
        accessToken: marker,
        refreshToken: marker,
        idToken: marker,
      },
    });
    await prisma.twoFactor.create({
      data: { userId: target.user.id, secret: marker, backupCodes: marker },
    });
    await prisma.apiKey.create({ data: { referenceId: target.user.id, key: syntheticDigest() } });
    await prisma.deviceCode.create({
      data: {
        userId: target.user.id,
        deviceCode: randomUUID(),
        userCode: randomUUID(),
        status: "approved",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await prisma.runnerClaim.create({
      data: {
        userId: target.user.id,
        sessionId: target.session.id,
        machineId: machine.id,
        tokenDigest: syntheticDigest(),
        proofDigest: syntheticDigest(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const { saveOpenRouterConnection } = await import(
      "../../packages/api/src/lib/openrouter-account.ts"
    );
    await saveOpenRouterConnection(target.user.id, "synthetic-d2b-provider-key", {
      label: marker,
      limitMicros: null,
      limitRemainingMicros: null,
      usageMicros: null,
      usageDailyMicros: null,
      expiresAt: null,
    });
    const keyHash = (
      await prisma.openRouterConnection.findUniqueOrThrow({ where: { userId: target.user.id } })
    ).keyHash;
    const prefix = randomUUID();
    const published = [];
    for (let index = 0; index < 52; index++) {
      const hidden = index === 51;
      published.push(
        await createMatch(
          target.user.id,
          {
            id: `${prefix}-${String(index).padStart(4, "0")}`,
            ...(hidden
              ? {
                  hiddenAt: new Date(),
                  moderationReason: "privacy",
                  moderationNote: "Reviewed privacy grounds",
                  moderationVersion: 1,
                  source: "runner",
                  credentialSource: "runner-local",
                  runnerMachineId: machine.id,
                  runnerState: "stopped",
                }
              : {}),
          },
          makeArchive(index === 0 ? "hosted" : "local"),
        ),
      );
    }
    const privateArchive = makeArchive("hosted");
    const privateOfficial = await createMatch(
      target.user.id,
      {
        published: false,
        status: "queued",
        credentialSource: "owner-openrouter",
        OfficialEntry: { create: official.officialCommitment(privateArchive, "owner-openrouter") },
        Creation: {
          create: {
            id: createHash("sha256").update(randomUUID()).digest("hex"),
            configDigest: createHash("sha256").update(randomUUID()).digest("hex"),
          },
        },
      },
      privateArchive,
    );
    const privateLocal = await createMatch(target.user.id, {
      published: false,
      source: "runner",
      credentialSource: "runner-local",
      runnerMachineId: machine.id,
      runnerState: "stopped",
    });
    const peerGame = await createMatch(peer.user.id);
    const ownReport = await prisma.chessReplayReport.create({
      data: {
        matchId: peerGame.id,
        reporterId: target.user.id,
        dedupKey: syntheticDigest(),
        reason: "privacy",
        note: marker,
      },
    });
    const peerReport = await prisma.chessReplayReport.create({
      data: {
        matchId: published[51].id,
        reporterId: peer.user.id,
        dedupKey: syntheticDigest(),
        reason: "privacy",
        note: "Unrelated reporter evidence",
      },
    });
    const action = await prisma.chessModerationAction.create({
      data: {
        matchId: published[51].id,
        actorId: target.user.id,
        hidden: true,
        reason: "privacy",
        note: "Reviewed privacy grounds",
      },
    });
    const { runnerMatchConfigSchema, runnerConfigDigest } = await import(
      "../../packages/chess/src/runner-protocol.ts"
    );
    const config = runnerMatchConfigSchema.parse({
      title: marker,
      white: privateArchive.config.white,
      black: privateArchive.config.black,
      rules: privateArchive.config.rules,
      initialFen: privateArchive.config.initialFen,
      promptVersion: "1",
    });
    for (const [index, match] of [published[51], privateLocal].entries()) {
      const commandId = randomUUID();
      await prisma.runnerCommand.create({
        data: {
          id: commandId,
          matchId: match.id,
          kind: "offer",
          revision: 1,
          payload: { commandId, configDigest: runnerConfigDigest(config), config },
          ackedAt: new Date(),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      await prisma.runnerEvent.create({
        data: {
          id: `${prefix}-receipt-${index}`,
          matchId: match.id,
          payloadDigest: createHash("sha256").update(marker).digest("hex"),
        },
      });
    }
    const leaseStore = runnerStore.createRunnerLeaseStore(redis);
    const lease = {
      machineId: machine.id,
      userId: target.user.id,
      generation: 1,
      connectionId: randomUUID(),
      ip: "192.0.2.74",
    };
    assert.equal(await leaseStore.reserveIp(lease.ip, lease.connectionId), true);
    assert.equal(await leaseStore.acquire(lease), true);
    releases.push(() => leaseStore.release(lease));
    await keys.holdChessKeyLease(redis, target.user.id, "d2b-live-key", keyHash);
    await keys.recordChessKeyRevoked(redis, target.user.id, keyHash, () => {});
    releases.push(() => keys.releaseChessKeyLease(redis, target.user.id, "d2b-live-key", keyHash));
    const acceptance = await requests.requestAccountDeletion(target.user.id, {
      kind: "self",
      sessionId: target.session.id,
    });
    assert.equal(acceptance.complete, false);
    assert.equal(acceptance.status, "pending");
    const records = await suppression.readAccountDeletionSuppressions(directory);
    assert.ok(
      records.some(
        (record) => record.subjectHash === suppression.accountDeletionSubjectHash(target.user.id),
      ),
      "Successful request already has its external suppression, before physical erasure",
    );
    assert.equal(JSON.stringify(records).includes(target.user.id), false);
    assert.equal(JSON.stringify(records).includes(target.user.email), false);
    assert.equal(await prisma.session.count({ where: { userId: target.user.id } }), 0);
    assert.equal(await prisma.apiKey.count({ where: { referenceId: target.user.id } }), 0);
    assert.equal(await prisma.deviceCode.count({ where: { userId: target.user.id } }), 0);
    assert.equal(await prisma.openRouterConnection.count({ where: { userId: target.user.id } }), 0);
    const ledgerBefore = await prisma.chessOfficialEntry.findUniqueOrThrow({
      where: { matchId: privateOfficial.id },
    });
    assert.equal(ledgerBefore.state, "withdrawal");
    assert.equal(ledgerBefore.cause, "owner-delete");
    const creation = await prisma.chessCreation.findUniqueOrThrow({
      where: { matchId: privateOfficial.id },
    });
    assert.equal((await cleanupAccountDeletion(target.user.id)).complete, false);
    assert.deepEqual(
      await cleanupAccountDeletion(target.user.id),
      { complete: false, phase: "stopping" },
      "Fresh acceptance cannot finish before its quiet window",
    );
    await age(target.user.id);
    assert.deepEqual(
      await cleanupAccountDeletion(target.user.id),
      { complete: false, phase: "stopping" },
      "A missed key invalidation cannot erase a live key lease",
    );
    await keys.releaseChessKeyLease(redis, target.user.id, "d2b-live-key", keyHash);
    assert.deepEqual(
      await cleanupAccountDeletion(target.user.id),
      { complete: false, phase: "stopping" },
      "A revoked old-generation runner lease still blocks physical completion",
    );
    assert.equal(await redis.exists(runnerKeys.runnerMachineLeaseKey(machine.id)), 1);
    await leaseStore.release(lease);
    assert.deepEqual(await cleanupAccountDeletion(target.user.id), {
      complete: false,
      phase: "matches",
    });

    // Delayed pre-fence writes and non-FK rows are exercised after the request's
    // immediate revoker; these are synthetic DB inserts, never an auth bypass.
    const challenge = `2fa-${randomUUID()}`;
    const definitions = [
      { identifier: `reset-password:${randomUUID()}`, value: target.user.id },
      { identifier: challenge, value: target.user.id },
      { identifier: `2fa-attempts-${challenge}`, value: "1" },
      {
        identifier: `2fa-otp-${target.user.id}!${target.session.id}`,
        value: "synthetic-session-otp",
      },
      { identifier: `${challenge}:credential:fixture`, value: target.user.id },
      { identifier: `trust-device-${randomUUID()}`, value: target.user.id },
      {
        identifier: `auth-state:${randomUUID()}`,
        value: JSON.stringify({ link: { userId: target.user.id, email: target.user.email } }),
      },
      {
        identifier: `runner-limits:v1:${machine.id}`,
        value: JSON.stringify({ userId: target.user.id, machineId: machine.id }),
      },
      { identifier: `runner-limits:v1:${malformedMachine.id}`, value: "malformed state" },
      {
        identifier: `runner-limit-proof:v1:${syntheticDigest()}`,
        value: JSON.stringify({
          userId: target.user.id,
          sessionId: target.session.id,
          machineId: machine.id,
        }),
      },
      {
        identifier: `runner-limit-totp:v1:${createHash("sha256").update(target.user.id).update("\0").update("123456").digest("hex")}`,
        value: target.user.id,
      },
      ...Array.from({ length: 125 }, () => ({
        identifier: `reset-password-mailed:${randomUUID()}`,
        value: JSON.stringify({ userId: target.user.id, email: target.user.email }),
      })),
      ...Array.from({ length: 105 }, () => ({
        identifier: `2fa-otp-${challenge}`,
        value: "synthetic-otp",
      })),
    ];
    const ownVerificationIds = definitions.map(() => randomUUID());
    const peerDefinitions = [
      { identifier: `reset-password:${randomUUID()}`, value: peer.user.id },
      {
        identifier: `reset-password-mailed:${randomUUID()}`,
        value: JSON.stringify({ userId: peer.user.id, email: peer.user.email }),
      },
      {
        identifier: `auth-state:${randomUUID()}`,
        value: JSON.stringify({ link: { userId: peer.user.id, email: peer.user.email } }),
      },
      { identifier: `reset-password-mailed:${randomUUID()}`, value: "{broken-json" },
      {
        identifier: `runner-limits:v1:${peerMachine.id}`,
        value: JSON.stringify({ userId: peer.user.id, machineId: peerMachine.id }),
      },
      {
        identifier: `runner-limit-proof:v1:${syntheticDigest()}`,
        value: JSON.stringify({
          userId: peer.user.id,
          sessionId: peer.session.id,
          machineId: peerMachine.id,
        }),
      },
      { identifier: `runner-limit-totp:v1:${syntheticDigest()}`, value: peer.user.id },
    ];
    const peerVerificationIds = peerDefinitions.map(() => randomUUID());
    verificationIds.push(...ownVerificationIds, ...peerVerificationIds);
    await prisma.verification.createMany({
      data: [...definitions, ...peerDefinitions].map((data, index) => ({
        id: verificationIds[index],
        ...data,
        expiresAt: new Date(Date.now() + 600_000),
      })),
    });

    // Both a retained result and a genuinely active BullMQ job must be erased.
    const activeEntered = deferred();
    const activeId = `d2b-active-${randomUUID()}`;
    const finishedId = `d2b-finished-${randomUUID()}`;
    for (const id of [finishedId, activeId]) {
      await jobRegistry.registerChessJob(published[0].id, "run", id);
      await queues.chessRunQueue.add(
        "d2b-fixture",
        { matchId: published[0].id },
        { jobId: id, removeOnComplete: false, removeOnFail: false },
      );
      jobs.push(id);
    }
    const workerConnection = queues.createRedisConnection();
    worker = new queues.Worker(
      queues.QUEUE_NAMES.chessRun,
      async (job) => {
        if (job.id === activeId) {
          activeEntered.resolve();
          await releaseWorker.promise;
        }
        return marker;
      },
      { connection: workerConnection, concurrency: 1, autorun: false },
    );
    worker.on("error", () => {});
    workerRun = worker.run();
    pending.push(workerRun.catch(() => {}));
    releases.push(async () => {
      await worker.close();
      workerConnection.disconnect();
    });
    await Promise.race([
      activeEntered.promise,
      delay(10_000).then(() => {
        throw new Error("Owned BullMQ fixture never became active");
      }),
    ]);
    assert.equal(await (await queues.chessRunQueue.getJob(activeId)).getState(), "active");
    assert.equal((await queues.chessRunQueue.getJob(finishedId)).returnvalue, marker);
    assert.deepEqual(await cleanupAccountDeletion(target.user.id), {
      complete: false,
      phase: "matches",
    });
    assert.equal(
      (await prisma.chessMatch.findUniqueOrThrow({ where: { id: published[0].id } })).ownerId,
      target.user.id,
    );
    releaseWorker.resolve();
    await until(
      async () => (await (await queues.chessRunQueue.getJob(activeId)).getState()) === "completed",
      "Owned job must finish before erasure proceeds",
    );
    await worker.close();
    workerConnection.disconnect();
    await workerRun;
    worker = undefined;
    const phases = await finish(target.user.id);
    assert.ok(
      phases.filter((value) => value === "matches").length >= 1,
      "52 retained games cross the50-row boundary",
    );
    assert.ok(
      phases.filter((value) => value === "verifications").length >= 2,
      "More than200 non-FK rows cross bounded deletion pages",
    );
    assert.equal(await prisma.user.count({ where: { id: target.user.id } }), 0);
    assert.equal(await keys.isChessKeyRevoked(redis, target.user.id, keyHash), false);
    for (const [delegate, where] of [
      [prisma.account, { userId: target.user.id }],
      [prisma.twoFactor, { userId: target.user.id }],
      [prisma.runnerMachine, { userId: target.user.id }],
      [prisma.runnerClaim, { userId: target.user.id }],
      [prisma.session, { userId: target.user.id }],
      [prisma.apiKey, { referenceId: target.user.id }],
      [prisma.deviceCode, { userId: target.user.id }],
      [prisma.openRouterConnection, { userId: target.user.id }],
    ])
      assert.equal(await delegate.count({ where }), 0);
    assert.equal(await prisma.verification.count({ where: { id: { in: ownVerificationIds } } }), 0);
    assert.equal(
      await prisma.verification.count({ where: { id: { in: peerVerificationIds } } }),
      peerVerificationIds.length,
    );
    assert.equal(
      await prisma.runnerMachine.count({ where: { id: peerMachine.id, userId: peer.user.id } }),
      1,
    );
    assert.equal(await prisma.session.count({ where: { id: peer.session.id } }), 1);
    assert.equal(
      await prisma.chessMatch.count({
        where: { id: { in: [privateOfficial.id, privateLocal.id] } },
      }),
      0,
    );
    const retained = await prisma.chessMatch.findMany({
      where: { id: { in: published.map((row) => row.id) } },
      take: 53,
    });
    assert.equal(retained.length, 52);
    for (const row of retained) {
      const original = published.find((value) => value.id === row.id);
      assert.equal(row.ownerId, null);
      assert.equal(row.runnerMachineId, null);
      assert.equal(row.published, true);
      assert.notEqual(row.slug, original.slug);
      assert.notEqual(row.publicId, original.publicId);
      assert.equal(row.title, "Deleted user");
      assert.equal(row.archive.config.white.model, safeModel);
      assert.equal(chess.boardAt(row.archive).fen(), chess.boardAt(original.archive).fen());
      assert.equal(JSON.stringify(row.archive).includes(marker), false);
      assert.equal(
        row.archive.events.some((event) => event.type === "tool" || event.type === "reply"),
        false,
      );
    }
    assert.equal(
      retained.find((row) => row.id === published[51].id).hiddenAt.getTime(),
      published[51].hiddenAt.getTime(),
    );
    assert.equal(await prisma.runnerCommand.count({ where: { matchId: { in: matchIds } } }), 0);
    assert.equal(await prisma.runnerEvent.count({ where: { matchId: { in: matchIds } } }), 0);
    assert.equal(await prisma.chessReplayReport.count({ where: { id: ownReport.id } }), 0);
    assert.equal(await prisma.chessReplayReport.count({ where: { id: peerReport.id } }), 1);
    assert.equal(
      (await prisma.chessModerationAction.findUniqueOrThrow({ where: { id: action.id } })).actorId,
      null,
    );
    assert.deepEqual(
      await prisma.chessOfficialEntry.findUniqueOrThrow({ where: { id: ledgerBefore.id } }),
      { ...ledgerBefore, matchId: null },
    );
    assert.deepEqual(await prisma.chessCreation.findUniqueOrThrow({ where: { id: creation.id } }), {
      ...creation,
      matchId: null,
    });
    for (const id of jobs) assert.equal(await queues.chessRunQueue.getJob(id), undefined);
    assert.equal(await redis.exists(`cockpit-chess:match-jobs:${published[0].id}`), 0);
    const api = orpc.createRouterClient(router.chessRouter, {
      context: { session: null, clientIp: "192.0.2.74" },
    });
    await assert.rejects(api.get({ slug: published[0].slug }), { code: "NOT_FOUND" });
    await assert.rejects(api.get({ slug: privateLocal.slug }), { code: "NOT_FOUND" });
    const publicGame = await api.get({
      slug: retained.find((row) => row.id === published[0].id).slug,
    });
    assert.equal(publicGame.anonymized, true);
    assert.equal(JSON.stringify(publicGame).includes(marker), false);
    const safeBackfillId = queues.chessSpectatorJobId(published[0].id, 0, {
      purpose: "public",
      version: 0,
    });
    await until(
      async () => !!(await queues.chessReconcileQueue.getJob(safeBackfillId)),
      "A retained anonymous replay may request fresh public-only evaluation",
    );
    const safeBackfill = await queues.chessReconcileQueue.getJob(safeBackfillId);
    assert.deepEqual(safeBackfill.data.access, { purpose: "public", version: 0 });
    assert.equal(JSON.stringify(safeBackfill.data).includes(target.user.id), false);
    assert.deepEqual(await cleanupAccountDeletion(target.user.id), {
      complete: true,
      phase: "complete",
    });
    console.log(
      "D2b: default real PG/Redis cleanup retained52 scrubbed replays, erased private/FK/non-FK/job data, preserved moderation/official starts, respected fresh/key/runner/active-job fences and stable retries",
    );

    // Faults in every stored phase retain the same fence and permit retry.
    const fault = await fixture();
    const corrupt = await createMatch(fault.user.id);
    const acceptedAdmin = await requests.requestAccountDeletion(fault.user.id, {
      kind: "admin",
      userId: actor.user.id,
      sessionId: actor.session.id,
    });
    assert.equal(acceptedAdmin.complete, false);
    await age(fault.user.id);
    for (const value of ["pending", "stopping", "matches", "verifications", "finalizing"]) {
      await setPhase(fault.user.id, value);
      const before = await phase(fault.user.id);
      await assert.rejects(
        cleanupAccountDeletion(fault.user.id, {
          ...observedEffects,
          record: async () => {
            throw new Error("synthetic external register failure");
          },
        }),
      );
      assert.deepEqual(await phase(fault.user.id), before);
      assert.equal(
        await prisma.chessMatch.count({ where: { id: corrupt.id, ownerId: fault.user.id } }),
        1,
      );
    }
    await setPhase(fault.user.id, "stopping");
    await assert.rejects(
      cleanupAccountDeletion(fault.user.id, {
        ...observedEffects,
        keyUseStopped: async () => {
          throw new Error("synthetic Redis uncertainty");
        },
      }),
    );
    assert.equal(await semanticPhase(fault.user.id), "stopping");
    assert.equal(
      (
        await cleanupAccountDeletion(fault.user.id, {
          ...observedEffects,
          runnerUseStopped: async () => false,
        })
      ).phase,
      "stopping",
    );
    await setPhase(fault.user.id, "matches");
    await assert.rejects(
      cleanupAccountDeletion(fault.user.id, {
        ...observedEffects,
        purgeJobs: async () => {
          throw new Error("synthetic queue uncertainty");
        },
      }),
    );
    await prisma.chessMatch.update({
      where: { id: corrupt.id },
      data: { archive: { format: "invalid-archive" } },
    });
    await assert.rejects(cleanupAccountDeletion(fault.user.id));
    assert.equal(await semanticPhase(fault.user.id), "matches");
    assert.equal(
      (await prisma.chessMatch.findUniqueOrThrow({ where: { id: corrupt.id } })).ownerId,
      fault.user.id,
    );
    await prisma.chessMatch.update({ where: { id: corrupt.id }, data: { archive: makeArchive() } });
    await finish(fault.user.id);
    console.log(
      "D2b: every-phase register failure, Redis/key/runner/queue uncertainty and corrupt retained archive stay pending; corrected evidence retries to completion",
    );

    // Publication admitted first: deletion waits, then erases the queued hint.
    const race = await fixture();
    const raceGame = await createMatch(
      race.user.id,
      { published: false, status: "queued" },
      makeArchive("hosted"),
    );
    const entered = deferred();
    const release = deferred();
    releases.push(() => {
      release.resolve();
    });
    const raceJobId = `d2b-race-${randomUUID()}`;
    jobs.push(raceJobId);
    const publishing = track(
      publications.withChessJobPublication(raceGame.id, "run", async (guard) => {
        entered.resolve();
        await release.promise;
        return jobRegistry.publishRegisteredChessJob(
          raceGame.id,
          "run",
          "chess-run",
          { matchId: raceGame.id },
          raceJobId,
          guard,
        );
      }),
    );
    await Promise.race([
      entered.promise,
      publishing.then(
        () => {
          throw new Error("Publication returned before acquiring its owner fence");
        },
        (error) => {
          throw error;
        },
      ),
      delay(10_000).then(() => {
        throw new Error("Publication never reached its owner fence");
      }),
    ]);
    const deleting = track(
      requests.requestAccountDeletion(race.user.id, { kind: "self", sessionId: race.session.id }),
    );
    await waitForLock(1);
    release.resolve();
    await publishing;
    assert.equal((await deleting).complete, false);
    assert.ok(await queues.chessRunQueue.getJob(raceJobId));
    await age(race.user.id);
    await finish(race.user.id);
    assert.equal(await queues.chessRunQueue.getJob(raceJobId), undefined);

    // Deletion queued first: a publisher that captured the old owner still
    // cannot register or publish after the tombstone wins the same lock.
    const reverse = await fixture();
    const reverseGame = await createMatch(
      reverse.user.id,
      { published: false, status: "queued" },
      makeArchive("hosted"),
    );
    const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    blockers.push(blocker);
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `cli-credentials:${reverse.user.id}`,
    ]);
    const reverseDeletion = track(
      requests.requestAccountDeletion(reverse.user.id, {
        kind: "self",
        sessionId: reverse.session.id,
      }),
    );
    await waitForLock(1);
    let lateWrites = 0;
    const latePublication = track(
      publications.withChessJobPublication(reverseGame.id, "run", async () => {
        lateWrites++;
      }),
    );
    await waitForLock(2);
    await blocker.query("COMMIT");
    await reverseDeletion;
    await latePublication;
    assert.equal(lateWrites, 0);
    await age(reverse.user.id);
    await finish(reverse.user.id);
    console.log(
      "D2b: real credential-lock publication/delete races pass both orders; accepted old jobs are purged and late captured owners cannot publish",
    );

    // A paused after-hook may resume on any replica long after completion.
    // Exercise the actual sign-in context and proof writer on real Postgres;
    // the barrier is before its insertion transaction, never a clock guess.
    const signInFence = await import("../../packages/auth/src/password-sign-in-fence.ts");
    const delayedHook = await fixture();
    await prisma.account.create({
      data: {
        userId: delayedHook.user.id,
        accountId: delayedHook.user.id,
        providerId: "credential",
        password: "synthetic-credential-snapshot",
      },
    });
    const hookEntered = deferred();
    const hookRelease = deferred();
    releases.push(() => {
      hookRelease.resolve();
    });
    const hookIdentifier = `2fa-${randomUUID().replaceAll("-", "")}`;
    const hookWriter = track(
      signInFence.withPasswordSignInFence(
        new Request("https://app.example.test/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: delayedHook.user.email,
            password: "synthetic-password-proof",
          }),
        }),
        async () => {
          const challenge = await prisma.verification.create({
            data: {
              identifier: hookIdentifier,
              value: delayedHook.user.id,
              expiresAt: new Date(Date.now() + 600_000),
            },
          });
          verificationIds.push(challenge.id);
          hookEntered.resolve();
          await hookRelease.promise;
          await signInFence.recordTwoFactorChallenge(challenge);
          return Response.json({});
        },
      ),
    );
    await Promise.race([
      hookEntered.promise,
      hookWriter.then(() => {
        throw new Error("Expected paused proof writer");
      }),
    ]);
    await requests.requestAccountDeletion(delayedHook.user.id, {
      kind: "self",
      sessionId: delayedHook.session.id,
    });
    await age(delayedHook.user.id);
    await finish(delayedHook.user.id);
    assert.equal(await prisma.user.count({ where: { id: delayedHook.user.id } }), 0);
    hookRelease.resolve();
    await assert.rejects(hookWriter, /Session refused/);
    assert.equal(
      await prisma.verification.count({ where: { value: delayedHook.user.id } }),
      0,
      "A resumed sign-in after-hook must not recreate an erased owner's proof",
    );

    // The adapter's public database dependency supplies an execution barrier
    // immediately before the real owner advisory-lock SQL. Every ownership
    // query and insert still runs against its real transaction client.
    const delayedAdapterOwner = await fixture();
    const adapterEntered = deferred();
    const adapterRelease = deferred();
    releases.push(() => {
      adapterRelease.resolve();
    });
    let blocked = false;
    const delayedDatabase = new Proxy(prisma, {
      get(target, property) {
        if (property === "$transaction")
          return (callback, options) =>
            target.$transaction(
              (tx) =>
                callback(
                  new Proxy(tx, {
                    get(client, operation) {
                      if (operation === "$executeRaw")
                        return async (strings, ...values) => {
                          if (
                            !blocked &&
                            strings.join("?").includes("pg_advisory_xact_lock") &&
                            values[0] === `cli-credentials:${delayedAdapterOwner.user.id}`
                          ) {
                            blocked = true;
                            adapterEntered.resolve();
                            await adapterRelease.promise;
                          }
                          return client.$executeRaw(strings, ...values);
                        };
                      const value = Reflect.get(client, operation);
                      return typeof value === "function" ? value.bind(client) : value;
                    },
                  }),
                ),
              options,
            );
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { createCredentialSetupAdapter } = await import(
      "../../packages/auth/src/credential-setup-adapter.ts"
    );
    const delayedAdapter = createCredentialSetupAdapter(delayedDatabase)({});
    const adapterIdentifier = `trust-device-${randomUUID()}`;
    const adapterWriter = track(
      delayedAdapter.create({
        model: "verification",
        data: {
          identifier: adapterIdentifier,
          value: delayedAdapterOwner.user.id,
          expiresAt: new Date(Date.now() + 600_000),
        },
      }),
    );
    await Promise.race([
      adapterEntered.promise,
      adapterWriter.then(() => {
        throw new Error("Expected paused adapter writer");
      }),
    ]);
    await requests.requestAccountDeletion(delayedAdapterOwner.user.id, {
      kind: "self",
      sessionId: delayedAdapterOwner.session.id,
    });
    await age(delayedAdapterOwner.user.id);
    await finish(delayedAdapterOwner.user.id);
    adapterRelease.resolve();
    await assert.rejects(adapterWriter, { status: "UNAUTHORIZED" });
    assert.equal(await prisma.verification.count({ where: { identifier: adapterIdentifier } }), 0);
    console.log(
      "D2b: actual PG after-hook and adapter writers paused before owner insertion cannot recreate non-FK proofs after completed erasure",
    );

    // Run the pinned HTTP endpoint with the production proof adapter and
    // response normalizer. No real mail transport enters this fixture.
    const authRequire = createRequire(new URL("../../packages/auth/package.json", import.meta.url));
    const [
      { betterAuth },
      { createAuthMiddleware },
      { neutralizeUnavailablePasswordResetResponse },
    ] = await Promise.all([
      import(authRequire.resolve("better-auth")),
      import(authRequire.resolve("better-auth/api")),
      import("../../packages/auth/src/password-reset-links.ts"),
    ]);
    let recoveryMailCalls = 0;
    let recoveryIp = 80;
    const recovery = betterAuth({
      baseURL: "https://app.example.test",
      secret: "synthetic-disposable-d2b-recovery-secret-only",
      trustedOrigins: ["https://app.example.test"],
      database: createCredentialSetupAdapter(prisma),
      advanced: {
        disableOriginCheck: false,
        disableCSRFCheck: false,
        // Each case is a separate synthetic caller. Keep the real recovery
        // limiter enabled instead of sharing its missing-IP fallback bucket.
        ipAddress: { ipAddressHeaders: ["x-d2b-fixture-ip"] },
      },
      emailAndPassword: {
        enabled: true,
        sendResetPassword: async () => {
          recoveryMailCalls++;
        },
      },
      hooks: {
        after: createAuthMiddleware(async (context) => {
          if (context.path === "/request-password-reset")
            return neutralizeUnavailablePasswordResetResponse(context);
        }),
      },
    });
    const recoveryRequest = (email) =>
      recovery.handler(
        new Request("https://app.example.test/api/auth/request-password-reset", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://app.example.test",
            "x-d2b-fixture-ip": `192.0.2.${recoveryIp++}`,
          },
          body: JSON.stringify({ email, redirectTo: "/en-US/reset-password" }),
        }),
      );
    const pendingRecovery = await fixture();
    await requests.requestAccountDeletion(pendingRecovery.user.id, {
      kind: "self",
      sessionId: pendingRecovery.session.id,
    });
    const missingRecoveryResponse = await recoveryRequest(`unknown-${randomUUID()}@example.test`);
    assert.equal(missingRecoveryResponse.status, 200);
    const neutralRecovery = await missingRecoveryResponse.text();
    assert.deepEqual(JSON.parse(neutralRecovery), {
      status: true,
      message: "If this email exists in our system, check your email for the reset link",
    });
    const pendingRecoveryResponse = await recoveryRequest(pendingRecovery.user.email);
    assert.equal(pendingRecoveryResponse.status, 200);
    assert.equal(await pendingRecoveryResponse.text(), neutralRecovery);
    assert.equal(await prisma.verification.count({ where: { value: pendingRecovery.user.id } }), 0);
    await age(pendingRecovery.user.id);
    await finish(pendingRecovery.user.id);
    const erasedRecoveryResponse = await recoveryRequest(pendingRecovery.user.email);
    assert.equal(erasedRecoveryResponse.status, 200);
    assert.equal(await erasedRecoveryResponse.text(), neutralRecovery);
    assert.equal(recoveryMailCalls, 0);
    assert.equal(await prisma.verification.count({ where: { value: pendingRecovery.user.id } }), 0);
    const activeRecovery = await fixture();
    const activeRecoveryResponse = await recoveryRequest(activeRecovery.user.email);
    assert.equal(activeRecoveryResponse.status, 200);
    assert.equal(await activeRecoveryResponse.text(), neutralRecovery);
    assert.equal(recoveryMailCalls, 1);
    assert.equal(await prisma.verification.count({ where: { value: activeRecovery.user.id } }), 1);
    await requests.requestAccountDeletion(activeRecovery.user.id, {
      kind: "self",
      sessionId: activeRecovery.session.id,
    });
    await age(activeRecovery.user.id);
    await finish(activeRecovery.user.id);
    console.log(
      "D2b: actual PG recovery HTTP is identical200 for missing/pending/erased accounts with0proofs/0mail; active positive creates one proof and fixture-only mail callback",
    );

    // Pause the actual impersonation before-hook after it validated the actor
    // and attached its insertion grant. No post-insert compensation is allowed
    // to erase evidence of an incorrectly admitted late session in this test.
    const { auth: productionAuth } = await import("../../packages/auth/src/index.ts");
    const productionOptions = (await productionAuth.$context).options;
    const productionSessionHooks = productionOptions.databaseHooks?.session?.create;
    assert.equal(typeof productionSessionHooks?.before, "function");
    const impersonationActor = await fixture({ role: "admin" });
    const impersonationPassword = `Synthetic-impersonation-${randomUUID()}`;
    const impersonationHash = await (await productionAuth.$context).password.hash(
      impersonationPassword,
    );
    await prisma.account.create({
      data: {
        userId: impersonationActor.user.id,
        accountId: impersonationActor.user.id,
        providerId: "credential",
        password: impersonationHash,
      },
    });
    const impersonationEntered = deferred();
    const impersonationRelease = deferred();
    releases.push(() => {
      impersonationRelease.resolve();
    });
    let impersonationCompensations = 0;
    const origin = new URL(productionOptions.baseURL).origin;
    const pausedAuth = betterAuth({
      ...productionOptions,
      database: createCredentialSetupAdapter(prisma),
      databaseHooks: {
        ...productionOptions.databaseHooks,
        session: {
          create: {
            before: async (session, context) => {
              const result = await productionSessionHooks.before(session, context);
              if (session.impersonatedBy === impersonationActor.user.id) {
                impersonationEntered.resolve();
                await impersonationRelease.promise;
              }
              return result;
            },
            after: async (session, context) => {
              if (session.impersonatedBy === impersonationActor.user.id) {
                impersonationCompensations++;
                throw new Error("Synthetic post-insert compensation unavailable");
              }
              await productionSessionHooks.after?.(session, context);
            },
          },
        },
      },
    });
    const impersonationSignInRequest = new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: impersonationActor.user.email,
        password: impersonationPassword,
      }),
    });
    const impersonationSignIn = await signInFence.withPasswordSignInFence(
      impersonationSignInRequest,
      () => pausedAuth.handler(impersonationSignInRequest),
    );
    assert.equal(
      impersonationSignIn.status,
      200,
      "Genuine primary sign-in must precede impersonation",
    );
    const actorCookie = impersonationSignIn.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    assert.ok(actorCookie, "The impersonation actor must hold its genuine browser session");
    await prisma.user.update({
      where: { id: impersonationActor.user.id },
      data: { twoFactorEnabled: true },
    });
    const peerSessionsBefore = await prisma.session.findMany({
      where: { userId: peer.user.id },
      select: { id: true, token: true, impersonatedBy: true },
      orderBy: { id: "asc" },
      take: 100,
    });
    assert.ok(peerSessionsBefore.some((session) => session.id === peer.session.id));
    const impersonating = track(
      pausedAuth.handler(
        new Request(`${origin}/api/auth/admin/impersonate-user`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie: actorCookie },
          body: JSON.stringify({ userId: peer.user.id }),
        }),
      ),
    );
    await Promise.race([
      impersonationEntered.promise,
      impersonating.then((response) => {
        throw new Error(
          `Impersonation returned before the validated insertion barrier (${response.status})`,
        );
      }),
      delay(10_000).then(() => {
        throw new Error("Impersonation never reached the validated before-hook");
      }),
    ]);
    const impersonationRemoval = await requests.requestAccountDeletion(impersonationActor.user.id, {
      kind: "admin",
      userId: actor.user.id,
      sessionId: actor.session.id,
    });
    assert.equal(impersonationRemoval.complete, false);
    await age(impersonationActor.user.id);
    await finish(impersonationActor.user.id);
    assert.equal(await prisma.user.count({ where: { id: impersonationActor.user.id } }), 0);
    impersonationRelease.resolve();
    const impersonationResponse = await impersonating;
    assert.ok(
      impersonationResponse.status >= 400,
      "Late impersonation cannot gain a peer session after actor erasure",
    );
    assert.equal(
      impersonationCompensations,
      0,
      "The adapter must refuse before insertion or any compensating after-hook",
    );
    assert.equal(
      await prisma.session.count({ where: { impersonatedBy: impersonationActor.user.id } }),
      0,
    );
    const peerSessionsAfter = await prisma.session.findMany({
      where: { userId: peer.user.id },
      select: { id: true, token: true, impersonatedBy: true },
      orderBy: { id: "asc" },
      take: 100,
    });
    assert.deepEqual(
      peerSessionsAfter,
      peerSessionsBefore,
      "Every existing peer session remains unchanged",
    );
    assert.equal(JSON.stringify(peerSessionsAfter).includes(impersonationActor.user.id), false);
    console.log(
      "D2b: real Better Auth impersonation paused after the production before-hook cannot retain an erased actor ID; no compensation ran and peer sessions survive unchanged",
    );
  } finally {
    releaseWorker.resolve();
    for (const release of releases.reverse())
      await Promise.resolve()
        .then(release)
        .catch(() => {});
    await worker?.close().catch(() => {});
    await workerRun?.catch(() => {});
    for (const blocker of blockers) {
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end().catch(() => {});
    }
    await Promise.allSettled(pending);
    for (const id of jobs) {
      const job = await queues.chessRunQueue.getJob(id);
      await job?.remove();
    }
    for (const matchId of matchIds) {
      let purged = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await jobRegistry.purgeChessJobs(matchId)) {
          purged = true;
          break;
        }
      }
      assert.equal(purged, true, "Owned fixture registry cleanup must finish");
    }
    await prisma.verification.deleteMany({ where: { id: { in: verificationIds } } });
    await prisma.chessMatch.deleteMany({ where: { id: { in: matchIds } } });
    await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
    await observer.end();
    catalog.resetModelCatalogCache();
    globalThis.fetch = originalFetch;
  }
}
