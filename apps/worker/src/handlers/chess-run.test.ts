import { chessTurnData } from "@cockpit-chess/api/lib/chess-human";
import {
  beginHostedTurn,
  boardAt,
  createMatch,
  finishMatch,
  submitMove,
  validateArchive,
} from "@cockpit-chess/chess";
import {
  advanceMatch,
  CREDENTIAL_REVOKED,
  finishAbortedMatch,
  MATCH_INTERRUPTED,
} from "@cockpit-chess/chess/runner";
import type prismaInstance from "@cockpit-chess/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const { Prisma } = await import("../../../../packages/db/prisma/generated/client");
  return { default: mockDeep<typeof prismaInstance>(), Prisma };
});
const { getJob, runner, ensureJob } = vi.hoisted(() => ({
  getJob: vi.fn(),
  ensureJob: vi.fn(),
  runner: {
    override: null as
      | null
      | ((
          match: import("@cockpit-chess/chess").MatchArchive,
          options?: import("@cockpit-chess/chess/runner").MatchRunnerOptions,
        ) => Promise<unknown>),
  },
}));
vi.mock("@cockpit-chess/queue", async () => {
  const { chessReconcileJobSchema, chessRunJobSchema } = await import(
    "../../../../packages/queue/src/jobs"
  );
  const { isLiveJobState } = await import("../../../../packages/queue/src/ensure-job");
  const { CHESS_SPECTATOR_JOB_PRIORITY, chessSpectatorJobId } = await import(
    "../../../../packages/queue/src/jobs"
  );
  return {
    chessReconcileJobSchema,
    chessRunJobSchema,
    chessRunQueue: { getJob },
    chessReconcileQueue: {},
    CHESS_SPECTATOR_JOB_PRIORITY,
    chessSpectatorJobId,
    ensureRunnableJob: ensureJob,
    isLiveJobState,
  };
});
vi.mock("@cockpit-chess/chess/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cockpit-chess/chess/runner")>();
  return {
    ...actual,
    runMatch: (...args: Parameters<typeof actual.runMatch>) =>
      runner.override ? runner.override(...args) : actual.runMatch(...args),
  };
});
const { evaluatePosition } = vi.hoisted(() => ({ evaluatePosition: vi.fn() }));
vi.mock("../../../../packages/chess/src/engine", () => ({ evaluatePosition }));
const score = (fen: string) => ({
  engine: "stockfish-19-lite-single" as const,
  fen,
  depth: 10,
  nodes: 10000,
  cp: 31,
  mate: null,
  bestMove: null,
});
const { env } = vi.hoisted(() => ({
  env: {
    DATABASE_POOL_MAX: 3,
    CHESS_HOSTED_ENABLED: false,
    OPENROUTER_API_KEY: undefined as string | undefined,
    CHESS_USER_MATCHES_ENABLED: false,
    CHESS_PROVIDER_KEY_SECRET: undefined as string | undefined,
    OPENROUTER_ORIGIN: "https://openrouter.ai",
    PUBLIC_APP_URL: "https://chess.example" as string | undefined,
    CHESS_CONVERSATION_MAX_BYTES: 2_097_152,
  },
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env }));
const { providerKey } = vi.hoisted(() => ({
  providerKey: { load: vi.fn(), markInvalid: vi.fn() },
}));
vi.mock("@cockpit-chess/api/lib/provider-key", () => ({
  loadOwnerOpenRouterKey: providerKey.load,
  markOpenRouterKeyInvalid: providerKey.markInvalid,
}));
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const { handleChessReconcileJob, handleChessRunJob } = await import("./chess-run");
const { applyChessKeyRevocation, resetChessKeyRevocations } = await import(
  "../chess-key-revocations"
);
const { fakeValkey } = await import("@cockpit-chess/queue/chess-key-revocation/test-support");
const { chessKeyLeasesBlocking } = await import("@cockpit-chess/queue/chess-key-revocation");
const player = { name: "Baseline", model: "random", protocol: "random" as const };
/** A fresh match two reversible plies from the fifty-move draw. */
const archive = () =>
  createMatch(
    { white: player, black: player, rules: {}, initialFen: "7k/8/8/8/8/8/8/R6K w - - 98 80" },
    "hosted",
  );
function row() {
  const match = archive();
  return {
    id: "match-id",
    publicId: "public-match-id",
    slug: "test-game",
    createdAt: new Date(),
    updatedAt: new Date(),
    ownerId: "owner",
    title: "Game",
    whiteName: "Baseline",
    blackName: "Baseline",
    status: "running",
    published: false,
    hiddenAt: null,
    moderationReason: null,
    moderationNote: null,
    moderationVersion: 0,
    official: true,
    source: "hosted",
    rulesKey: "rules",
    rulesVersion: "cockpit-v1",
    promptVersion: match.config.prompt.version,
    promptHash: match.config.prompt.hash,
    contextMode: "fresh",
    identityMode: "hidden",
    runToken: "token",
    heartbeatAt: new Date(),
    turnType: "idle",
    turnId: null,
    turnSide: null,
    turnExpectedSeq: null,
    turnStartedAt: null,
    turnDeadline: null,
    pendingMove: null,
    archive: match,
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
    terminalCause: null,
    spectatorEvaluations: null,
    credentialSource: "operator",
    Owner: { role: "admin" },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mockReset(db);
  runner.override = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
  db.chessMatch.findUnique.mockResolvedValue(row());
  db.chessMatch.findFirst.mockResolvedValue(row());
  db.$queryRaw.mockResolvedValue([{ id: "match-id" }]);
  db.chessMatch.findMany.mockResolvedValue([]);
  db.$executeRaw.mockResolvedValue(1);
  db.$queryRaw.mockResolvedValue([{ id: "match-id" }]);
  db.user.findUnique.mockResolvedValue({ deletionRequestedAt: null, banned: false } as never);
  db.$transaction.mockImplementation(async (run) => {
    if (typeof run !== "function") return Promise.all(run);
    return run(db);
  });
  ensureJob.mockResolvedValue({});
  evaluatePosition.mockImplementation(async (fen: string) => score(fen));
  providerKey.markInvalid.mockResolvedValue(undefined);
});
/** The spectator evaluations the run merged into the row: ply → evaluated FEN. */
const updates = () =>
  db.$executeRaw.mock.calls.filter((call) =>
    (call[0] as unknown as TemplateStringsArray)[0]?.startsWith("UPDATE"),
  );
const spectatorWrites = () =>
  updates().map((call): [number, string] => {
    const [, patch, id] = call as unknown as [TemplateStringsArray, string, string];
    expect(id).toBe("match-id");
    const entries = Object.entries(JSON.parse(patch) as Record<string, { fen: string }>);
    expect(entries).toHaveLength(1);
    const [ply = "", value] = entries[0] ?? [];
    return [Number(ply), value?.fen ?? ""];
  });
