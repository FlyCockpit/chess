import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  resolve: vi.fn(),
  lock: vi.fn(),
  update: vi.fn(),
  match: vi.fn(),
  transaction: vi.fn(),
  slot: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("./runner-session.js", () => ({ resolveRunnerMachineCredential: state.resolve }));
vi.mock("@cockpit-chess/auth/device-redemption-lock", () => ({
  lockCliCredentials: state.lock,
}));
vi.mock("@cockpit-chess/auth/lock-slots", () => ({ withLockSlot: state.slot }));
vi.mock("@cockpit-chess/db", () => ({
  default: { $transaction: state.transaction, chessMatch: { findFirst: state.match } },
}));
const { createRunnerAuthority } = await import("./runner-ws-authority.js");
const identity = {
  userId: "owner1",
  machineId: "machine1",
  connectionGeneration: 7,
  expiresAt: new Date(Date.now() + 60_000),
};
const tx = { runnerMachine: { updateMany: state.update }, $executeRaw: state.execute };

beforeEach(() => {
  vi.clearAllMocks();
  state.resolve.mockResolvedValue(identity);
  state.lock.mockResolvedValue(undefined);
  state.update.mockResolvedValue({ count: 1 });
  state.execute.mockResolvedValue(1);
  state.transaction.mockImplementation(async (fn) => fn(tx));
  state.slot.mockImplementation(async (fn) => fn());
});
afterEach(() => vi.restoreAllMocks());

describe("runner transport durable authority", () => {
  it("claims a monotonic generation under the same credential lock as reset", async () => {
    const isOwnerActive = vi.fn().mockResolvedValue(true);
    expect(await createRunnerAuthority(isOwnerActive).claim("Bearer test")).toEqual({
      ...identity,
      connectionGeneration: 8,
    });
    expect(state.lock).toHaveBeenCalledWith("owner1", tx);
    expect(state.resolve.mock.calls).toEqual([["Bearer test"], ["Bearer test", tx]]);
    expect(state.lock.mock.invocationCallOrder[0]).toBeLessThan(
      state.resolve.mock.invocationCallOrder[1] ?? 0,
    );
    expect(state.update).toHaveBeenCalledWith({
      where: {
        id: "machine1",
        userId: "owner1",
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
        connectionGeneration: 7,
      },
      data: { connectionGeneration: { increment: 1 }, lastSeenAt: expect.any(Date) },
    });
    expect(state.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
      timeout: expect.any(Number),
      maxWait: expect.any(Number),
    });
    expect(state.slot).toHaveBeenCalledWith(expect.any(Function), { deadline: expect.any(Number) });
  });

  it("denies a reset that wins before the locked recheck", async () => {
    state.resolve.mockResolvedValueOnce(identity).mockResolvedValueOnce(null);
    expect(await createRunnerAuthority(async () => true).claim("Bearer test")).toBeNull();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("rolls back a write finishing after the absolute deadline following delayed checkout", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    let generation = 7;
    let rolledBack = false;
    state.transaction.mockImplementationOnce(async (fn) => {
      clock.mockReturnValue(3000);
      try {
        const result = await fn(tx);
        if (result) generation = result.connectionGeneration;
        return result;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    state.update.mockImplementationOnce(async () => {
      clock.mockReturnValue(5200);
      return { count: 1 };
    });
    await expect(createRunnerAuthority(async () => true).claim("Bearer test")).rejects.toThrow(
      "RUNNER_CLAIM_EXPIRED",
    );
    expect(generation).toBe(7);
    expect(rolledBack).toBe(true);
    expect(state.execute.mock.calls[0]?.[1]).toBe("1000ms");
    const options = state.transaction.mock.calls[0]?.[1];
    expect(options.maxWait + options.timeout).toBeLessThanOrEqual(4000);
  });

  it("does not mutate generation when lock admission or an awaited lock finishes after its deadline", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    state.slot.mockImplementationOnce(async (fn) => {
      clock.mockReturnValue(5000);
      return fn();
    });
    expect(await createRunnerAuthority(async () => true).claim("Bearer test")).toBeNull();
    expect(state.transaction).not.toHaveBeenCalled();
    clock.mockReturnValue(0);
    state.lock.mockImplementationOnce(async () => {
      clock.mockReturnValue(5000);
    });
    await expect(createRunnerAuthority(async () => true).claim("Bearer test")).rejects.toThrow(
      "RUNNER_CLAIM_EXPIRED",
    );
    expect(state.update).not.toHaveBeenCalled();
  });

  it("denies deletion-pending owners at both connect and action seams", async () => {
    const authority = createRunnerAuthority(async () => false);
    expect(await authority.claim("Bearer test")).toBeNull();
    expect(await authority.resolve("Bearer test")).toBeNull();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("propagates fence/storage failure so callers fail closed", async () => {
    const authority = createRunnerAuthority(async () => {
      throw new Error("unavailable");
    });
    await expect(authority.claim("Bearer test")).rejects.toThrow("unavailable");
    await expect(authority.resolve("Bearer test")).rejects.toThrow("unavailable");
    expect(state.update).not.toHaveBeenCalled();
  });

  it("rejects a failed generation CAS or integer exhaustion", async () => {
    state.update.mockResolvedValue({ count: 0 });
    expect(await createRunnerAuthority(async () => true).claim("Bearer test")).toBeNull();
    state.resolve.mockResolvedValue({ ...identity, connectionGeneration: 2_147_483_646 });
    state.update.mockClear();
    expect(await createRunnerAuthority(async () => true).claim("Bearer test")).toBeNull();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("does not acquire locks for an invalid purpose credential", async () => {
    state.resolve.mockResolvedValue(null);
    expect(
      await createRunnerAuthority(async () => true).claim("Bearer general-api-key"),
    ).toBeNull();
    expect(state.lock).not.toHaveBeenCalled();
  });

  it("requires runner source and exact owner even for valid match IDs", async () => {
    state.match.mockResolvedValue(null);
    const authority = createRunnerAuthority(async () => true);
    expect(await authority.ownsMatch(identity, "foreign")).toBe(false);
    expect(state.match).toHaveBeenCalledWith({
      where: { id: "foreign", ownerId: "owner1", source: "runner", runnerMachineId: "machine1" },
      select: { id: true },
    });
    state.match.mockResolvedValue({ id: "owned" });
    expect(await authority.ownsMatch(identity, "owned")).toBe(true);
  });
});
