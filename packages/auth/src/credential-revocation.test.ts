import { beforeEach, describe, expect, it, vi } from "vitest";

// Never a real DB. Each write returns a tag (not a promise) so the transaction
// assertions can see exactly which statements were batched together.
const db = vi.hoisted(() => ({
  apiKey: { deleteMany: vi.fn() },
  session: { deleteMany: vi.fn() },
  deviceCode: { deleteMany: vi.fn() },
  user: { updateMany: vi.fn() },
  account: { updateMany: vi.fn() },
  verification: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
}));
vi.mock("@cockpit-chess/db", () => ({ default: db }));
// Pool of 3 → two CLI-credential lock slots.
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));

const {
  passwordChangeRevocationTarget,
  quarantineUntrustedPasswordWrite,
  REVOCATION_ATTEMPTS,
  revokeCredentialsAfterPasswordChange,
  revokeCredentialsAfterPasswordReset,
} = await import("./credential-revocation");
const { cliCredentialLockKey } = await import("./device-redemption-lock");
const { setPasswordLinkLockKey } = await import("./set-password-link-lock");

beforeEach(() => {
  vi.clearAllMocks();
  db.apiKey.deleteMany.mockReturnValue("apiKey.deleteMany");
  db.session.deleteMany.mockReturnValue("session.deleteMany");
  db.deviceCode.deleteMany.mockReturnValue("deviceCode.deleteMany");
  db.user.updateMany.mockReturnValue("user.updateMany");
  db.account.updateMany.mockReturnValue("account.updateMany");
  db.verification.deleteMany.mockReturnValue("verification.deleteMany");
  db.$executeRaw.mockImplementation((_strings: TemplateStringsArray, key: string) =>
    key.startsWith("set-password-link:") ? "setPasswordLinkLock" : "advisoryLock",
  );
  db.$transaction.mockResolvedValue([]);
});

describe("CLI credential revocation writes", () => {
  it("scopes every delete to the one user", async () => {
    await revokeCredentialsAfterPasswordChange({ userId: "u1", keepSessionToken: "new-token" });
    expect(db.apiKey.deleteMany).toHaveBeenCalledWith({ where: { referenceId: "u1" } });
    // Only device-flow sessions: browser sessions are Better-Auth's to manage.
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", origin: "device-flow" },
    });
    expect(db.deviceCode.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });
});

describe("CLI credential lock", () => {
  it("opens every revocation batch with the per-user lock a device-flow redemption holds", async () => {
    await revokeCredentialsAfterPasswordReset("u1");
    const [strings, key] = db.$executeRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(strings.join("?")).toBe("SELECT pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe(cliCredentialLockKey("u1"));
    expect(vi.mocked(db.$transaction).mock.calls[0]?.[0][0]).toBe("advisoryLock");
  });
});

describe("revokeCredentialsAfterPasswordReset", () => {
  it("revokes API keys, every session, device codes, two-factor challenges and other reset links in one transaction, and never verifies the email", async () => {
    await revokeCredentialsAfterPasswordReset("u1");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith([
      "advisoryLock",
      "apiKey.deleteMany",
      "session.deleteMany",
      "deviceCode.deleteMany",
      "session.deleteMany",
      "verification.deleteMany",
      "setPasswordLinkLock",
      "verification.deleteMany",
    ]);
    // Every session again, after Better-Auth wrote the new hash: a sign-in
    // that verified the old one may have inserted its session in between.
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    // Pending two-factor sign-in challenges and their credential fence rows.
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: { value: "u1", identifier: { startsWith: "2fa-" } },
    });
    // The lock an invite resend holds while it mints a link, then every
    // remaining reset link of this user (packages/api set-password-link.ts).
    expect(db.$executeRaw.mock.calls[1]?.[1]).toBe(setPasswordLinkLockKey("u1"));
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: { value: "u1", identifier: { startsWith: "reset-password:" } },
    });
    // A reset alone proves nothing about the mailbox: an invite link may have
    // been shown to the admin. Only a mailed link verifies, in the
    // /reset-password after-hook (password-reset-links.ts).
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  // Better-Auth has already committed the password and consumed the token when
  // this runs, so a single blip must not leave the user's keys live.
  it("retries a failed transaction with a short backoff, rebuilding the batch", async () => {
    const sleeps: number[] = [];
    db.$transaction
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce([]);
    await revokeCredentialsAfterPasswordReset("u1", {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 400]);
    // Each attempt gets fresh write promises, and still deletes the reset
    // links under the set-password-link lock.
    expect(db.apiKey.deleteMany).toHaveBeenCalledTimes(3);
    expect(
      db.verification.deleteMany.mock.calls.filter(
        ([args]) => args?.where?.identifier?.startsWith === "reset-password:",
      ),
    ).toHaveLength(3);
    for (const call of db.$transaction.mock.calls) {
      expect(call[0]).toContain("setPasswordLinkLock");
      expect(call[0]).toContain("verification.deleteMany");
    }
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("logs loudly with only the user id and rethrows after the last attempt", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    db.$transaction.mockRejectedValue(new Error("db down"));
    await expect(
      revokeCredentialsAfterPasswordReset("u1", { sleep: async () => {} }),
    ).rejects.toThrow("db down");
    expect(db.$transaction).toHaveBeenCalledTimes(REVOCATION_ATTEMPTS);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [message, details] = errorLog.mock.calls[0] ?? [];
    expect(message).toMatch(/SECURITY: password-reset credential revocation failed/);
    expect(details).toEqual({ userId: "u1", error: "Error: db down" });
    errorLog.mockRestore();
  });
});

