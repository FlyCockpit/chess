import { describe, expect, it, vi } from "vitest";
import { publishChessEngineStats, readChessEngineStats } from "./chess-capacity";

describe("chess engine pool stats", () => {
  it("deduplicates SCAN results and ignores malformed count records", async () => {
    const valid = JSON.stringify({ busy: 1, total: 2, waiting: 0, running: 3, concurrency: 512 });
    const records = new Map([
      ["a", valid],
      ["b", valid],
      ["null", "null"],
      ["array", "[]"],
      [
        "negative",
        JSON.stringify({ busy: -1, total: 2, waiting: 0, running: 0, concurrency: 512 }),
      ],
      ["missing", "{}"],
    ]);
    const redis = {
      scan: vi
        .fn()
        .mockResolvedValueOnce(["1", ["a", "a", "null", "array"]])
        .mockResolvedValueOnce(["0", ["a", "b", "negative", "missing"]]),
      mget: vi.fn(async (...keys: string[]) => keys.map((key) => records.get(key) ?? null)),
    };
    expect(await readChessEngineStats(redis as never)).toEqual({
      busy: 2,
      total: 4,
      waiting: 0,
      running: 6,
      concurrency: 1024,
      workers: 2,
    });
    expect(redis.mget.mock.calls[0]?.[0]).toBe("a");
    expect(redis.mget.mock.calls[0]?.filter((key) => key === "a")).toHaveLength(1);
  });
  it("bounds scans even when SCAN keeps returning empty nonterminal pages", async () => {
    const redis = { scan: vi.fn(async () => ["1", []]), mget: vi.fn() };
    await expect(readChessEngineStats(redis as never)).rejects.toThrow("scan incomplete");
    expect(redis.scan).toHaveBeenCalledTimes(10);
    expect(redis.mget).not.toHaveBeenCalled();
  });
  it("reports an oversized terminal scan batch as unavailable rather than a partial total", async () => {
    const redis = {
      scan: vi.fn(async () => ["0", Array.from({ length: 501 }, (_, index) => `worker-${index}`)]),
      mget: vi.fn(),
    };
    await expect(readChessEngineStats(redis as never)).rejects.toThrow("scan incomplete");
    expect(redis.scan).toHaveBeenCalledTimes(1);
    expect(redis.mget).not.toHaveBeenCalled();
  });
  it("publishes counts with an expiry and sums every fresh worker, skipping junk", async () => {
    const store = new Map<string, string>();
    const redis = {
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK" as const;
      }),
      scan: vi.fn(async () => ["0", [...store.keys()]] as [string, string[]]),
      mget: vi.fn(async (...keys: string[]) => keys.map((key) => store.get(key) ?? null)),
    };
    await publishChessEngineStats(redis, "a", {
      busy: 2,
      total: 4,
      waiting: 5,
      running: 30,
      concurrency: 512,
    });
    await publishChessEngineStats(redis, "b", {
      busy: 1,
      total: 4,
      waiting: 0,
      running: 3,
      concurrency: 512,
    });
    expect(redis.set).toHaveBeenCalledWith(
      "cockpit-chess:chess-engine-pool:a",
      expect.any(String),
      "EX",
      15,
    );
    store.set("cockpit-chess:chess-engine-pool:junk", "{not json");
    expect(await readChessEngineStats(redis as never)).toEqual({
      busy: 3,
      total: 8,
      waiting: 5,
      running: 33,
      concurrency: 1024,
      workers: 2,
    });
    store.clear();
    expect(await readChessEngineStats(redis as never)).toMatchObject({ workers: 0, total: 0 });
  });
});