afterEach(() => vi.useRealTimers());
describe("durable chess worker", () => {
  it("rejects a stored snapshot missing current turn state before invoking any runner", async () => {
    const record = row();
    const { turn: _turn, ...old } = record.archive;
    db.chessMatch.findUnique.mockResolvedValue({ ...record, archive: old });
    const run = vi.fn();
    runner.override = run;
    await handleChessRunJob({ data: { matchId: record.id } });
    expect(run).not.toHaveBeenCalled();
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: record.id, status: "running" }),
        data: expect.objectContaining({ status: "error", runToken: null }),
      }),
    );
  });
  it("does no work unless it atomically claims the queued match", async () => {
    db.chessMatch.updateMany.mockResolvedValue({ count: 0 });
    await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-id", status: "queued", source: "hosted" },
        data: expect.objectContaining({ status: "running", runToken: expect.any(String) }),
      }),
    );
    expect(db.chessMatch.findUnique).not.toHaveBeenCalled();
  });
  it("plays and persists a genuine legal baseline game, including terminal result", async () => {
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(result).toMatchObject({ result: "1/2-1/2", termination: "draw" });
    const terminal = db.chessMatch.updateMany.mock.calls.find(
      ([input]) => input.data.status === "completed",
    )?.[0];
    expect(terminal?.where).toMatchObject({
      id: "match-id",
      status: "running",
      runToken: expect.any(String),
    });
    expect(terminal?.data.runToken).toBe(null);
    const record = validateArchive(terminal?.data.archive);
    expect(
      record.events.filter((event) => event.type === "attempt" && event.accepted),
    ).toHaveLength(2);
  });
  it("plays a cockpit-v1 baseline to the rules engine's own ending, with no move cap", async () => {
    // Twenty plies short of the fifty-move rule: the engine's own ending comes quickly.
    const baseline = createMatch(
      { white: player, black: player, rules: {}, initialFen: "7k/8/8/8/8/8/8/R6K w - - 80 80" },
      "hosted",
    );
    db.chessMatch.findUnique.mockResolvedValue({ ...row(), archive: baseline });
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(["checkmate", "draw"]).toContain(result?.termination);
    const terminal = db.chessMatch.updateMany.mock.calls.find(
      ([input]) => input.data.status === "completed",
    )?.[0];
    const record = validateArchive(terminal?.data.archive);
    expect(record.config.rules.version).toBe("cockpit-v1");
    expect(record.termination).toBe(result?.termination);
  });
  it("evaluates every committed position for spectators, outside the archive", async () => {
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(result).toMatchObject({ termination: "draw" });
    const terminal = db.chessMatch.updateMany.mock.calls.find(
      ([input]) => input.data.status === "completed",
    )?.[0];
    const record = validateArchive(terminal?.data.archive);
    const writes = spectatorWrites();
    expect(writes.map(([ply]) => ply)).toEqual([0, 1, 2]);
    expect(writes.at(-1)?.[1]).toBe(boardAt(record).fen());
    for (const [, options] of evaluatePosition.mock.calls)
      expect(options).toMatchObject({ lane: "spectators" });
    expect(record.events.some((event) => event.type === "evaluation")).toBe(false);
    // Only the spectator column is written: never the archive, status or claim.
    for (const call of updates())
      expect((call[0] as TemplateStringsArray).join("?")).toMatch(
        /^UPDATE "chess_match" SET "spectatorEvaluations" = \(CASE WHEN jsonb_typeof\("spectatorEvaluations"\) = 'object' THEN "spectatorEvaluations" ELSE '\{\}'::jsonb END\) \|\| \?::jsonb WHERE "id" = \? AND \?$/,
      );
  });
  it("finishes the game normally when spectator evaluation fails", async () => {
    evaluatePosition.mockRejectedValue(new Error("Engine could not start"));
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(result).toMatchObject({ result: "1/2-1/2", termination: "draw" });
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
    );
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(evaluatePosition).toHaveBeenCalledTimes(1);
    // The gap goes to a backfill job instead of holding the run.
    expect(ensureJob).toHaveBeenCalledWith(
      {},
      "chess-spectator",
      {
        reason: "spectator",
        matchId: "match-id",
        fromPly: 0,
        access: { purpose: "owner", ownerId: "owner" },
      },
      "chess-spectator-match-id-0-owner-owner",
      { priority: 10 },
    );
  });
  it("never lets a failing or hanging spectator write hold up the game", async () => {
    // A rejected write: the game and its terminal write go on; the gap is handed off.
    db.$transaction.mockRejectedValue(new Error("deadlock"));
    let result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(result).toMatchObject({ termination: "draw" });
    expect(ensureJob).toHaveBeenCalledTimes(1);
    // A write that never returns: moves, heartbeats and the terminal write still land,
    // and the run lets go after its bounded wait.
    vi.clearAllMocks();
    mockReset(db);
    db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
    db.chessMatch.findUnique.mockResolvedValue(row());
    db.chessMatch.findFirst.mockResolvedValue(row());
    db.$queryRaw.mockResolvedValue([{ id: "match-id" }]);
    ensureJob.mockResolvedValue({});
    evaluatePosition.mockImplementation(async (fen: string) => score(fen));
    db.$transaction.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const running = handleChessRunJob({ data: { matchId: "match-id" } });
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1000);
    result = await running;
    expect(result).toMatchObject({ result: "1/2-1/2", termination: "draw" });
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
    );
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(ensureJob).toHaveBeenCalledWith(
      {},
      "chess-spectator",
      {
        reason: "spectator",
        matchId: "match-id",
        fromPly: 0,
        access: { purpose: "owner", ownerId: "owner" },
      },
      "chess-spectator-match-id-0-owner-owner",
      { priority: 10 },
    );
  });
  it("keeps heartbeating and playing while a spectator write hangs", async () => {
    db.$transaction.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let heartbeatsDuringGame = 0;
    const gameOver = Promise.withResolvers<void>();
    runner.override = async (match, options) => {
      // The first move commits (its spectator write then hangs); the game goes on.
      await advanceMatch(match, options);
      await vi.advanceTimersByTimeAsync(6000); // three heartbeat ticks
      heartbeatsDuringGame = db.chessMatch.updateMany.mock.calls.filter(
        ([input]) => Object.keys(input.data).join() === "heartbeatAt",
      ).length;
      while (match.status === "running") await advanceMatch(match, options);
      gameOver.resolve();
    };
    const running = handleChessRunJob({ data: { matchId: "match-id" } });
    await gameOver.promise;
    // Then the bounded wait for the hanging spectator write.
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1000);
    const result = await running;
    expect(heartbeatsDuringGame).toBeGreaterThanOrEqual(3);
    expect(result).toMatchObject({ result: "1/2-1/2", termination: "draw" });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
  it("routes a spectator backfill job to the backfill", async () => {
    db.chessMatch.findUnique.mockResolvedValue({ ...row(), status: "running" });
    await expect(
      handleChessReconcileJob({
        data: {
          reason: "spectator",
          matchId: "match-id",
          fromPly: 0,
          access: { purpose: "owner", ownerId: "owner" },
        },
      }),
    ).resolves.toEqual({ evaluated: false });
    expect(db.chessMatch.findMany).not.toHaveBeenCalled();
  });
  it("interrupts an already-aborted hosted run without dispatching inference", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await handleChessRunJob({ data: { matchId: "match-id" } }, controller.signal);
    expect(result).toMatchObject({ termination: "interrupted", result: "*" });
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "error" }) }),
    );
  });
  it.each([
    { name: "a single transient error", outcomes: ["error", "success"], aborted: [false, false] },
    {
      name: "three consecutive errors",
      outcomes: ["error", "error", "error"],
      aborted: [false, false, true],
    },
    { name: "definitive ownership loss", outcomes: ["lost"], aborted: [true] },
    {
      name: "success resetting the error count",
      outcomes: ["error", "error", "success", "error", "error", "error"],
      aborted: [false, false, false, false, false, true],
    },
  ])("handles $name during heartbeats", async ({ outcomes, aborted }) => {
    vi.useFakeTimers();
    runner.override = async (match, options) => {
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome === "error")
          db.chessMatch.updateMany.mockRejectedValueOnce(new Error("DB blip"));
        else db.chessMatch.updateMany.mockResolvedValueOnce({ count: outcome === "lost" ? 0 : 1 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(options?.signal?.aborted).toBe(aborted[index]);
      }
      if (options?.signal?.aborted) expect(options.signal.reason).toBe(MATCH_INTERRUPTED);
      while (match.status === "running") await advanceMatch(match, options);
    };
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    const ownershipLost = outcomes.includes("lost");
    if (ownershipLost) expect(result).toBeUndefined();
    else expect(result?.termination).toBe(aborted.at(-1) ? "interrupted" : "draw");
    const terminal = db.chessMatch.updateMany.mock.calls.find(
      ([input]) => input.data.status === "error",
    )?.[0];
    if (ownershipLost) expect(terminal).toBeUndefined();
    else if (aborted.at(-1)) {
      expect(terminal?.data).toMatchObject({
        status: "error",
        archive: expect.objectContaining({ termination: "interrupted", result: "*" }),
      });
      expect(validateArchive(terminal?.data.archive).termination).toBe("interrupted");
    }
  });
  it("releases the claim as an error when the stored archive fails validation", async () => {
    const record = row();
    record.archive = { ...archive(), format: "not-an-archive" } as unknown as ReturnType<
      typeof archive
    >;
    db.chessMatch.findUnique.mockResolvedValue(record);
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(result).toBeUndefined();
    const claim = db.chessMatch.updateMany.mock.calls[0]?.[0];
    expect(db.chessMatch.updateMany).toHaveBeenLastCalledWith({
      where: { id: "match-id", status: "running", runToken: claim?.data.runToken },
      data: {
        status: "error",
        runToken: null,
        ...chessTurnData({ type: "idle" }),
        ending: { kind: "interrupted" },
        terminalCause: "archive-invalid",
      },
    });
  });
  it("rejects a forged prompt pin before hosted work", async () => {
    const record = row();
    record.archive.config.prompt.hash = "0".repeat(64);
    db.chessMatch.findUnique.mockResolvedValue(record);
    const run = vi.fn();
    runner.override = run;
    await handleChessRunJob({ data: { matchId: "match-id" } });
    const claim = db.chessMatch.updateMany.mock.calls[0]?.[0];
    expect(db.chessMatch.updateMany).toHaveBeenLastCalledWith({
      where: { id: "match-id", status: "running", runToken: claim?.data.runToken },
      data: {
        status: "error",
        runToken: null,
        ...chessTurnData({ type: "idle" }),
        ending: { kind: "interrupted" },
        terminalCause: "archive-invalid",
      },
    });
    expect(run).not.toHaveBeenCalled();
    expect(providerKey.load).not.toHaveBeenCalled();
    expect(evaluatePosition).not.toHaveBeenCalled();
  });
  it.each([
    { source: "local", archiveSource: "hosted" },
    { source: "runner", archiveSource: "hosted" },
    { source: "hosted", archiveSource: "local" },
    { source: "hosted", archiveSource: "demo" },
  ] as const)(
    "refuses $source rows with $archiveSource archives before hosted work",
    async ({ source, archiveSource }) => {
      const record = row();
      record.source = source;
      record.archive.source = archiveSource;
      db.chessMatch.findUnique.mockResolvedValue(record);
      const fetch = vi.spyOn(globalThis, "fetch");
      const run = vi.fn();
      runner.override = run;
      try {
        await expect(handleChessRunJob({ data: { matchId: "match-id" } })).resolves.toBeUndefined();
        expect(db.chessMatch.findUnique).toHaveBeenCalledWith({
          where: { id: "match-id" },
          select: {
            archive: true,
            source: true,
            spectatorEvaluations: true,
            ownerId: true,
            credentialSource: true,
            Owner: { select: { role: true, deletionRequestedAt: true } },
          },
        });
        const claim = db.chessMatch.updateMany.mock.calls[0]?.[0];
        expect(db.chessMatch.updateMany).toHaveBeenLastCalledWith({
          where: { id: "match-id", status: "running", runToken: claim?.data.runToken },
          data: {
            status: "error",
            runToken: null,
            ...chessTurnData({ type: "idle" }),
            ending: { kind: "interrupted" },
            terminalCause: "archive-invalid",
          },
        });
        expect(run).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(providerKey.load).not.toHaveBeenCalled();
        expect(evaluatePosition).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    },
  );
  it.each(["hosting-disabled", "operator-key-missing"])(
    "classifies %s as infrastructure interruption",
    async (cause) => {
      env.CHESS_HOSTED_ENABLED = cause === "operator-key-missing";
      env.OPENROUTER_API_KEY = undefined;
      const record = row();
      record.archive = createMatch(
        {
          white: { name: "Model", model: "test-model", protocol: "openai-chat" },
          black: player,
          rules: {},
        },
        "hosted",
      );
      db.chessMatch.findUnique.mockResolvedValue(record);
      await handleChessRunJob({ data: { matchId: "match-id" } });
      expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "error",
            runToken: null,
            terminalCause: "interrupted",
            ending: { kind: "interrupted" },
            archive: expect.objectContaining({ termination: "interrupted", result: "*" }),
          }),
        }),
      );
    },
  );
  it("hands the runner each model's own output limits from the catalog", async () => {
    env.CHESS_HOSTED_ENABLED = true;
    env.OPENROUTER_API_KEY = "test-only";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [
          {
            id: "vendor/model",
            pricing: { prompt: "0.000001", completion: "0.000002" },
            context_length: 163840,
            top_provider: { max_completion_tokens: 65536 },
          },
        ],
      }),
    );
    let seen: unknown;
    runner.override = async (match, options) => {
      seen = options?.credentials?.w;
      finishMatch(match, "*", "cancelled", "stopped");
      return match;
    };
    try {
      const record = row();
      record.archive = createMatch(
        {
          white: { name: "Model", model: "vendor/model", protocol: "openai-chat" },
          black: player,
          rules: {},
        },
        "hosted",
      );
      db.chessMatch.findUnique.mockResolvedValue(record);
      await handleChessRunJob({ data: { matchId: "match-id" } });
      expect(seen).toMatchObject({ maxOutputTokens: 65536, contextLength: 163840 });
    } finally {
      fetch.mockRestore();
      env.CHESS_HOSTED_ENABLED = false;
      env.OPENROUTER_API_KEY = undefined;
    }
  });
  it("fences operator dispatch after ownership confirmation expires, without needing a timer tick", async () => {
    vi.useFakeTimers();
    env.CHESS_HOSTED_ENABLED = true;
    env.OPENROUTER_API_KEY = "test-only";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [{ id: "vendor/model", pricing: { prompt: "0", completion: "0" } }],
      }),
    );
    const record = row();
    record.archive = createMatch(
      {
        white: { name: "Model", model: "vendor/model", protocol: "openai-chat" },
        black: player,
        rules: {},
      },
      "hosted",
    );
    db.chessMatch.findUnique.mockResolvedValue(record);
    runner.override = async (match, options) => {
      const dispatch = options?.credentials?.w?.beforeDispatch;
      expect(dispatch).toBeTypeOf("function");
      expect(() => dispatch?.()).not.toThrow();
      vi.setSystemTime(Date.now() + 8000);
      expect(() => dispatch?.()).toThrow();
      expect(options?.signal?.reason).toBe(MATCH_INTERRUPTED);
      finishAbortedMatch(match, options?.signal ?? new AbortController().signal);
    };
    try {
      expect(await handleChessRunJob({ data: { matchId: "match-id" } })).toMatchObject({
        termination: "interrupted",
      });
      expect(fetch).toHaveBeenCalledTimes(1); // catalog only; no inference
    } finally {
      fetch.mockRestore();
      env.CHESS_HOSTED_ENABLED = false;
      env.OPENROUTER_API_KEY = undefined;
    }
  });
  it("does not bill operator inference for an owner demoted while queued", async () => {
    env.CHESS_HOSTED_ENABLED = true;
    env.OPENROUTER_API_KEY = "test-only";
    const fetch = vi.spyOn(globalThis, "fetch");
    const record = row();
    record.Owner.role = "user";
    record.archive = createMatch(
      {
        white: { name: "Model", model: "vendor/model", protocol: "openai-chat" },
        black: player,
        rules: {},
      },
      "hosted",
    );
    db.chessMatch.findUnique.mockResolvedValue(record);
    try {
      expect(await handleChessRunJob({ data: { matchId: "match-id" } })).toMatchObject({
        termination: "interrupted",
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      env.CHESS_HOSTED_ENABLED = false;
      env.OPENROUTER_API_KEY = undefined;
    }
  });
  it("names no side when Black's model has no price and the run fails before play", async () => {
    env.CHESS_HOSTED_ENABLED = true;
    env.OPENROUTER_API_KEY = "test-only";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [] }), // Black's model is not in the catalog
    );
    try {
      const record = row();
      record.archive = createMatch(
        {
          white: player,
          black: { name: "Model", model: "vendor/unpriced", protocol: "openai-chat" },
          rules: {},
        },
        "hosted",
      );
      db.chessMatch.findUnique.mockResolvedValue(record);
      await handleChessRunJob({ data: { matchId: "match-id" } });
      expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "error",
            archive: expect.objectContaining({ termination: "provider-error" }),
            ending: { kind: "provider-error" },
          }),
        }),
      );
    } finally {
      fetch.mockRestore();
      env.CHESS_HOSTED_ENABLED = false;
      env.OPENROUTER_API_KEY = undefined;
    }
  });
  it("records typed leaderboard stats on the terminal write only", async () => {
    await handleChessRunJob({ data: { matchId: "match-id" } });
    const writes = db.chessMatch.updateMany.mock.calls.map(([input]) => input.data);
    const terminal = writes.find((data) => data.status === "completed");
    expect(terminal).toMatchObject({
      result: "1/2-1/2",
      whiteModel: "random",
      whiteProtocol: "random",
      blackProtocol: "random",
      whiteIllegal: 0,
      blackIllegal: 0,
      whiteCostMicros: 0n,
      blackCostMicros: 0n,
      moveFormat: "strict",
    });
    const running = writes.filter((data) => "archive" in data && data.status === undefined);
    expect(running.every((data) => !("result" in data))).toBe(true);
  });
  it("classifies a running snapshot DB failure as interrupted rather than provider-error", async () => {
    db.chessMatch.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockRejectedValueOnce(new Error("Snapshot DB unavailable"));
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(result).toMatchObject({ termination: "interrupted", result: "*" });
    const terminal = db.chessMatch.updateMany.mock.calls.at(-1)?.[0];
    expect(terminal?.data).toMatchObject({ status: "error", runToken: null });
    expect(validateArchive(terminal?.data.archive)).toMatchObject({
      status: "error",
      termination: "interrupted",
      result: "*",
    });
  });
  it.each(["runner", "handler"])(
    "retries a transient terminal write from the %s without changing the completed result",
    async (source) => {
      if (source === "handler")
        runner.override = async (match) => {
          while (match.status === "running") await advanceMatch(match);
        };
      db.chessMatch.updateMany.mockResolvedValueOnce({ count: 1 }); // claim
      if (source === "runner") db.chessMatch.updateMany.mockResolvedValueOnce({ count: 1 }); // first ply
      db.chessMatch.updateMany.mockRejectedValueOnce(new Error("Terminal DB blip"));
      const result = await handleChessRunJob({ data: { matchId: "match-id" } });
      expect(result).toMatchObject({ result: "1/2-1/2", termination: "draw" });
      const writes = db.chessMatch.updateMany.mock.calls
        .map(([input]) => input)
        .filter((input) => "archive" in input.data && input.data.status !== undefined);
      expect(writes).toHaveLength(2);
      for (const write of writes) {
        expect(write.where).toMatchObject({ status: "running", runToken: expect.any(String) });
        expect(write.data).toMatchObject({
          status: "completed",
          runToken: null,
          result: "1/2-1/2",
        });
        expect(validateArchive(write.data.archive)).toMatchObject({
          status: "completed",
          termination: "draw",
          result: "1/2-1/2",
        });
      }
    },
  );
  it("bounds terminal DB retries and leaves an unwritten completed result for reconciliation", async () => {
    db.chessMatch.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 1 }) // first ply
      .mockRejectedValue(new Error("DB still unavailable"));
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(result).toBeUndefined();
    const writes = db.chessMatch.updateMany.mock.calls
      .map(([input]) => input)
      .filter((input) => "archive" in input.data && input.data.status !== undefined);
    expect(writes).toHaveLength(3);
    for (const write of writes) {
      expect(write.data.status).toBe("completed");
      expect(validateArchive(write.data.archive)).toMatchObject({
        status: "completed",
        termination: "draw",
        result: "1/2-1/2",
      });
    }
  });
  it("stops terminal retries without returning a stale outcome when an operator stop wins", async () => {
    db.chessMatch.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 1 }) // first ply
      .mockRejectedValueOnce(new Error("Terminal DB blip"))
      .mockResolvedValue({ count: 0 }); // stop cleared the claim during backoff
    expect(await handleChessRunJob({ data: { matchId: "match-id" } })).toBeUndefined();
    const terminalWrites = db.chessMatch.updateMany.mock.calls.filter(
      ([input]) => input.data.status === "completed",
    );
    expect(terminalWrites).toHaveLength(2);
  });
  it("skips rewriting an unchanged running snapshot", async () => {
    runner.override = async (match, options) => {
      await options?.onUpdate?.(match);
      await options?.onUpdate?.(structuredClone(match));
      return match;
    };
    await handleChessRunJob({ data: { matchId: "match-id" } });
    const snapshotWrites = db.chessMatch.updateMany.mock.calls.filter(
      ([input]) => "archive" in input.data && input.data.status === undefined,
    );
    expect(snapshotWrites).toHaveLength(1);
  });
  it("rewrites a running snapshot whose content changed even at the same event count", async () => {
    runner.override = async (match, options) => {
      await options?.onUpdate?.(match);
      match.config.title = "Renamed";
      await options?.onUpdate?.(match);
      return match;
    };
    await handleChessRunJob({ data: { matchId: "match-id" } });
    const snapshotWrites = db.chessMatch.updateMany.mock.calls.filter(
      ([input]) => "archive" in input.data && input.data.status === undefined,
    );
    expect(snapshotWrites).toHaveLength(2);
  });
  it("aborts without overwriting when stop wins the race against a persist", async () => {
    let afterLoss = 0;
    runner.override = async (match, options) => {
      await options?.onUpdate?.(match);
      afterLoss += 1;
      return match;
    };
    db.chessMatch.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValue({ count: 0 }); // stop already cleared status/runToken
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(afterLoss).toBe(0);
    expect(result).toBeUndefined();
    const [, ...writes] = db.chessMatch.updateMany.mock.calls.map(([input]) => input);
    expect(writes).toHaveLength(1);
    for (const write of writes)
      expect(write.where).toMatchObject({ status: "running", runToken: expect.any(String) });
    expect(console.info).toHaveBeenCalledWith(
      "[chess-run] Match claim ended (stopped or reassigned); run aborted",
      { matchId: "match-id" },
    );
    expect(console.error).not.toHaveBeenCalledWith(
      "[chess-run] Match run ended with an error",
      expect.anything(),
    );
  });
});
describe("chess reconcile sweep", () => {
  const stale = (status: "running" | "queued", id = `${status}-id`) => ({
    id,
    status,
    heartbeatAt: new Date(Date.now() - 600000),
    archive: archive(),
  });
  function rows(running: ReturnType<typeof stale>[], queued: ReturnType<typeof stale>[]) {
    db.chessMatch.findMany.mockImplementation(((args: {
      where: { status: string; turnType?: string };
    }) =>
      Promise.resolve(
        args.where.turnType === "human" ? [] : args.where.status === "running" ? running : queued,
      )) as never);
  }
  it("errors stale running records with a bounded, ordered heartbeat compare-and-set", async () => {
    const row = stale("running");
    rows([row], []);
    await handleChessReconcileJob({ data: { reason: "cron" } });
    expect(db.chessMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        orderBy: [{ heartbeatAt: "asc" }, { id: "asc" }],
        where: {
          source: "hosted",
          status: "running",
          turnType: { notIn: ["human", "human-move"] },
          heartbeatAt: { lt: expect.any(Date) },
        },
        select: { id: true, status: true, heartbeatAt: true, archive: true },
      }),
    );
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, status: "running", heartbeatAt: row.heartbeatAt },
      data: {
        status: "error",
        runToken: null,
        ...chessTurnData({ type: "idle" }),
        ending: { kind: "interrupted" },
        terminalCause: "worker-lost",
      },
    });
    expect(getJob).not.toHaveBeenCalled();
  });
  it("leaves a queued match alone while its job is still live", async () => {
    rows([], [stale("queued")]);
    getJob.mockResolvedValue({ getState: async () => "waiting" });
    const result = await handleChessReconcileJob({ data: { reason: "cron" } });
    expect(getJob).toHaveBeenCalledWith("chess-queued-id");
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, errored: 0 });
  });
  it.each(["queued", "running"] as const)(
    "does not count or retry a stale %s row when its compare-and-set loses",
    async (status) => {
      const row = stale(status);
      rows(status === "running" ? [row] : [], status === "queued" ? [row] : []);
      getJob.mockResolvedValue(null);
      db.chessMatch.updateMany.mockResolvedValue({ count: 0 });
      await expect(handleChessReconcileJob({ data: { reason: "cron" } })).resolves.toEqual({
        scanned: 1,
        errored: 0,
      });
      expect(db.chessMatch.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: { id: row.id, status, heartbeatAt: row.heartbeatAt },
        data: {
          status: "error",
          runToken: null,
          ...chessTurnData({ type: "idle" }),
          ending: { kind: "interrupted" },
          terminalCause: status === "running" ? "worker-lost" : "queue-lost",
        },
      });
    },
  );
  it.each([
    ["missing", null],
    ["failed", { getState: async () => "failed" }],
    ["completed", { getState: async () => "completed" }],
  ])("errors a queued match whose job is %s", async (_label, job) => {
    const row = stale("queued");
    rows([], [row]);
    getJob.mockResolvedValue(job);
    await handleChessReconcileJob({ data: { reason: "cron" } });
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, status: "queued", heartbeatAt: row.heartbeatAt },
      data: {
        status: "error",
        runToken: null,
        ...chessTurnData({ type: "idle" }),
        ending: { kind: "interrupted" },
        terminalCause: "queue-lost",
      },
    });
  });
  it.each([false, true])(
    "advances past fifty queued rows and wraps (lookup failure: %s)",
    async (lookupFails) => {
      const heartbeatAt = new Date(Date.now() - 600000);
      const live = Array.from({ length: 50 }, (_, index) => ({
        ...row(),
        id: `queued-${String(index).padStart(2, "0")}`,
        status: "queued",
        heartbeatAt,
      }));
      const orphan = { ...row(), id: "queued-50", status: "queued", heartbeatAt };
      db.chessMatch.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(live)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([orphan])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(live)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      getJob.mockImplementation(async (id: string) => {
        if (id === "chess-queued-50") return null;
        if (lookupFails) throw new Error("Redis lookup failed");
        return { getState: async () => "waiting" };
      });
      const sweep = () => handleChessReconcileJob({ data: { reason: "cron" } });
      expect(await sweep()).toEqual({ scanned: 50, errored: 0 });
      expect(await sweep()).toEqual({ scanned: 1, errored: 1 });
      expect(db.chessMatch.findMany.mock.calls[4]?.[0]).toMatchObject({
        where: {
          status: "queued",
          heartbeatAt: { lt: expect.any(Date) },
          OR: [{ heartbeatAt: { gt: heartbeatAt } }, { heartbeatAt, id: { gt: "queued-49" } }],
        },
        orderBy: [{ heartbeatAt: "asc" }, { id: "asc" }],
        take: 50,
      });
      expect(db.chessMatch.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: { id: orphan.id, status: "queued", heartbeatAt },
        data: {
          status: "error",
          runToken: null,
          ...chessTurnData({ type: "idle" }),
          ending: { kind: "interrupted" },
          terminalCause: "queue-lost",
        },
      });
      await sweep();
      expect(db.chessMatch.findMany.mock.calls[7]?.[0]?.where?.OR).toBeUndefined();
      // An empty page at the end also wraps, without a second query in that sweep.
      expect(await sweep()).toEqual({ scanned: 0, errored: 0 });
      await sweep();
      expect(db.chessMatch.findMany.mock.calls[13]?.[0]?.where?.OR).toBeUndefined();
      expect(db.chessMatch.findMany).toHaveBeenCalledTimes(15);
      for (const [query] of db.chessMatch.findMany.mock.calls) expect(query?.take).toBe(50);
    },
  );
  it("one failing row does not stop the sweep", async () => {
    rows([stale("running", "bad"), stale("running", "good")], [stale("queued")]);
    getJob.mockRejectedValue(new Error("redis down"));
    db.chessMatch.updateMany
      .mockRejectedValueOnce(new Error("db hiccup"))
      .mockResolvedValue({ count: 1 });
    const result = await handleChessReconcileJob({ data: { reason: "cron" } });
    expect(result).toEqual({ scanned: 3, errored: 1 });
    expect(db.chessMatch.updateMany).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith("[chess-reconcile] Failed to reconcile match", {
      matchId: "bad",
      error: "db hiccup",
    });
    expect(console.error).toHaveBeenCalledWith("[chess-reconcile] Failed to reconcile match", {
      matchId: "queued-id",
      error: "redis down",
    });
  });
});

