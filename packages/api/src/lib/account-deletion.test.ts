import type { Prisma } from "@cockpit-chess/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { Prisma: { DbNull: Symbol("DbNull") }, default: mockDeep() };
});
vi.mock("../../../../scripts/backup/account-deletion-suppression.mjs", () => ({
  appendAccountDeletionSuppression: vi.fn(),
  assertAccountDeletionRegisterAvailable: vi.fn(),
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env: {} }));
vi.mock("@cockpit-chess/auth/credential-revocation", () => ({
  revokeCredentialsInTransaction: vi.fn(),
}));
vi.mock("@cockpit-chess/auth/device-redemption-lock", () => ({ lockCliCredentials: vi.fn() }));
vi.mock("@cockpit-chess/auth/lock-slots", () => ({
  withLockSlot: (run: () => Promise<unknown>) => run(),
}));
vi.mock("@cockpit-chess/auth/password-write-lock", () => ({
  passwordWriteLockKey: (id: string) => `password-write:${id}`,
}));
vi.mock("@cockpit-chess/auth/set-password-link-lock", () => ({ lockSetPasswordLinks: vi.fn() }));

const { default: prisma } = await import("@cockpit-chess/db");
const { revokeCredentialsInTransaction } = await import(
  "@cockpit-chess/auth/credential-revocation"
);
const { requestAccountDeletion } = await import("./account-deletion");
const { assertAccountDeletionRegisterAvailable, appendAccountDeletionSuppression } = await import(
  "../../../../scripts/backup/account-deletion-suppression.mjs"
);
const { invalidateForceTwoFactorSettingsCache, isTwoFactorPolicySatisfied } = await import(
  "./two-factor-policy"
);
const tx = mockDeep<Prisma.TransactionClient>();
const locks = mockDeep<Prisma.TransactionClient>();
const timeline: string[] = [];
const admin = { kind: "admin", userId: "admin", sessionId: "admin-session" } as const;
const db = vi.mocked(prisma);

it("refuses an unavailable deployment before committing destructive intent", async () => {
  vi.mocked(assertAccountDeletionRegisterAvailable).mockRejectedValueOnce(
    new Error("not configured"),
  );
  await expect(requestAccountDeletion("u1", admin)).rejects.toMatchObject({
    code: "SERVICE_UNAVAILABLE",
    data: { reason: "DELETION_NOT_READY" },
  });
  expect(db.$transaction).not.toHaveBeenCalled();
});

it("never acknowledges acceptance if external suppression fails after the durable fence", async () => {
  vi.mocked(appendAccountDeletionSuppression).mockRejectedValueOnce(new Error("storage failed"));
  await expect(requestAccountDeletion("u1", admin)).rejects.toMatchObject({
    code: "SERVICE_UNAVAILABLE",
    data: { reason: "CLEANUP_UNAVAILABLE" },
  });
  expect(tx.user.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ deletionState: "pending" }) }),
  );
  expect(locks.chessMatch.updateMany).not.toHaveBeenCalled();
});

beforeEach(() => {
  mockReset(tx);
  mockReset(locks);
  mockReset(db);
  vi.mocked(revokeCredentialsInTransaction).mockReset();
  vi.clearAllMocks();
  timeline.length = 0;
  invalidateForceTwoFactorSettingsCache();
  tx.appSetting.findMany.mockResolvedValue([]);
  locks.chessMatch.findMany.mockResolvedValue([]);
  locks.chessMatch.updateMany.mockImplementation(async () => {
    timeline.push("settle");
    return { count: 0 };
  });
  vi.mocked(revokeCredentialsInTransaction).mockImplementation(async () => {
    timeline.push("revoke");
  });
  db.$transaction.mockImplementation(async (run, options) => {
    if (typeof run !== "function") throw new Error("Expected interactive transaction");
    return run(options?.isolationLevel === "ReadCommitted" ? locks : tx);
  });
  tx.user.findUnique.mockResolvedValue({
    id: "u1",
    role: "user",
    emailVerified: true,
    banned: false,
    banExpires: null,
    deletionRequestedAt: null,
  } as never);
  tx.user.findUniqueOrThrow.mockResolvedValue({
    deletionRequestedAt: null,
    deletionState: "active",
    role: "user",
    twoFactorEnabled: true,
    createdAt: new Date(),
    banned: false,
    banExpires: null,
  } as never);
  tx.session.findFirst.mockResolvedValue({
    id: "s1",
    user: {
      id: "admin",
      role: "admin",
      emailVerified: true,
      twoFactorEnabled: true,
      banned: false,
      banExpires: null,
      deletionRequestedAt: null,
      createdAt: new Date(),
    },
  } as never);
});

