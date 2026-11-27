import type { Session } from "@cockpit-chess/auth";
import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import { usersRouter } from "./users";

// Mock @cockpit-chess/db before importing the module so the router pulls the deep-
// mocked Prisma client.
vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

vi.mock("@cockpit-chess/env/server", () => ({
  env: { BETTER_AUTH_URL: "http://localhost:3000" },
  ADMIN_EMAILS: new Set<string>(),
}));

// Mock @cockpit-chess/auth so the router's `auth.api.createUser` call hits a stub
// instead of pulling in the real better-auth (which needs an env, prisma, etc).
vi.mock("@cockpit-chess/auth", () => ({
  auth: {
    api: {
      createUser: vi.fn(),
    },
  },
}));

// The real grant runs (so the stubbed createUser still executes inside it); the
// spy lets a test read the grant's mode and locale.
vi.mock("@cockpit-chess/auth/user-creation-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cockpit-chess/auth/user-creation-policy")>();
  return { ...actual, runWithAllowedUserCreation: vi.fn(actual.runWithAllowedUserCreation) };
});

// Mock @cockpit-chess/mailer so invites don't try to open SMTP. Tests assert on the
// call shape via the mock instead. `renderInviteUser` is stubbed to return a
// stable subject/html so the router can pass them straight through to
// `sendEmail` — the actual rendering is tested in the mailer package.
const mailer = vi.hoisted(() => ({ configured: true }));
vi.mock("@cockpit-chess/mailer", () => ({
  sendEmail: vi.fn(),
  isEmailConfigured: () => mailer.configured,
  renderInviteUser: vi.fn(() => ({
    subject: "You've been invited",
    html: "<html><body>invite</body></html>",
  })),
}));

// The set-password link machinery has its own tests; here it is a stub whose
// output the router must route to the email or to the admin, never both.
const SET_PASSWORD_URL = "https://api.example.com/api/auth/reset-password/tok?callbackURL=x";
const LINK_EXPIRES_AT = new Date("2026-11-11T00:00:00Z");
const createSetPasswordLink = vi.hoisted(() => vi.fn());
vi.mock("../lib/set-password-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/set-password-link")>()),
  createSetPasswordLink,
}));
const { SetPasswordLinkRefusedError } = await import("../lib/set-password-link");

// Capture how each budget is declared and which key it is charged against,
// and let a test make the next consume throw (`createProcedureBudget` has its
// own tests).
const budget = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  charges: [] as Array<{ prefix: unknown; key: string }>,
  errorQueue: [] as unknown[],
}));
vi.mock("../lib/procedure-budget", () => ({
  createProcedureBudget: (options: Record<string, unknown>) => {
    budget.options.push(options);
    return async (key: string) => {
      budget.charges.push({ prefix: options.keyPrefix, key });
      const error = budget.errorQueue.shift();
      if (error) throw error;
    };
  },
}));

const { default: prisma } = await import("@cockpit-chess/db");
const { auth } = await import("@cockpit-chess/auth");
const { renderInviteUser, sendEmail } = await import("@cockpit-chess/mailer");
const { runWithAllowedUserCreation } = await import("@cockpit-chess/auth/user-creation-policy");