describe("hosted matches billed to the owner's own OpenRouter key", () => {
  const CANARY = "sk-or-v1-CANARY0000111122223333444455556666777788889999aaaabbbbccccdddd";
  const OPERATOR = "sk-or-v1-OPERATOR-not-for-users";
  const modelPlayer = { name: "Model", model: "vendor/model", protocol: "openai-chat" as const };
  const catalog = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        data: [{ id: "vendor/model", pricing: { prompt: "0.000001", completion: "0.000002" } }],
      }),
    );
  /** A user's match: `ownerId` "user-b" owns it, a model plays White. */
  const userRow = (overrides: Record<string, unknown> = {}) => {
    const record = row();
    record.archive = createMatch({ white: modelPlayer, black: player, rules: {} }, "hosted");
    return {
      ...record,
      ownerId: "user-b",
      credentialSource: "owner-openrouter",
      official: false,
      Owner: { role: "user" },
      ...overrides,
    };
  };
  /** Everything the worker handed to the outside world, for canary checks. */
  const observable = () =>
    JSON.stringify(
      [
        vi.mocked(console.error).mock.calls,
        vi.mocked(console.info).mock.calls,
        db.chessMatch.updateMany.mock.calls,
        db.$executeRaw.mock.calls,
        ensureJob.mock.calls,
        providerKey.markInvalid.mock.calls,
      ],
      (_, value) => (typeof value === "bigint" ? value.toString() : value),
    );
  let fetchSpy: ReturnType<typeof catalog>;
  let valkey: ReturnType<typeof fakeValkey>;
  beforeEach(() => {
    env.CHESS_HOSTED_ENABLED = true;
    env.CHESS_USER_MATCHES_ENABLED = true;
    env.CHESS_PROVIDER_KEY_SECRET = "a".repeat(64);
    env.OPENROUTER_API_KEY = OPERATOR;
    providerKey.load.mockResolvedValue({ apiKey: CANARY, keyHash: "hash-b" });
    db.openRouterConnection.findMany.mockResolvedValue([
      { userId: "user-b", keyHash: "hash-b", status: "active" },
    ] as never);
    fetchSpy = catalog();
    valkey = fakeValkey();
    resetChessKeyRevocations(valkey.connection);
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
    env.CHESS_HOSTED_ENABLED = false;
    env.CHESS_USER_MATCHES_ENABLED = false;
    env.CHESS_PROVIDER_KEY_SECRET = undefined;
    env.OPENROUTER_API_KEY = undefined;
  });

  it("loads the key by the row's owner and never the operator's, with attribution headers", async () => {
    db.chessMatch.findUnique.mockResolvedValue(userRow() as never);
    let seen: import("@cockpit-chess/chess/runner").MatchRunnerOptions | undefined;
    runner.override = async (match, options) => {
      seen = options;
      finishMatch(match, "1-0", "resignation");
      await options?.onUpdate?.(match);
    };
    await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(providerKey.load).toHaveBeenCalledTimes(1);
    expect(providerKey.load).toHaveBeenCalledWith("user-b");
    expect(seen?.credentials?.w).toMatchObject({
      apiKey: CANARY,
      baseUrl: "https://openrouter.ai/api/v1",
      headers: { "X-OpenRouter-Title": "Cockpit Chess", "HTTP-Referer": "https://chess.example" },
    });
    expect(JSON.stringify(seen?.credentials)).not.toContain(OPERATOR);
    expect(seen?.conversationMaxBytes).toBe(2_097_152);
    expect(observable()).not.toContain(CANARY);
  });

  it("never uses another user's key: each match loads its own owner's", async () => {
    providerKey.load.mockImplementation(async (userId: string) =>
      userId === "user-a" ? { apiKey: `${CANARY}-A`, keyHash: "hash-a" } : null,
    );
    db.chessMatch.findUnique.mockResolvedValue(userRow() as never);
    let ran = false;
    runner.override = async () => {
      ran = true;
    };
    await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(providerKey.load).toHaveBeenCalledWith("user-b");
    expect(providerKey.load).not.toHaveBeenCalledWith("user-a");
    expect(ran).toBe(false);
    const terminal = db.chessMatch.updateMany.mock.calls.find(
      ([input]) => input.data.status === "error",
    )?.[0];
    expect(terminal?.data).toMatchObject({ ending: { kind: "credential-revoked" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(observable()).not.toContain(CANARY);
    expect(observable()).not.toContain(OPERATOR);
  });

  it("ends a non-admin's queued match unscored when the operator turned user matches off", async () => {
    env.CHESS_USER_MATCHES_ENABLED = false;
    db.chessMatch.findUnique.mockResolvedValue(userRow() as never);
    await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(providerKey.load).not.toHaveBeenCalled();
    const terminal = db.chessMatch.updateMany.mock.calls.find(
      ([input]) => input.data.status === "error",
    )?.[0];
    expect(terminal?.data).toMatchObject({ ending: { kind: "interrupted" } });
    // An admin's own-key match still runs with the flag off.
    vi.clearAllMocks();
    db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
    db.chessMatch.findUnique.mockResolvedValue(userRow({ Owner: { role: "admin" } }) as never);
    runner.override = async (match, options) => {
      finishMatch(match, "1-0", "resignation");
      await options?.onUpdate?.(match);
    };
    await expect(handleChessRunJob({ data: { matchId: "match-id" } })).resolves.toMatchObject({
      termination: "resignation",
    });
    expect(providerKey.load).toHaveBeenCalledWith("user-b");
  });

  it.each([
    { name: "a disconnect", connections: [] },
    {
      name: "a different key connected",
      connections: [{ userId: "user-b", keyHash: "hash-new", status: "active" }],
    },
    {
      name: "the key marked invalid",
      connections: [{ userId: "user-b", keyHash: "hash-b", status: "invalid" }],
    },
  ])("stops the match as credential-revoked on $name mid-match", async ({ connections }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    db.chessMatch.findUnique.mockResolvedValue(userRow() as never);
    runner.override = async (match, options) => {
      await vi.advanceTimersByTimeAsync(2000);
      expect(options?.signal?.aborted).toBe(false);
      db.openRouterConnection.findMany.mockResolvedValue(connections as never);
      await vi.advanceTimersByTimeAsync(2000);
      expect(options?.signal?.aborted).toBe(true);
      expect(options?.signal?.reason).toBe(CREDENTIAL_REVOKED);
      finishAbortedMatch(match, options?.signal);
    };
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(result).toMatchObject({ termination: "credential-revoked", result: "*" });
    expect(providerKey.markInvalid).toHaveBeenCalledWith("user-b", "hash-b");
    expect(observable()).not.toContain(CANARY);
  });

  it("applies the switch and the disconnect check to a random-only own-key match too", async () => {
    const randomOnly = () => {
      const record = userRow();
      record.archive = createMatch({ white: player, black: player, rules: {} }, "hosted");
      return record;
    };
    env.CHESS_USER_MATCHES_ENABLED = false;
    db.chessMatch.findUnique.mockResolvedValue(randomOnly() as never);
    let ran = false;
    runner.override = async () => {
      ran = true;
    };
    await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(ran).toBe(false);
    expect(
      db.chessMatch.updateMany.mock.calls.find(([input]) => input.data.status === "error")?.[0]
        ?.data,
    ).toMatchObject({ ending: { kind: "interrupted" } });
    // With the switch on, a disconnect mid-match still stops it.
    env.CHESS_USER_MATCHES_ENABLED = true;
    vi.clearAllMocks();
    db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
    db.openRouterConnection.findMany.mockResolvedValue([
      { userId: "user-b", keyHash: "hash-b", status: "active" },
    ] as never);
    db.chessMatch.findUnique.mockResolvedValue(randomOnly() as never);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    runner.override = async (match, options) => {
      db.openRouterConnection.findMany.mockResolvedValue([] as never);
      await vi.advanceTimersByTimeAsync(4000);
      expect(options?.signal?.reason).toBe(CREDENTIAL_REVOKED);
      finishAbortedMatch(match, options?.signal);
    };
    await expect(handleChessRunJob({ data: { matchId: "match-id" } })).resolves.toMatchObject({
      termination: "credential-revoked",
    });
    expect(providerKey.load).toHaveBeenCalledWith("user-b");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("marks the key invalid when OpenRouter refused it, and redacts it from logged errors", async () => {
    db.chessMatch.findUnique.mockResolvedValue(userRow() as never);
    runner.override = async (match, options) => {
      finishMatch(match, "*", "credential-revoked", "error");
      await options?.onUpdate?.(match);
      throw new Error(`upstream said: bad key ${options?.credentials?.w?.apiKey}`);
    };
    await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(providerKey.markInvalid).toHaveBeenCalledWith("user-b", "hash-b");
    expect(
      vi
        .mocked(console.error)
        .mock.calls.flat()
        .map((entry) => JSON.stringify(entry))
        .join(),
    ).toContain("[redacted]");
    expect(observable()).not.toContain(CANARY);
  });

  describe("Disconnect (key-use leases and the revocation broadcast)", () => {
    let chatCalls: number;
    beforeEach(() => {
      chatCalls = 0;
    });
    /** Disconnect's own completion test: no lease loading or on the revoked key. */
    const disconnectDone = async () =>
      !(await chessKeyLeasesBlocking(valkey.connection, "user-b", ["hash-b"], null));
    /** Real runner, real agent runtime: only the network is fake. */
    const network = (onChat: (signal: AbortSignal | null | undefined) => Promise<Response>) => {
      fetchSpy.mockImplementation(async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/models"))
          return Response.json({
            data: [{ id: "vendor/model", pricing: { prompt: "0.000001", completion: "0.000002" } }],
          });
        chatCalls += 1;
        expect(request.headers.get("authorization")).toBe(`Bearer ${CANARY}`);
        return onChat(init?.signal ?? request.signal);
      });
    };

    it("makes zero provider calls once Disconnect sees the key no longer in use", async () => {
      db.chessMatch.findUnique.mockResolvedValue(userRow() as never);
      let disconnected = false;
      network(
        (signal) =>
          new Promise<Response>((_resolve, reject) => {
            // Disconnect lands while the first model request is in flight.
            if (chatCalls === 1)
              applyChessKeyRevocation({ userId: "user-b", keyHashes: ["hash-b"] });
            if (signal?.aborted) reject(signal.reason);
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
      expect(await disconnectDone()).toBe(true);
      const run = handleChessRunJob({ data: { matchId: "match-id" } });
      // While the run holds the key, Disconnect keeps waiting.
      await vi.waitFor(() => expect(chatCalls).toBe(1));
      await vi.waitFor(async () => {
        disconnected = await disconnectDone();
        expect(disconnected).toBe(true);
      });
      // Disconnect returns here. From now on nothing may leave with the key.
      const callsAtReturn = chatCalls;
      const result = await run;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(callsAtReturn).toBe(1);
      expect(chatCalls).toBe(callsAtReturn);
      expect(result).toMatchObject({ termination: "credential-revoked", result: "*" });
      expect(observable()).not.toContain(CANARY);
    });

    it("never dispatches a run whose revocation arrived while it was starting", async () => {
      providerKey.load.mockImplementation(async () => {
        // Disconnect lands while the key is being loaded.
        applyChessKeyRevocation({ userId: "user-b", keyHashes: ["hash-b"] });
        return { apiKey: CANARY, keyHash: "hash-b" };
      });
      db.chessMatch.findUnique.mockResolvedValue(userRow() as never);
      network(async () => new Response("{}", { status: 500 }));
      const result = await handleChessRunJob({ data: { matchId: "match-id" } });
      expect(chatCalls).toBe(0);
      expect(result).toMatchObject({ termination: "credential-revoked" });
      expect(await disconnectDone()).toBe(true);
    });

    it("never dispatches a run whose key was revoked before it loaded (a missed message)", async () => {
      valkey.sets.set("cockpit-chess:openrouter-key-revoked:user-b", new Map([["hash-b", 1]]));
      db.chessMatch.findUnique.mockResolvedValue(userRow() as never);
      network(async () => new Response("{}", { status: 500 }));
      const result = await handleChessRunJob({ data: { matchId: "match-id" } });
      expect(chatCalls).toBe(0);
      expect(result).toMatchObject({ termination: "credential-revoked" });
    });

    it("sends nothing from a run whose process stalled past its lease", async () => {
      db.chessMatch.findUnique.mockResolvedValue(userRow() as never);
      network(async () => {
        // The first request is slow; meanwhile the process stalls past the lease.
        vi.setSystemTime(Date.now() + 25_000);
        return new Response("{}", { status: 503, headers: { "retry-after": "0" } });
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      const result = await handleChessRunJob({ data: { matchId: "match-id" } });
      // The retry after the stall was refused at the dispatch boundary.
      expect(chatCalls).toBe(1);
      expect(result).toMatchObject({ result: "*" });
      expect(await disconnectDone()).toBe(true);
    });

    it("refuses to load the key without a lease", async () => {
      valkey.state.down = true;
      db.chessMatch.findUnique.mockResolvedValue(userRow() as never);
      const result = await handleChessRunJob({ data: { matchId: "match-id" } });
      expect(providerKey.load).not.toHaveBeenCalled();
      expect(result).toMatchObject({ termination: "interrupted" });
    });

    it("leaves a run on a newer key of the same user alone", async () => {
      db.chessMatch.findUnique.mockResolvedValue(userRow() as never);
      let seen: AbortSignal | undefined;
      runner.override = async (match, options) => {
        // The previous key was disconnected while this one runs.
        applyChessKeyRevocation({ userId: "user-b", keyHashes: ["hash-old"] });
        seen = options?.signal;
        finishMatch(match, "1-0", "resignation");
        await options?.onUpdate?.(match);
      };
      await expect(handleChessRunJob({ data: { matchId: "match-id" } })).resolves.toMatchObject({
        termination: "resignation",
      });
      expect(seen?.aborted).toBe(false);
      // Its lease is gone once it ended.
      expect(await disconnectDone()).toBe(true);
    });
  });

  it("keeps the operator key for admin operator matches and leaves user keys alone", async () => {
    db.chessMatch.findUnique.mockResolvedValue(
      userRow({ credentialSource: "operator", Owner: { role: "admin" } }) as never,
    );
    let seen: import("@cockpit-chess/chess/runner").MatchRunnerOptions | undefined;
    runner.override = async (match, options) => {
      seen = options;
      finishMatch(match, "1-0", "resignation");
      await options?.onUpdate?.(match);
    };
    await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(seen?.credentials?.w?.apiKey).toBe(OPERATOR);
    expect(providerKey.load).not.toHaveBeenCalled();
  });
});

describe("hosted human worker parking and repair", () => {
  function humanMatch(first: "w" | "b" = "w") {
    const human = { name: "Human", model: "human", protocol: "human" as const };
    const model = { name: "Model", model: "fixture/model", protocol: "openai-chat" as const };
    return createMatch(
      {
        white: first === "w" ? human : model,
        black: first === "b" ? human : model,
        rules: { context: "fresh", engineEvaluation: "off" },
      },
      "hosted",
    );
  }
  it("parks a human without loading any key, provider catalog, heartbeat or spectator engine", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const match = humanMatch();
    db.chessMatch.findUnique.mockResolvedValue({ ...row(), archive: match });
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(result).toMatchObject({ parked: true });
    expect(providerKey.load).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(evaluatePosition).not.toHaveBeenCalled();
    const parked = db.chessMatch.updateMany.mock.calls.at(-1)?.[0];
    expect(parked?.data).toMatchObject({ turnType: "human", runToken: null });
    const persisted = validateArchive(parked?.data.archive);
    expect(persisted.turn.type).toBe("human");
    expect(persisted.events).toEqual([]);
    fetcher.mockRestore();
  });
  it("persists the model claim before dispatch and releases it after exactly one automatic turn", async () => {
    env.CHESS_HOSTED_ENABLED = true;
    env.OPENROUTER_API_KEY = "fixture-only";
    // A spectator that never resolves cannot retain the parked gameplay slot.
    evaluatePosition.mockImplementation(() => new Promise(() => {}));
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [
          {
            id: "fixture/model",
            pricing: { prompt: "0", completion: "0" },
          },
        ],
      }),
    );
    const match = humanMatch("b");
    db.chessMatch.findUnique.mockResolvedValue({ ...row(), archive: match });
    runner.override = async (archive, options) => {
      expect(options?.stopAfterTurn).toBe(true);
      const claimed = db.chessMatch.updateMany.mock.calls.at(-1)?.[0]?.data;
      expect(claimed).toMatchObject({ turnType: "model" });
      expect(options?.credentials?.w).toBeDefined();
      expect(options?.credentials?.b).toBeUndefined();
      submitMove(archive, boardAt(archive), "e2e4");
      await options?.onUpdate?.(archive);
    };
    expect(await handleChessRunJob({ data: { matchId: "match-id" } })).toMatchObject({
      parked: true,
    });
    await vi.waitFor(() => expect(ensureJob).toHaveBeenCalled());
    expect(db.$queryRaw).toHaveBeenCalled();
    expect(ensureJob).toHaveBeenCalledWith(
      {},
      "chess-spectator",
      {
        reason: "spectator",
        matchId: "match-id",
        fromPly: 0,
        access: { purpose: "owner", ownerId: "owner" },
      },
      "chess-spectator-match-id-0-owner-owner",
      { priority: 10 },
    );
    const parked = db.chessMatch.updateMany.mock.calls.find(
      ([input]) => input.data.turnType === "human",
    )?.[0];
    expect(parked?.data.runToken).toBeNull();
    expect(validateArchive(parked?.data.archive).turn).toMatchObject({
      type: "human",
      side: "b",
      expectedSeq: 1,
    });
    fetcher.mockRestore();
  });
  it("repairs an accepted human continuation whose deterministic wake was lost", async () => {
    const match = humanMatch();
    beginHostedTurn(match);
    // A successfully applied human input has become an idle queued model turn.
    match.turn = { type: "idle" };
    submitMove(match, boardAt(match), "e2e4");
    const queued = {
      ...row(),
      archive: match,
      id: "wake-lost",
      status: "queued",
      heartbeatAt: new Date(0),
    };
    db.chessMatch.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([queued])
      .mockResolvedValueOnce([]);
    getJob.mockResolvedValue(null);
    expect(await handleChessReconcileJob({ data: { reason: "cron" } })).toEqual({
      scanned: 1,
      errored: 0,
    });
    expect(ensureJob).toHaveBeenCalledWith(
      expect.anything(),
      "chess-run",
      { matchId: "wake-lost" },
      "chess-wake-lost-turn-1",
    );
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
  });
  it("expires an unclaimed human wait with deadline/identity CAS and no provider work", async () => {
    const match = humanMatch();
    beginHostedTurn(match, new Date(Date.now() - 600_000));
    const turn = match.turn;
    if (turn.type !== "human") throw new Error("Expected human turn");
    db.chessMatch.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...row(),
          archive: match,
          turnId: turn.turnId,
          turnExpectedSeq: turn.expectedSeq,
          turnDeadline: new Date(turn.deadline),
        },
      ]);
    const result = await handleChessReconcileJob({ data: { reason: "cron" } });
    expect(result).toEqual({ scanned: 1, errored: 0, expired: 1 });
    const update = db.chessMatch.updateMany.mock.calls.at(-1)?.[0];
    expect(update?.where).toMatchObject({
      status: "running",
      turnType: "human",
      runToken: null,
      turnId: turn.turnId,
      turnExpectedSeq: turn.expectedSeq,
      turnDeadline: { lte: expect.any(Date) },
    });
    const ended = validateArchive(update?.data.archive);
    expect(ended.termination).toBe("move-timeout");
    expect(ended.turn).toEqual({ type: "idle" });
  });
});

describe("pending owner after a hosted claim", () => {
  it("clears human turn state with SQL-null input and never dispatches", async () => {
    const match = createMatch(
      {
        white: { name: "Human", model: "human", protocol: "human" },
        black: { name: "Model", model: "fixture/model", protocol: "openai-chat" },
        rules: {},
      },
      "hosted",
    );
    beginHostedTurn(match);
    db.chessMatch.findUnique.mockResolvedValue({
      ...row(),
      archive: match,
      ...chessTurnData(match.turn),
      Owner: { role: "user", deletionRequestedAt: new Date() },
    } as never);
    await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(db.chessMatch.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: "match-id", status: "running", runToken: expect.any(String) },
      data: {
        status: "stopped",
        runToken: null,
        terminalCause: "owner-delete",
        ...chessTurnData({ type: "idle" }),
      },
    });
    expect(providerKey.load).not.toHaveBeenCalled();
    expect(evaluatePosition).not.toHaveBeenCalled();
  });
});