describe("requestAccountDeletion", () => {
  it("commits the credential fence before ReadCommitted settlement without physical deletion", async () => {
    const answer = await requestAccountDeletion("u1", { kind: "self", sessionId: "s1" });
    expect(answer).toEqual({
      status: "pending",
      requestedAt: expect.any(Date),
      phase: "pending",
      complete: false,
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { deletionRequestedAt: answer.requestedAt, deletionState: "pending" },
      select: { id: true },
    });
    expect(locks.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ownerId: "u1",
          source: { not: "runner" },
          status: { in: ["queued", "running"] },
        },
        data: expect.objectContaining({
          terminalCause: "owner-delete",
          turnType: "idle",
          runToken: null,
        }),
      }),
    );
    expect(timeline).toEqual(["revoke", "settle"]);
    expect(tx.chessMatch.updateMany).not.toHaveBeenCalled();
    expect(locks.chessMatch.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("runnerState");
    expect(revokeCredentialsInTransaction).toHaveBeenCalledWith(tx, "u1", {
      activeMatches: "deletion-pending",
    });
    expect(tx.openRouterConnection.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    expect(tx.user.delete).not.toHaveBeenCalled();
    expect(tx.chessMatch.deleteMany).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
      timeout: 30_000,
      isolationLevel: "ReadCommitted",
    });
    expect(db.$transaction).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
  });

  it("atomically fences active owned runner state and its outstanding commands", async () => {
    locks.chessMatch.findMany.mockResolvedValueOnce([{ id: "runner-active" }] as never);
    locks.chessMatch.updateMany.mockResolvedValue({ count: 1 });
    await requestAccountDeletion("u1", admin);
    expect(locks.chessMatch.findMany).toHaveBeenCalledWith({
      where: { ownerId: "u1", source: "runner", status: { in: ["queued", "running"] } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 50,
    });
    expect(locks.chessMatch.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "runner-active",
        ownerId: "u1",
        source: "runner",
        status: { in: ["queued", "running"] },
      },
      data: expect.objectContaining({
        status: "stopped",
        terminalCause: "owner-delete",
        runToken: null,
        turnType: "idle",
        runnerState: "stopped",
        runnerGeneration: null,
        runnerResumeDeadline: null,
        runnerRevision: { increment: 1 },
      }),
    });
    expect(locks.runnerCommand.updateMany).toHaveBeenCalledWith({
      where: { matchId: "runner-active", ackedAt: null, cancelledAt: null },
      data: { cancelledAt: expect.any(Date) },
    });
    expect(tx.runnerCommand.updateMany).not.toHaveBeenCalled();
    expect(tx.chessMatch.findMany).not.toHaveBeenCalled();
  });

  it("spares a runner that became terminal before its stop CAS and leaves its commands untouched", async () => {
    locks.chessMatch.findMany.mockResolvedValueOnce([{ id: "runner-finished" }] as never);
    locks.chessMatch.updateMany.mockResolvedValue({ count: 0 });
    await requestAccountDeletion("u1", admin);
    expect(locks.chessMatch.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          id: "runner-finished",
          ownerId: "u1",
          source: "runner",
          status: { in: ["queued", "running"] },
        },
      }),
    );
    expect(locks.runnerCommand.updateMany).not.toHaveBeenCalled();
  });

  it("requires a fresh, live, nonimpersonated browser session for password or SSO", async () => {
    await requestAccountDeletion("u1", { kind: "self", sessionId: "sso-session" });
    expect(tx.session.findFirst).toHaveBeenCalledWith({
      where: {
        id: "sso-session",
        userId: "u1",
        origin: "sign-in",
        impersonatedBy: null,
        expiresAt: { gt: expect.any(Date) },
        authenticatedAt: { gte: expect.any(Date), lte: expect.any(Date) },
      },
      select: { id: true },
    });
    const where = tx.session.findFirst.mock.calls.find(
      ([args]) => args?.where?.authenticatedAt,
    )?.[0]?.where;
    const range = where?.authenticatedAt as { lte: Date; gte: Date } | undefined;
    if (!range) throw new Error("Expected recent sign-in range");
    expect(Number(range.lte) - Number(range.gte)).toBe(300_000);
  });

  it("refuses stale/missing session proof before any write", async () => {
    tx.session.findFirst.mockResolvedValue(null);
    await expect(
      requestAccountDeletion("u1", { kind: "self", sessionId: "old" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", data: { reason: "REAUTH_REQUIRED" } });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(revokeCredentialsInTransaction).not.toHaveBeenCalled();
  });

  it("rechecks forced 2FA inside the authority transaction after the credential-lock wait", async () => {
    const user = {
      deletionRequestedAt: null,
      deletionState: "active",
      role: "user",
      twoFactorEnabled: false,
      createdAt: new Date(Date.now() - 172_800_000),
      banned: false,
      banExpires: null,
    };
    tx.user.findUniqueOrThrow.mockResolvedValue(user as never);
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faPublicUsers", value: "false" }]);
    // Simulate the protected route's successful, cached check before locking.
    expect(await isTwoFactorPolicySatisfied(user)).toBe(true);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { lockCliCredentials } = await import("@cockpit-chess/auth/device-redemption-lock");
    let waiting = false;
    vi.mocked(lockCliCredentials).mockImplementationOnce(() => {
      waiting = true;
      return gate as never;
    });
    const removing = requestAccountDeletion("u1", { kind: "self", sessionId: "s1" });
    const refused = expect(removing).rejects.toMatchObject({ code: "FORBIDDEN" });
    await vi.waitFor(() => expect(waiting).toBe(true));
    expect(tx.user.findUniqueOrThrow).not.toHaveBeenCalled();
    tx.appSetting.findMany.mockResolvedValue([{ key: "force2faPublicUsers", value: "true" }]);
    release();
    await refused;
    expect(tx.appSetting.findMany).toHaveBeenCalledWith({
      where: { key: { in: ["force2faPublicUsers", "force2faInternalUsers"] } },
      select: { key: true, value: true },
      take: 2,
    });
    expect(db.appSetting.findMany).toHaveBeenCalledTimes(1);
    expect(locks.appSetting.findMany).not.toHaveBeenCalled();
    expect(tx.user.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: {
        deletionRequestedAt: true,
        deletionState: true,
        role: true,
        twoFactorEnabled: true,
        createdAt: true,
        banned: true,
        banExpires: true,
      },
    });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(revokeCredentialsInTransaction).not.toHaveBeenCalled();
    expect(tx.openRouterConnection.deleteMany).not.toHaveBeenCalled();
    expect(locks.chessMatch.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { label: "unforced", forced: false, enrolled: false, age: 172_800_000 },
    { label: "enrollment grace", forced: true, enrolled: false, age: 1000 },
    { label: "enrolled", forced: true, enrolled: true, age: 172_800_000 },
  ])(
    "preserves self-deletion for an eligible $label account",
    async ({ forced, enrolled, age }) => {
      tx.user.findUniqueOrThrow.mockResolvedValue({
        deletionRequestedAt: null,
        deletionState: "active",
        role: "user",
        twoFactorEnabled: enrolled,
        createdAt: new Date(Date.now() - age),
        banned: false,
        banExpires: null,
      } as never);
      tx.appSetting.findMany.mockResolvedValue([
        { key: "force2faPublicUsers", value: String(forced) },
      ]);
      await expect(
        requestAccountDeletion("u1", { kind: "self", sessionId: "s1" }),
      ).resolves.toMatchObject({ status: "pending", complete: false });
      expect(tx.user.update).toHaveBeenCalledOnce();
      expect(revokeCredentialsInTransaction).toHaveBeenCalledOnce();
      expect(db.appSetting.findMany).not.toHaveBeenCalled();
      expect(locks.appSetting.findMany).not.toHaveBeenCalled();
    },
  );

  it("returns the durable request unchanged on admin/retry without resetting cleanup progress", async () => {
    const requestedAt = new Date("2026-11-27T20:00:00Z");
    tx.user.findUniqueOrThrow.mockResolvedValue({
      deletionRequestedAt: requestedAt,
      deletionState: "cleaning",
    } as never);
    await expect(requestAccountDeletion("u1", admin)).resolves.toEqual({
      status: "pending",
      requestedAt,
      phase: "cleaning",
      complete: false,
    });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(revokeCredentialsInTransaction).not.toHaveBeenCalled();
  });

  it("requires every self-admin to transfer authority, even when another admin exists", async () => {
    tx.user.findUnique.mockResolvedValue({
      id: "u1",
      role: "user, Admin",
      emailVerified: true,
      banned: false,
      banExpires: null,
    } as never);
    tx.$queryRaw.mockResolvedValue([{ count: 2 }]);
    await expect(
      requestAccountDeletion("u1", { kind: "self", sessionId: "s1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { reason: "ADMIN_TRANSFER_REQUIRED" } });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("preserves the last-active-admin guard on admin deletion", async () => {
    tx.user.findUnique.mockResolvedValue({
      id: "u1",
      role: "admin",
      emailVerified: true,
      banned: false,
      banExpires: null,
    } as never);
    tx.$queryRaw.mockResolvedValue([{ count: 1 }]);
    await expect(requestAccountDeletion("u1", admin)).rejects.toMatchObject({
      data: { reason: "LAST_ACTIVE_ADMIN" },
    });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("does not report acceptance if credential fencing fails", async () => {
    vi.mocked(revokeCredentialsInTransaction).mockRejectedValueOnce(new Error("fence unavailable"));
    await expect(requestAccountDeletion("u1", admin)).rejects.toMatchObject({
      message: "fence unavailable",
    });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    // Real rollback/idempotency is exercised by the disposable PG integration.
  });
});

describe("active-worker serialization retry", () => {
  it("retries a fresh Serializable authority/effect snapshot without releasing the outer locks", async () => {
    let conflicts = 1;
    db.$transaction.mockImplementation(async (run, options) => {
      if (typeof run !== "function") throw new Error("Expected interactive transaction");
      if (options?.isolationLevel === "Serializable" && conflicts-- > 0) {
        await run(tx);
        throw Object.assign(new Error("worker wrote after snapshot"), { code: "P2034" });
      }
      return run(options?.isolationLevel === "ReadCommitted" ? locks : tx);
    });
    await expect(requestAccountDeletion("u1", admin)).resolves.toMatchObject({
      status: "pending",
      complete: false,
    });
    expect(db.$transaction.mock.calls.map(([, options]) => options?.isolationLevel)).toEqual([
      "ReadCommitted",
      "Serializable",
      "Serializable",
    ]);
    // Each attempt rechecks the live actor; only the outer scope takes the four locks.
    expect(tx.session.findFirst).toHaveBeenCalledTimes(2);
    expect(locks.$queryRaw).toHaveBeenCalledTimes(1);
    expect(
      locks.$executeRaw.mock.calls.filter(([, key]) => key === "password-write:u1"),
    ).toHaveLength(1);
    const { lockCliCredentials } = await import("@cockpit-chess/auth/device-redemption-lock");
    const { lockSetPasswordLinks } = await import("@cockpit-chess/auth/set-password-link-lock");
    expect(lockCliCredentials).toHaveBeenCalledOnce();
    expect(lockSetPasswordLinks).toHaveBeenCalledOnce();
  });

  it("bounds serialization retries to three attempts and preserves the conflict refusal", async () => {
    db.$transaction.mockImplementation(async (run, options) => {
      if (typeof run !== "function") throw new Error("Expected interactive transaction");
      if (options?.isolationLevel === "Serializable")
        throw Object.assign(new Error("concurrent worker"), { code: "P2034" });
      return run(options?.isolationLevel === "ReadCommitted" ? locks : tx);
    });
    await expect(requestAccountDeletion("u1", admin)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "USER_CHANGE_CONFLICT" },
    });
    expect(db.$transaction).toHaveBeenCalledTimes(4);
  });

  it("never retries stale authentication", async () => {
    tx.session.findFirst.mockResolvedValue(null);
    await expect(
      requestAccountDeletion("u1", { kind: "self", sessionId: "stale" }),
    ).rejects.toMatchObject({
      data: { reason: "REAUTH_REQUIRED" },
    });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
  it("revalidates actor authority after rollback rather than replaying an old authorization", async () => {
    let attempts = 0;
    db.$transaction.mockImplementation(async (run, options) => {
      if (typeof run !== "function") throw new Error("Expected interactive transaction");
      if (options?.isolationLevel === "Serializable" && attempts++ === 0) {
        await run(tx);
        tx.session.findFirst.mockResolvedValue(null);
        throw Object.assign(new Error("worker write"), { code: "P2034" });
      }
      return run(options?.isolationLevel === "ReadCommitted" ? locks : tx);
    });
    await expect(requestAccountDeletion("u1", admin)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tx.session.findFirst).toHaveBeenCalledTimes(2);
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });

  it("keeps the original time budget across retries", async () => {
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(0);
    db.$transaction.mockImplementation(async (run, options) => {
      if (typeof run !== "function") throw new Error("Expected interactive transaction");
      if (options?.isolationLevel === "Serializable") {
        clock.mockReturnValue(25_001);
        throw Object.assign(new Error("worker write"), { code: "P2034" });
      }
      return run(options?.isolationLevel === "ReadCommitted" ? locks : tx);
    });
    try {
      await expect(requestAccountDeletion("u1", admin)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
      expect(db.$transaction).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
});