const db = prisma as unknown as {
  user: {
    findUnique: MockInstance;
    findMany: MockInstance;
    count: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  session: { deleteMany: MockInstance };
  $transaction: MockInstance;
};

const authApi = auth as unknown as {
  api: { createUser: MockInstance };
};
const sendEmailMock = sendEmail as unknown as MockInstance;

function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null, clientIp: undefined };
  return {
    clientIp: undefined,
    session: {
      user: {
        id: "admin-user-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role: "admin",
        // Forced admin 2FA is the shipped default (FORCE_2FA_DEFAULTS), so an
        // unenrolled admin would 404 here before the router ever ran.
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.user,
      },
      session: {
        id: "test-session-id",
        userId: sessionOverride?.user?.id ?? "admin-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

describe("usersRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    budget.charges.length = 0;
    budget.errorQueue.length = 0;
    mailer.configured = true;
    createSetPasswordLink.mockResolvedValue({
      url: SET_PASSWORD_URL,
      expiresAt: LINK_EXPIRES_AT,
    });
  });

  describe("auth gates", () => {
    it("list throws NOT_FOUND when no session", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext(null) });
      await expect(client.list()).rejects.toSatisfy((e: ORPCError<string, unknown>) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("list throws NOT_FOUND for non-admin role", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(client.list()).rejects.toSatisfy((e: ORPCError<string, unknown>) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("invite throws NOT_FOUND for non-admin role", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(
        client.invite({ email: "x@example.com", name: "X", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError<string, unknown>) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
      expect(authApi.api.createUser).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("returns users + nextCursor without a search filter", async () => {
      db.user.findMany.mockResolvedValue([
        {
          id: "1",
          email: "a@x.com",
          name: "A",
          role: "user",
          createdAt: new Date("2025-01-01"),
          accounts: [],
          sessions: [],
        },
      ]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list();

      expect(res.users).toHaveLength(1);
      expect(res.nextCursor).toBeNull();
      // No cursor on the first page: the filter stands alone in the AND.
      expect(db.user.findMany.mock.calls[0]?.[0].where).toEqual({ AND: [{}] });
      // Never a per-page count — the UI is an infinite list.
      expect(db.user.count).not.toHaveBeenCalled();
    });

    // `emailVerified: false` alone is not "invite pending": an active SSO user
    // can be unverified (genericOAuth copies the IdP's email_verified ?? false).
    it("computes invitePending server-side and never returns the account/session probes", async () => {
      const base = {
        email: "x@x.com",
        name: "X",
        role: "user",
        emailVerified: false,
        createdAt: new Date("2025-01-01"),
      };
      const credential = { providerId: "credential" };
      db.user.findMany.mockResolvedValue([
        { ...base, id: "pending", accounts: [credential], sessions: [] },
        { ...base, id: "verified", emailVerified: true, accounts: [credential], sessions: [] },
        { ...base, id: "sso", accounts: [{ providerId: "oidc" }], sessions: [] },
        { ...base, id: "linked", accounts: [credential, { providerId: "oidc" }], sessions: [] },
        { ...base, id: "signed-in", accounts: [credential], sessions: [{ id: "s1" }] },
        { ...base, id: "no-account", accounts: [], sessions: [] },
      ]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list();

      expect(Object.fromEntries(res.users.map((u) => [u.id, u.invitePending]))).toEqual({
        pending: true,
        verified: false,
        sso: false,
        linked: false,
        "signed-in": false,
        "no-account": false,
      });
      for (const user of res.users) {
        expect(user).not.toHaveProperty("accounts");
        expect(user).not.toHaveProperty("sessions");
      }
      // The probes are bounded and only count live sessions.
      const select = db.user.findMany.mock.calls[0]?.[0].select;
      expect(select.accounts).toEqual({ select: { providerId: true }, take: 2 });
      expect(select.sessions).toMatchObject({
        where: { expiresAt: { gt: expect.any(Date) } },
        select: { id: true },
        take: 1,
      });
    });

    it("takes limit + 1 to detect hasMore and mints a cursor for a full page", async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({
        id: `u-${i}`,
        email: `u${i}@x.com`,
        name: `U ${i}`,
        role: "user",
        createdAt: new Date("2025-01-01"),
        accounts: [],
        sessions: [],
      }));
      db.user.findMany.mockResolvedValue(rows);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list({ limit: 10 });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.take).toBe(11);
      expect(call.skip).toBeUndefined();
      expect(res.users).toHaveLength(10);
      expect(res.nextCursor).toEqual(expect.any(String));
    });

    it("applies a case-insensitive OR search across name and email", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ search: "alice", limit: 10 });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({
        AND: [
          {
            OR: [
              { email: { contains: "alice", mode: "insensitive" } },
              { name: { contains: "alice", mode: "insensitive" } },
            ],
          },
        ],
      });
      expect(call.take).toBe(11);
      expect(call.skip).toBeUndefined();
    });

    it("rejects a malformed cursor", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.list({ cursor: "not-a-cursor" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(db.user.findMany).not.toHaveBeenCalled();
    });

    it("filters archived users in the database (banned=true)", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "archived" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({ AND: [{ banned: true }] });
    });

    it("treats active as not-banned, including NULL banned", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "active" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({ AND: [{ OR: [{ banned: false }, { banned: null }] }] });
    });

    it("combines status and search with AND", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "archived", search: "alice" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({
        AND: [
          {
            AND: [
              { banned: true },
              {
                OR: [
                  { email: { contains: "alice", mode: "insensitive" } },
                  { name: { contains: "alice", mode: "insensitive" } },
                ],
              },
            ],
          },
        ],
      });
    });
  });

  describe("invite", () => {
    it("creates the user with an unusable password and emails a set-password link", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "NEW@example.com",
        name: "New User",
        role: "user",
        locale: "es-MX",
      });

      // Nothing secret comes back when the email went out.
      expect(res).toEqual({ userId: "new-user-id", emailSent: true });
      // Email should be lowercased by the input zod schema.
      const body = authApi.api.createUser.mock.calls[0]?.[0].body;
      expect(body).toMatchObject({ email: "new@example.com", name: "New User", role: "user" });
      expect(body.password).toEqual(expect.any(String));
      expect(body.password.length).toBeGreaterThanOrEqual(64);
      expect(createSetPasswordLink).toHaveBeenCalledWith({
        userId: "new-user-id",
        locale: "es-MX",
      });
      expect(renderInviteUser).toHaveBeenCalledWith({
        name: "New User",
        email: "new@example.com",
        setPasswordUrl: SET_PASSWORD_URL,
        expiresInDays: 7,
        locale: "es-MX",
      });
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "new@example.com" }),
      );
    });

    it("creates the account under the invite grant, in the chosen language", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.invite({ email: "new@example.com", name: "New User", locale: "es-MX" });

      expect(runWithAllowedUserCreation).toHaveBeenCalledWith(
        "admin-invite",
        expect.any(Function),
        { locale: "es-MX" },
      );
    });

    it("refuses an unsupported language", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({
          email: "new@example.com",
          name: "New User",
          // @ts-expect-error -- not one of SUPPORTED_LOCALES
          locale: "fr-FR",
        }),
      ).rejects.toSatisfy((e: ORPCError<string, unknown>) => {
        expect(e.code).toBe("BAD_REQUEST");
        return true;
      });
      expect(authApi.api.createUser).not.toHaveBeenCalled();
    });

    it("never puts the generated password in the email or the response", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockRejectedValue(new Error("SMTP down"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "new@example.com",
        name: "New User",
        locale: "en-US",
      });

      const password = authApi.api.createUser.mock.calls[0]?.[0].body.password as string;
      expect(JSON.stringify(res)).not.toContain(password);
      expect(JSON.stringify(vi.mocked(renderInviteUser).mock.calls)).not.toContain(password);
    });

    it("hands the admin the link when the email send fails", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockRejectedValue(new Error("SMTP down"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "new@example.com",
        name: "New User",
        locale: "en-US",
      });

      expect(res).toEqual({
        userId: "new-user-id",
        emailSent: false,
        setPasswordUrl: SET_PASSWORD_URL,
        expiresAt: LINK_EXPIRES_AT,
      });
    });

    it("skips SMTP entirely and returns the link when email is not configured", async () => {
      mailer.configured = false;
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "new@example.com",
        name: "New User",
        locale: "en-US",
      });

      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(res).toMatchObject({ emailSent: false, setPasswordUrl: SET_PASSWORD_URL });
    });

    it("reports a link failure without undoing the created user", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      createSetPasswordLink.mockRejectedValue(new Error("db down"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ email: "new@example.com", name: "New", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError<string, unknown>) => {
        expect(e.code).toBe("INTERNAL_SERVER_ERROR");
        return true;
      });
      expect(db.user.delete).not.toHaveBeenCalled();
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("charges the admin's invite-mail budget before creating anyone", async () => {
      budget.errorQueue.push(new ORPCError("TOO_MANY_REQUESTS"));
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ email: "new@example.com", name: "New", locale: "en-US" }),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
      expect(budget.charges).toEqual([
        { prefix: "rl:users-invite-mail", key: "admin:admin-user-id" },
      ]);
      expect(authApi.api.createUser).not.toHaveBeenCalled();
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("declares the invite budgets fail-closed", () => {
      const declared = budget.options.filter((o) => String(o.keyPrefix).startsWith("rl:users-"));
      expect(declared.map((o) => [o.keyPrefix, o.failClosed])).toEqual([
        ["rl:users-invite-mail", true],
        ["rl:users-resend-invite", true],
      ]);
    });

    it("translates a duplicate-email error into a CONFLICT", async () => {
      authApi.api.createUser.mockRejectedValue(new Error("User already exists"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ email: "dup@example.com", name: "Dup", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError<string, unknown>) => {
        expect(e.code).toBe("CONFLICT");
        return true;
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("surfaces a clear error if auth configuration blocks account creation", async () => {
      authApi.api.createUser.mockRejectedValue(
        new Error("Sign-up is currently disabled. Contact an admin if you need access."),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ email: "new@example.com", name: "New User", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError<string, unknown>) => {
        expect(e.code).toBe("BAD_REQUEST");
        expect(e.message).toMatch(/account creation is disabled/i);
        return true;
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  describe("resendInvite", () => {
    const pending = {
      id: "u2",
      email: "pending@example.com",
      name: "Pending",
      locale: "es-MX",
      emailVerified: false,
      banned: false,
      banExpires: null,
      accounts: [{ providerId: "credential" }],
      sessions: [],
    };

    const expectNotPending = async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.resendInvite({ userId: "u2" })).rejects.toSatisfy(
        (e: ORPCError<string, unknown>) => {
          expect(e.code).toBe("INVITE_NOT_PENDING");
          expect(e.status).toBe(409);
          return true;
        },
      );
      expect(createSetPasswordLink).not.toHaveBeenCalled();
      expect(sendEmailMock).not.toHaveBeenCalled();
    };

    // An unverified SSO user is an active account (genericOAuth copies the
    // IdP's email_verified ?? false). A set-password link for it — handed to
    // the admin when SMTP is off — would add a password beside the SSO
    // identity: account takeover plus an SSO-MFA bypass.
    it("refuses an unverified user who signs in through SSO", async () => {
      mailer.configured = false;
      db.user.findUnique.mockResolvedValue({ ...pending, accounts: [{ providerId: "oidc" }] });
      await expectNotPending();
    });

    it("refuses a user with a credential account and another provider linked", async () => {
      db.user.findUnique.mockResolvedValue({
        ...pending,
        accounts: [{ providerId: "credential" }, { providerId: "oidc" }],
      });
      await expectNotPending();
    });

    it("refuses an unverified user with a live session", async () => {
      db.user.findUnique.mockResolvedValue({ ...pending, sessions: [{ id: "s1" }] });
      await expectNotPending();
    });

    it("refuses a user with no credential account", async () => {
      db.user.findUnique.mockResolvedValue({ ...pending, accounts: [] });
      await expectNotPending();
    });

    it("checks only bounded probes and live sessions", async () => {
      db.user.findUnique.mockResolvedValue(pending);
      sendEmailMock.mockResolvedValue(undefined);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.resendInvite({ userId: "u2" });
      const select = db.user.findUnique.mock.calls[0]?.[0].select;
      expect(select.accounts).toEqual({ select: { providerId: true }, take: 2 });
      expect(select.sessions).toMatchObject({ where: { expiresAt: { gt: expect.any(Date) } } });
    });

    // The link minter re-checks under its lock; a provider linked between the
    // check above and the mint is still refused.
    it("maps a refused mint to INVITE_NOT_PENDING", async () => {
      db.user.findUnique.mockResolvedValue(pending);
      createSetPasswordLink.mockRejectedValue(new SetPasswordLinkRefusedError("not-pending"));
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.resendInvite({ userId: "u2" })).rejects.toSatisfy(
        (e: ORPCError<string, unknown>) => {
          expect(e.code).toBe("INVITE_NOT_PENDING");
          return true;
        },
      );
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("mints a fresh link for a pending invitee and emails it", async () => {
      db.user.findUnique.mockResolvedValue(pending);
      sendEmailMock.mockResolvedValue(undefined);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.resendInvite({ userId: "u2" })).resolves.toEqual({
        userId: "u2",
        emailSent: true,
      });
      expect(createSetPasswordLink).toHaveBeenCalledWith({ userId: "u2", locale: "es-MX" });
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "pending@example.com" }),
      );
    });

    it("returns the link to the admin when it can't be emailed", async () => {
      mailer.configured = false;
      db.user.findUnique.mockResolvedValue(pending);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.resendInvite({ userId: "u2" })).resolves.toMatchObject({
        emailSent: false,
        setPasswordUrl: SET_PASSWORD_URL,
      });
    });

    // A verified account is in use: handing an admin a working set-password
    // link for it would be an account-takeover path.
    it("refuses a user who already set up their account", async () => {
      db.user.findUnique.mockResolvedValue({ ...pending, emailVerified: true });
      await expectNotPending();
    });

    it("refuses an archived user", async () => {
      db.user.findUnique.mockResolvedValue({ ...pending, banned: true });

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.resendInvite({ userId: "u2" })).rejects.toSatisfy(
        (e: ORPCError<string, unknown>) => {
          expect(e.code).toBe("BAD_REQUEST");
          return true;
        },
      );
      expect(createSetPasswordLink).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND for an unknown user", async () => {
      db.user.findUnique.mockResolvedValue(null);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.resendInvite({ userId: "nope" })).rejects.toSatisfy(
        (e: ORPCError<string, unknown>) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });

    // The mint repeats the checks under the lock a finishing reset also takes
    // (set-password-link.ts); its verdict wins over the fast path above.
    it("maps the mint's archived and missing verdicts like the fast path", async () => {
      db.user.findUnique.mockResolvedValue(pending);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      createSetPasswordLink.mockRejectedValueOnce(new SetPasswordLinkRefusedError("archived"));
      await expect(client.resendInvite({ userId: "u2" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      createSetPasswordLink.mockRejectedValueOnce(new SetPasswordLinkRefusedError("missing"));
      await expect(client.resendInvite({ userId: "u2" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("charges the admin's invite-mail budget and the invitee's resend budget first", async () => {
      db.user.findUnique.mockResolvedValue(pending);
      sendEmailMock.mockResolvedValue(undefined);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.resendInvite({ userId: "u2" });
      expect(budget.charges).toEqual([
        { prefix: "rl:users-invite-mail", key: "admin:admin-user-id" },
        { prefix: "rl:users-resend-invite", key: "user:u2" },
      ]);
    });

    it("mints and mails nothing once a budget is spent", async () => {
      db.user.findUnique.mockResolvedValue(pending);
      budget.errorQueue.push(undefined, new ORPCError("TOO_MANY_REQUESTS"));
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.resendInvite({ userId: "u2" })).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
      });
      expect(createSetPasswordLink).not.toHaveBeenCalled();
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("is admin-only", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(client.resendInvite({ userId: "u2" })).rejects.toSatisfy(
        (e: ORPCError<string, unknown>) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("setRole", () => {
    it("updates the role on a different user", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.setRole({ userId: "other-user-id", role: "admin" });

      expect(res).toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "other-user-id" },
        data: { role: "admin" },
      });
    });

    it("blocks the admin from demoting themselves", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.setRole({ userId: "admin-user-id", role: "user" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("FORBIDDEN");
          expect(e.message).toMatch(/own admin role/i);
          return true;
        },
      );
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("allows promoting yourself to admin (no-op safety net)", async () => {
      // Even though the admin is already admin, the schema allows the call.
      // We only block demotion of self — promoting yourself is harmless.
      db.user.findUnique.mockResolvedValue({ id: "admin-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.setRole({ userId: "admin-user-id", role: "admin" });
      expect(res).toEqual({ success: true });
    });

    it("throws NOT_FOUND for an unknown user id", async () => {
      db.user.findUnique.mockResolvedValue(null);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.setRole({ userId: "missing", role: "user" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });
  });

  describe("archive", () => {
    it("bans the user and revokes their sessions in a transaction", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.$transaction.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.archive({
        userId: "other-user-id",
        reason: "Inactive",
      });

      expect(res).toEqual({ success: true });
      expect(db.$transaction).toHaveBeenCalledOnce();
    });

    it("blocks self-archive", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.archive({ userId: "admin-user-id" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("FORBIDDEN");
          return true;
        },
      );
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("unarchive", () => {
    it("clears banned + banReason + banExpires", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.unarchive({ userId: "other-user-id" });

      expect(res).toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "other-user-id" },
        data: { banned: false, banReason: null, banExpires: null },
      });
    });
  });

  describe("remove", () => {
    it("hard-deletes when no FK constraint blocks it", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.remove({ userId: "other-user-id" });

      expect(res).toEqual({ success: true });
      expect(db.user.delete).toHaveBeenCalledWith({ where: { id: "other-user-id" } });
    });

    it("blocks self-delete", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "admin-user-id" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("FORBIDDEN");
        return true;
      });
      expect(db.user.delete).not.toHaveBeenCalled();
    });

    it("converts a Prisma FK constraint error into a CONFLICT with archive guidance", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.delete.mockRejectedValue(
        new Error("Foreign key constraint violated on the field: `Post_authorId_fkey`"),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "other-user-id" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("CONFLICT");
        expect(e.message).toMatch(/archive/i);
        return true;
      });
    });
  });
});
