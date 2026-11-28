/** Actual PostgreSQL portability and access fences, only in owned disposable services. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function accountExportCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "account-export");
  const [database, exports, chess, locks, revocation, { loadPg }] = await Promise.all([
    import("../../packages/db/src/index.ts"),
    import("../../packages/api/src/lib/account-export.ts"),
    import("../../packages/chess/src/index.ts"),
    import("../../packages/auth/src/device-redemption-lock.ts"),
    import("../../packages/auth/src/credential-revocation.ts"),
    import("../db/lib/prisma.mjs"),
  ]);
  const prisma = database.default;
  const { assertAccountExportAuthority, streamAccountExport } = exports;
  const pg = loadPg();
  const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await observer.connect();
  const owners = [];
  const verificationIds = [];
  const reportIds = [];
  const moderationActionIds = [];
  const reportDedupKeys = [];
  const blockers = [];
  const pending = [];
  const suffix = randomUUID();
  const secrets = [
    "password-hash",
    "access-token",
    "refresh-token",
    "id-token",
    "session-token",
    "two-factor-secret",
    "two-factor-backup",
    "api-key-digest",
    "device-code",
    "user-code",
    "runner-digest",
    "claim-token-digest",
    "claim-proof-digest",
    "provider-ciphertext",
    "provider-nonce",
    "provider-secret-id",
    "reset-proof",
    "runner-limit-proof",
    "runner-limit-totp",
    "runner-state-invalid",
    "foreign-report-note",
    "anonymous-report-note",
    "moderation-audit-only",
  ].map((name) => `synthetic-${name}-${suffix}`);
  const secret = (name) => `synthetic-${name}-${suffix}`;
  const collect = async (authority, format = "json") => {
    let value = "";
    for await (const chunk of streamAccountExport(authority, format)) value += chunk;
    return value;
  };
  const fixture = async (extra = {}) => {
    const id = `export-${randomUUID()}`;
    owners.push(id);
    const user = await prisma.user.create({
      data: {
        id,
        name: `Export owner ${id}`,
        email: `${id}@example.test`,
        emailVerified: true,
        ...extra,
      },
    });
    const session = await prisma.session.create({
      data: {
        userId: id,
        token: `${secret("session-token")}-${id}`,
        origin: "sign-in",
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return { user, session, authority: { userId: id, sessionId: session.id } };
  };
  const game = (title) => {
    const archive = chess.createMatch(
      {
        title,
        white: { name: "White", model: "fixture/export-white", protocol: "openai-chat" },
        black: { name: "Black", model: "fixture/export-black", protocol: "openai-chat" },
        rules: {},
      },
      "local",
    );
    chess.submitMove(archive, new chess.Chess(), "e2e4");
    return archive;
  };
  const makeMatch = async (owner, title, published = false, archive = game(title)) =>
    prisma.chessMatch.create({
      data: {
        ownerId: owner.user.id,
        slug: `export-fixture-${randomUUID()}`,
        title,
        whiteName: "White",
        blackName: "Black",
        status: "stopped",
        published,
        source: "local",
        rulesKey: "export-fixture",
        rulesVersion: archive.config?.rules.version,
        promptVersion: archive.config?.prompt.version,
        promptHash: archive.config?.prompt.hash,
        contextMode: "history",
        identityMode: "model",
        archive,
      },
    });
  const denied = async (promise, codes) =>
    assert.rejects(promise, (error) => {
      assert.ok(codes.includes(error.code), `Expected ${codes.join("/")}, got ${error.code}`);
      return true;
    });
  const waitForLock = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await observer.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'",
      );
      if (result.rows[0].n > 0) return;
      await delay(10);
    }
    throw new Error("Expected export authority to wait on the actual credential lock");
  };
  try {
    const own = await fixture();
    const foreign = await fixture();
    const privateTitle = `Private portable game ${suffix}`;
    const publicTitle = `Published portable game ${suffix}`;
    const foreignTitle = `Foreign secret game ${suffix}`;
    const games = [];
    for (let index = 0; index < 53; index++)
      games.push(
        await makeMatch(
          own,
          index === 0 ? privateTitle : index === 1 ? publicTitle : `Paged ${index} ${suffix}`,
          index === 1,
        ),
      );
    // Status-only stop/error writes retain the last running archive in storage.
    // Export must use the same terminal normalization as the replay readers.
    const terminalCases = [
      {
        label: "Stopped human turn",
        status: "stopped",
        ending: { kind: "cancelled" },
        termination: "cancelled",
        pgnTermination: "abandoned",
        closing: "Stopped by the operator",
        human: true,
      },
      {
        label: "Interrupted model turn",
        status: "error",
        ending: { kind: "interrupted" },
        termination: "interrupted",
        pgnTermination: "emergency",
        closing: "Interrupted by the server",
      },
      {
        label: "Revoked model turn",
        status: "error",
        ending: { kind: "credential-revoked" },
        termination: "credential-revoked",
        pgnTermination: "emergency",
        closing: "The OpenRouter key was revoked or disconnected",
      },
    ];
    for (const terminal of terminalCases) {
      terminal.title = `${terminal.label} ${suffix}`;
      const snapshot = game(terminal.title);
      if (terminal.human)
        snapshot.config.black = { name: "Human", model: "human", protocol: "human" };
      chess.beginHostedTurn(snapshot);
      assert.equal(snapshot.status, "running");
      assert.equal(snapshot.termination, "playing");
      assert.equal(snapshot.turn.type, terminal.human ? "human" : "model");
      terminal.snapshot = structuredClone(snapshot);
      terminal.row = await makeMatch(own, terminal.title, false, snapshot);
      await prisma.chessMatch.update({
        where: { id: terminal.row.id },
        data: { status: terminal.status, ending: terminal.ending },
      });
      games.push(terminal.row);
    }
    const foreignPublished = await makeMatch(foreign, foreignTitle, true);
    const unsupported = await makeMatch(own, `Unsupported ${suffix}`, false, {
      format: "unsupported-prerelease",
      credentials: secret("provider-ciphertext"),
    });
    await prisma.account.create({
      data: {
        userId: own.user.id,
        providerId: "fixture-idp",
        accountId: `portable-account-${suffix}`,
        issuer: "https://idp.example.test",
        password: secret("password-hash"),
        accessToken: secret("access-token"),
        refreshToken: secret("refresh-token"),
        idToken: secret("id-token"),
      },
    });
    await prisma.account.createMany({
      data: Array.from({ length: 51 }, (_unused, index) => ({
        userId: own.user.id,
        providerId: "fixture-secondary-idp",
        issuer: "https://secondary.example.test",
        accountId: `portable-secondary-${index}-${suffix}`,
      })),
    });
    await prisma.twoFactor.create({
      data: {
        userId: own.user.id,
        secret: secret("two-factor-secret"),
        backupCodes: secret("two-factor-backup"),
      },
    });
    await prisma.apiKey.create({
      data: {
        referenceId: own.user.id,
        key: secret("api-key-digest"),
        name: `Portable API key ${suffix}`,
      },
    });
    await prisma.deviceCode.create({
      data: {
        userId: own.user.id,
        deviceCode: secret("device-code"),
        userCode: secret("user-code"),
        expiresAt: new Date(Date.now() + 600_000),
        status: "approved",
      },
    });
    const machine = await prisma.runnerMachine.create({
      data: {
        userId: own.user.id,
        displayName: `Portable runner ${suffix}`,
        credentialDigest: secret("runner-digest"),
        credentialPrefix: "cockpit_chess_runner_display",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const foreignMachineName = `Foreign runner ${suffix}`;
    const foreignMachine = await prisma.runnerMachine.create({
      data: {
        userId: foreign.user.id,
        displayName: foreignMachineName,
        credentialDigest: `foreign-${suffix}`,
        credentialPrefix: "cockpit_chess_runner_foreign",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const operatingLimits = {
      matchMicros: 1_000_000,
      dayMicros: 10_000_000,
      concurrency: 2,
      revision: 0,
    };
    const hardLimits = {
      matchMicros: 25_000_000,
      dayMicros: 100_000_000,
      concurrency: 8,
    };
    const runnerState = (ownerId, machineId) => ({
      version: 1,
      userId: ownerId,
      machineId,
      generation: 0,
      operatingLimits,
      hardLimits,
      pending: null,
      lastResult: null,
    });
    const stateMachine = async (name) =>
      prisma.runnerMachine.create({
        data: {
          userId: own.user.id,
          displayName: `Runner state ${name} ${suffix}`,
          credentialDigest: `runner-state-${name}-${suffix}`,
          credentialPrefix: "cockpit_chess_runner_display",
          expiresAt: machine.expiresAt,
        },
      });
    const mismatchedMachine = await stateMachine("mismatched");
    const malformedMachine = await stateMachine("malformed");
    const expiredMachine = await stateMachine("expired");
    const storeVerification = async (id, value, expiresAt = machine.expiresAt) => {
      const row = await prisma.verification.create({
        data: {
          id,
          identifier: id,
          value: typeof value === "string" ? value : JSON.stringify(value),
          expiresAt,
        },
      });
      verificationIds.push(row.id);
      return row;
    };
    const stateId = (id) => `runner-limits:v1:${id}`;
    await storeVerification(stateId(machine.id), runnerState(own.user.id, machine.id));
    await storeVerification(
      stateId(foreignMachine.id),
      runnerState(foreign.user.id, foreignMachine.id),
    );
    await storeVerification(
      stateId(mismatchedMachine.id),
      runnerState(foreign.user.id, mismatchedMachine.id),
    );
    await storeVerification(stateId(malformedMachine.id), {
      ...runnerState(own.user.id, malformedMachine.id),
      rawSecret: secret("runner-state-invalid"),
    });
    await storeVerification(
      stateId(expiredMachine.id),
      runnerState(own.user.id, expiredMachine.id),
      new Date(0),
    );
    const proofId = `runner-limit-proof:v1:${createHash("sha256").update(secret("runner-limit-proof")).digest("hex")}`;
    const totpId = `runner-limit-totp:v1:${createHash("sha256").update(own.user.id).update("\0").update("123456").digest("hex")}`;
    await storeVerification(proofId, secret("runner-limit-proof"), new Date(Date.now() + 120_000));
    await storeVerification(totpId, secret("runner-limit-totp"), new Date(Date.now() + 90_000));
    await prisma.runnerClaim.create({
      data: {
        userId: own.user.id,
        sessionId: own.session.id,
        machineId: machine.id,
        tokenDigest: secret("claim-token-digest"),
        proofDigest: secret("claim-proof-digest"),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await prisma.openRouterConnection.create({
      data: {
        userId: own.user.id,
        label: `Portable OpenRouter ${suffix}`,
        keyHash: `portable-hash-${suffix}`,
        keyHint: "1234",
        keyCiphertext: Buffer.from(secret("provider-ciphertext")),
        keyNonce: Buffer.from(secret("provider-nonce")),
        keySecretId: secret("provider-secret-id"),
        limitMicros: 1_000_000n,
      },
    });
    const verification = await prisma.verification.create({
      data: {
        identifier: `reset-password:${own.user.id}`,
        value: secret("reset-proof"),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    verificationIds.push(verification.id);

    const ownReportNote = `Own filed privacy report ${suffix}`;
    const reportReviewedAt = new Date(Date.now() - 1000);
    const reportDedup = (label) => {
      const value = createHash("sha256").update(`export-report-${label}-${suffix}`).digest("hex");
      reportDedupKeys.push(value);
      return value;
    };
    const ownReport = await prisma.chessReplayReport.create({
      data: {
        matchId: foreignPublished.id,
        reporterId: own.user.id,
        dedupKey: reportDedup("own-first"),
        reason: "privacy",
        note: ownReportNote,
        reviewedAt: reportReviewedAt,
      },
    });
    reportIds.push(ownReport.id);
    const ownedReportIds = new Set([ownReport.id]);
    const additionalReports = Array.from({ length: 52 }, (_unused, index) => {
      const id = `export-report-${randomUUID()}`;
      reportIds.push(id);
      ownedReportIds.add(id);
      return {
        id,
        matchId: foreignPublished.id,
        reporterId: own.user.id,
        dedupKey: reportDedup(`own-page-${index}`),
        reason: "spam",
        note: `Own paged report ${index} ${suffix}`,
      };
    });
    await prisma.chessReplayReport.createMany({ data: additionalReports });
    for (const [label, reporterId, note, reason] of [
      ["foreign", foreign.user.id, secret("foreign-report-note"), "harassment"],
      ["anonymous", null, secret("anonymous-report-note"), "illegal_content"],
    ]) {
      const report = await prisma.chessReplayReport.create({
        data: { matchId: games[1].id, reporterId, note, reason, dedupKey: reportDedup(label) },
      });
      reportIds.push(report.id);
    }
    const hiddenAt = new Date();
    const uploaderStatement = `Uploader statement of reasons ${suffix}`;
    await prisma.chessMatch.update({
      where: { id: games[1].id },
      data: {
        hiddenAt,
        moderationReason: "privacy",
        moderationNote: uploaderStatement,
        moderationVersion: 1,
      },
    });
    const ownDecision = await prisma.chessModerationAction.create({
      data: {
        matchId: games[1].id,
        actorId: foreign.user.id,
        hidden: true,
        reason: "privacy",
        note: uploaderStatement,
      },
    });
    moderationActionIds.push(ownDecision.id);
    const foreignAuditAction = await prisma.chessModerationAction.create({
      data: {
        matchId: foreignPublished.id,
        actorId: own.user.id,
        hidden: false,
        reason: "no_violation",
        note: secret("moderation-audit-only"),
      },
    });
    moderationActionIds.push(foreignAuditAction.id);

    await assertAccountExportAuthority(own.authority);
    const json = await collect(own.authority);
    const parsed = JSON.parse(json);
    assert.ok(parsed && typeof parsed === "object");
    assert.equal(parsed.matches.length, 57);
    assert.equal(parsed.linkedAccounts.length, 52);
    assert.equal(new Set(parsed.linkedAccounts.map((row) => row.id)).size, 52);
    assert.deepEqual(
      parsed.matches.map((row) => row.id).sort(),
      [...games, unsupported].map((row) => row.id).sort(),
    );
    assert.equal(parsed.matches.find((row) => row.id === games[0].id).published, false);
    assert.equal(parsed.matches.find((row) => row.id === games[1].id).published, true);
    assert.equal(parsed.matches.find((row) => row.id === unsupported.id).archive, null);
    assert.equal(
      parsed.matches.find((row) => row.id === unsupported.id).archiveError,
      "unsupported_ruleset_archive",
    );
    assert.equal(parsed.reports.length, 53);
    assert.deepEqual(new Set(parsed.reports.map((report) => report.id)), ownedReportIds);
    const exportedReport = parsed.reports.find((report) => report.id === ownReport.id);
    assert.deepEqual(exportedReport, {
      id: ownReport.id,
      createdAt: ownReport.createdAt.toISOString(),
      matchId: foreignPublished.id,
      reason: "privacy",
      note: ownReportNote,
      reviewedAt: reportReviewedAt.toISOString(),
    });
    for (const report of parsed.reports) {
      assert.deepEqual(Object.keys(report).sort(), [
        "createdAt",
        "id",
        "matchId",
        "note",
        "reason",
        "reviewedAt",
      ]);
      assert.equal(report.matchId, foreignPublished.id);
      assert.equal(typeof report.createdAt, "string");
    }
    for (const excluded of [...reportDedupKeys, foreignAuditAction.id])
      assert.equal(
        json.includes(excluded),
        false,
        "Report deduplication identities and privileged audit records are excluded",
      );
    const hiddenMatch = parsed.matches.find((row) => row.id === games[1].id);
    assert.equal(hiddenMatch.hiddenAt, hiddenAt.toISOString());
    assert.equal(hiddenMatch.moderationReason, "privacy");
    assert.equal(hiddenMatch.moderationNote, uploaderStatement);
    assert.equal(hiddenMatch.moderationVersion, 1);
    assert.deepEqual(parsed.moderationActions, [
      {
        id: ownDecision.id,
        createdAt: ownDecision.createdAt.toISOString(),
        matchId: games[1].id,
        hidden: true,
        reason: "privacy",
        note: uploaderStatement,
      },
    ]);
    assert.deepEqual(Object.keys(parsed.moderationActions[0]).sort(), [
      "createdAt",
      "hidden",
      "id",
      "matchId",
      "note",
      "reason",
    ]);
    const exportedStates = new Map(
      parsed.runnerLimitStates.map((state) => [state.machineId, state]),
    );
    assert.equal(exportedStates.size, 3);
    assert.deepEqual(exportedStates.get(machine.id), {
      machineId: machine.id,
      generation: 0,
      operatingLimits,
      hardLimits,
      pending: null,
      lastResult: null,
      expiresAt: machine.expiresAt.toISOString(),
    });
    for (const invalid of [mismatchedMachine, malformedMachine])
      assert.deepEqual(exportedStates.get(invalid.id), {
        machineId: invalid.id,
        stateError: "unsupported_runner_state",
      });
    assert.equal(exportedStates.has(foreignMachine.id), false);
    assert.equal(exportedStates.has(expiredMachine.id), false);
    for (const excludedId of [stateId(foreignMachine.id), proofId, totpId])
      assert.equal(
        json.includes(excludedId),
        false,
        "Verification security namespaces and foreign state are excluded",
      );
    const stoppedGame = parsed.matches.find((row) => row.id === games[0].id);
    assert.equal(stoppedGame.archive.status, "stopped");
    assert.equal(stoppedGame.archive.termination, "cancelled");
    assert.deepEqual(stoppedGame.archive.turn, { type: "idle" });
    assert.equal(stoppedGame.archive.events[0].accepted, true);
    assert.equal(stoppedGame.archive.events[0].move, "e2e4");
    for (const terminal of terminalCases) {
      const exported = parsed.matches.find((row) => row.id === terminal.row.id);
      assert.equal(exported.status, terminal.status);
      assert.equal(exported.archive.status, terminal.status);
      assert.equal(exported.archive.termination, terminal.termination);
      assert.equal(exported.archive.result, "*");
      assert.deepEqual(exported.archive.turn, { type: "idle" });
      assert.deepEqual(exported.archive.events, terminal.snapshot.events);
      // A download projection must not rewrite the durable worker snapshot.
      const stored = await prisma.chessMatch.findUniqueOrThrow({ where: { id: terminal.row.id } });
      assert.deepEqual(stored.archive, terminal.snapshot);
    }
    for (const value of [
      own.user.email,
      privateTitle,
      publicTitle,
      `Portable runner ${suffix}`,
      `Portable OpenRouter ${suffix}`,
      `portable-account-${suffix}`,
    ])
      assert.ok(json.includes(value), `JSON missing own portable metadata: ${value}`);
    for (const value of [
      ...secrets,
      foreign.user.id,
      foreign.user.email,
      foreignTitle,
      foreignMachineName,
    ])
      assert.equal(
        json.includes(value),
        false,
        "Export disclosed a foreign value or synthetic credential",
      );
    const forbiddenFields = new Set([
      "password",
      "accessToken",
      "refreshToken",
      "idToken",
      "token",
      "keyCiphertext",
      "keyNonce",
      "keySecretId",
      "credentialDigest",
      "tokenDigest",
      "proofDigest",
      "secret",
      "backupCodes",
      "deviceCode",
      "userCode",
      "key",
    ]);
    const inspectFields = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        assert.equal(
          forbiddenFields.has(key),
          false,
          `Credential field ${key} must not be exported`,
        );
        inspectFields(entry);
      }
    };
    inspectFields(parsed);
    for (const row of [...games, unsupported])
      assert.equal(
        json.split(`"id":"${row.id}"`).length - 1,
        1,
        "Every match appears exactly once across keyset pages",
      );
    assert.ok(
      json.toLowerCase().includes("unsupported"),
      "Unsupported archive must be identified explicitly",
    );
    const pgn = await collect(own.authority, "pgn");
    assert.ok(pgn.includes(privateTitle));
    assert.ok(pgn.includes(publicTitle));
    assert.ok(pgn.includes("1. e4"));
    const pgnGames = pgn.split(/\n(?=\[Event )/);
    for (const terminal of terminalCases) {
      const exported = pgnGames.find((entry) => entry.includes(`[Event "${terminal.title}"]`));
      assert.ok(exported, `Missing PGN terminal fixture ${terminal.label}`);
      assert.ok(exported.includes(`[Termination "${terminal.pgnTermination}"]`));
      assert.ok(exported.includes(terminal.closing));
      assert.ok(exported.includes("1. e4"), "Terminal PGN retains the accepted board history");
      assert.equal(exported.includes('[Termination "unterminated"]'), false);
    }
    assert.equal(pgn.includes(foreignTitle), false);
    for (const value of secrets) assert.equal(pgn.includes(value), false);

    // A new cookie rotation date cannot renew old primary-authentication proof.
    await prisma.session.update({
      where: { id: own.session.id },
      data: {
        createdAt: new Date(),
        authenticatedAt: new Date(Date.now() - 6 * 60_000),
      },
    });
    await denied(assertAccountExportAuthority(own.authority), ["REAUTH_REQUIRED"]);
    await prisma.session.update({ where: { id: own.session.id }, data: { authenticatedAt: null } });
    await denied(assertAccountExportAuthority(own.authority), ["REAUTH_REQUIRED"]);
    await prisma.session.update({
      where: { id: own.session.id },
      data: { authenticatedAt: new Date() },
    });
    for (const patch of [
      { expiresAt: new Date(0) },
      { origin: "device-flow" },
      { impersonatedBy: foreign.user.id },
    ]) {
      await prisma.session.update({ where: { id: own.session.id }, data: patch });
      await denied(assertAccountExportAuthority(own.authority), ["UNAUTHORIZED", "FORBIDDEN"]);
      await prisma.session.update({
        where: { id: own.session.id },
        data: {
          expiresAt: new Date(Date.now() + 600_000),
          origin: "sign-in",
          impersonatedBy: null,
        },
      });
    }
    await denied(
      assertAccountExportAuthority({ userId: foreign.user.id, sessionId: own.session.id }),
      ["UNAUTHORIZED"],
    );
    await prisma.user.update({ where: { id: own.user.id }, data: { banned: true } });
    await denied(assertAccountExportAuthority(own.authority), ["UNAUTHORIZED", "FORBIDDEN"]);
    await prisma.user.update({
      where: { id: own.user.id },
      data: { banned: false, deletionRequestedAt: new Date(), deletionState: "pending" },
    });
    await denied(assertAccountExportAuthority(own.authority), ["UNAUTHORIZED", "FORBIDDEN"]);
    await prisma.user.update({
      where: { id: own.user.id },
      data: { deletionRequestedAt: null, deletionState: "active" },
    });
    // Administrators outside the enrollment grace must satisfy the real default 2FA policy.
    await prisma.user.update({
      where: { id: own.user.id },
      data: {
        role: "admin",
        twoFactorEnabled: false,
        createdAt: new Date(Date.now() - 2 * 86400_000),
      },
    });
    await denied(assertAccountExportAuthority(own.authority), ["FORBIDDEN"]);
    await prisma.user.update({ where: { id: own.user.id }, data: { role: "user" } });

    // Server streams must fail rather than finish a portability document after reset.
    const reset = await fixture();
    await makeMatch(reset, `Reset stream ${suffix}`);
    const resetStream = streamAccountExport(reset.authority, "json");
    let partial = (await resetStream.next()).value ?? "";
    await prisma.$transaction(async (tx) => {
      await locks.lockCliCredentials(reset.user.id, tx);
      await revocation.revokeCredentialsInTransaction(tx, reset.user.id);
    });
    await denied(
      (async () => {
        for await (const chunk of resetStream) partial += chunk;
      })(),
      ["UNAUTHORIZED"],
    );
    assert.throws(() => JSON.parse(partial), SyntaxError);

    // Completion itself remains fenced even when the final match page is cached.
    const completing = await fixture();
    const completingMatch = await makeMatch(completing, `Completion stream ${suffix}`);
    const completingStream = streamAccountExport(completing.authority, "json");
    let completingPartial = "";
    for (;;) {
      const chunk = await completingStream.next();
      assert.equal(chunk.done, false, "Expected a match row before document completion");
      completingPartial += chunk.value;
      if (chunk.value.includes(`"id":"${completingMatch.id}"`)) break;
    }
    await prisma.$transaction(async (tx) => {
      await locks.lockCliCredentials(completing.user.id, tx);
      await tx.user.update({
        where: { id: completing.user.id },
        data: {
          deletionRequestedAt: new Date(),
          deletionState: "pending",
        },
      });
    });
    await denied(
      (async () => {
        for await (const chunk of completingStream) completingPartial += chunk;
      })(),
      ["FORBIDDEN", "UNAUTHORIZED"],
    );
    assert.throws(() => JSON.parse(completingPartial), SyntaxError);

    // PostgreSQL lock waits must observe deletion committed by the previous holder.
    const deleting = await fixture();
    const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
    blockers.push(blocker);
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      locks.cliCredentialLockKey(deleting.user.id),
    ]);
    const waiting = assertAccountExportAuthority(deleting.authority).then(
      () => ({ accepted: true }),
      (error) => ({ error }),
    );
    pending.push(waiting);
    await waitForLock();
    await blocker.query(
      'UPDATE "user" SET "deletionRequestedAt" = now(), "deletionState" = $2 WHERE "id" = $1',
      [deleting.user.id, "pending"],
    );
    await blocker.query("COMMIT");
    const outcome = await waiting;
    assert.equal(outcome.accepted, undefined);
    assert.ok(["UNAUTHORIZED", "FORBIDDEN"].includes(outcome.error?.code));

    const controller = new AbortController();
    controller.abort();
    await denied(
      (async () => {
        for await (const _chunk of streamAccountExport(own.authority, "json", {
          signal: controller.signal,
        }))
          throw new Error("An aborted download must not emit data");
      })(),
      ["ABORTED"],
    );
    console.log(
      "account-export: actual PG safe JSON/PGN, private/published ownership, 57-row keyset pagination, normalized stop/interruption/revocation with stale human/model turns, strict owner-bound runner limit state and security-proof exclusions, 53 own filed reports with foreign/anonymous/HMAC exclusion and own uploader decision history without actor identities or foreign-match audit data, secret exclusion, strict unsupported archives, genuine primary-auth proof, live session/2FA, reset streaming refusal and deletion lock ordering passed.",
    );
  } finally {
    for (const blocker of blockers) {
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
    }
    await Promise.allSettled(pending);
    await prisma.chessReplayReport.deleteMany({ where: { id: { in: reportIds } } });
    await prisma.chessModerationAction.deleteMany({ where: { id: { in: moderationActionIds } } });
    await prisma.verification.deleteMany({ where: { id: { in: verificationIds } } });
    await prisma.chessMatch.deleteMany({ where: { ownerId: { in: owners } } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    await observer.end();
    await prisma.$disconnect();
    const queues = await import("../../packages/queue/src/index.ts");
    await Promise.all(
      Object.values(queues)
        .filter((value) => value instanceof queues.Queue)
        .map((queue) => queue.close()),
    );
    queues.redisConnection.disconnect();
  }
}
