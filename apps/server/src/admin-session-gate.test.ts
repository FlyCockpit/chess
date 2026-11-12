import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, isTwoFactorPolicySatisfied } = vi.hoisted(() => ({
  getSession: vi.fn(),
  isTwoFactorPolicySatisfied: vi.fn(),
}));
vi.mock("@cockpit-chess/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@cockpit-chess/api/lib/two-factor-policy", () => ({ isTwoFactorPolicySatisfied }));

import { requireVerifiedAdminSession } from "./admin-session-gate";

beforeEach(() => {
  vi.clearAllMocks();
  isTwoFactorPolicySatisfied.mockResolvedValue(true);
});

describe("requireVerifiedAdminSession ban admission", () => {
  it.each([
    ["permanent", null],
    ["temporary", new Date(Date.now() + 60_000)],
    ["cached temporary", new Date(Date.now() + 60_000).toISOString()],
  ])("rejects an active %s ban before checking 2FA", async (_name, banExpires) => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, banned: true, banExpires },
    });

    await expect(requireVerifiedAdminSession(new Headers())).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: "access_denied",
    });
    expect(isTwoFactorPolicySatisfied).not.toHaveBeenCalled();
  });

  it.each([
    ["database", new Date(Date.now() - 60_000)],
    ["cookie cache", new Date(Date.now() - 60_000).toISOString()],
  ])("admits a %s session after a temporary ban expires", async (_name, banExpires) => {
    const session = {
      user: { id: "a1", role: "admin", emailVerified: true, banned: true, banExpires },
    };
    getSession.mockResolvedValue(session);

    await expect(requireVerifiedAdminSession(new Headers())).resolves.toEqual({
      ok: true,
      session,
    });
    expect(isTwoFactorPolicySatisfied).toHaveBeenCalledWith(session.user);
  });
});
