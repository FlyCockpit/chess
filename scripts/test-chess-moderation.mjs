/** D3 real PostgreSQL/Valkey checks. Only the owned disposable-services runner may invoke this. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { loadPg } from "./db/lib/prisma.mjs";

export async function chessModerationCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "chess-moderation");
  const [database, chess, router, moderation, official, locks, queues, orpc] = await Promise.all([
    import("../packages/db/src/index.ts"),
    import("../packages/chess/src/index.ts"),
    import("../packages/api/src/routers/chess.ts"),
    import("../packages/api/src/routers/chess-moderation.ts"),
    import("../packages/api/src/lib/chess-official.ts"),
    import("../packages/auth/src/device-redemption-lock.ts"),
    import("../packages/queue/src/index.ts"),
    import(
      createRequire(new URL("../packages/api/package.json", import.meta.url)).resolve(
        "@orpc/server",
      )
    ),
  ]);
  const prisma = database.default;
  const observer = new (loadPg().Client)({ connectionString: process.env.DATABASE_URL });
  const blocker = new (loadPg().Client)({ connectionString: process.env.DATABASE_URL });
  await Promise.all([observer.connect(), blocker.connect()]);
  const users = [];
  const matches = [];
  let nextIp = 0;
  const ip = () => `198.51.100.${++nextIp}`;
  const client = (procedures, session = null, clientIp = ip()) =>
    orpc.createRouterClient(procedures, { context: { session, clientIp } });
  const makeUser = async (role = "user") => {
    const user = await prisma.user.create({
      data: {
        name: "Moderation fixture",
        email: `${randomUUID()}@example.test`,
        emailVerified: true,
        role,
        twoFactorEnabled: true,
      },
    });
    users.push(user.id);
    const session = await prisma.session.create({
      data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 600_000) },
    });
    return { user, session };
  };
  const missing = (promise) => assert.rejects(promise, (error) => error.code === "NOT_FOUND");
  const waitForLocks = async (count) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await observer.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%chess_match%'",
      );
      if (result.rows[0].n >= count) return;
      await delay(25);
    }
    throw new Error(`Moderation fixture did not observe ${count} match lock waiters`);
  };
  try {
    const owner = await makeUser();
    const reporter = await makeUser();
    const admin = await makeUser("admin");
    const publicApi = client(router.chessRouter);
    const anonymous = client(moderation.chessModerationRouter);
    const signed = client(moderation.chessModerationRouter, reporter);
    const adminApi = client(moderation.chessModerationRouter, admin);
    const ownerApi = client(router.chessRouter, owner);
    const baseline = { name: "Random", model: "random", protocol: "random" };
    const model = { name: "Safe model", model: "fixture/moderation", protocol: "openai-chat" };
    const seed = async (published = true, source = "local", officialEntry = false) => {
      const archive = chess.createMatch(
        { title: "Moderation replay", white: model, black: baseline, rules: {} },
        source,
      );
      chess.finishMatch(archive, "*", "cancelled", "stopped");
      const row = await prisma.chessMatch.create({
        data: {
          ownerId: owner.user.id,
          slug: `moderation-${randomUUID()}`,
          title: archive.config.title,
          whiteName: model.name,
          blackName: baseline.name,
          source,
          status: officialEntry ? "queued" : "stopped",
          published,
          archive,
          rulesKey: official.chessDigest(archive.config.rules).slice(0, 16),
          rulesVersion: archive.config.rules.version,
          promptVersion: archive.config.prompt.version,
          promptHash: archive.config.prompt.hash,
          contextMode: archive.config.rules.context,
          identityMode: archive.config.rules.opponentIdentity,
          ...(officialEntry
            ? { OfficialEntry: { create: official.officialCommitment(archive, "operator") } }
            : {}),
        },
      });
      matches.push(row.id);
      if (officialEntry)
        return prisma.chessMatch.update({
          where: { id: row.id },
          data: { status: "stopped", terminalCause: "owner-stop" },
        });
      return row;
    };
    const target = await seed(true, "hosted", true);
    const entryBefore = await prisma.chessOfficialEntry.findUniqueOrThrow({
      where: { matchId: target.id },
    });
    const notice = { slug: target.slug, reason: "privacy", note: "reporter-private-note" };
    assert.deepEqual(await anonymous.report(notice), { accepted: true });
    assert.deepEqual(await anonymous.report({ ...notice, note: "cannot overwrite first" }), {
      accepted: true,
    });
    assert.equal(await prisma.chessReplayReport.count({ where: { matchId: target.id } }), 1);
    const storedNotice = await prisma.chessReplayReport.findFirstOrThrow({
      where: { matchId: target.id },
    });
    assert.equal(storedNotice.note, notice.note);
    assert.equal(storedNotice.reporterId, null);
    assert.match(storedNotice.dedupKey, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(storedNotice).includes("198.51.100"), false);
    await signed.report(notice);
    assert.equal(await prisma.chessReplayReport.count({ where: { matchId: target.id } }), 2);
    await missing(
      client(moderation.chessModerationRouter, owner).setHidden({
        id: target.id,
        hidden: true,
        reason: "privacy",
        note: "unauthorized",
      }),
    );
    await missing(anonymous.list({}));
    const before = await anonymous.visibility({ slug: target.slug });
    const reason =
      "Personal information was removed from public view. Review the publication policy before requesting restoration.";
    await adminApi.setHidden({ id: target.id, hidden: true, reason: "privacy", note: reason });
    await missing(publicApi.get({ slug: target.slug }));
    await missing(anonymous.visibility({ slug: target.slug }));
    await missing(client(moderation.chessModerationRouter).report(notice));
    const hiddenPage = await publicApi.list({ limit: 100 });
    assert.equal(
      hiddenPage.items.some((row) => row.slug === target.slug),
      false,
    );
    await ownerApi.publish({ slug: target.slug, published: false });
    await ownerApi.publish({ slug: target.slug, published: true });
    await missing(publicApi.get({ slug: target.slug }));
    const inspected = await ownerApi.inspect({ slug: target.slug });
    assert.ok(inspected.hiddenAt);
    assert.equal(inspected.moderationNote, reason);
    assert.equal(JSON.stringify(inspected).includes(notice.note), false);
    assert.equal("Reports" in inspected, false);
    assert.deepEqual(
      await prisma.chessOfficialEntry.findUniqueOrThrow({ where: { matchId: target.id } }),
      entryBefore,
    );
    assert.ok(
      (await publicApi.officialEntries({ limit: 100 })).items.some(
        (entry) => entry.id === entryBefore.id,
      ),
    );
    const { backfillSpectatorEvaluations } = await import(
      "../apps/worker/src/handlers/chess-spectator.ts"
    );
    assert.deepEqual(
      await backfillSpectatorEvaluations(target.id, 0, {
        purpose: "public",
        version: before.version,
      }),
      { evaluated: false },
    );
    const queuePage = await adminApi.list({ status: "hidden", limit: 1 });
    assert.equal(queuePage.items[0].id, target.id);
    assert.equal(queuePage.items[0].ModerationActions[0].note, reason);
    assert.equal(queuePage.items[0].Reports.length, 2);
    assert.equal(JSON.stringify(queuePage).includes("dedupKey"), false);
    await adminApi.setHidden({
      id: target.id,
      hidden: false,
      reason: "no_violation",
      note: "Reviewed and restored after correction.",
    });
    assert.equal((await anonymous.visibility({ slug: target.slug })).version, before.version + 2);
    // Even a hide->unhide cannot revive a public job from an older visibility generation.
    assert.deepEqual(
      await backfillSpectatorEvaluations(target.id, 0, {
        purpose: "public",
        version: before.version,
      }),
      { evaluated: false },
    );
    assert.deepEqual(
      await prisma.chessOfficialEntry.findUniqueOrThrow({ where: { matchId: target.id } }),
      entryBefore,
    );
    console.log(
      "chess-moderation: anonymous dedup, private reasons, admin audit, owner cannot unhide, stale public jobs, unchanged ledger passed",
    );

    const draft = await seed(false);
    await missing(client(moderation.chessModerationRouter).report({ ...notice, slug: draft.slug }));
    await missing(anonymous.visibility({ slug: draft.slug }));
    const nonhosted = await seed();
    assert.deepEqual(
      await backfillSpectatorEvaluations(nonhosted.id, 0, { purpose: "public", version: 0 }),
      { evaluated: false },
    );

    assert.deepEqual(
      await backfillSpectatorEvaluations(target.id, 0, {
        purpose: "public",
        version: before.version + 2,
      }),
      { evaluated: true },
    );
    assert.ok(
      (await prisma.chessMatch.findUniqueOrThrow({ where: { id: target.id } }))
        .spectatorEvaluations["0"],
    );
    // A real engine result waits behind the row lock. The hide commits before
    // the merge acquires that lock: its SQL predicate must recheck the new row.
    const writeRace = await seed(true, "hosted");
    await blocker.query("BEGIN");
    await blocker.query('SELECT "id" FROM "chess_match" WHERE "id" = $1 FOR UPDATE', [
      writeRace.id,
    ]);
    const backfilling = backfillSpectatorEvaluations(writeRace.id, 0, {
      purpose: "public",
      version: 0,
    });
    await waitForLocks(1);
    await blocker.query(
      'UPDATE "chess_match" SET "hiddenAt" = CURRENT_TIMESTAMP, "moderationVersion" = "moderationVersion" + 1 WHERE "id" = $1',
      [writeRace.id],
    );
    await blocker.query("COMMIT");
    assert.deepEqual(await backfilling, { evaluated: false });
    assert.equal(
      (await prisma.chessMatch.findUniqueOrThrow({ where: { id: writeRace.id } }))
        .spectatorEvaluations,
      null,
    );
    console.log(
      "chess-moderation: public engine/write authorization and hide-vs-in-flight-score SQL CAS passed",
    );

    // Queue actual admin hide first and report second behind a held row lock.
    // Their post-lock reads must see the committed hiding decision.
    const raced = await seed();
    await blocker.query("BEGIN");
    await blocker.query('SELECT "id" FROM "chess_match" WHERE "id" = $1 FOR UPDATE', [raced.id]);
    const hiding = adminApi.setHidden({
      id: raced.id,
      hidden: true,
      reason: "spam",
      note: "Spam removed after review.",
    });
    await waitForLocks(1);
    const reporting = client(moderation.chessModerationRouter).report({
      ...notice,
      slug: raced.slug,
    });
    const reportRefusal = missing(reporting);
    await waitForLocks(2);
    await blocker.query("COMMIT");
    await hiding;
    await reportRefusal;
    assert.equal(await prisma.chessReplayReport.count({ where: { matchId: raced.id } }), 0);

    // Physical reporter deletion removes their notes, and a surviving stale
    // context may not silently downgrade itself to an anonymous submission.
    const deletionTarget = await seed();
    let locked;
    let release;
    const acquired = new Promise((resolve) => {
      locked = resolve;
    });
    const proceed = new Promise((resolve) => {
      release = resolve;
    });
    const deleting = prisma.$transaction(async (tx) => {
      await locks.lockCliCredentials(reporter.user.id, tx);
      locked();
      await proceed;
      await tx.user.delete({ where: { id: reporter.user.id } });
    });
    await acquired;
    const staleReport = signed.report({ ...notice, slug: deletionTarget.slug });
    const staleRefusal = assert.rejects(staleReport, (error) => error.code === "UNAUTHORIZED");
    release();
    await deleting;
    await staleRefusal;
    assert.equal(
      await prisma.chessReplayReport.count({ where: { reporterId: reporter.user.id } }),
      0,
    );
    assert.equal(
      await prisma.chessReplayReport.count({ where: { matchId: deletionTarget.id } }),
      0,
    );
    assert.equal(await prisma.chessReplayReport.count({ where: { matchId: target.id } }), 1);

    const removed = await seed();
    await blocker.query("BEGIN");
    await blocker.query('SELECT "id" FROM "chess_match" WHERE "id" = $1 FOR UPDATE', [removed.id]);
    const lateNotice = client(moderation.chessModerationRouter).report({
      ...notice,
      slug: removed.slug,
    });
    const deletedRefusal = missing(lateNotice);
    await waitForLocks(1);
    await blocker.query('DELETE FROM "chess_match" WHERE "id" = $1', [removed.id]);
    await blocker.query("COMMIT");
    await deletedRefusal;
    assert.equal(await prisma.chessReplayReport.count({ where: { matchId: removed.id } }), 0);
    console.log(
      "chess-moderation: real PG hide/report, reporter-delete/report and match-delete/report races passed",
    );
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await Promise.all([observer.end(), blocker.end()]);
    const ownedRows = await prisma.chessMatch.findMany({
      where: { id: { in: matches } },
      take: matches.length + 1,
      select: { id: true, ownerId: true, moderationVersion: true },
    });
    for (const row of ownedRows) {
      const accesses = [
        ...Array.from({ length: row.moderationVersion + 1 }, (_, version) => ({
          purpose: "public",
          version,
        })),
        ...(row.ownerId ? [{ purpose: "owner", ownerId: row.ownerId }] : []),
      ];
      for (const access of accesses)
        await (
          await queues.chessReconcileQueue.getJob(queues.chessSpectatorJobId(row.id, 0, access))
        )?.remove();
    }
    const ledgerIds = await prisma.chessOfficialEntry.findMany({
      where: { matchId: { in: matches } },
      take: matches.length + 1,
      select: { id: true },
    });
    await prisma.chessMatch.deleteMany({ where: { id: { in: matches } } });
    await prisma.chessOfficialEntry.deleteMany({
      where: { id: { in: ledgerIds.map((entry) => entry.id) } },
    });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await Promise.all(
      Object.values(queues)
        .filter((value) => value instanceof queues.Queue)
        .map((queue) => queue.close()),
    );
    queues.redisConnection.disconnect();
    await prisma.$disconnect();
  }
}