describe("revokeCredentialsAfterPasswordChange", () => {
  it("revokes CLI credentials and every other session without touching email verification", async () => {
    await revokeCredentialsAfterPasswordChange({ userId: "u1", keepSessionToken: "new-token" });
    expect(db.$transaction).toHaveBeenCalledWith([
      "advisoryLock",
      "apiKey.deleteMany",
      "session.deleteMany",
      "deviceCode.deleteMany",
      "session.deleteMany",
    ]);
    // The session the change issued to the device that made it stays.
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", token: { not: "new-token" } },
    });
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("retries the same way after a committed password change", async () => {
    const target = { userId: "u1", keepSessionToken: "new-token" };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    db.$transaction.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce([]);
    await revokeCredentialsAfterPasswordChange(target, { sleep: async () => {} });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(errorLog).not.toHaveBeenCalled();

    db.$transaction.mockReset();
    db.$transaction.mockRejectedValue(new Error("db down"));
    await expect(
      revokeCredentialsAfterPasswordChange(target, { sleep: async () => {} }),
    ).rejects.toThrow("db down");
    expect(errorLog.mock.calls[0]?.[0]).toMatch(/password-change credential revocation failed/);
    errorLog.mockRestore();
  });
});

describe("passwordChangeRevocationTarget", () => {
  const success = { token: "t", user: { id: "u1" } };

  it("targets the user of a successful change that signed out other sessions, keeping its new session", () => {
    expect(
      passwordChangeRevocationTarget({
        path: "/change-password",
        body: { revokeOtherSessions: true },
        returned: success,
      }),
    ).toEqual({ userId: "u1", keepSessionToken: "t" });
    // No new session token: nothing to keep, so nothing is revoked.
    expect(
      passwordChangeRevocationTarget({
        path: "/change-password",
        body: { revokeOtherSessions: true },
        returned: { token: null, user: { id: "u1" } },
      }),
    ).toBeNull();
  });

  it("ignores a change that kept other sessions", () => {
    expect(
      passwordChangeRevocationTarget({
        path: "/change-password",
        body: { revokeOtherSessions: false },
        returned: success,
      }),
    ).toBeNull();
    expect(
      passwordChangeRevocationTarget({ path: "/change-password", body: {}, returned: success }),
    ).toBeNull();
  });

  it("ignores a rejected change (the result is an error, not a user)", () => {
    expect(
      passwordChangeRevocationTarget({
        path: "/change-password",
        body: { revokeOtherSessions: true },
        returned: Object.assign(new Error("INVALID_PASSWORD"), { status: "BAD_REQUEST" }),
      }),
    ).toBeNull();
  });

  it("ignores every other endpoint", () => {
    expect(
      passwordChangeRevocationTarget({
        path: "/sign-in/email",
        body: { revokeOtherSessions: true },
        returned: success,
      }),
    ).toBeNull();
  });
});

describe("untrusted password write quarantine", () => {
  it("scrambles the credential with the app's own hash (the pepper's sealed format)", async () => {
    const hash = vi.fn(async (password: string) => `pw1:test:${password.length}`);
    await quarantineUntrustedPasswordWrite("u1", { hash, sleep: async () => {} });
    expect(hash).toHaveBeenCalledTimes(1);
    // A fresh random secret nobody knows (32 bytes, base64url).
    expect(hash.mock.calls[0]?.[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.account.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", providerId: "credential" },
      data: { password: "pw1:test:43" },
    });
  });
});
