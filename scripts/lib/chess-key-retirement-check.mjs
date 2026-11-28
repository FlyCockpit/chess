/** Native Valkey mutation replay after actual PG account erasure; disposable harness only. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function chessKeyRetirementCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "account-deletion-cleanup");
  const [
    { default: prisma },
    queues,
    keys,
    { cleanupAccountDeletion },
    { requestAccountDeletion },
    catalog,
  ] = await Promise.all([
    import("../../packages/db/src/index.ts"),
    import("../../packages/queue/src/index.ts"),
    import("../../packages/queue/src/chess-key-revocation.ts"),
    import("../../packages/api/src/lib/account-deletion-cleanup.ts"),
    import("../../packages/api/src/lib/account-deletion.ts"),
    import("../../packages/api/src/lib/chess-models.ts"),
  ]);
  const redis = queues.redisConnection;
  const ownerIds = [];
  const rawKeys = [];
  const epochKeys = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/v1/models")) return Response.json({ data: [] });
    throw new Error("Key-retirement fixture does not authorize external requests");
  };
  catalog.resetModelCatalogCache();
  const person = async () => {
    const user = await prisma.user.create({
      data: {
        name: "Disposable key retirement fixture",
        email: `${randomUUID()}@example.test`,
        emailVerified: true,
      },
    });
    ownerIds.push(user.id);
    rawKeys.push(`cockpit-chess:openrouter-key-revoked:${user.id}`);
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
  const erase = async (owner) => {
    const accepted = await requestAccountDeletion(owner.user.id, {
      kind: "self",
      sessionId: owner.session.id,
    });
    assert.equal(accepted.complete, false);
    await prisma.user.update({
      where: { id: owner.user.id },
      data: { deletionRequestedAt: new Date(Date.now() - 181_000) },
      select: { id: true },
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      const answer = await cleanupAccountDeletion(owner.user.id);
      if (answer.complete) {
        assert.equal(await prisma.user.count({ where: { id: owner.user.id } }), 0);
        return;
      }
    }
    assert.fail("Default key-state retirement must complete before late replay");
  };
  try {
    const started = Date.now();
    for (;;) {
      const uptime = Number(/^uptime_in_seconds:(\d+)/m.exec(await redis.info("server"))?.[1] ?? 0);
      if (uptime >= 60) break;
      assert.ok(Date.now() - started < 65_000, "Owned lease store must mature within65s");
      await delay(1000);
    }
    const owner = await person();
    const peer = await person();
    const oldHash = createHash("sha256").update("synthetic-old-key").digest("hex");
    const lateHash = createHash("sha256").update("synthetic-delayed-key").digest("hex");
    await keys.recordChessKeyRevoked(redis, owner.user.id, oldHash, () => {});
    let captured;
    const delayed = {
      set: (...args) => redis.set(...args),
      get: (...args) => redis.get(...args),
      eval: async (...args) => {
        assert.ok(String(args[0]).startsWith("-- cockpit-chess:key-cache-record:v1"));
        captured = args;
        throw new Error("synthetic disconnect client timeout before underlying Lua execution");
      },
    };
    const holderStarted = Date.now();
    const holderStartedMono = performance.now();
    await assert.rejects(
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cli-credentials:${owner.user.id}`}))`;
          assert.equal(
            (await tx.user.findUniqueOrThrow({ where: { id: owner.user.id } })).deletionRequestedAt,
            null,
          );
          await keys.recordChessKeyRevoked(delayed, owner.user.id, lateHash, () => {
            if (Math.max(Date.now() - holderStarted, performance.now() - holderStartedMono) >= 4000)
              throw new Error("original fixture owner holder expired");
          });
        },
        { timeout: 5000 },
      ),
      /synthetic disconnect client timeout/,
    );
    assert.ok(captured, "The production revocation Lua and its native arguments were captured");
    const epoch = String(captured[2]);
    const raw = String(captured[3]);
    epochKeys.push(epoch);
    assert.equal(raw, `cockpit-chess:openrouter-key-revoked:${owner.user.id}`);
    assert.match(epoch, /^cockpit-chess:key-retirement:[a-f0-9]{64}$/);
    assert.equal(epoch.includes(owner.user.id), false);
    await erase(owner);
    assert.equal(await redis.get(epoch), "retired");
    assert.equal(await redis.exists(raw), 0);
    assert.deepEqual(
      await redis.eval(...captured),
      [0],
      "Late native cache Lua must refuse the retired epoch",
    );
    assert.equal(await redis.exists(raw), 0);
    assert.equal(await redis.zscore(raw, lateHash), null);
    await assert.rejects(
      keys.recordChessKeyRevoked(redis, owner.user.id, lateHash, () => {}),
      /retired/,
    );
    assert.equal(await redis.exists(raw), 0);
    // Model a missing epoch after a store restart without flushing any other
    // fixture data. An old captured mutation must not acquire new authority.
    await redis.del(epoch);
    assert.deepEqual(await redis.eval(...captured), [0]);
    assert.equal(await redis.exists(raw), 0);
    const peerHash = createHash("sha256").update("synthetic-active-peer-key").digest("hex");
    assert.deepEqual(await keys.recordChessKeyRevoked(redis, peer.user.id, peerHash, () => {}), [
      peerHash,
    ]);
    assert.equal(
      (await redis.zscore(`cockpit-chess:openrouter-key-revoked:${peer.user.id}`, peerHash)) !==
        null,
      true,
    );
    await erase(peer);
    assert.equal(await redis.exists(`cockpit-chess:openrouter-key-revoked:${peer.user.id}`), 0);
    console.log(
      "D2b: native delayed key-cache Lua after a synthetic disconnect timeout and completed PG erasure cannot recreate raw owner/hash metadata; missing-epoch refusal and active-peer positive pass",
    );
  } finally {
    // Only this fixture's keys/users; no shared flush, lease deletion or real provider.
    for (const key of rawKeys) await redis.del(key);
    for (const key of epochKeys) await redis.del(key);
    await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
    catalog.resetModelCatalogCache();
    globalThis.fetch = originalFetch;
  }
}
