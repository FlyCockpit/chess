import { createMatch, validateArchive } from "@cockpit-chess/chess";
import { advanceMatch, MATCH_INTERRUPTED } from "@cockpit-chess/chess/runner";
import type prismaInstance from "@cockpit-chess/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
const { getJob, runner } = vi.hoisted(() => ({
  getJob: vi.fn(),
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
  return { chessReconcileJobSchema, chessRunJobSchema, chessRunQueue: { getJob }, isLiveJobState };
});
vi.mock("@cockpit-chess/chess/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cockpit-chess/chess/runner")>();
  return {
    ...actual,
    runMatch: (...args: Parameters<typeof actual.runMatch>) =>
      runner.override ? runner.override(...args) : actual.runMatch(...args),
  };
});
const { env } = vi.hoisted(() => ({
  env: { CHESS_HOSTED_ENABLED: false, OPENROUTER_API_KEY: undefined },
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env }));
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const { handleChessReconcileJob, handleChessRunJob } = await import("./chess-run");
const player = { name: "Baseline", model: "random", protocol: "random" as const };
const archive = () =>
  createMatch({ white: player, black: player, rules: { maxPlies: 2 } }, "hosted");
function row() {
  return {
    id: "match-id",
    slug: "test-game",
    createdAt: new Date(),
    updatedAt: new Date(),
    ownerId: "owner",
    title: "Game",
    whiteName: "Baseline",
    blackName: "Baseline",
    status: "running",
    published: false,
    official: true,
    source: "hosted",
    rulesKey: "rules",
    contextMode: "fresh",
    identityMode: "hidden",
    runToken: "token",
    heartbeatAt: new Date(),
    archive: archive(),
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
beforeEach(() => {
  vi.clearAllMocks();
  mockReset(db);
  runner.override = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
  db.chessMatch.findUnique.mockResolvedValue(row());
});
afterEach(() => vi.useRealTimers());
describe("durable chess worker", () => {
  it("does no work unless it atomically claims the queued match", async () => {
    db.chessMatch.updateMany.mockResolvedValue({ count: 0 });
    await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-id", status: "queued" },
        data: expect.objectContaining({ status: "running", runToken: expect.any(String) }),
      }),
    );
    expect(db.chessMatch.findUnique).not.toHaveBeenCalled();
  });
  it("plays and persists a genuine legal baseline game, including terminal result", async () => {
    const result = await handleChessRunJob({ data: { matchId: "match-id" } });
    expect(result).toMatchObject({ result: "1/2-1/2", termination: "ply-limit" });
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
    else expect(result?.termination).toBe(aborted.at(-1) ? "interrupted" : "ply-limit");
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
      data: { status: "error", runToken: null },
    });
  });
  it("ends model runs with provider-error if hosted inference is disabled", async () => {
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
          archive: expect.objectContaining({ termination: "provider-error", result: "*" }),
        }),
      }),
    );
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
      expect(result).toMatchObject({ result: "1/2-1/2", termination: "ply-limit" });
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
          termination: "ply-limit",
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
        termination: "ply-limit",
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
  });
  function rows(running: ReturnType<typeof stale>[], queued: ReturnType<typeof stale>[]) {
    db.chessMatch.findMany.mockImplementation(((args: { where: { status: string } }) =>
      Promise.resolve(args.where.status === "running" ? running : queued)) as never);
  }
  it("errors stale running records with a bounded, ordered heartbeat compare-and-set", async () => {
    const row = stale("running");
    rows([row], []);
    await handleChessReconcileJob({ data: { reason: "cron" } });
    expect(db.chessMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        orderBy: [{ heartbeatAt: "asc" }, { id: "asc" }],
        where: { status: "running", heartbeatAt: { lt: expect.any(Date) } },
        select: { id: true, status: true, heartbeatAt: true },
      }),
    );
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, status: "running", heartbeatAt: row.heartbeatAt },
      data: { status: "error", runToken: null },
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
      data: { status: "error", runToken: null },
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
        .mockResolvedValueOnce([orphan])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(live)
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
      expect(db.chessMatch.findMany.mock.calls[3]?.[0]).toMatchObject({
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
        data: { status: "error", runToken: null },
      });
      await sweep();
      expect(db.chessMatch.findMany.mock.calls[5]?.[0]?.where?.OR).toBeUndefined();
      // An empty page at the end also wraps, without a second query in that sweep.
      expect(await sweep()).toEqual({ scanned: 0, errored: 0 });
      await sweep();
      expect(db.chessMatch.findMany.mock.calls[9]?.[0]?.where?.OR).toBeUndefined();
      expect(db.chessMatch.findMany).toHaveBeenCalledTimes(10);
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
