/** Real PostgreSQL replay retention checks; only the owned runtime child may call this. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

export async function chessAnonymizationCheck() {
  assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
  assert.equal(process.argv[2], "--runtime-child");
  assert.equal(process.argv[3], "account-deletion");
  const [database, chess, retained, router, locks, orpc, pgn] = await Promise.all([
    import("../../packages/db/src/index.ts"),
    import("../../packages/chess/src/index.ts"),
    import("../../packages/api/src/lib/chess-anonymization.ts"),
    import("../../packages/api/src/routers/chess.ts"),
    import("../../packages/auth/src/device-redemption-lock.ts"),
    import(
      createRequire(new URL("../../packages/api/package.json", import.meta.url)).resolve(
        "@orpc/server",
      )
    ),
    import("../../packages/chess/src/pgn.ts"),
  ]);
  const prisma = database.default;
  const marker = `PRIVATE-${randomUUID()}`;
  const originalFetch = globalThis.fetch;
  const safeModel = "fixture/deletion-safe-model";
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/v1/models"))
      return Response.json({
        data: [{ id: safeModel, pricing: { prompt: "0", completion: "0" } }],
      });
    throw new Error("Deletion replay fixture never makes upstream requests");
  };
  const { resetModelCatalogCache } = await import("../../packages/api/src/lib/chess-models.ts");
  resetModelCatalogCache();
  const owner = await prisma.user.create({
    data: { name: marker, email: `${randomUUID()}@example.test`, emailVerified: true },
  });
  const active = await prisma.user.create({
    data: {
      name: "Active replay fixture",
      email: `${randomUUID()}@example.test`,
      emailVerified: true,
    },
  });
  const matchIds = [];
  const api = orpc.createRouterClient(router.chessRouter, { context: { session: null } });
  try {
    const archive = chess.createMatch(
      {
        title: marker,
        white: { name: marker, model: safeModel, protocol: "openai-chat" },
        black: { name: marker, model: "human", protocol: "human" },
        rules: {},
      },
      "local",
    );
    archive.events.push({
      seq: 0,
      at: archive.createdAt,
      side: "w",
      ply: 0,
      type: "tool",
      name: "board",
      input: marker,
      output: marker,
    });
    chess.submitMove(archive, chess.boardAt(archive), "e2e4", marker);
    const rejected = chess.submitMove(archive, chess.boardAt(archive), marker, marker);
    rejected.reply = marker;
    chess.finishMatch(archive, "*", "cancelled", "stopped");
    const seed = (id, ownerId = owner.id, published = true, createdAt = new Date()) => ({
      id,
      ownerId,
      slug: `private-${randomUUID()}`,
      createdAt,
      title: marker,
      whiteName: marker,
      blackName: marker,
      source: "local",
      status: "stopped",
      published,
      rulesKey: "fixture",
      rulesVersion: archive.config.rules.version,
      promptVersion: archive.config.prompt.version,
      promptHash: archive.config.prompt.hash,
      contextMode: archive.config.rules.context,
      identityMode: archive.config.rules.opponentIdentity,
      whiteModel: safeModel,
      whiteProtocol: "openai-chat",
      blackModel: "human",
      blackProtocol: "human",
      archive,
    });
    const prefix = randomUUID();
    const target = await prisma.chessMatch.create({ data: seed(`${prefix}-0000`) });
    matchIds.push(target.id);
    const privateRow = await prisma.chessMatch.create({
      data: seed(`${prefix}-private`, owner.id, false),
    });
    matchIds.push(privateRow.id);
    assert.equal(
      (await api.get({ slug: target.slug })).archive.id,
      archive.id,
      "Active owner's publication remains unchanged",
    );
    await prisma.chessMatch.createMany({
      data: Array.from({ length: 51 }, (_, index) =>
        seed(`${prefix}-${String(index + 1).padStart(4, "0")}`),
      ),
    });
    for (let index = 1; index <= 51; index++)
      matchIds.push(`${prefix}-${String(index).padStart(4, "0")}`);

    await prisma.user.update({
      where: { id: owner.id },
      data: { deletionRequestedAt: new Date(), deletionState: "pending" },
    });
    await assert.rejects(api.get({ slug: target.slug }), { code: "NOT_FOUND" });
    assert.equal(
      (await api.list({ limit: 100 })).items.some((item) => item.slug === target.slug),
      false,
      "Pending-owner public cards disappear before cleanup",
    );
    let cursor;
    let pages = 0;
    for (;;) {
      assert.ok(++pages <= 3, "Retention cursor advances over detached rows");
      const result = await prisma.$transaction(async (tx) => {
        await locks.lockCliCredentials(owner.id, tx);
        return retained.anonymizePublishedReplayBatch(tx, owner.id, cursor, new Set([safeModel]));
      });
      if (result.done) break;
      cursor = result.cursor;
    }
    assert.equal(pages, 2, "52 published rows use two bounded retention transactions");
    assert.equal(
      await prisma.chessMatch.count({ where: { ownerId: owner.id, published: true } }),
      0,
    );
    assert.equal(
      (await prisma.chessMatch.findUniqueOrThrow({ where: { id: privateRow.id } })).ownerId,
      owner.id,
      "Private physical cleanup remains D2b-owned",
    );
    const row = await prisma.chessMatch.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(row.ownerId, null);
    assert.notEqual(row.slug, target.slug);
    assert.notEqual(row.publicId, target.publicId);
    assert.equal(row.published, true);
    await assert.rejects(api.get({ slug: target.slug }), { code: "NOT_FOUND" });
    const game = await api.get({ slug: row.slug });
    assert.equal(game.anonymized, true);
    assert.equal(game.archive.config.white.model, safeModel);
    assert.equal(game.archive.config.black.name, "Deleted user");
    assert.equal(chess.boardAt(game.archive).fen(), chess.boardAt(archive).fen());
    const serialized = JSON.stringify(game) + pgn.exportPgn(game.archive);
    for (const forbidden of [marker, owner.id, archive.id, target.publicId, target.id])
      assert.equal(
        serialized.includes(forbidden),
        false,
        `Public projection leaked ${forbidden === marker ? "personal text" : "former identity"}`,
      );
    assert.equal(
      game.archive.events.some((event) => event.type === "tool" || event.type === "reply"),
      false,
    );

    // Public keyset order uses replaceable public IDs, never database row IDs or
    // a lookup of a cursor row that can be removed between pages.
    const future = new Date("2099-01-01T00:00:00.000Z");
    const cursorRows = [];
    for (let index = 0; index < 3; index++) {
      const value = await prisma.chessMatch.create({
        data: seed(`${prefix}-cursor-${index}`, active.id, true, future),
      });
      matchIds.push(value.id);
      cursorRows.push(value);
    }
    const first = await api.list({ limit: 1 });
    assert.ok(first.nextCursor);
    const decoded = Buffer.from(first.nextCursor, "base64url").toString("utf8");
    assert.equal(decoded.endsWith(`|${first.items[0].id}`), true);
    assert.ok(cursorRows.some((value) => value.publicId === first.items[0].id));
    for (const value of cursorRows) assert.equal(decoded.includes(value.id), false);
    await prisma.chessMatch.deleteMany({
      where: { publicId: first.items[0].id, ownerId: active.id },
    });
    const second = await api.list({ limit: 1, cursor: first.nextCursor });
    assert.equal(
      second.items.length,
      1,
      "Deleting cursor row must not truncate following public rows",
    );
    assert.notEqual(second.items[0].id, first.items[0].id);
    assert.ok(cursorRows.some((value) => value.publicId === second.items[0].id));
    // A catalog cache miss must not preserve a personal row sampled before
    // the owner's tombstone. The external IO is a deterministic stub; the
    // actual visibility query and deletion state are PostgreSQL operations.
    resetModelCatalogCache();
    const catalogFetch = globalThis.fetch;
    let catalogEntered;
    let resumeCatalog;
    const entered = new Promise((resolve) => {
      catalogEntered = resolve;
    });
    const resume = new Promise((resolve) => {
      resumeCatalog = resolve;
    });
    globalThis.fetch = async (input) => {
      catalogEntered();
      await resume;
      return catalogFetch(input);
    };
    try {
      const listing = api.list({ limit: 100 });
      await entered;
      await prisma.user.update({
        where: { id: active.id },
        data: { deletionRequestedAt: new Date(), deletionState: "pending" },
      });
      resumeCatalog();
      const currentPage = await listing;
      assert.equal(
        JSON.stringify(currentPage).includes(marker),
        false,
        "Catalog IO must be followed by a fresh visibility query before returning personal cards",
      );
      for (const value of cursorRows)
        assert.equal(
          currentPage.items.some((item) => item.slug === value.slug),
          false,
        );
    } finally {
      resumeCatalog();
      globalThis.fetch = catalogFetch;
    }
    console.log(
      "account-deletion: real PG pending publication fence, bounded replay scrub, neutral export identity, delete-safe public cursor and catalog/deletion visibility race passed",
    );
  } finally {
    await prisma.chessMatch.deleteMany({ where: { id: { in: matchIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, active.id] } } });
    globalThis.fetch = originalFetch;
    resetModelCatalogCache();
  }
}
