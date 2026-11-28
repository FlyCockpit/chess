import { createHash } from "node:crypto";
import type { Prisma } from "@cockpit-chess/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-chess/db", () => ({ default: {} }));
vi.mock("./index.js", () => ({ auth: {}, passwordPepper: {} }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 5 } }));
const { createRunnerLimitsService, readRunnerLimitsInTransaction } = await import(
  "./runner-limits.js"
);
type Row = { id: string; identifier: string; value: string; expiresAt: Date };
const tx = {
  $executeRaw: vi.fn(),
  user: { findUnique: vi.fn() },
  session: { findFirst: vi.fn() },
  appSetting: { findUnique: vi.fn() },
  runnerMachine: { findFirst: vi.fn() },
  account: { findFirst: vi.fn() },
  twoFactor: { findUnique: vi.fn(), update: vi.fn() },
  verification: {
    findUnique: vi.fn<(args: Prisma.VerificationFindUniqueArgs) => Promise<Row | null>>(),
    upsert: vi.fn<(args: Prisma.VerificationUpsertArgs) => Promise<Row>>(),
    create: vi.fn<(args: Prisma.VerificationCreateArgs) => Promise<Row>>(),
    deleteMany: vi.fn<(args: Prisma.VerificationDeleteManyArgs) => Promise<{ count: number }>>(),
  },
};
const stored = new Map<
  string,
  { id: string; identifier: string; value: string; expiresAt: Date }
>();
const session = { userId: "u1", sessionId: "s1" };
const identity = { userId: "u1", machineId: "m1", connectionGeneration: 1 };
const hardLimits = { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 };
const operatingLimits = {
  matchMicros: 1_000_000,
  dayMicros: 10_000_000,
  concurrency: 2,
  revision: 0,
};
const raise = {
  id: "m1",
  expectedRevision: 0,
  limits: { matchMicros: 2_000_000, dayMicros: 10_000_000, concurrency: 2 },
};
const verification = { method: "password" as const, password: "test-secret" };
const verify = vi.fn(async () => true);
const service = createRunnerLimitsService(
  { $transaction: async (run) => run(tx as unknown as Prisma.TransactionClient) },
  verify,
);
function liveSession() {
  return {
    id: "s1",
    expiresAt: new Date(Date.now() + 86_400_000),
    user: {
      id: "u1",
      email: "u1@example.com",
      emailVerified: true,
      role: "user",
      banned: false,
      deletionRequestedAt: null,
      banExpires: null,
      createdAt: new Date("2026-11-01"),
      twoFactorEnabled: false,
    },
  };
}
function machine() {
  return {
    id: "m1",
    userId: "u1",
    connectionGeneration: 1,
    expiresAt: new Date(Date.now() + 86_400_000),
    User: { emailVerified: true, banned: false, banExpires: null },
  };
}
async function seed() {
  await service.hello(identity, { operatingLimits, hardLimits });
}
async function proof() {
  const result = await service.prove(session, { ...raise, verification });
  if (!result) throw new Error("Expected proof");
  return result.proof;
}
beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-28T01:00:00Z") });
  vi.resetAllMocks();
  stored.clear();
  verify.mockReset().mockResolvedValue(true);
  tx.$executeRaw.mockResolvedValue(1);
  tx.user.findUnique.mockResolvedValue({
    deletionRequestedAt: null,
    banned: false,
    banExpires: null,
  });
  tx.session.findFirst.mockResolvedValue(liveSession() as never);
  tx.appSetting.findUnique.mockResolvedValue(null);
  tx.runnerMachine.findFirst.mockResolvedValue(machine() as never);
  tx.account.findFirst.mockResolvedValue({ password: "sealed-password" } as never);
  tx.twoFactor.findUnique.mockResolvedValue(null);
  tx.verification.findUnique.mockImplementation(
    async (args) => stored.get(args.where.id ?? "") as never,
  );
  tx.verification.upsert.mockImplementation(async (args) => {
    const id = args.where.id ?? "";
    const next = {
      id,
      identifier: String(args.create.identifier),
      value: String(args.create.value),
      expiresAt: new Date(args.create.expiresAt),
    };
    stored.set(id, next);
    return next as never;
  });
  tx.verification.create.mockImplementation(async (args) => {
    const next = {
      id: String(args.data.id),
      identifier: String(args.data.identifier),
      value: String(args.data.value),
      expiresAt: new Date(args.data.expiresAt),
    };
    stored.set(next.id, next);
    return next as never;
  });
  tx.verification.deleteMany.mockImplementation(async (args) => {
    const id = typeof args?.where?.id === "string" ? args.where.id : "";
    const found = stored.has(id);
    stored.delete(id);
    return { count: Number(found) };
  });
});
afterEach(() => vi.useRealTimers());

