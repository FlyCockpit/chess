import type { Session } from "@cockpit-chess/auth";
import {
  boardAt,
  createMatch,
  finishMatch,
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  type MatchEvent,
  submitMove,
  utf8ByteLength,
} from "@cockpit-chess/chess";
import type prismaInstance from "@cockpit-chess/db";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { Context } from "../context";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
const { ensureRunnableJob, budget, env } = vi.hoisted(() => ({
  ensureRunnableJob: vi.fn(),
  budget: vi.fn(),
  env: { CHESS_HOSTED_ENABLED: true, OPENROUTER_API_KEY: "test-only" },
}));
vi.mock("@cockpit-chess/queue", () => ({ chessRunQueue: {}, ensureRunnableJob }));
vi.mock("@cockpit-chess/env/shared", () => ({ env }));
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => budget }));
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const { chessRouter } = await import("./chess");
const { invalidateForceTwoFactorSettingsCache } = await import("../index");
function context(role: "admin" | "user" | null = "admin", id = "owner"): Context {
  if (!role) return { session: null, clientIp: "127.0.0.1" };
  return {
    clientIp: "127.0.0.1",
    session: {
      user: {
        id,
        name: "Test",
        email: "test@example.com",
        emailVerified: true,
        role,
        twoFactorEnabled: true,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
      },
      session: {
        id: "test",
        userId: id,
        token: "test",
        expiresAt: new Date("2027-01-01"),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
    } as Session,
  };
}
const client = (role: "admin" | "user" | null = "admin") =>
  createRouterClient(chessRouter, { context: context(role) });
const baseline = { name: "Baseline", model: "random", protocol: "random" as const };
const match = () => createMatch({ white: baseline, black: baseline, rules: { maxPlies: 8 } });
function row() {
  const archive = match();
  return {
    id: "id",
    slug: "test-game",
    createdAt: new Date(),
    updatedAt: new Date(),
    ownerId: "owner",
    title: archive.config.title,
    whiteName: "Baseline",
    blackName: "Baseline",
    status: "running",
    published: false,
    official: false,
    source: "local",
    rulesKey: "rules",
    contextMode: "fresh",
    identityMode: "hidden",
    runToken: null,
    heartbeatAt: new Date(),
    archive,
    result: null,
    whiteModel: null,
    whiteProtocol: null,
    blackModel: null,
    blackProtocol: null,
    whiteIllegal: null,
    blackIllegal: null,
    whiteCostMicros: null,
    blackCostMicros: null,
    moveFormat: null,
  };
}
type StatsRow = {
  rulesKey: string;
  result: string | null;
  whiteModel: string | null;
  whiteProtocol: string | null;
  blackModel: string | null;
  blackProtocol: string | null;
  whiteIllegal: number | null;
  blackIllegal: number | null;
  whiteCostMicros: bigint | null;
  blackCostMicros: bigint | null;
  moveFormat: string | null;
};
const statsRow = (overrides: Partial<StatsRow> = {}): StatsRow => ({
  rulesKey: "rules",
  result: "1-0",
  whiteModel: "model-a",
  whiteProtocol: "openai-chat",
  blackModel: "random",
  blackProtocol: "random",
  whiteIllegal: 0,
  blackIllegal: 0,
  whiteCostMicros: 10n,
  blackCostMicros: 0n,
  moveFormat: "strict",
  ...overrides,
});
const forged = () => {
  const archive = match();
  const event = submitMove(archive, boardAt(archive), "e2e5");
  event.accepted = true;
  finishMatch(archive, "*", "cancelled", "stopped");
  return archive;
};
/** Compact upload JSON of a stopped archive, padded to exactly `target` UTF-8 bytes. */
function uploadOfSize(target: number, fill = "x"): string {
  const archive: MatchArchive = createMatch({
    white: { name: "Model", model: "vendor/model", protocol: "openai-chat" },
    black: baseline,
    rules: {},
  });
  finishMatch(archive, "*", "cancelled", "stopped");
  const fillBytes = utf8ByteLength(fill);
  const filler = (output: string): Extract<MatchEvent, { type: "tool" }> => ({
    type: "tool",
    seq: archive.events.length,
    at: "2026-11-12T00:00:00.000Z",
    side: "w",
    ply: 0,
    name: "board",
    input: "{}",
    output,
  });
  // Bulk-fill from one probe of the per-event overhead, then fine-tune exactly; measuring
  // the 2 MB archive per event would make this quadratic.
  const start = utf8ByteLength(JSON.stringify(archive));
  archive.events.push(filler(""));
  const overhead = utf8ByteLength(JSON.stringify(archive)) - start;
  archive.events.pop();
  const bulk = Math.floor((target - start) / (15_000 * fillBytes + overhead + 16)) - 1;
  for (let i = 0; i < bulk; i += 1) archive.events.push(filler(fill.repeat(15_000)));
  for (;;) {
    const remaining = target - utf8ByteLength(JSON.stringify(archive));
    if (remaining === 0) break;
    if (remaining < 0) throw new Error("archive already larger than the target");
    const roomy = archive.events.find(
      (event) => event.type === "tool" && event.output.length + remaining <= 16_000,
    );
    if (roomy?.type === "tool") {
      roomy.output += "x".repeat(remaining);
      continue;
    }
    const event = filler("");
    archive.events.push(event);
    const room = target - utf8ByteLength(JSON.stringify(archive));
    if (room < 0) throw new Error("no room to pad to the exact target");
    event.output = fill.repeat(Math.min(Math.floor(room / fillBytes), 15_000));
  }
  return JSON.stringify(archive);
}
beforeEach(() => {
  vi.clearAllMocks();
  invalidateForceTwoFactorSettingsCache();
  db.appSetting.findMany.mockResolvedValue([]);
  env.CHESS_HOSTED_ENABLED = true;
  budget.mockResolvedValue(undefined);
});
describe("chess public projection and operator boundaries", () => {
  it("bounds public lists and preserves published visibility alongside the cursor", async () => {
    db.chessMatch.findMany.mockResolvedValue([]);
    await client(null).list({ limit: 5 });
    expect(db.chessMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ published: true }] },
        take: 6,
        select: expect.not.objectContaining({ archive: true, ownerId: true }),
      }),
    );
  });
  it("keeps drafts indistinguishable from missing games", async () => {
    db.chessMatch.findFirst.mockResolvedValue(null);
    await expect(client(null).get({ slug: "private-game" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.chessMatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: "private-game", published: true } }),
    );
  });
  it.each([null, "user"] as const)(
    "rejects non-admin writes before storage or scheduling: %s",
    async (role) => {
      const api = client(role);
      await expect(api.create(match().config)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(api.importGame({ json: JSON.stringify(match()) })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(api.publish({ slug: "private-game", published: true })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(api.stop({ slug: "private-game" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(db.chessMatch.create).not.toHaveBeenCalled();
      expect(ensureRunnableJob).not.toHaveBeenCalled();
    },
  );
  it("fails closed when hosted inference is off, even for an admin", async () => {
    env.CHESS_HOSTED_ENABLED = false;
    await expect(client().create(match().config)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });
  it("rejects an unloadable initial FEN as input validation before charging the budget", async () => {
    await expect(
      client().create({ ...match().config, initialFen: "not a fen" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(budget).not.toHaveBeenCalled();
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });
  it("creates durable queued intent before publishing the deterministic job", async () => {
    db.chessMatch.create.mockResolvedValue(row());
    ensureRunnableJob.mockResolvedValue({ id: "chess-id" });
    const result = await client().create(match().config);
    expect(result.slug).toMatch(/^agent-showdown-/);
    expect(budget).toHaveBeenCalledWith("owner");
    expect(db.chessMatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: "owner",
          status: "queued",
          official: true,
          published: false,
        }),
      }),
    );
    expect(ensureRunnableJob).toHaveBeenCalledWith({}, "chess-run", { matchId: "id" }, "chess-id");
  });
  it("imports a replay-validated private archive without granting official provenance", async () => {
    const archive = match();
    archive.source = "hosted";
    finishMatch(archive, "*", "cancelled", "stopped");
    db.chessMatch.findFirst.mockResolvedValue(null);
    db.chessMatch.create.mockResolvedValue(row());
    await client().importGame({ json: JSON.stringify(archive) });
    expect(db.chessMatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          published: false,
          official: false,
          source: "local",
          archive: expect.objectContaining({ source: "local" }),
        }),
      }),
    );
  });
  it("accepts an interrupted archive as an unrated error draft", async () => {
    const archive = match();
    finishMatch(archive, "*", "interrupted", "error");
    db.chessMatch.findFirst.mockResolvedValue(null);
    db.chessMatch.create.mockResolvedValue(row());
    await client().importGame({ json: JSON.stringify(archive) });
    expect(db.chessMatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "error",
          official: false,
          published: false,
          archive: expect.objectContaining({ termination: "interrupted", result: "*" }),
        }),
      }),
    );
  });
  it("keeps an operator stop authoritative over an interrupted snapshot", async () => {
    const archive = match();
    finishMatch(archive, "*", "interrupted", "error");
    db.chessMatch.findFirst.mockResolvedValue({ ...row(), status: "stopped", archive });
    const game = await client(null).get({ slug: "test-game" });
    expect(game.archive).toMatchObject({
      status: "stopped",
      termination: "cancelled",
      result: "*",
    });
  });
  it("accepts an upload of exactly the shared archive limit", async () => {
    const json = uploadOfSize(MAX_ARCHIVE_BYTES);
    expect(utf8ByteLength(json)).toBe(MAX_ARCHIVE_BYTES);
    db.chessMatch.findFirst.mockResolvedValue(null);
    db.chessMatch.create.mockResolvedValue(row());
    await client().importGame({ json });
    expect(db.chessMatch.create).toHaveBeenCalledTimes(1);
  });
  it("rejects an upload one byte over the shared limit with a clear error", async () => {
    // Multi-byte text keeps the UTF-16 length under the limit, so the exact byte check decides.
    const json = uploadOfSize(MAX_ARCHIVE_BYTES + 1, "é");
    expect(json.length).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
    await expect(client().importGame({ json })).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      message: expect.stringContaining("Game archive exceeds 2000000 bytes"),
    });
    await expect(
      client().importGame({ json: uploadOfSize(MAX_ARCHIVE_BYTES + 1) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });
  it("rejects forged accepted moves before database writes", async () => {
    const archive = forged();
    await expect(client().importGame({ json: JSON.stringify(archive) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });
  it("scopes studio mutations to their owner and cancels without overwriting newer durable events", async () => {
    db.chessMatch.findFirst.mockResolvedValue(row());
    db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
    await client().stop({ slug: "test-game" });
    expect(db.chessMatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: "test-game", ownerId: "owner" } }),
    );
    const args = db.chessMatch.updateMany.mock.calls[0]?.[0];
    expect(args?.data).toEqual({ status: "stopped", runToken: null });
  });
  it("excludes imported, draft, interrupted, and incomplete games from the bounded leaderboard", async () => {
    db.chessMatch.findMany.mockResolvedValue([]);
    await client(null).leaderboard({ limit: 20 });
    expect(db.chessMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          published: true,
          official: true,
          source: "hosted",
          status: "completed",
          result: { not: null },
        },
        take: 500,
        select: expect.not.objectContaining({ archive: true }),
      }),
    );
  });
  it("aggregates leaderboard rows from typed stats columns, per side", async () => {
    db.chessMatch.findMany.mockResolvedValue([
      // model-a wins as white, draws as black, loses as white
      statsRow({ result: "1-0", whiteIllegal: 2, whiteCostMicros: 100n }),
      statsRow({
        result: "1/2-1/2",
        whiteModel: "model-b",
        whiteProtocol: "anthropic",
        blackModel: "model-a",
        blackProtocol: "openai-chat",
        whiteCostMicros: 5n,
        blackCostMicros: 50n,
        blackIllegal: 1,
      }),
      statsRow({ result: "0-1", whiteCostMicros: null }),
      // model-b wins as black against a random baseline
      statsRow({
        result: "0-1",
        whiteModel: "random",
        whiteProtocol: "random",
        blackModel: "model-b",
        blackProtocol: "anthropic",
        blackCostMicros: 7n,
      }),
      // A lenient ruleset has its own rulesKey, so it is ranked separately and labeled.
      statsRow({ rulesKey: "lenient-rules", moveFormat: "lenient", whiteCostMicros: 1n }),
      // A row without stats is skipped, not a 500.
      statsRow({ whiteModel: null }),
    ] as never);
    const board = await client(null).leaderboard({ limit: 20 });
    expect(board.sampleSize).toBe(5);
    expect(board.items).toEqual([
      {
        model: "model-a",
        protocol: "openai-chat",
        rulesKey: "lenient-rules",
        moveFormat: "lenient",
        games: 1,
        wins: 1,
        draws: 0,
        losses: 0,
        illegalAttempts: 0,
        estimatedCostMicros: 1,
      },
      {
        model: "model-b",
        protocol: "anthropic",
        rulesKey: "rules",
        moveFormat: "strict",
        games: 2,
        wins: 1,
        draws: 1,
        losses: 0,
        illegalAttempts: 0,
        estimatedCostMicros: 12,
      },
      {
        model: "model-a",
        protocol: "openai-chat",
        rulesKey: "rules",
        moveFormat: "strict",
        games: 3,
        wins: 1,
        draws: 1,
        losses: 1,
        illegalAttempts: 3,
        estimatedCostMicros: null,
      },
    ]);
  });
  it("serves public games from a projection without owner or run secrets, without replaying", async () => {
    const record = row();
    record.status = "error";
    db.chessMatch.findFirst.mockResolvedValue({ ...record, archive: forged() });
    const game = await client(null).get({ slug: "test-game" });
    const select = db.chessMatch.findFirst.mock.calls[0]?.[0]?.select;
    expect(select).toMatchObject({ archive: true, slug: true, status: true });
    for (const field of ["ownerId", "runToken", "heartbeatAt"])
      expect(select).not.toHaveProperty(field);
    // A forged-but-well-formed stored archive is served (shape-checked only)...
    expect(game.archive.events).toHaveLength(1);
    // ...while a malformed one is still rejected.
    db.chessMatch.findFirst.mockResolvedValue({ ...record, archive: { format: "nope" } });
    await expect(client(null).get({ slug: "test-game" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
  it("normalizes a running snapshot under an errored row status", async () => {
    const record = row();
    record.status = "error";
    db.chessMatch.findFirst.mockResolvedValue(record);
    const game = await client(null).get({ slug: "test-game" });
    expect(game.archive).toMatchObject({
      status: "error",
      result: "*",
      termination: "interrupted",
    });
  });
  it("publish and stop look up only the owned row id", async () => {
    db.chessMatch.findFirst.mockResolvedValue(row());
    db.chessMatch.update.mockResolvedValue(row());
    db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
    await client().publish({ slug: "test-game", published: true });
    await client().stop({ slug: "test-game" });
    for (const [args] of db.chessMatch.findFirst.mock.calls)
      expect(args?.select).toEqual({ id: true });
  });
  it("writes leaderboard stats columns when importing a finished archive", async () => {
    const archive = match();
    finishMatch(archive, "*", "cancelled", "stopped");
    db.chessMatch.findFirst.mockResolvedValue(null);
    db.chessMatch.create.mockResolvedValue(row());
    await client().importGame({ json: JSON.stringify(archive) });
    expect(db.chessMatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: "*",
          whiteModel: "random",
          whiteProtocol: "random",
          whiteIllegal: 0,
          whiteCostMicros: 0n,
          moveFormat: "strict",
        }),
      }),
    );
  });
  it("returns the duplicate response when a concurrent import wins the unique slug", async () => {
    const archive = match();
    finishMatch(archive, "*", "cancelled", "stopped");
    db.chessMatch.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...row(), ownerId: "owner" });
    db.chessMatch.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const result = await client().importGame({ json: JSON.stringify(archive) });
    expect(result).toEqual({ slug: expect.any(String), duplicate: true });
  });
  it("a concurrent import by another owner is a conflict, not a duplicate", async () => {
    const archive = match();
    finishMatch(archive, "*", "cancelled", "stopped");
    db.chessMatch.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...row(), ownerId: "someone-else" });
    db.chessMatch.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(client().importGame({ json: JSON.stringify(archive) })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
  it("logs and errors the row when the hosted job cannot be enqueued", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.chessMatch.create.mockResolvedValue(row());
    db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
    ensureRunnableJob.mockRejectedValue(new Error("redis down"));
    await expect(client().create(match().config)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(log).toHaveBeenCalledWith("[chess] Failed to enqueue hosted match", {
      matchId: "id",
      error: "redis down",
    });
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith({
      where: { id: "id", status: "queued" },
      data: { status: "error" },
    });
  });
});
