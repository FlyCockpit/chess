import { beforeEach, describe, expect, it, vi } from "vitest";

const { redis, run, spectator } = vi.hoisted(() => ({
  redis: {
    eval: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    srandmember: vi.fn(),
    srem: vi.fn(),
    scard: vi.fn(),
  },
  run: { getJob: vi.fn(), add: vi.fn(), toKey: (type: string) => `bull:chess-run:${type}` },
  spectator: {
    getJob: vi.fn(),
    add: vi.fn(),
    toKey: (type: string) => `bull:chess-reconcile:${type}`,
  },
}));
vi.mock("./connection.js", () => ({ redisConnection: redis }));
vi.mock("./index.js", () => ({ chessRunQueue: run, chessReconcileQueue: spectator }));
const { publishRegisteredChessJob, purgeChessJobs } = await import("./chess-job-registry");

const job = (state: string) => ({
  getState: vi.fn(async () => state),
  remove: vi.fn(async () => {}),
  updateData: vi.fn(async () => {}),
  retry: vi.fn(async () => {}),
});
beforeEach(() => {
  vi.resetAllMocks();
  redis.eval.mockImplementation(async (script: string) =>
    script.includes("XREVRANGE") ? ["", "", 0] : 1,
  );
  redis.get.mockResolvedValue("publication-epoch");
  redis.set.mockResolvedValue("OK");
  redis.srandmember.mockResolvedValue([]);
  redis.srem.mockResolvedValue(1);
  redis.scard.mockResolvedValue(0);
  run.getJob.mockResolvedValue(null);
  spectator.getJob.mockResolvedValue(null);
});

describe("per-match job erasure registry", () => {
  it("registers before publication and leaves a repairable entry if publication fails", async () => {
    const events: string[] = [];
    redis.eval.mockImplementation(async () => {
      events.push("register");
      return 1;
    });
    run.add.mockImplementation(async () => {
      events.push("publish");
      throw new Error("Redis unavailable");
    });
    await expect(
      publishRegisteredChessJob("match", "run", "chess-run", { matchId: "match" }, "job", () => {}),
    ).rejects.toThrow("Redis unavailable");
    expect(events).toEqual(["register", "publish"]);
    expect(redis.srem).not.toHaveBeenCalled();
  });

  it("refuses publication if the bounded registry cannot accept another reference", async () => {
    redis.eval.mockResolvedValue(0);
    await expect(
      publishRegisteredChessJob("match", "run", "chess-run", { matchId: "match" }, "job", () => {}),
    ).rejects.toThrow("registry is full");
    expect(run.add).not.toHaveBeenCalled();
  });

  it("removes retained payload/results on both queues and only then forgets their references", async () => {
    redis.srandmember.mockResolvedValue(["run|hosted", "spectator|evaluation"]);
    const hosted = job("completed");
    const evaluation = job("failed");
    run.getJob.mockResolvedValue(hosted);
    spectator.getJob.mockResolvedValue(evaluation);
    expect(await purgeChessJobs("match")).toBe(true);
    expect(hosted.remove).toHaveBeenCalledOnce();
    expect(evaluation.remove).toHaveBeenCalledOnce();
    expect(redis.srandmember).toHaveBeenCalledWith("cockpit-chess:match-jobs:match", 10);
    expect(redis.srem).toHaveBeenCalledTimes(2);
  });

  it.each(["active", "unknown"])("keeps %s work pending", async (state) => {
    redis.srandmember.mockResolvedValue(["run|hosted"]);
    redis.scard.mockResolvedValue(1);
    const hosted = job(state);
    run.getJob.mockResolvedValue(hosted);
    expect(await purgeChessJobs("match")).toBe(false);
    expect(hosted.remove).not.toHaveBeenCalled();
    expect(redis.srem).not.toHaveBeenCalled();
  });

  it("keeps a job claimed between classification and removal indexed", async () => {
    redis.srandmember.mockResolvedValue(["run|hosted"]);
    redis.scard.mockResolvedValue(1);
    const hosted = job("waiting");
    hosted.remove.mockRejectedValue(new Error("locked"));
    run.getJob.mockResolvedValue(hosted);
    expect(await purgeChessJobs("match")).toBe(false);
    expect(redis.srem).not.toHaveBeenCalled();
  });

  it("does not claim completion on Redis failure or an unfinished next page", async () => {
    redis.scard.mockResolvedValueOnce(8).mockRejectedValueOnce(new Error("Redis unavailable"));
    expect(await purgeChessJobs("match")).toBe(false);
    await expect(purgeChessJobs("match")).rejects.toThrow("Redis unavailable");
  });

  it("guards a retry again after its retained payload write awaits", async () => {
    const retained = job("completed");
    run.getJob.mockResolvedValue(retained);
    let expired = false;
    retained.updateData.mockImplementation(async () => {
      expired = true;
    });
    const assertFresh = () => {
      if (expired) throw new Error("owner lock expired");
    };
    await expect(
      publishRegisteredChessJob(
        "match",
        "run",
        "chess-run",
        { matchId: "match" },
        "job",
        assertFresh,
      ),
    ).rejects.toThrow();
    expect(retained.retry).not.toHaveBeenCalled();
    expect(run.add).not.toHaveBeenCalled();
  });

  it("keeps the registry until private event erasure is confirmed, then retries idempotently", async () => {
    redis.srandmember.mockResolvedValue(["run|hosted"]);
    redis.eval.mockRejectedValueOnce(new Error("event store unavailable"));
    await expect(purgeChessJobs("match")).rejects.toThrow("event store unavailable");
    expect(redis.srem).not.toHaveBeenCalled();
    expect(await purgeChessJobs("match")).toBe(true);
    expect(redis.srem).toHaveBeenCalledExactlyOnceWith(
      "cockpit-chess:match-jobs:match",
      "run|hosted",
    );
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.stringContaining("XDEL"),
      1,
      "bull:chess-run:events",
      "-",
      "",
      "hosted",
    );
  });

  it("does not claim erasure of an unexpectedly unbounded event stream", async () => {
    redis.srandmember.mockResolvedValue(["run|hosted"]);
    redis.eval.mockResolvedValue(["100-0", "999999-0", 512]);
    expect(await purgeChessJobs("match")).toBe(false);
    expect(redis.eval).toHaveBeenCalledTimes(64);
    expect(redis.srem).not.toHaveBeenCalled();
  });
});