describe("runner operating limits", () => {
  it("reads the exact advertised limits in an existing credential transaction", async () => {
    const transaction = tx as unknown as Prisma.TransactionClient;
    await expect(readRunnerLimitsInTransaction(transaction, "u1", "m1")).resolves.toBeNull();
    await seed();
    await expect(readRunnerLimitsInTransaction(transaction, "u1", "m1")).resolves.toEqual({
      version: 1,
      userId: "u1",
      machineId: "m1",
      generation: 1,
      operatingLimits,
      hardLimits,
      pending: null,
      lastResult: null,
    });
    expect(tx.verification.findUnique).toHaveBeenLastCalledWith({
      where: { id: "runner-limits:v1:m1" },
      select: { value: true, expiresAt: true },
    });
  });
  it.each(["owner", "machine", "expired", "oversized", "ceiling", "extra"])(
    "preserves the current %s storage refusal in transactional callers",
    async (fault) => {
      await seed();
      const row = stored.get("runner-limits:v1:m1");
      if (!row) throw new Error("Expected state");
      const state = JSON.parse(row.value);
      if (fault === "owner") state.userId = "other";
      if (fault === "machine") state.machineId = "other";
      if (fault === "ceiling") state.operatingLimits.matchMicros = hardLimits.matchMicros + 1;
      if (fault === "extra") state.extra = true;
      row.value = fault === "oversized" ? "x".repeat(8193) : JSON.stringify(state);
      if (fault === "expired") row.expiresAt = new Date();
      await expect(
        readRunnerLimitsInTransaction(tx as unknown as Prisma.TransactionClient, "u1", "m1"),
      ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    },
  );
  it("returns no invented limits before a runner advertises its local authority", async () => {
    expect(await service.get(session, "m1")).toEqual({
      available: false,
      operatingLimits: null,
      hardLimits: null,
      pending: null,
      lastResult: null,
      methods: { password: true, totp: false },
    });
  });
  it("binds a fresh proof to exact values and keeps the applied snapshot until terminal acknowledgement", async () => {
    await seed();
    const value = await proof();
    expect(verify).toHaveBeenCalledWith(verification, {
      password: "sealed-password",
      totpSecret: undefined,
    });
    await expect(
      service.set(session, {
        ...raise,
        limits: { ...raise.limits, dayMicros: 11_000_000 },
        proof: value,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const queued = await service.set(session, { ...raise, proof: value });
    expect(queued.operatingLimits).toEqual(operatingLimits);
    expect(queued.pending).toMatchObject({ ...raise.limits, expectedRevision: 0, revision: 1 });
    expect(
      stored.has(`runner-limit-proof:v1:${createHash("sha256").update(value).digest("hex")}`),
    ).toBe(false);
    await expect(service.set(session, { ...raise, proof: value })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const command = queued.pending;
    if (!command) throw new Error("Expected pending");
    const result = {
      commandId: command.commandId,
      revision: 1,
      status: "applied" as const,
      reason: "applied" as const,
      operatingLimits: { ...raise.limits, revision: 1 },
      hardLimits,
    };
    expect(await service.result(identity, result)).toBe(true);
    expect(await service.result(identity, result)).toBe(false);
    expect((await service.get(session, "m1")).operatingLimits).toEqual(result.operatingLimits);
    await expect(
      service.set(session, {
        ...raise,
        expectedRevision: 1,
        limits: { ...raise.limits, matchMicros: 3_000_000 },
        proof: value,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each(["session", "machine", "generation", "expired"])(
    "refuses proof reused for another %s",
    async (change) => {
      await seed();
      const value = await proof();
      const bound = { ...session };
      const request = { ...raise, proof: value };
      if (change === "session") bound.sessionId = "s2";
      if (change === "machine") request.id = "m2";
      if (change === "generation")
        tx.runnerMachine.findFirst.mockResolvedValue({
          ...machine(),
          connectionGeneration: 2,
        } as never);
      if (change === "expired") vi.advanceTimersByTime(120_001);
      // Seed a second machine state so this test reaches the exact proof binding.
      if (change === "machine") {
        tx.runnerMachine.findFirst.mockResolvedValue({ ...machine(), id: "m2" } as never);
        await service.hello({ ...identity, machineId: "m2" }, { operatingLimits, hardLimits });
      }
      await expect(service.set(bound, request)).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );
  it("requires step-up for mixed reduction/increase and refuses ceilings rather than clamping", async () => {
    await seed();
    await expect(
      service.set(session, {
        ...raise,
        limits: { matchMicros: 500_000, dayMicros: 11_000_000, concurrency: 1 },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.set(session, {
        ...raise,
        limits: { ...raise.limits, matchMicros: hardLimits.matchMicros + 1 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      service.set(session, { ...raise, limits: { matchMicros: 1, dayMicros: 1, concurrency: 1 } }),
    ).resolves.toMatchObject({
      pending: { revision: 1, matchMicros: 1, dayMicros: 1, concurrency: 1 },
    });
  });
  it("redelivers an unchanged command after reconnect and records an explicit refusal", async () => {
    await seed();
    const queued = await service.set(session, { ...raise, proof: await proof() });
    expect(await service.pending(identity)).toEqual(queued.pending);
    expect(await service.hello(identity, { operatingLimits, hardLimits })).toEqual(queued.pending);
    const pending = queued.pending;
    if (!pending) throw new Error("Expected pending");
    const result = {
      commandId: pending.commandId,
      revision: pending.revision,
      status: "rejected" as const,
      reason: "stopped" as const,
      operatingLimits,
      hardLimits,
    };
    await service.result(identity, result);
    expect(await service.get(session, "m1")).toMatchObject({
      pending: null,
      operatingLimits,
      lastResult: result,
    });
  });
  it("preserves lost-ACK commands when hello reports the accepted revision", async () => {
    await seed();
    const queued = await service.set(session, { ...raise, proof: await proof() });
    expect(
      await service.hello(identity, {
        operatingLimits: { ...raise.limits, revision: 1 },
        hardLimits,
      }),
    ).toEqual(queued.pending);
    expect(await service.pending(identity)).toEqual(queued.pending);
  });
  it("refuses a removed session and revoked machine before creating or consuming proof", async () => {
    await seed();
    tx.session.findFirst.mockResolvedValue(null);
    await expect(service.prove(session, { ...raise, verification })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    tx.session.findFirst.mockResolvedValue(liveSession() as never);
    tx.runnerMachine.findFirst.mockResolvedValue(null);
    await expect(service.set(session, raise)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(verify).not.toHaveBeenCalled();
  });
  it("refuses malformed current storage instead of interpreting old or extra shapes", async () => {
    await seed();
    const row = stored.get("runner-limits:v1:m1");
    if (!row) throw new Error("Expected state");
    row.value = JSON.stringify({ ...JSON.parse(row.value), legacy: true });
    await expect(service.get(session, "m1")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("offers setup for an SSO-only account and never accepts unsupported verification", async () => {
    await seed();
    tx.account.findFirst.mockResolvedValue(null);
    expect((await service.get(session, "m1")).methods).toEqual({ password: false, totp: false });
    expect(await service.prove(session, { ...raise, verification })).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });
  it("rejects wrong passwords without creating proofs", async () => {
    await seed();
    verify.mockResolvedValue(false);
    expect(await service.prove(session, { ...raise, verification })).toBeNull();
    expect([...stored.keys()]).toEqual(["runner-limits:v1:m1"]);
  });
  it("makes TOTP codes one-use and preserves account lockout", async () => {
    await seed();
    tx.session.findFirst.mockResolvedValue({
      ...liveSession(),
      user: { ...liveSession().user, twoFactorEnabled: true },
    } as never);
    tx.twoFactor.findUnique.mockResolvedValue({
      verified: true,
      secret: "sealed-totp",
      lockedUntil: null,
      failedVerificationCount: 0,
    } as never);
    const input = { ...raise, verification: { method: "totp" as const, code: "123456" } };
    expect(await service.prove(session, input)).toMatchObject({ proof: expect.any(String) });
    const usedId = `runner-limit-totp:v1:${createHash("sha256").update(session.userId).update("\0").update(input.verification.code).digest("hex")}`;
    expect(stored.get(usedId)?.value).toBe(session.userId);
    expect(await service.prove(session, input)).toBeNull();
    tx.twoFactor.findUnique.mockResolvedValue({
      verified: true,
      secret: "sealed-totp",
      lockedUntil: new Date(Date.now() + 1000),
      failedVerificationCount: 5,
    } as never);
    verify.mockClear();
    expect(await service.prove(session, input)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("deletion-pending runner limits authority", () => {
  it.each(["get", "prove", "set"])(
    "refuses browser %s despite a surviving session and machine",
    async (operation) => {
      await seed();
      const stateBefore = [...stored.entries()].map(([id, value]) => [id, value.value]);
      tx.session.findFirst.mockResolvedValue({
        ...liveSession(),
        user: { ...liveSession().user, deletionRequestedAt: new Date() },
      } as never);
      const run =
        operation === "get"
          ? () => service.get(session, "m1")
          : operation === "prove"
            ? () => service.prove(session, { ...raise, verification })
            : () =>
                service.set(session, {
                  ...raise,
                  limits: { matchMicros: 1, dayMicros: 1, concurrency: 1 },
                });
      await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(verify).not.toHaveBeenCalled();
      expect([...stored.entries()].map(([id, value]) => [id, value.value])).toEqual(stateBefore);
    },
  );
  it.each(["hello", "pending", "result"])(
    "refuses transport %s through the canonical transactional owner fence",
    async (operation) => {
      await seed();
      const queued = await service.set(session, { ...raise, proof: await proof() });
      const pending = queued.pending;
      if (!pending) throw new Error("Expected pending");
      const result = {
        commandId: pending.commandId,
        revision: pending.revision,
        status: "applied" as const,
        reason: "applied" as const,
        operatingLimits: { ...raise.limits, revision: pending.revision },
        hardLimits,
      };
      const stateBefore = [...stored.entries()].map(([id, value]) => [id, value.value]);
      tx.user.findUnique.mockResolvedValue({
        deletionRequestedAt: new Date(),
        banned: false,
        banExpires: null,
      });
      const run =
        operation === "hello"
          ? () => service.hello(identity, { operatingLimits, hardLimits })
          : operation === "pending"
            ? () => service.pending(identity)
            : () => service.result(identity, result);
      await expect(run()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(tx.user.findUnique).toHaveBeenLastCalledWith({
        where: { id: identity.userId },
        select: { deletionRequestedAt: true, banned: true, banExpires: true },
      });
      expect([...stored.entries()].map(([id, value]) => [id, value.value])).toEqual(stateBefore);
    },
  );
  it("refuses a missing owner or unavailable deletion authority without a fallback read", async () => {
    await seed();
    tx.user.findUnique.mockResolvedValue(null);
    await expect(service.pending(identity)).rejects.toMatchObject({ code: "NOT_FOUND" });
    tx.user.findUnique.mockRejectedValue(new Error("authority unavailable"));
    await expect(service.pending(identity)).rejects.toThrow("authority unavailable");
  });
});
