import { boardAt, Chess, createMatch, submitMove } from "@cockpit-chess/chess";
import type prismaInstance from "@cockpit-chess/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const { Prisma } = await import("../../../../packages/db/prisma/generated/client");
  return { default: mockDeep<typeof prismaInstance>(), Prisma };
});
const { evaluatePosition, ensureJob } = vi.hoisted(() => ({
  evaluatePosition: vi.fn(),
  ensureJob: vi.fn(),
}));
vi.mock("@cockpit-chess/queue", async () => {
  const { CHESS_SPECTATOR_JOB_PRIORITY, chessSpectatorJobId } = await import(
    "../../../../packages/queue/src/jobs"
  );
  return {
    CHESS_SPECTATOR_JOB_PRIORITY,
    chessReconcileQueue: {},
    chessSpectatorJobId,
    ensureRunnableJob: ensureJob,
  };
});
vi.mock("../../../../packages/chess/src/engine", () => ({ evaluatePosition }));
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const {
  backfillSpectatorEvaluations,
  matchSpectatorFeed,
  requestSpectatorBackfill,
  settleSpectatorFeed,
} = await import("./chess-spectator");

const access = { purpose: "public", version: 0 } as const;
const ownerAccess = { purpose: "owner", ownerId: "owner" } as const;
const player = { name: "Baseline", model: "random", protocol: "random" as const };
const score = (fen: string) => ({
  engine: "stockfish-19-lite-single" as const,
  fen,
  depth: 10,
  nodes: 10000,
  cp: 31,
  mate: null,
  bestMove: null,
});
/** The plies each spectator write merged into the row, in order. */
const updates = () =>
  db.$executeRaw.mock.calls.filter((call) =>
    (call[0] as unknown as TemplateStringsArray)[0]?.startsWith("UPDATE"),
  );
const writtenPlies = () =>
  updates().map((call) => {
    const [, patch, id] = call as unknown as [TemplateStringsArray, string, string];
    expect(id).toBe("match-id");
    const keys = Object.keys(JSON.parse(patch) as object);
    expect(keys).toHaveLength(1);
    return Number(keys[0]);
  });
const finished = () => {
  const match = createMatch({ white: player, black: player, rules: {} }, "hosted");
  const chess = boardAt(match);
  submitMove(match, chess, "e2e4");
  submitMove(match, chess, "e7e5");
  return match;
};
const row = (overrides: Record<string, unknown>) =>
  ({
    id: "match-id",
    ownerId: "owner",
    slug: "test-game",
    published: true,
    hiddenAt: null,
    moderationVersion: 0,
    source: "hosted",
    status: "completed",
    archive: finished(),
    spectatorEvaluations: null,
    ...overrides,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockReset(db);
  db.$executeRaw.mockResolvedValue(1);
  db.$queryRaw.mockResolvedValue([{ id: "match-id" }]);
  db.chessMatch.findFirst.mockResolvedValue(row({}));
  db.$transaction.mockImplementation(async (run) =>
    typeof run === "function" ? run(db) : Promise.all(run),
  );
  ensureJob.mockResolvedValue({});
  evaluatePosition.mockImplementation(async (fen: string) => score(fen));
});

