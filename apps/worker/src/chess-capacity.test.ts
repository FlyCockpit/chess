import { afterEach, describe, expect, it, vi } from "vitest";

const { env, pool } = vi.hoisted(() => ({
  env: {
    CHESS_ENGINE_POOL_SIZE: 0,
    CHESS_RUN_CONCURRENCY: 512,
    COCKPIT_CHESS_INSTANCE_ID: "11111111-1111-4111-8111-111111111111" as string | undefined,
  },
  pool: { configure: vi.fn(), stats: vi.fn(() => ({ busy: 3, total: 4, waiting: 9, started: 5 })) },
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env }));
vi.mock("@cockpit-chess/chess/engine", () => ({
  configureEnginePool: pool.configure,
  defaultEnginePoolSize: (cpus: number) => Math.min(16, Math.max(2, Math.floor(cpus / 2))),
  enginePoolStats: pool.stats,
}));
vi.mock("./handlers/chess-heartbeat.js", () => ({ runningChessMatches: () => 7 }));
const { startChessCapacity } = await import("./chess-capacity");
afterEach(() => vi.useRealTimers());

describe("worker chess capacity", () => {
  it("sizes the engine pool from the CPU count unless configured, and publishes counts only", async () => {
    vi.useFakeTimers();
    const set = vi.fn(async () => "OK" as const);
    const capacity = startChessCapacity({ set } as never);
    expect(pool.configure).toHaveBeenCalledWith({ size: expect.any(Number) });
    expect(capacity.concurrency).toBe(512);
    await vi.advanceTimersByTimeAsync(5000);
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(
      "cockpit-chess:chess-engine-pool:11111111-1111-4111-8111-111111111111",
      JSON.stringify({ busy: 3, total: 4, waiting: 9, running: 7, concurrency: 512 }),
      "EX",
      15,
    );
    capacity.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(set).toHaveBeenCalledTimes(2);
    env.CHESS_ENGINE_POOL_SIZE = 6;
    startChessCapacity({ set } as never).stop();
    expect(pool.configure).toHaveBeenLastCalledWith({ size: 6 });
  });
});
