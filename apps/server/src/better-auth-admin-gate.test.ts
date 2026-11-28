import { type Context, Hono } from "hono";
import { generateSignedCookie } from "hono/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const cookieSecret = "disposable-impersonation-unit-secret";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep<typeof import("@cockpit-chess/db").default>();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

vi.mock("@cockpit-chess/auth", () => ({
  auth: {
    $context: Promise.resolve({
      secret: "disposable-impersonation-unit-secret",
      createAuthCookie: () => ({ name: "better-auth.admin_session" }),
      authCookies: { sessionToken: { name: "better-auth.session_token", attributes: {} } },
    }),
    api: {
      get getSession() {
        return getSession;
      },
    },
  },
}));

const { default: prisma } = await import("@cockpit-chess/db");
const { invalidateForceTwoFactorSettingsCache } = await import(
  "@cockpit-chess/api/lib/two-factor-policy"
);
const { betterAuthAdminGate } = await import("./better-auth-admin-gate");

const db = prisma as unknown as {
  appSetting: { findMany: ReturnType<typeof vi.fn> };
  session: { findFirst: ReturnType<typeof vi.fn> };
};

describe("betterAuthAdminGate", () => {
  let app: Hono;
  const downstream = vi.fn((c: Context) => c.json({ ok: true }));

  beforeEach(() => {
    getSession.mockReset();
    db.session.findFirst.mockReset();
    db.appSetting.findMany.mockResolvedValue([]);
    // Force-2FA settings are TTL-cached in-process; reset between tests.
    invalidateForceTwoFactorSettingsCache();
    downstream.mockClear();
    app = new Hono();
    app.use("/api/auth/admin/*", betterAuthAdminGate);
    app.all("/api/auth/admin/list-users", downstream);
    app.all("/api/auth/admin/impersonate-user", downstream);
    app.all("/api/auth/admin/*", downstream);
  });

  it("rejects unauthenticated callers with 401", async () => {
    getSession.mockResolvedValue(null);
    const res = await app.request("/api/auth/admin/list-users", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthorized",
      error_description: "Authentication required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers before Better-Auth handles the route", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", role: "user", emailVerified: true } });
    const res = await app.request("/api/auth/admin/impersonate-user", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "access_denied",
      error_description: "Verified admin access required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects unverified admins", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: false, twoFactorEnabled: true },
    });
    const res = await app.request("/api/auth/admin/list-users", { method: "POST" });
    expect(res.status).toBe(403);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects admins without 2FA when admin 2FA is required", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faInternalUsers", value: "true" }]);
    const res = await app.request("/api/auth/admin/set-user-password", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "access_denied",
      error_description: "Two-factor authentication setup is required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  // Forced admin 2FA is the absent-row default, so an established admin who
  // never enrolled is refused without anyone having written the setting.
  it("rejects an established admin without 2FA when the setting row is absent", async () => {
    getSession.mockResolvedValue({
      user: {
        id: "a1",
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date("2025-01-01"),
      },
    });
    const res = await app.request("/api/auth/admin/list-users", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "access_denied",
      error_description: "Two-factor authentication setup is required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  // The gate must forward `createdAt` to the policy, or the first admin to
  // sign up is locked out before they can reach the enrollment screen.
  it("admits a brand-new admin without 2FA while the enrollment grace window is open", async () => {
    getSession.mockResolvedValue({
      user: {
        id: "a1",
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const res = await app.request("/api/auth/admin/impersonate-user", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("admits verified admins when admin 2FA is explicitly not required", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faInternalUsers", value: "false" }]);
    const res = await app.request("/api/auth/admin/impersonate-user", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("admits verified admins with 2FA when admin 2FA is required", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: true },
    });
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faInternalUsers", value: "true" }]);
    const res = await app.request("/api/auth/admin/impersonate-user", { method: "POST" });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["set-role", { userId: "target", role: "user" }, "users.setRole"],
    ["set-role/", { userId: "target", role: "admin" }, "users.setRole"],
    ["update-user", { userId: "target", data: { role: "user" } }, "users.setRole"],
    ["update-user/", { userId: "target", data: { role: ["admin"] } }, "users.setRole"],
    ["update-user", { userId: "target", data: { banned: true } }, "users.archive"],
    ["update-user", { userId: "target", data: { emailVerified: false } }, "users"],
    ["ban-user", { userId: "target" }, "users.archive"],
    ["ban-user/", { userId: "target" }, "users.archive"],
    ["remove-user", { userId: "target" }, "users.remove"],
    ["remove-user/", { userId: "target" }, "users.remove"],
  ])("blocks parallel writes through %s (%j)", async (path, body, procedure) => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: true },
    });
    const res = await app.request(`/api/auth/admin/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "USE_ORPC_USER_MANAGEMENT",
      error_description: expect.stringContaining(procedure),
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("forwards ordinary update-user bodies intact", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: true },
    });
    const body = { userId: "target", data: { name: "New name" } };
    app = new Hono();
    app.use("/api/auth/admin/*", betterAuthAdminGate);
    app.post("/api/auth/admin/update-user", async (c) => c.json(await c.req.json()));
    const res = await app.request("/api/auth/admin/update-user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
  });

  describe("return from impersonation", () => {
    const actor = () => ({
      user: { id: "admin", role: "admin", emailVerified: true, twoFactorEnabled: true },
      session: { id: "original", origin: "sign-in", impersonatedBy: null },
    });
    const target = () => ({
      user: { id: "ordinary", role: "user", emailVerified: false },
      session: { id: "impersonation", impersonatedBy: "admin", authenticatedAt: null },
    });
    const stop = async (path = "stop-impersonating", saved = "original-token:") =>
      app.request(`/api/auth/admin/${path}`, {
        method: "POST",
        headers: {
          cookie: await generateSignedCookie("better-auth.admin_session", saved, cookieSecret),
          authorization: "Bearer must-not-authorize",
        },
      });

    it("admits only the saved verified admin and strips bearer lookup credentials", async () => {
      getSession.mockResolvedValueOnce(target());
      db.session.findFirst.mockResolvedValueOnce(actor());
      expect((await stop()).status).toBe(200);
      expect(downstream).toHaveBeenCalledTimes(1);
      for (const [options] of getSession.mock.calls) {
        expect(options.headers.has("authorization")).toBe(false);
      }
      expect(db.session.findFirst).toHaveBeenCalledWith({
        where: {
          token: "original-token",
          userId: "admin",
          impersonatedBy: null,
          origin: "sign-in",
          expiresAt: { gt: expect.any(Date) },
        },
        select: { user: { select: expect.objectContaining({ deletionRequestedAt: true }) } },
      });
    });

    it.each([{ banned: true }, { deletionRequestedAt: new Date() }])(
      "a target's lifecycle cannot block returning: %j",
      async (lifecycle) => {
        const impersonated = target();
        getSession.mockResolvedValueOnce({
          ...impersonated,
          user: { ...impersonated.user, ...lifecycle },
        });
        db.session.findFirst.mockResolvedValueOnce(actor());
        expect((await stop()).status).toBe(200);
      },
    );

    it.each([
      { role: "user" },
      { emailVerified: false },
      { twoFactorEnabled: false },
      { banned: true },
      { deletionRequestedAt: new Date() },
    ])("checks the actor's current authority: %j", async (change) => {
      const admin = actor();
      getSession.mockResolvedValueOnce(target());
      db.session.findFirst.mockResolvedValueOnce({ ...admin, user: { ...admin.user, ...change } });
      expect((await stop()).status).toBe(403);
      expect(downstream).not.toHaveBeenCalled();
    });

    it("refuses when no live saved browser session is bound to the actor", async () => {
      getSession.mockResolvedValueOnce(target());
      db.session.findFirst.mockResolvedValueOnce(null);
      expect((await stop()).status).toBe(401);
      expect(downstream).not.toHaveBeenCalled();
    });

    it.each([
      ["POST", "stop-impersonating/"],
      ["GET", "stop-impersonating"],
      ["POST", "stop-impersonating-extra"],
    ])("keeps %s %s on the active-user gate", async (method, path) => {
      getSession.mockResolvedValueOnce(target());
      const response = await app.request(`/api/auth/admin/${path}`, { method });
      expect(response.status).toBe(403);
      expect(db.session.findFirst).not.toHaveBeenCalled();
      expect(downstream).not.toHaveBeenCalled();
    });

    it.each([null, { user: { id: "admin" }, session: { impersonatedBy: null } }])(
      "requires a live impersonated session: %j",
      async (impersonated) => {
        getSession.mockResolvedValueOnce(impersonated);
        expect((await stop()).status).toBe(401);
        expect(getSession).toHaveBeenCalledTimes(1);
        expect(downstream).not.toHaveBeenCalled();
      },
    );

    it.each(["", "better-auth.admin_session=unsigned", "better-auth.admin_session=bad.signature"])(
      "refuses a missing or invalid signed restoration cookie",
      async (cookie) => {
        getSession.mockResolvedValueOnce(target());
        const response = await app.request("/api/auth/admin/stop-impersonating", {
          method: "POST",
          headers: { cookie },
        });
        expect(response.status).toBe(401);
        expect(getSession).toHaveBeenCalledTimes(1);
        expect(downstream).not.toHaveBeenCalled();
      },
    );

    it("does not confer actor authority on another management endpoint", async () => {
      getSession.mockResolvedValue(target());
      expect((await stop("list-users")).status).toBe(403);
      expect(downstream).not.toHaveBeenCalled();
    });

    it.each(["duplicate", "malformed-quoted-duplicate", "quoted"])(
      "rejects ambiguous saved cookie inputs: %s",
      async (kind) => {
        const signed = await generateSignedCookie(
          "better-auth.admin_session",
          "original-token:",
          cookieSecret,
        );
        const cookie =
          kind === "duplicate"
            ? `${signed}; ${signed}`
            : kind === "malformed-quoted-duplicate"
              ? signed.replace("=", '="') + `X; ${signed}`
              : signed.replace("=", '="') + '"';
        getSession.mockResolvedValueOnce(target());
        const response = await app.request("/api/auth/admin/stop-impersonating", {
          method: "POST",
          headers: { cookie },
        });
        expect(response.status).toBe(401);
        expect(db.session.findFirst).not.toHaveBeenCalled();
        expect(downstream).not.toHaveBeenCalled();
      },
    );

    it("fails closed when the session lookup fails", async () => {
      getSession.mockRejectedValue(new Error("database unavailable"));
      expect((await stop()).status).toBe(401);
      expect(downstream).not.toHaveBeenCalled();
    });
  });
});
