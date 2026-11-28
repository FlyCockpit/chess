import type prismaInstance from "@cockpit-chess/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const { registerHeartbeat, runningChessMatches } = await import("./chess-heartbeat");

const claim = (id: string, ownerKey?: { userId: string; keyHash: string }) => ({
  matchId: id,
  runToken: `token-${id}`,
  ownerKey,
  onLost: vi.fn(),
  onRevoked: vi.fn(),
  onFailing: vi.fn(),
});
let leave: Array<() => void> = [];
beforeEach(() => {
  mockReset(db);
  vi.useFakeTimers();
});
afterEach(() => {
  for (const done of leave) done();
  leave = [];
  vi.useRealTimers();
});

describe("shared chess heartbeat", () => {
  it("uses monotonic elapsed time when the wall clock goes backwards", () => {
    const one = claim("rollback");
    const done = registerHeartbeat(one);
    leave = [done];
    const started = performance.now();
    const mono = vi.spyOn(performance, "now").mockReturnValue(started + 8000);
    vi.setSystemTime(Date.now() - 60_000);
    try {
      expect(() => done.assertUsable()).toThrow("ownership could not be confirmed");
      expect(one.onFailing).toHaveBeenCalledTimes(1);
    } finally {
      mono.mockRestore();
    }
  });
  it("fences a hung database call and checks elapsed time before dispatch after a clock jump", async () => {
    const one = claim("hung");
    const done = registerHeartbeat(one);
    leave = [done];
    let settle = (_value: { count: number }) => {};
    const pending = new Promise<{ count: number }>((resolve) => {
      settle = resolve;
    });
    db.chessMatch.updateMany.mockReturnValueOnce(pending as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(() => done.assertUsable()).not.toThrow();
    // No timer callback needed: the synchronous actual-request guard fails closed.
    vi.setSystemTime(Date.now() + 8000);
    expect(() => done.assertUsable()).toThrow("ownership could not be confirmed");
    expect(one.onFailing).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(db.chessMatch.updateMany).toHaveBeenCalledTimes(1);
    expect(one.onFailing).toHaveBeenCalledTimes(1);
    settle({ count: 0 });
    await vi.advanceTimersByTimeAsync(0);
  });
  it("refreshes new claims after a query timeout and ignores the late old result", async () => {
    const old = claim("old");
    const done = registerHeartbeat(old);
    let settle = (_value: { count: number }) => {};
    const pending = new Promise<{ count: number }>((resolve) => {
      settle = resolve;
    });
    db.chessMatch.updateMany.mockReturnValueOnce(pending as never);
    await vi.advanceTimersByTimeAsync(8000);
    expect(old.onFailing).toHaveBeenCalledTimes(1);
    done();
    const fresh = claim("fresh");
    const freshDone = registerHeartbeat(fresh);
    leave = [freshDone];
    db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(db.chessMatch.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          source: "hosted",
          status: "running",
          OR: [{ id: "fresh", runToken: "token-fresh" }],
        },
      }),
    );
    expect(() => freshDone.assertUsable()).not.toThrow();
    settle({ count: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(old.onLost).not.toHaveBeenCalled();
    expect(fresh.onLost).not.toHaveBeenCalled();
    expect(() => freshDone.assertUsable()).not.toThrow();
  });
  it("refreshes every claim with one UPDATE per tick, however many matches run", async () => {
    const claims = Array.from({ length: 300 }, (_, index) => claim(`m${index}`));
    leave = claims.map(registerHeartbeat);
    expect(runningChessMatches()).toBe(300);
    db.chessMatch.updateMany.mockResolvedValue({ count: 300 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(db.chessMatch.updateMany).toHaveBeenCalledTimes(1);
    const [input] = db.chessMatch.updateMany.mock.calls[0] ?? [];
    expect(input?.where).toMatchObject({ status: "running" });
    expect((input?.where as { OR?: unknown[] } | undefined)?.OR).toHaveLength(300);
    expect(db.chessMatch.findMany).not.toHaveBeenCalled();
    expect(db.openRouterConnection.findMany).not.toHaveBeenCalled();
    for (const each of claims) expect(each.onLost).not.toHaveBeenCalled();
  });

  it("reports only the claims whose row is no longer theirs", async () => {
    const kept = claim("kept");
    const stopped = claim("stopped");
    leave = [registerHeartbeat(kept), registerHeartbeat(stopped)];
    db.chessMatch.updateMany.mockResolvedValue({ count: 1 });
    db.chessMatch.findMany.mockResolvedValue([{ id: "kept", runToken: "token-kept" }] as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(stopped.onLost).toHaveBeenCalledTimes(1);
    expect(kept.onLost).not.toHaveBeenCalled();
  });

  it("checks owner-key connections in one read and revokes only changed ones", async () => {
    const same = claim("a", { userId: "user-a", keyHash: "hash-a" });
    const replaced = claim("b", { userId: "user-b", keyHash: "hash-b" });
    const gone = claim("c", { userId: "user-c", keyHash: "hash-c" });
    const operator = claim("d");
    leave = [same, replaced, gone, operator].map(registerHeartbeat);
    db.chessMatch.updateMany.mockResolvedValue({ count: 4 });
    db.openRouterConnection.findMany.mockResolvedValue([
      { userId: "user-a", keyHash: "hash-a", status: "active" },
      { userId: "user-b", keyHash: "hash-new", status: "active" },
    ] as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(db.openRouterConnection.findMany).toHaveBeenCalledTimes(1);
    expect(same.onRevoked).not.toHaveBeenCalled();
    expect(operator.onRevoked).not.toHaveBeenCalled();
    expect(replaced.onRevoked).toHaveBeenCalledTimes(1);
    expect(gone.onRevoked).toHaveBeenCalledTimes(1);
  });

  it("stops every claim after three failed ticks in a row, and stops ticking when empty", async () => {
    const one = claim("one");
    const done = registerHeartbeat(one);
    db.chessMatch.updateMany.mockRejectedValue(new Error("db down"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(one.onFailing).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(one.onFailing).toHaveBeenCalled();
    done();
    expect(runningChessMatches()).toBe(0);
    db.chessMatch.updateMany.mockClear();
    await vi.advanceTimersByTimeAsync(6000);
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
  });
});