describe("spectator evaluation of hosted games", () => {
  it.each(["runner", "local", "forged", ""])(
    "refuses %s source before backfill engine or writes",
    async (source) => {
      db.chessMatch.findFirst.mockResolvedValue(row({ source }));
      await expect(
        backfillSpectatorEvaluations("match-id", 0, { purpose: "owner", ownerId: "owner" }),
      ).resolves.toEqual({
        evaluated: false,
      });
      expect(evaluatePosition).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(ensureJob).not.toHaveBeenCalled();
    },
  );
  it("refuses stale backfill hints and completion handoffs for runner rows", async () => {
    db.$queryRaw.mockResolvedValue([]);
    await requestSpectatorBackfill("match-id", 0, { purpose: "owner", ownerId: "owner" });
    const stop = new AbortController();
    const feed = matchSpectatorFeed("match-id", null, "owner", stop.signal);
    feed.update(finished());
    await feed.drain();
    expect(feed.failed).toBe(true);
    await settleSpectatorFeed("match-id", feed, stop, "owner");
    expect(evaluatePosition).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(ensureJob).not.toHaveBeenCalled();
    for (const call of db.$queryRaw.mock.calls)
      expect((call[0] as TemplateStringsArray).join("?")).toContain("AND ? LIMIT 1");
  });
  it("checks durable source independently before every engine evaluation", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ id: "match-id" }]).mockResolvedValue([]);
    const feed = matchSpectatorFeed("match-id", null, "owner");
    feed.update(finished());
    await feed.drain();
    expect(evaluatePosition).toHaveBeenCalledTimes(1);
    expect(writtenPlies()).toEqual([0]);
    expect(feed.failed).toBe(true);
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });
  it("merges one ply per write into the spectator column only", async () => {
    const feed = matchSpectatorFeed("match-id", null, "owner");
    feed.update(finished());
    await feed.drain();
    expect(writtenPlies()).toEqual([0, 1, 2]);
    for (const call of updates())
      expect((call[0] as TemplateStringsArray).join("?")).toBe(
        `UPDATE "chess_match" SET "spectatorEvaluations" = (CASE WHEN jsonb_typeof("spectatorEvaluations") = 'object' THEN "spectatorEvaluations" ELSE '{}'::jsonb END) || ?::jsonb WHERE "id" = ? AND ?`,
      );
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    // Each write is one transaction with lock and statement deadlines first.
    const sets = db.$executeRaw.mock.calls
      .map((call) => (call[0] as unknown as TemplateStringsArray).join("?"))
      .filter((sql) => sql.startsWith("SET LOCAL"));
    expect(sets.slice(0, 2)).toEqual([
      "SET LOCAL lock_timeout = '2s'",
      "SET LOCAL statement_timeout = '5s'",
    ]);
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });
  it("backfills only the positions a finished game still lacks", async () => {
    const start = new Chess().fen();
    db.chessMatch.findFirst.mockResolvedValue(
      row({
        spectatorEvaluations: {
          "0": score(start),
          "1": score("stale/8/8/8/8/8/8/8 w - - 0 1"),
        },
      }),
    );
    await expect(backfillSpectatorEvaluations("match-id", 0, access)).resolves.toEqual({
      evaluated: true,
    });
    expect(writtenPlies()).toEqual([1, 2]);
  });
  it("leaves running games to their run, and fails the job on an engine failure", async () => {
    db.chessMatch.findFirst.mockResolvedValue(row({ status: "running" }));
    await expect(backfillSpectatorEvaluations("match-id", 0, access)).resolves.toEqual({
      evaluated: false,
    });
    expect(db.$executeRaw).not.toHaveBeenCalled();
    evaluatePosition.mockRejectedValue(new Error("Engine could not start"));
    db.chessMatch.findFirst.mockResolvedValue(row({}));
    // A failed job is retained; a later read makes it runnable again (ensureRunnableJob).
    await expect(backfillSpectatorEvaluations("match-id", 0, access)).rejects.toMatchObject({
      message: "Spectator evaluation failed",
    });
    expect(db.$executeRaw).not.toHaveBeenCalled();
    db.chessMatch.findFirst.mockResolvedValue(row({ archive: { format: "nope" } }));
    await expect(backfillSpectatorEvaluations("match-id", 0, access)).resolves.toEqual({
      evaluated: false,
    });
  });
  it("reads malformed stored entries as missing and backfills them", async () => {
    const start = new Chess().fen();
    db.chessMatch.findFirst.mockResolvedValue(
      row({ spectatorEvaluations: { "0": score(start), "1": { bogus: true }, junk: 1 } }),
    );
    await backfillSpectatorEvaluations("match-id", 0, access);
    expect(writtenPlies()).toEqual([1, 2]);
  });
  it("hands the rest of a slow backfill to the next chunk, from the first missing ply", async () => {
    vi.useFakeTimers();
    try {
      // A slow engine that, like the real one, stops when its search is cancelled.
      evaluatePosition.mockImplementation(
        (fen: string, options: { signal?: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(score(fen)), 15_000);
            options.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("cancelled"));
            });
          }),
      );
      db.chessMatch.findFirst
        .mockResolvedValueOnce(row({}))
        .mockResolvedValueOnce(row({ spectatorEvaluations: { "0": score(new Chess().fen()) } }));
      const done = backfillSpectatorEvaluations("match-id", 0, access, undefined, 20_000);
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(done).resolves.toEqual({ evaluated: false, continued: 1 });
      expect(ensureJob).toHaveBeenCalledWith(
        {},
        "chess-spectator",
        { reason: "spectator", matchId: "match-id", fromPly: 1, access },
        "chess-spectator-match-id-1-public-0",
        { priority: 10 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("waits a bounded time for a finished run's last positions, then hands them off", async () => {
    vi.useFakeTimers();
    try {
      evaluatePosition.mockImplementation(() => new Promise(() => {}));
      const stop = new AbortController();
      const feed = matchSpectatorFeed("match-id", null, "owner", stop.signal);
      feed.update(finished());
      const settled = settleSpectatorFeed("match-id", feed, stop, "owner", 15_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(settled).resolves.toEqual({ handedOff: true });
      expect(stop.signal.aborted).toBe(true);
      expect(ensureJob).toHaveBeenCalledWith(
        {},
        "chess-spectator",
        { reason: "spectator", matchId: "match-id", fromPly: 0, access: ownerAccess },
        "chess-spectator-match-id-0-owner-owner",
        { priority: 10 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("lets a finished run go at once when every position is scored", async () => {
    const stop = new AbortController();
    const feed = matchSpectatorFeed("match-id", null, "owner", stop.signal);
    feed.update(finished());
    await expect(settleSpectatorFeed("match-id", feed, stop, "owner")).resolves.toEqual({
      handedOff: false,
    });
    expect(ensureJob).not.toHaveBeenCalled();
    expect(writtenPlies()).toEqual([0, 1, 2]);
  });
  it("continues a chunk whose deadline cancelled its last, in-flight position", async () => {
    vi.useFakeTimers();
    try {
      // Plies 0 and 1 are stored; ply 2 is analysed when the deadline hits.
      evaluatePosition.mockImplementation(
        (_fen: string, options: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            options.signal?.addEventListener("abort", () => reject(new Error("cancelled"))),
          ),
      );
      const archive = finished();
      const stored = Object.fromEntries(
        [
          new Chess().fen(),
          new Chess("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1").fen(),
        ].map((fen, ply) => [String(ply), score(fen)]),
      );
      db.chessMatch.findFirst
        .mockResolvedValueOnce(row({ archive, spectatorEvaluations: stored }))
        .mockResolvedValueOnce(row({ archive, spectatorEvaluations: stored }));
      const done = backfillSpectatorEvaluations("match-id", 0, access, undefined, 20_000);
      await vi.advanceTimersByTimeAsync(20_000);
      // Nothing was left in the queue, yet ply 2 is missing: the next chunk starts there.
      await expect(done).resolves.toEqual({ evaluated: false, continued: 2 });
      expect(ensureJob).toHaveBeenCalledWith(
        {},
        "chess-spectator",
        { reason: "spectator", matchId: "match-id", fromPly: 2, access },
        "chess-spectator-match-id-2-public-0",
        { priority: 10 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("fails a chunk that made no progress instead of asking for its own active job", async () => {
    vi.useFakeTimers();
    try {
      evaluatePosition.mockImplementation(
        (_fen: string, options: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            options.signal?.addEventListener("abort", () => reject(new Error("cancelled"))),
          ),
      );
      db.chessMatch.findFirst.mockResolvedValue(row({}));
      const done = backfillSpectatorEvaluations("match-id", 0, access, undefined, 20_000);
      const outcome = expect(done).rejects.toMatchObject({
        message: "Spectator backfill made no progress",
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await outcome;
      expect(ensureJob).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("fails the backfill job when a write fails, leaving the gap for its retry", async () => {
    db.chessMatch.findFirst.mockResolvedValue(row({}));
    db.$transaction.mockRejectedValueOnce(new Error("could not obtain lock"));
    await expect(backfillSpectatorEvaluations("match-id", 0, access)).rejects.toMatchObject({
      message: "Spectator evaluation failed",
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(ensureJob).not.toHaveBeenCalled();
  });
  it("fails a chunk whose write hangs past its deadline, freeing the queue", async () => {
    vi.useFakeTimers();
    try {
      db.chessMatch.findFirst.mockResolvedValue(row({}));
      db.$transaction.mockImplementation(() => new Promise(() => {}));
      const done = backfillSpectatorEvaluations("match-id", 0, access, undefined, 20_000);
      const outcome = expect(done).rejects.toMatchObject({
        message: "Spectator backfill timed out on a write",
      });
      await vi.advanceTimersByTimeAsync(25_000);
      await outcome;
      expect(ensureJob).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("finishes delayed spectator scoring during an unchanged unclaimed hosted human wait", async () => {
  const { beginHostedTurn } = await import("@cockpit-chess/chess");
  const archive = createMatch(
    {
      white: { name: "Human", model: "human", protocol: "human" },
      black: { name: "Model", model: "fixture/model", protocol: "openai-chat" },
      rules: {},
    },
    "hosted",
  );
  submitMove(archive, boardAt(archive), "e2e4");
  submitMove(archive, boardAt(archive), "e7e5");
  beginHostedTurn(archive);
  const turn = structuredClone(archive.turn);
  db.chessMatch.findFirst.mockResolvedValue(
    row({ status: "running", source: "hosted", turnType: "human", runToken: null, archive }),
  );
  const pending = Promise.withResolvers<ReturnType<typeof score>>();
  evaluatePosition.mockImplementationOnce(() => pending.promise);
  const job = backfillSpectatorEvaluations("match-id", 0, access);
  await vi.waitFor(() => expect(evaluatePosition).toHaveBeenCalledOnce());
  expect(db.$executeRaw).not.toHaveBeenCalled();
  pending.resolve(score(boardAt(archive, 0).fen()));
  expect(await job).toEqual({ evaluated: true });
  expect(writtenPlies()).toEqual([0, 1, 2]);
  expect(archive.turn).toEqual(turn);
  expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
});

describe("spectator moderation authority", () => {
  it("does no engine work when a queued public request is now hidden", async () => {
    db.chessMatch.findFirst.mockResolvedValue(null);
    expect(await backfillSpectatorEvaluations("match-id", 0, access)).toEqual({ evaluated: false });
    expect(db.chessMatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          published: true,
          hiddenAt: null,
          source: "hosted",
          moderationVersion: 0,
        }),
      }),
    );
    expect(evaluatePosition).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(ensureJob).not.toHaveBeenCalled();
  });

  it.each(["local", "runner"])("never runs server Stockfish for a %s match", async (source) => {
    db.chessMatch.findFirst.mockResolvedValue(row({ source }));
    expect(await backfillSpectatorEvaluations("match-id", 0, access)).toEqual({ evaluated: false });
    expect(evaluatePosition).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("stops before the next engine call if visibility ends between positions", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ id: "match-id" }]).mockResolvedValue([]);
    expect(await backfillSpectatorEvaluations("match-id", 0, access)).toEqual({ evaluated: false });
    expect(evaluatePosition).toHaveBeenCalledTimes(1);
    expect(writtenPlies()).toEqual([0]);
    expect(ensureJob).not.toHaveBeenCalled();
  });

  it("refuses a stale public write after hide without retry or owner-purpose handoff", async () => {
    db.$transaction.mockResolvedValue([0, 0, 0]);
    expect(await backfillSpectatorEvaluations("match-id", 0, access)).toEqual({ evaluated: false });
    expect(evaluatePosition).toHaveBeenCalledTimes(1);
    const guard = updates()[0]?.[3];
    expect(guard).toMatchObject({ values: [0] });
    expect(String((guard as { sql: string }).sql)).toContain('"hiddenAt" IS NULL');
    expect(ensureJob).not.toHaveBeenCalled();
  });

  it("allows a hidden private replay only with the exact separate owner authority", async () => {
    db.chessMatch.findFirst.mockResolvedValue(row({ hiddenAt: new Date(), published: false }));
    expect(await backfillSpectatorEvaluations("match-id", 0, ownerAccess)).toEqual({
      evaluated: true,
    });
    expect(db.chessMatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerId: "owner",
          source: "hosted",
          Owner: expect.any(Object),
        }),
      }),
    );
    const guard = updates()[0]?.[3] as unknown as { sql: string; values: unknown[] };
    expect(guard.values).toEqual(["owner"]);
    expect(guard.sql).toContain('"deletionRequestedAt" IS NULL');
    expect(guard.sql).not.toContain('"hiddenAt"');
  });

  it("refuses deleted or rebound owner authority before any new engine call", async () => {
    db.$queryRaw.mockResolvedValue([]);
    expect(await backfillSpectatorEvaluations("match-id", 0, ownerAccess)).toEqual({
      evaluated: false,
    });
    expect(evaluatePosition).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(ensureJob).not.toHaveBeenCalled();
  });
});
