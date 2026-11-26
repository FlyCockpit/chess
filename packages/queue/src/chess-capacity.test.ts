import { describe, expect, it, vi } from "vitest";
import { publishChessEngineStats, readChessEngineStats } from "./chess-capacity";

describe("chess engine pool stats", () => {
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
