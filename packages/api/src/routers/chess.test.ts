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
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";
import type { Context } from "../context";
import { chessTurnColumns } from "../lib/chess-turn";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
const { ensureRunnableJob, budget, env, reconcileAdd } = vi.hoisted(() => ({
  ensureRunnableJob: vi.fn(),
  reconcileAdd: vi.fn(),
  budget: vi.fn(),
  env: {
    CHESS_HOSTED_ENABLED: true,
    OPENROUTER_API_KEY: "test-only" as string | undefined,
    CHESS_MAX_COST_USD: 25,
    CHESS_MAX_TOKENS: 10_000_000,
    CHESS_USER_MATCHES_ENABLED: true,
    CHESS_PROVIDER_KEY_SECRET: "ab".repeat(32) as string | undefined,
    CHESS_USER_DAILY_MATCHES: 20,
    CHESS_QUEUE_MAX: 200,
    CHESS_RUN_CONCURRENCY: 512,
  },
}));
const { engineStats } = vi.hoisted(() => ({ engineStats: vi.fn() }));
const { openKey } = vi.hoisted(() => ({ openKey: vi.fn() }));
vi.mock("../lib/provider-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/provider-key")>()),
  openOwnerOpenRouterKey: openKey,
}));
vi.mock("@cockpit-chess/queue/chess-capacity", () => ({ readChessEngineStats: engineStats }));
vi.mock("@cockpit-chess/env/server", () => ({
  env: { SOURCE_CODE_URL: "https://github.com/FlyCockpit/chess" },
}));
vi.mock("@cockpit-chess/queue", () => ({
  CHESS_SPECTATOR_JOB_PRIORITY: 10,
  chessRunQueue: {},
  redisConnection: {},
  chessReconcileQueue: { add: reconcileAdd },
  chessSpectatorJobId: (id: string, ply: number) => `chess-spectator-${id}-${ply}`,
  ensureRunnableJob,
}));
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
const match = () => createMatch({ white: baseline, black: baseline, rules: {} });
const newConfig = () => ({ white: baseline, black: baseline, rules: {} });
function row() {
  const archive = match();
  return {
    ...chessTurnColumns({ type: "idle" }),
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
    rulesVersion: "cockpit-v1",
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
    whiteTruncated: null,
    blackTruncated: null,
    whiteCostMicros: null,
    blackCostMicros: null,
    moveFormat: null,
    ending: null,
    spectatorEvaluations: null as unknown,
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
  whiteTruncated: number | null;
  blackTruncated: number | null;
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
  whiteTruncated: 0,
  blackTruncated: 0,
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
  mockReset(db);
  ensureRunnableJob.mockReset().mockResolvedValue({});
  invalidateForceTwoFactorSettingsCache();
  db.appSetting.findMany.mockResolvedValue([]);
  env.CHESS_HOSTED_ENABLED = true;
  env.CHESS_MAX_COST_USD = 25;
  env.CHESS_MAX_TOKENS = 10_000_000;
  env.CHESS_USER_MATCHES_ENABLED = true;
  env.CHESS_PROVIDER_KEY_SECRET = "ab".repeat(32);
  env.OPENROUTER_API_KEY = "test-only";
  env.CHESS_USER_DAILY_MATCHES = 20;
  env.CHESS_QUEUE_MAX = 200;
  budget.mockResolvedValue(undefined);
  // The create transaction runs its callback against the same mock client.
  db.$transaction.mockImplementation(((fn: (tx: typeof db) => unknown) => fn(db)) as never);
  db.$queryRaw.mockResolvedValue([] as never);
  db.chessMatch.count.mockResolvedValue(0);
  db.openRouterConnection.findUnique.mockResolvedValue(null);
});
describe("chess public projection and operator boundaries", () => {
  it("projects bounded turn metadata without leaking the pending input into cards", async () => {
    const record = row();
    const archive = createMatch(
      {
        white: { name: "Human", model: "human", protocol: "human" },
        black: baseline,
        rules: {},
      },
      "hosted",
    );
    archive.turn = {
      type: "human-move",
      turnId: "11111111-1111-4111-8111-111111111111",
      side: "w",
      expectedSeq: 0,
      startedAt: "2026-11-27T00:00:00.000Z",
      deadline: "2026-11-27T00:01:00.000Z",
      pendingMove: { move: "e2e4", receivedAt: "2026-11-27T00:00:01.000Z" },
    };
    db.chessMatch.findMany.mockResolvedValue([
      { ...record, ...chessTurnColumns(archive.turn), archive },
    ]);
    const cards = await client(null).list({ limit: 10 });
    const card = cards.items[0];
    expect(card?.turn).toMatchObject({
      type: "human-move",
      turnId: archive.turn.turnId,
      expectedSeq: 0,
    });
    expect(card?.turn).not.toHaveProperty("pendingMove");
    expect(card).not.toHaveProperty("pendingMove");
    expect(db.chessMatch.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 11 }));
  });
  it("rejects stored archives missing the current turn on public and owner readers", async () => {
    const record = row();
    const { turn: _turn, ...old } = record.archive;
    db.chessMatch.findFirst.mockResolvedValue({ ...record, archive: old });
    await expect(client(null).get({ slug: "test-game" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Unsupported archive",
    });
    await expect(client().inspect({ slug: "test-game" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Unsupported archive",
    });
  });
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
  it("maps stored rules versions to public cards without exposing the version", async () => {
    db.chessMatch.findMany.mockResolvedValue(
      ["cockpit-v2", "cockpit-v1", null].map((rulesVersion, i) => ({
        ...row(),
        id: String(i),
        rulesVersion,
      })) as never,
    );
    const result = await client(null).list({ limit: 5 });
    expect(result.items.map((item) => item.oldRules)).toEqual([true, false, true]);
    for (const item of result.items) expect(item).not.toHaveProperty("rulesVersion");
  });
  it("returns an old-rules card without parsing its invalid archive", async () => {
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      rulesVersion: "cockpit-v2",
      archive: { invalid: true },
    });
    const game = await client(null).get({ slug: "test-game" });
    expect(game).toMatchObject({ oldRules: true, archive: null, spectatorEvaluations: null });
    expect(game).not.toHaveProperty("rulesVersion");
  });
  it("tells the owner an old-rules game can't be inspected instead of calling it invalid", async () => {
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      rulesVersion: "cockpit-v2",
      archive: { invalid: true },
    });
    await expect(client().inspect({ slug: "test-game" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Unsupported ruleset/archive",
    });
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
  it("rejects anonymous writes before storage or scheduling", async () => {
    const api = client(null);
    await expect(api.create(newConfig())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(api.importGame({ json: JSON.stringify(match()) })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(api.publish({ slug: "private-game", published: true })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(api.stop({ slug: "private-game" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
    expect(ensureRunnableJob).not.toHaveBeenCalled();
  });
  it("keeps imports admin-only and refuses a user without a connected key", async () => {
    const api = client("user");
    await expect(api.importGame({ json: JSON.stringify(match()) })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(api.create(newConfig())).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: { reason: "not-connected" },
    });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
    expect(ensureRunnableJob).not.toHaveBeenCalled();
  });
  it("fails closed when hosted inference is off, even for an admin", async () => {
    env.CHESS_HOSTED_ENABLED = false;
    await expect(client().create(newConfig())).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });
  it("publishes safe registry text and refuses unsupported or client-supplied instructions before admission", async () => {
    const info = await client(null).info();
    expect(info.currentPromptVersion).toBe("1");
    expect(info.promptVersions).toHaveLength(1);
    expect(info.promptVersions[0]).toMatchObject({
      version: "1",
      hash: match().config.prompt.hash,
      manifest: { system: expect.arrayContaining([expect.stringContaining("Board authority:")]) },
    });
    await expect(
      client().create({ ...newConfig(), promptVersion: "2" as never }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client().create({ ...newConfig(), prompt: { system: "Choose my instructions" } } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(budget).not.toHaveBeenCalled();
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });
  it("refuses fabricated imported prompt provenance instead of assigning the current bundle", async () => {
    const archive = match();
    finishMatch(archive, "*", "cancelled", "stopped");
    archive.config.prompt.hash = "0".repeat(64);
    await expect(client().importGame({ json: JSON.stringify(archive) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Unsupported archive",
    });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });
  it("tells the create form the operator limits from server config", async () => {
    env.CHESS_MAX_COST_USD = 2.5;
    env.CHESS_MAX_TOKENS = 3_000_000;
    expect(await client(null).info()).toMatchObject({
      limits: { maxCostMicros: 2_500_000, maxTokens: 3_000_000 },
    });
  });
  it("accepts budgets up to the configured operator limits and rejects more", async () => {
    db.chessMatch.create.mockResolvedValue(row() as never);
    ensureRunnableJob.mockResolvedValue({ id: "chess-id" });
    const at = { costBudgetMicros: 25_000_000, tokenBudget: 10_000_000 };
    await expect(client().create({ ...newConfig(), rules: at })).resolves.toMatchObject({
      slug: expect.any(String),
    });
    for (const over of [
      { ...at, costBudgetMicros: 25_000_001 },
      { ...at, tokenBudget: 10_000_001 },
    ])
      await expect(client().create({ ...newConfig(), rules: over })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Hosted match exceeds the operator limits",
      });
    env.CHESS_MAX_COST_USD = 1;
    await expect(
      client().create({ ...newConfig(), rules: { costBudgetMicros: 1_000_001 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.chessMatch.create).toHaveBeenCalledTimes(1);
  });
  it("rejects an unloadable initial FEN as input validation before charging the budget", async () => {
    await expect(
      client().create({ ...newConfig(), initialFen: "not a fen" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(budget).not.toHaveBeenCalled();
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });
  it("creates durable queued intent before publishing the deterministic job", async () => {
    db.chessMatch.create.mockResolvedValue(row() as never);
    ensureRunnableJob.mockResolvedValue({ id: "chess-id" });
    const result = await client().create(newConfig());
    expect(result.slug).toMatch(/^agent-showdown-/);
    expect(budget).toHaveBeenCalledWith("owner");
    expect(db.chessMatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: "owner",
          rulesVersion: "cockpit-v1",
          promptVersion: "1",
          promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          archive: expect.objectContaining({
            config: expect.objectContaining({
              prompt: expect.objectContaining({
                version: "1",
                promptApplied: false,
                system: expect.stringContaining("Tools are limited to the current position"),
              }),
            }),
          }),
          status: "queued",
          official: true,
          published: false,
        }),
      }),
    );
    expect(ensureRunnableJob).toHaveBeenCalledWith({}, "chess-run", { matchId: "id" }, "chess-id");
  });
  it("never admits or enqueues when the fail-closed procedure budget is unavailable", async () => {
    budget.mockRejectedValue(new Error("scheduling unavailable"));
    await expect(client().create(newConfig())).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.chessMatch.create).not.toHaveBeenCalled();
    expect(ensureRunnableJob).not.toHaveBeenCalled();
  });
  it("never overwrites a claimed or stopped match after an ambiguous enqueue failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.chessMatch.create.mockResolvedValue(row() as never);
    ensureRunnableJob.mockRejectedValue(new Error("queue reply lost"));
    db.chessMatch.updateMany.mockResolvedValue({ count: 0 });
    await expect(client().create(newConfig())).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(db.chessMatch.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "id", status: "queued" },
      data: { status: "error", ending: { kind: "interrupted" } },
    });
    log.mockRestore();
  });
  it("imports a replay-validated private archive without granting official provenance", async () => {
    const archive = match();
    archive.source = "hosted";
    finishMatch(archive, "*", "cancelled", "stopped");
    db.chessMatch.findFirst.mockResolvedValue(null);
    db.chessMatch.create.mockResolvedValue(row() as never);
    await client().importGame({ json: JSON.stringify(archive) });
    expect(db.chessMatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          published: false,
          official: false,
          source: "local",
          rulesVersion: "cockpit-v1",
          promptVersion: "1",
          promptHash: archive.config.prompt.hash,
          archive: expect.objectContaining({ source: "local" }),
        }),
      }),
    );
  });
  it("accepts an interrupted archive as an unrated error draft", async () => {
    const archive = match();
    finishMatch(archive, "*", "interrupted", "error");
    db.chessMatch.findFirst.mockResolvedValue(null);
    db.chessMatch.create.mockResolvedValue(row() as never);
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
  it("normalizes a queued own-key match cancelled by Disconnect as credential-revoked", async () => {
    const archive = match();
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      status: "error",
      ending: { kind: "credential-revoked" },
      archive,
    });
    const inspected = await client("user").inspect({ slug: "test-game" });
    expect(inspected.archive).toMatchObject({
      status: "error",
      termination: "credential-revoked",
      result: "*",
    });
    const published = await client(null).get({ slug: "test-game" });
    expect(published.archive).toMatchObject({
      status: "error",
      termination: "credential-revoked",
      result: "*",
    });
  });
  it("normalizes a terminal-FEN queued match cancelled by Disconnect as credential-revoked", async () => {
    const archive = createMatch({
      white: baseline,
      black: baseline,
      rules: {},
      initialFen: "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
    });
    expect(archive.status).toBe("completed");
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      status: "error",
      ending: { kind: "credential-revoked" },
      archive,
    });
    const inspected = await client("user").inspect({ slug: "test-game" });
    expect(inspected.archive).toMatchObject({
      status: "error",
      termination: "credential-revoked",
      result: "*",
    });
    const published = await client(null).get({ slug: "test-game" });
    expect(published.archive).toMatchObject({
      status: "error",
      termination: "credential-revoked",
      result: "*",
    });
  });
  it("accepts an upload of exactly the shared archive limit", async () => {
    const json = uploadOfSize(MAX_ARCHIVE_BYTES);
    expect(utf8ByteLength(json)).toBe(MAX_ARCHIVE_BYTES);
    db.chessMatch.findFirst.mockResolvedValue(null);
    db.chessMatch.create.mockResolvedValue(row() as never);
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
    expect(args?.data).toEqual({
      status: "stopped",
      runToken: null,
      ending: { kind: "cancelled" },
    });
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
      statsRow({ result: "1-0", whiteIllegal: 2, whiteTruncated: 1, whiteCostMicros: 100n }),
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
        truncatedAttempts: 0,
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
        truncatedAttempts: 0,
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
        truncatedAttempts: 1,
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
  it("serves spectator evaluations and asks once for a backfill of a finished game's gaps", async () => {
    reconcileAdd.mockResolvedValue({});
    const archive = match();
    const chess = boardAt(archive);
    submitMove(archive, chess, "e2e4");
    finishMatch(archive, "*", "cancelled", "stopped");
    const start = createMatch(newConfig()).config.initialFen;
    const evaluation = {
      engine: "stockfish-19-lite-single",
      fen: boardAt(createMatch(newConfig())).fen(),
      depth: 9,
      nodes: 10000,
      cp: 25,
      mate: null,
      bestMove: null,
    };
    expect(start).toContain("rnbqkbnr");
    const stored = { ...row(), id: "spectated", status: "stopped", archive };
    db.chessMatch.findFirst.mockResolvedValue({
      ...stored,
      spectatorEvaluations: { "0": evaluation, bogus: 1 },
    });
    // A malformed stored entry reads as "not evaluated" without hiding the valid ones.
    expect((await client(null).get({ slug: "test-game" })).spectatorEvaluations).toEqual({
      "0": evaluation,
    });
    db.chessMatch.findFirst.mockResolvedValue({
      ...stored,
      spectatorEvaluations: { "0": evaluation },
    });
    const game = await client(null).get({ slug: "test-game" });
    expect(game.spectatorEvaluations).toEqual({ "0": evaluation });
    expect(db.chessMatch.findFirst.mock.calls[0]?.[0]?.select).toMatchObject({
      spectatorEvaluations: true,
    });
    await client(null).get({ slug: "test-game" });
    // One request per gap (memoized), made runnable even if a finished job is retained.
    await vi.waitFor(() =>
      expect(ensureRunnableJob).toHaveBeenCalledExactlyOnceWith(
        { add: reconcileAdd },
        "chess-spectator",
        { reason: "spectator", matchId: "spectated", fromPly: 1 },
        "chess-spectator-spectated-1",
        { priority: 10 },
      ),
    );
    // A running game is evaluated by its own run; a complete one needs nothing.
    ensureRunnableJob.mockClear();
    db.chessMatch.findFirst.mockResolvedValue({ ...row(), id: "live", status: "running" });
    await client(null).get({ slug: "test-game" });
    const done = match();
    db.chessMatch.findFirst.mockResolvedValue({
      ...row(),
      id: "complete",
      status: "completed",
      archive: done,
      spectatorEvaluations: { "0": evaluation },
    });
    await client(null).get({ slug: "test-game" });
    expect(ensureRunnableJob).not.toHaveBeenCalled();
    // A queue outage never fails the read.
    ensureRunnableJob.mockRejectedValueOnce(new Error("valkey down"));
    db.chessMatch.findFirst.mockResolvedValue({ ...stored, id: "outage" });
    await expect(client(null).get({ slug: "test-game" })).resolves.toMatchObject({
      spectatorEvaluations: null,
    });
    await vi.waitFor(() => expect(ensureRunnableJob).toHaveBeenCalledTimes(1));
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
    db.chessMatch.create.mockResolvedValue(row() as never);
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
    db.chessMatch.create.mockResolvedValue(row() as never);
    db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
    ensureRunnableJob.mockRejectedValue(new Error("redis down"));
    await expect(client().create(newConfig())).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(log).toHaveBeenCalledWith("[chess] Failed to enqueue hosted match", {
      matchId: "id",
      error: "redis down",
    });
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith({
      where: { id: "id", status: "queued" },
      data: { status: "error", ending: { kind: "interrupted" } },
    });
  });
});

describe("chess.models", () => {
  it("is for signed-in users and maps a catalog outage to SERVICE_UNAVAILABLE", async () => {
    const { resetModelCatalogCache } = await import("../lib/chess-models");
    resetModelCatalogCache();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("down", { status: 503 }));
    try {
      await expect(client(null).models()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(client().models()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "openai/gpt-4.1-nano", pricing: { prompt: "0", completion: "0" } }],
          }),
        ),
      );
      const catalog = await client().models();
      expect(catalog.models.map((model) => model.id)).toEqual(["openai/gpt-4.1-nano"]);
    } finally {
      fetchSpy.mockRestore();
      resetModelCatalogCache();
    }
  });
});

