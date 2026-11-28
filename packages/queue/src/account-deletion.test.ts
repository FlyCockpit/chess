import type IORedis from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { runnerDeletionLeasesBlocking } from "./account-deletion";

function store(results: unknown) {
  const multi = { info: vi.fn(), exists: vi.fn(), exec: vi.fn().mockResolvedValue(results) };
  return { multi: vi.fn().mockReturnValue(multi) } as unknown as Pick<IORedis, "multi">;
}
describe("runner deletion stop evidence", () => {
  it("accepts absence only from a stable store and rejects any live lease", async () => {
    expect(
      await runnerDeletionLeasesBlocking(
        store([
          [null, "uptime_in_seconds:90"],
          [null, 0],
        ]),
        ["m"],
      ),
    ).toBe(false);
    expect(
      await runnerDeletionLeasesBlocking(
        store([
          [null, "uptime_in_seconds:90"],
          [null, 1],
        ]),
        ["m"],
      ),
    ).toBe(true);
  });
  it.each([
    null,
    [[new Error("redis failed"), null]],
    [[null, "uptime_in_seconds:2"]],
    [[null, "unknown"]],
  ])("fails closed on missing, failed, restarted or malformed evidence", async (results) => {
    await expect(runnerDeletionLeasesBlocking(store(results), [])).rejects.toThrow();
  });
  it("rejects an unbounded machine page", async () => {
    await expect(
      runnerDeletionLeasesBlocking(
        store([]),
        Array.from({ length: 51 }, () => "m"),
      ),
    ).rejects.toThrow("too large");
  });
});
