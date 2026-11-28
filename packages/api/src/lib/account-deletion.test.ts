import type { Prisma } from "@cockpit-chess/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { Prisma: { DbNull: Symbol("DbNull") }, default: mockDeep() };
});
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
const tx = mockDeep<Prisma.TransactionClient>();
const timeline: string[] = [];
const admin = { kind: "admin", userId: "admin", sessionId: "admin-session" } as const;
const db = vi.mocked(prisma);

beforeEach(() => {
  mockReset(tx);
  vi.mocked(revokeCredentialsInTransaction).mockReset();
  vi.clearAllMocks();
  timeline.length = 0;
  tx.chessMatch.updateMany.mockImplementation(async () => {
    timeline.push("settle");
    return { count: 0 };
  });
  vi.mocked(revokeCredentialsInTransaction).mockImplementation(async () => {
    timeline.push("revoke");
  });
  db.$transaction.mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected interactive transaction");
    return run(tx);
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
  it("commits a pending access fence with deletion settlement before revocation and no physical delete", async () => {
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
    expect(tx.chessMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: "u1", status: { in: ["queued", "running"] } },
        data: expect.objectContaining({
          terminalCause: "owner-delete",
          turnType: "idle",
          runToken: null,
        }),
      }),
    );
    expect(timeline).toEqual(["settle", "revoke"]);
    expect(revokeCredentialsInTransaction).toHaveBeenCalledWith(tx, "u1");
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
    // Real rollback/idempotency is exercised by the disposable PG integration.
  });
});
