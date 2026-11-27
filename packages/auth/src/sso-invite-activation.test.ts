import type { Prisma } from "@cockpit-chess/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const revoke = vi.hoisted(() => vi.fn());
vi.mock("./credential-revocation.js", () => ({ revokeCredentialsInTransaction: revoke }));
vi.mock("@cockpit-chess/db", () => ({ default: {} }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
const { clearPendingInvitePassword } = await import("./sso-invite-activation");
const tx = {
  user: { findUnique: vi.fn() },
  account: { updateMany: vi.fn() },
};
const pending = () => ({
  emailVerified: false,
  accounts: [{ providerId: "credential" }],
  sessions: [] as { id: string }[],
});
const clear = () =>
  clearPendingInvitePassword(tx as unknown as Prisma.TransactionClient, "invitee");

beforeEach(() => {
  vi.resetAllMocks();
  tx.user.findUnique.mockResolvedValue(pending());
  tx.account.updateMany.mockResolvedValue({ count: 1 });
});

describe("pending authorized IdP activation", () => {
  it("clears the credential before revoking access on the supplied transaction", async () => {
    expect(await clear()).toBe(true);
    expect(tx.account.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "invitee", providerId: "credential" },
      data: { password: null },
    });
    expect(revoke).toHaveBeenCalledExactlyOnceWith(tx, "invitee");
    expect(tx.account.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      revoke.mock.invocationCallOrder[0]!,
    );
    expect(tx.user.findUnique.mock.calls[0]?.[0].select.accounts.take).toBe(2);
    expect(tx.user.findUnique.mock.calls[0]?.[0].select.sessions.take).toBe(1);
  });

  it.each([
    { label: "missing", state: null },
    { label: "verified", state: { ...pending(), emailVerified: true } },
    { label: "fresh OAuth without a credential", state: { ...pending(), accounts: [] } },
    { label: "existing SSO", state: { ...pending(), accounts: [{ providerId: "sso" }] } },
    {
      label: "two credential rows",
      state: {
        ...pending(),
        accounts: [{ providerId: "credential" }, { providerId: "credential" }],
      },
    },
    {
      label: "linked SSO",
      state: { ...pending(), accounts: [{ providerId: "credential" }, { providerId: "sso" }] },
    },
    { label: "live session", state: { ...pending(), sessions: [{ id: "live" }] } },
  ])("preserves $label", async ({ state }) => {
    tx.user.findUnique.mockResolvedValue(state);
    expect(await clear()).toBe(false);
    expect(tx.account.updateMany).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("propagates clearing/revocation failures so the caller can roll back the IdP insert", async () => {
    revoke.mockRejectedValueOnce(new Error("revocation unavailable"));
    await expect(clear()).rejects.toThrow("revocation unavailable");
  });
});