describe("hosted matches on the user's own OpenRouter key", () => {
  const connected = () => {
    db.openRouterConnection.findUnique.mockResolvedValue({
      status: "active",
      expiresAt: null,
    } as never);
    // The re-check under the create lock.
    db.openRouterConnection.findFirst.mockResolvedValue({ id: "conn" } as never);
  };
  const userClient = (id = "user-1") =>
    createRouterClient(chessRouter, { context: context("user", id) });
  beforeEach(() => {
    db.chessMatch.create.mockResolvedValue(row() as never);
    ensureRunnableJob.mockResolvedValue({ id: "chess-id" });
    openKey.mockResolvedValue({ state: "ok", apiKey: "not-returned", keyHash: "h" });
  });

  it("asks for a reconnect when this server can no longer open the stored key", async () => {
    connected();
    openKey.mockResolvedValue({ state: "unreadable", keyHash: "h" });
    await expect(userClient().create(newConfig())).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: { reason: "reconnect" },
    });
    expect(openKey).toHaveBeenCalledWith("user-1");
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });

  it("creates a private, unofficial match billed to the owner's key", async () => {
    connected();
    await expect(userClient().create(newConfig())).resolves.toMatchObject({
      slug: expect.any(String),
    });
    expect(db.openRouterConnection.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(db.chessMatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: "user-1",
          official: false,
          published: false,
          credentialSource: "owner-openrouter",
        }),
      }),
    );
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("refuses, under the create lock, a key disconnected since the first check", async () => {
    connected();
    db.openRouterConnection.findFirst.mockResolvedValue(null);
    await expect(userClient().create(newConfig())).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: { reason: "not-connected" },
    });
    expect(db.openRouterConnection.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        status: "active",
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      select: { id: true },
    });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });

  it("never lets a non-admin bill the operator key", async () => {
    connected();
    await expect(
      userClient().create({ ...newConfig(), billing: "operator" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "operator-billing-admin-only" },
    });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });

  it("refuses users while the operator has not opened user matches", async () => {
    env.CHESS_USER_MATCHES_ENABLED = false;
    connected();
    await expect(userClient().create(newConfig())).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "user-matches-disabled" },
    });
    // Admins still run operator matches.
    await expect(client().create(newConfig())).resolves.toBeTruthy();
  });

  it("asks for a reconnect when the key is invalid or expired", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue({
      status: "invalid",
      expiresAt: null,
    } as never);
    await expect(userClient().create(newConfig())).rejects.toMatchObject({
      data: { reason: "reconnect" },
    });
    db.openRouterConnection.findUnique.mockResolvedValue({
      status: "active",
      expiresAt: new Date(Date.now() - 1000),
    } as never);
    await expect(userClient().create(newConfig())).rejects.toMatchObject({
      data: { reason: "reconnect" },
    });
  });

  it("fails closed without a sealing secret", async () => {
    env.CHESS_PROVIDER_KEY_SECRET = undefined;
    connected();
    await expect(userClient().create(newConfig())).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "openrouter-unavailable" },
    });
  });

  it("allows one active match per user, counted under the create lock", async () => {
    connected();
    db.chessMatch.count.mockImplementation((async (args: { where: Record<string, unknown> }) =>
      args.where.ownerId && args.where.status ? 1 : 0) as never);
    await expect(userClient().create(newConfig())).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "active-match" },
    });
    expect(db.chessMatch.count).toHaveBeenCalledWith({
      where: {
        ownerId: "user-1",
        credentialSource: "owner-openrouter",
        status: { in: ["queued", "running"] },
      },
    });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });

  it("enforces the rolling daily cap", async () => {
    connected();
    env.CHESS_USER_DAILY_MATCHES = 3;
    db.chessMatch.count.mockImplementation((async (args: { where: Record<string, unknown> }) =>
      args.where.createdAt ? 3 : 0) as never);
    await expect(userClient().create(newConfig())).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      data: { reason: "daily-limit" },
    });
  });

  it("refuses every create once the queue is full, admins included", async () => {
    connected();
    env.CHESS_QUEUE_MAX = 5;
    db.chessMatch.count.mockImplementation((async (args: { where: Record<string, unknown> }) =>
      args.where.status === "queued" ? 5 : 0) as never);
    await expect(userClient().create(newConfig())).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      data: { reason: "queue-full" },
    });
    await expect(client().create(newConfig())).rejects.toMatchObject({
      data: { reason: "queue-full" },
    });
    expect(db.chessMatch.create).not.toHaveBeenCalled();
  });

  it("serializes concurrent creates so the caps cannot be raced", async () => {
    connected();
    // A real advisory lock: the second transaction waits until the first commits.
    let active = 0;
    let lock = Promise.resolve();
    db.$transaction.mockImplementation((async (fn: (tx: typeof db) => Promise<unknown>) => {
      const previous = lock;
      let release = () => {};
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(db);
      } finally {
        release();
      }
    }) as never);
    db.chessMatch.count.mockImplementation((async (args: { where: Record<string, unknown> }) =>
      args.where.ownerId && args.where.status ? active : 0) as never);
    db.chessMatch.create.mockImplementation((async () => {
      active += 1;
      return row();
    }) as never);
    // Two creates in flight at once; the lock lets exactly one through.
    const settle = (call: Promise<unknown>) =>
      call.then(
        () => "created",
        () => "refused",
      );
    const first = settle(userClient().create(newConfig()));
    const second = settle(userClient().create(newConfig()));
    expect([await first, await second].sort()).toEqual(["created", "refused"]);
    expect(db.chessMatch.create).toHaveBeenCalledTimes(1);
  });

  it("lets an admin bill their own key, with the user caps and no official standing", async () => {
    connected();
    await client().create({ ...newConfig(), billing: "openrouter" });
    expect(db.chessMatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ official: false, credentialSource: "owner-openrouter" }),
      }),
    );
    expect(db.chessMatch.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerId: "owner" }) }),
    );
  });

  it("refuses an unverified email before anything else", async () => {
    const ctx = context("user", "user-1");
    if (ctx.session) ctx.session.user.emailVerified = false;
    await expect(
      createRouterClient(chessRouter, { context: ctx }).create(newConfig()),
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "unverified" } });
    expect(budget).not.toHaveBeenCalled();
  });

  it("tells the client whether user matches are open, the daily limit and the source link", async () => {
    expect(await client(null).info()).toMatchObject({
      userMatchesEnabled: true,
      dailyLimit: 20,
      sourceCodeUrl: expect.stringMatching(/^https:\/\/github\.com\/FlyCockpit\/chess/),
    });
    env.CHESS_PROVIDER_KEY_SECRET = undefined;
    expect(await client(null).info()).toMatchObject({ userMatchesEnabled: false });
  });

  it("scopes a user's studio, inspect, stop and publish to their own rows", async () => {
    const api = userClient("user-2");
    db.chessMatch.findMany.mockResolvedValue([]);
    await api.studio({ limit: 5 });
    expect(db.chessMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ ownerId: "user-2" }] } }),
    );
    db.chessMatch.findFirst.mockResolvedValue(null);
    await expect(api.inspect({ slug: "someone-else" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(api.publish({ slug: "someone-else", published: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(api.stop({ slug: "someone-else" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const call of db.chessMatch.findFirst.mock.calls)
      expect(call[0]?.where).toEqual({ slug: "someone-else", ownerId: "user-2" });
    expect(db.chessMatch.update).not.toHaveBeenCalled();
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
  });

  it("reports a queued match's position and who pays", async () => {
    const queued = { ...row(), status: "queued", credentialSource: "owner-openrouter" };
    db.chessMatch.findFirst.mockResolvedValue(queued as never);
    db.chessMatch.count.mockResolvedValue(2);
    const result = await userClient("owner").inspect({ slug: "test-game" });
    expect(result).toMatchObject({ queuePosition: 3, credentialSource: "openrouter" });
    expect(db.chessMatch.count).toHaveBeenCalledWith({
      where: {
        status: "queued",
        OR: [
          { createdAt: { lt: queued.createdAt } },
          { createdAt: queued.createdAt, id: { lt: queued.id } },
        ],
      },
    });
  });

  it("lets only admins mark a published hosted game official", async () => {
    await expect(
      userClient().setOfficial({ slug: "test-game", official: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
    await expect(client().setOfficial({ slug: "test-game", official: true })).resolves.toEqual({
      official: true,
    });
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith({
      where: { slug: "test-game", published: true, source: "hosted" },
      data: { official: true },
    });
    db.chessMatch.updateMany.mockResolvedValue({ count: 0 });
    await expect(client().setOfficial({ slug: "draft", official: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("shows admins live and queued counts and the engine pool, without private data", async () => {
    await expect(userClient().capacity()).rejects.toMatchObject({ code: "NOT_FOUND" });
    db.chessMatch.count.mockImplementation((async (args: { where: { status: string } }) =>
      args.where.status === "running" ? 7 : 3) as never);
    db.chessMatch.findMany.mockResolvedValue([
      {
        slug: "a",
        title: "A",
        status: "running",
        createdAt: new Date("2026-11-26T00:00:00Z"),
        Owner: { name: "Ada" },
      },
    ] as never);
    engineStats.mockResolvedValue({
      busy: 2,
      total: 4,
      waiting: 1,
      running: 7,
      concurrency: 512,
      workers: 1,
    });
    const result = await client().capacity();
    expect(result).toEqual({
      running: 7,
      concurrencyLimit: 512,
      queued: 3,
      queueCap: 200,
      engine: { busy: 2, total: 4, waiting: 1, workers: 1 },
      matches: [
        {
          slug: "a",
          title: "A",
          status: "running",
          createdAt: new Date("2026-11-26T00:00:00Z"),
          ownerName: "Ada",
        },
      ],
    });
    expect(db.chessMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        select: {
          slug: true,
          title: true,
          status: true,
          createdAt: true,
          Owner: { select: { name: true } },
        },
      }),
    );
    engineStats.mockRejectedValue(new Error("valkey down"));
    expect(await client().capacity()).toMatchObject({ engine: null, concurrencyLimit: 512 });
  });

  it("reports no engine when every worker's numbers expired, not 0/0", async () => {
    db.chessMatch.count.mockResolvedValue(0 as never);
    db.chessMatch.findMany.mockResolvedValue([] as never);
    engineStats.mockResolvedValue({
      busy: 0,
      total: 0,
      waiting: 0,
      running: 0,
      concurrency: 0,
      workers: 0,
    });
    expect(await client().capacity()).toMatchObject({ engine: null, concurrencyLimit: 0 });
  });
});
