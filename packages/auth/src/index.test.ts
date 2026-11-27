import { describe, expect, it, vi } from "vitest";

// Capture the options object handed to `betterAuth` without constructing a
// real instance (which would need a database adapter and a validated env).
const betterAuth = vi.fn((options: unknown) => ({ options }));
vi.mock("better-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("better-auth")>()),
  betterAuth,
}));
const prismaAdapter = vi.hoisted(() => vi.fn((_prisma: unknown, _config: unknown) => ({})));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter }));
// Identity: the captured hook is then the plain handler, re-wrapped below.
vi.mock("better-auth/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("better-auth/api")>()),
  createAuthMiddleware: (fn: unknown) => fn,
}));
const revokeCredentialsAfterPasswordReset = vi.fn(async (_userId: string) => {});
const revokeCredentialsAfterPasswordChange = vi.fn(
  async (_target: { userId: string; keepSessionToken: string }) => {},
);
vi.mock("./credential-revocation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credential-revocation")>()),
  revokeCredentialsAfterPasswordReset,
  revokeCredentialsAfterPasswordChange,
}));
vi.mock("better-auth/plugins", () => ({
  admin: () => ({ id: "admin" }),
  deviceAuthorization: () => ({ id: "device-authorization" }),
  genericOAuth: () => ({ id: "generic-oauth" }),
  twoFactor: () => ({ id: "two-factor" }),
}));
vi.mock("@better-auth/api-key", () => ({ apiKey: () => ({ id: "api-key" }) }));
vi.mock("@cockpit-chess/db", () => ({ default: {} }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));
const envState = vi.hoisted(() => ({ signupEnabled: true }));
vi.mock("@cockpit-chess/env/server", () => ({
  ADMIN_EMAILS: new Set<string>(),
  FORCE_SSO: false,
  get SIGNUP_ENABLED() {
    return envState.signupEnabled;
  },
  SSO_ENABLED: false,
  env: {
    BETTER_AUTH_URL: "https://app.example.test",
    BETTER_AUTH_SECRET: "disposable-unit-test-key-for-password-pepper",
    NODE_ENV: "test",
  },
}));
vi.mock("@cockpit-chess/mailer", () => ({
  isEmailConfigured: () => false,
  renderResetPassword: vi.fn(),
  renderTwoFactorOtp: vi.fn(),
  renderVerifyEmail: vi.fn(),
  sendEmail: vi.fn(),
}));

const { passwordPepper } = await import("./index");

type CapturedOptions = {
  emailAndPassword?: {
    revokeSessionsOnPasswordReset?: boolean;
    minPasswordLength?: number;
    onPasswordReset?: (data: { user: { id: string } }) => Promise<void>;
    password?: { hash: unknown; verify: unknown };
  };
  user?: Record<string, unknown>;
  hooks?: {
    after?: (ctx: { path: string; body: unknown; context: { returned: unknown } }) => Promise<void>;
  };
  databaseHooks?: {
    user?: Record<string, unknown>;
    account?: {
      create?: {
        before?: (account: object, context: { path?: string }) => Promise<unknown>;
        after?: (account: object, context: { path?: string }) => Promise<unknown>;
      };
      update?: {
        before?: (data: object, context: { path?: string }) => Promise<unknown>;
        after?: (data: object, context: { path?: string }) => Promise<unknown>;
      };
    };
    session?: {
      create?: {
        before?: (session: { userId: string }, context: { path?: string }) => Promise<unknown>;
      };
    };
  };
};

const options = betterAuth.mock.calls[0]?.[0] as CapturedOptions;
const prismaAdapterConfig = prismaAdapter.mock.calls[0]?.[1] as
  | { provider?: string; transaction?: boolean }
  | undefined;

describe("Better-Auth config", () => {
  // A reset is what a user does when they suspect someone else has their
  // password; it must sign out every existing session, the attacker's included.
  it("revokes every session when a password is reset", () => {
    expect(options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
  });

  it("refuses a device-flow session minted outside the CLI-credential lock", async () => {
    const before = options.databaseHooks?.session?.create?.before;
    if (!before) throw new Error("session create hook missing");
    const session = { userId: "u1", token: "t" };
    await expect(before(session, { path: "/device/token" })).rejects.toThrow(
      /did not hold the CLI credential lock/,
    );
    // A browser sign-in outside the credential fence is refused too
    // (password-sign-in-fence.ts); other browser paths are untouched.
    await expect(before(session, { path: "/sign-in/email" })).rejects.toThrow(
      /credential fence is missing/,
    );
    await expect(before(session, { path: "/sign-in/social" })).resolves.toBeUndefined();
    const { withDeviceRedemptionLock } = await import("./device-redemption-lock");
    // The lock helper's DB calls are not under test here: with no device code
    // in the body, it runs the callback directly, so the hook still refuses.
    await expect(
      withDeviceRedemptionLock(
        new Request("http://x/", { method: "POST", body: "{}" }),
        async () => {
          await before(session, { path: "/device/token" });
          return new Response("minted");
        },
      ),
    ).rejects.toThrow(/did not hold/);
  });

  it("refuses a password write outside the password-write lock", async () => {
    const create = options.databaseHooks?.account?.create?.before;
    const update = options.databaseHooks?.account?.update?.before;
    if (!create || !update) throw new Error("account hooks missing");
    await expect(update({ password: "hash" }, { path: "/change-password" })).rejects.toThrow(
      /password-write lock/,
    );
    await expect(update({ password: "hash" }, { path: "/anything" })).rejects.toThrow(
      /password-write lock/,
    );
    await expect(create({ password: "hash" }, { path: "/reset-password" })).rejects.toThrow(
      /password-write lock/,
    );
    // Other account writes, and a new user's first credential, need no lock.
    await expect(update({ accessToken: "t" }, { path: "/callback/sso" })).resolves.toBeUndefined();
    await expect(create({ password: "hash" }, { path: "/sign-up/email" })).resolves.toBeUndefined();
    await expect(
      create({ password: "hash" }, { path: "/admin/create-user" }),
    ).resolves.toBeUndefined();
  });

  it("confirms every password write after it commits (password-write-lock.ts)", async () => {
    const { confirmPasswordWriteLocked } = await import("./password-write-lock");
    expect(options.databaseHooks?.account?.create?.after?.toString()).toContain(
      confirmPasswordWriteLocked.name,
    );
    expect(options.databaseHooks?.account?.update?.after?.toString()).toContain(
      confirmPasswordWriteLocked.name,
    );
    // Outside a password write there is nothing to confirm.
    await expect(
      options.databaseHooks?.account?.update?.after?.({}, { path: "/callback/sso" }),
    ).resolves.toBeUndefined();
  });

  it("keeps the 12-character password floor", () => {
    expect(options.emailAndPassword?.minPasswordLength).toBe(12);
  });

  // Session revocation never reaches API keys, so the reset callback must.
  it("revokes the user's CLI credentials after a password reset", async () => {
    await options.emailAndPassword?.onPasswordReset?.({ user: { id: "u1" } });
    expect(revokeCredentialsAfterPasswordReset).toHaveBeenCalledWith("u1");
  });

  it("revokes CLI credentials after a password change that signed out other devices", async () => {
    revokeCredentialsAfterPasswordChange.mockClear();
    await options.hooks?.after?.({
      path: "/change-password",
      body: { revokeOtherSessions: true },
      context: { returned: { token: "t", user: { id: "u1" } } },
    });
    expect(revokeCredentialsAfterPasswordChange).toHaveBeenCalledWith({
      userId: "u1",
      keepSessionToken: "t",
    });

    revokeCredentialsAfterPasswordChange.mockClear();
    await options.hooks?.after?.({
      path: "/sign-in/email",
      body: {},
      context: { returned: { token: "t", user: { id: "u1" } } },
    });
    expect(revokeCredentialsAfterPasswordChange).not.toHaveBeenCalled();
  });
});

it("uses the pepper password hooks", () => {
  expect(options.emailAndPassword?.password).toEqual({
    hash: passwordPepper.hash,
    verify: passwordPepper.verify,
  });
});

// `/sign-up/email` must not tell a free address from a registered one. Runs the
// production auth options (user fields, requireEmailVerification, hooks,
// database hooks) on a real Better-Auth handler with its in-memory adapter.
// Every sign-up pays a real scrypt hash, hence the roomier timeout.
describe("sign-up response is the same for free and registered addresses", {
  timeout: 20_000,
}, () => {
  async function realAuth() {
    const { betterAuth: realBetterAuth } =
      await vi.importActual<typeof import("better-auth")>("better-auth");
    const { createAuthMiddleware } =
      await vi.importActual<typeof import("better-auth/api")>("better-auth/api");
    // The plugin factories are stubbed above; the real admin plugin is what
    // gives a created user `role: "user"` and the synthetic duplicate `null`.
    const { admin } =
      await vi.importActual<typeof import("better-auth/plugins")>("better-auth/plugins");
    const { memoryAdapter } = await import("better-auth/adapters/memory");
    const after = options.hooks?.after;
    if (!after) throw new Error("after hook missing");
    const db: Record<string, Record<string, unknown>[]> = {
      user: [],
      account: [],
      session: [],
      verification: [],
    };
    // Records every adapter call, including the ones made on the adapter a
    // transaction callback receives, so a test can prove two outcomes cost the
    // same database work (a conditional lookup is a timing oracle).
    const adapterOps: string[] = [];
    const recording = <A extends object>(adapter: A): A =>
      new Proxy(adapter, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const [first] = args;
            const model =
              typeof first === "object" && first !== null && "model" in first ? first.model : "";
            adapterOps.push(`${String(key)}:${String(model)}`);
            const callback = args[0];
            if (key === "transaction" && typeof callback === "function") {
              args[0] = (trx: object) => callback(recording(trx));
            }
            return Reflect.apply(value, target, args);
          };
        },
      });
    const memory = memoryAdapter(db);
    const countingAdapter = ((adapterOptions: Parameters<typeof memory>[0]) =>
      recording(memory(adapterOptions))) as typeof memory;
    const sendVerificationEmail = vi.fn(async () => {});
    const instance = realBetterAuth({
      baseURL: "https://app.example.test",
      secret: "disposable-unit-test-secret-with-no-external-use",
      database: countingAdapter,
      rateLimit: { enabled: false },
      user: options.user,
      emailAndPassword: { ...options.emailAndPassword, enabled: true },
      emailVerification: { sendOnSignUp: true, sendOnSignIn: true, sendVerificationEmail },
      hooks: { after: createAuthMiddleware(after as Parameters<typeof createAuthMiddleware>[0]) },
      databaseHooks: { user: options.databaseHooks?.user },
      plugins: [admin({ defaultRole: "user" })],
    } as Parameters<typeof realBetterAuth>[0]);
    const signUp = async (email: string) => {
      const res = await instance.handler(
        new Request("https://app.example.test/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://app.example.test" },
          body: JSON.stringify({ name: "Same Name", email, password: "same-password-12345" }),
        }),
      );
      return {
        status: res.status,
        headers: [...res.headers.entries()].filter(([name]) => name !== "date"),
        body: await res.text(),
      };
    };
    const countAdapterCalls = async <T>(fn: () => T | Promise<T>) => {
      const before = adapterOps.length;
      const result = await fn();
      return { result, calls: adapterOps.slice(before) };
    };
    return { db, signUp, countAdapterCalls, instance, sendVerificationEmail };
  }

  it("answers a new and an existing address byte-identically", async () => {
    envState.signupEnabled = true;
    const { db, signUp } = await realAuth();
    await signUp("taken-verified@example.test");
    await signUp("taken-unverified@example.test");
    const verified = db.user?.find((u) => u.email === "taken-verified@example.test");
    if (!verified) throw new Error("seed user missing");
    verified.emailVerified = true;

    const fresh = await signUp("fresh@example.test");
    expect(fresh.status).toBe(200);
    expect(fresh.body).toBe('{"token":null,"user":null}');
    expect(await signUp("taken-verified@example.test")).toEqual(fresh);
    expect(await signUp("taken-unverified@example.test")).toEqual(fresh);
    // The new address really got an account; the duplicates did not get a second one.
    expect(db.user?.map((u) => u.email).sort()).toEqual([
      "fresh@example.test",
      "taken-unverified@example.test",
      "taken-verified@example.test",
    ]);
  });

  it("with sign-up disabled, rejects an existing address exactly like a new one", async () => {
    envState.signupEnabled = true;
    const { db, signUp, countAdapterCalls } = await realAuth();
    await signUp("taken@example.test");
    envState.signupEnabled = false;
    try {
      const { result: fresh, calls: freshCalls } = await countAdapterCalls(() =>
        signUp("fresh@example.test"),
      );
      expect(fresh.status).toBe(422);
      expect(JSON.parse(fresh.body)).toMatchObject({ code: "FAILED_TO_CREATE_USER" });
      const taken = await countAdapterCalls(() => signUp("taken@example.test"));
      expect(taken.result).toEqual(fresh);
      // Same database work too: no lookup only a registered address pays for.
      expect(freshCalls).toContain("findOne:user");
      expect(taken.calls).toEqual(freshCalls);
      expect(db.user?.map((u) => u.email)).toEqual(["taken@example.test"]);

      // The ADMIN_EMAILS bootstrap (the server marks admin-listed addresses)
      // still creates a new account, with the neutral body: the one intended
      // divergence, which inherently creates the account.
      const { runWithAllowedUserCreation } = await import("./user-creation-policy");
      const asAdminListed = (email: string) =>
        runWithAllowedUserCreation("admin-bootstrap", () => signUp(email));
      const bootstrap = await asAdminListed("owner@example.test");
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.body).toBe('{"token":null,"user":null}');
      expect(db.user?.map((u) => u.email)).toContain("owner@example.test");
      // A registered address answers the same 422 whether or not it is
      // admin-listed, so it is no admin-membership oracle either.
      const ownerAgain = await countAdapterCalls(() => asAdminListed("owner@example.test"));
      expect(ownerAgain.result).toEqual(fresh);
      expect(ownerAgain.calls).toEqual(freshCalls);
      expect(await asAdminListed("taken@example.test")).toEqual(fresh);
      expect(db.user).toHaveLength(2);
    } finally {
      envState.signupEnabled = true;
    }
  });

  // Admin invites (packages/api users.invite) create the account server-side
  // under the "admin-invite" grant. The invitee's language comes from the
  // grant, not from a request header, and nothing mails a "verify your email"
  // link: the set-password link is the only mail, and spending it verifies.
  it("creates an invited user in the invite's language, unverified, with no verification mail", async () => {
    envState.signupEnabled = false;
    try {
      const { db, instance, sendVerificationEmail } = await realAuth();
      // The options are cast for realBetterAuth, so the admin plugin's
      // endpoints are not on the inferred API type.
      const api = instance.api as unknown as {
        createUser: (req: {
          body: { email: string; password: string; name: string; role: string };
        }) => Promise<unknown>;
      };
      const { runWithAllowedUserCreation } = await import("./user-creation-policy");
      await runWithAllowedUserCreation(
        "admin-invite",
        () =>
          api.createUser({
            body: {
              email: "invitee@example.test",
              password: "unusable-random-password-0123456789",
              name: "Invitee",
              role: "user",
            },
          }),
        { locale: "es-MX" },
      );
      const row = db.user?.find((u) => u.email === "invitee@example.test");
      expect(row).toMatchObject({ locale: "es-MX", emailVerified: false, role: "user" });
      expect(sendVerificationEmail).not.toHaveBeenCalled();

      // Without a grant locale, a sign-up still takes the client's header.
      envState.signupEnabled = true;
      await instance.handler(
        new Request("https://app.example.test/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://app.example.test",
            "x-app-locale": "es-MX",
          },
          body: JSON.stringify({
            name: "Self",
            email: "self@example.test",
            password: "self-password-12345",
          }),
        }),
      );
      expect(db.user?.find((u) => u.email === "self@example.test")).toMatchObject({
        locale: "es-MX",
      });
      // Self sign-up keeps its verification mail.
      expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    } finally {
      envState.signupEnabled = true;
    }
  });
});

// The Prisma adapter runs without transactions (index.ts says why), so a
// reset's steps commit one by one. Pin the config, and the failure direction
// the comment promises: a failed password write leaves the token spent and the
// sessions gone, the old password in place, and runs no onPasswordReset.
describe("password reset without adapter transactions", { timeout: 20_000 }, () => {
  it("creates the Prisma adapter with Better-Auth's default (no transactions)", () => {
    expect(prismaAdapterConfig).toEqual({ provider: "postgresql" });
  });

  it("fails closed when the password write fails after the token was spent", async () => {
    const { betterAuth: realBetterAuth } =
      await vi.importActual<typeof import("better-auth")>("better-auth");
    const { memoryAdapter } = await import("better-auth/adapters/memory");
    const now = new Date();
    const db: Record<string, Record<string, unknown>[]> = {
      user: [
        {
          id: "u1",
          email: "reset@example.test",
          name: "Reset",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      account: [],
      session: [
        {
          id: "s1",
          userId: "u1",
          token: "session-token",
          expiresAt: new Date(now.getTime() + 3_600_000),
          createdAt: now,
          updatedAt: now,
        },
      ],
      verification: [
        {
          id: "v1",
          identifier: "reset-password:the-token",
          value: "u1",
          expiresAt: new Date(now.getTime() + 3_600_000),
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const memory = memoryAdapter(db);
    // Like chess's Prisma adapter: `transaction` just runs the work, so every
    // write commits as it happens. The account (password) write fails.
    const nonTransactional = ((adapterOptions: Parameters<typeof memory>[0]) => {
      const inner = memory(adapterOptions);
      const adapter: typeof inner = new Proxy(inner, {
        get(target, key, receiver) {
          if (key === "transaction") return (work: (trx: typeof inner) => unknown) => work(adapter);
          const value = Reflect.get(target, key, receiver);
          if ((key === "update" || key === "updateMany") && typeof value === "function") {
            return (args: { model: string }) => {
              if (args.model === "account") throw new Error("password write failed");
              return Reflect.apply(value, target, [args]);
            };
          }
          return value;
        },
      });
      return adapter;
    }) as typeof memory;
    revokeCredentialsAfterPasswordReset.mockClear();
    const instance = realBetterAuth({
      baseURL: "https://app.example.test",
      secret: "disposable-unit-test-secret-with-no-external-use",
      database: nonTransactional,
      rateLimit: { enabled: false },
      user: options.user,
      emailAndPassword: { ...options.emailAndPassword, enabled: true },
      logger: { disabled: true },
    } as Parameters<typeof realBetterAuth>[0]);
    const ctx = await instance.$context;
    const oldHash = await ctx.password.hash("old-password-12345");
    db.account?.push({
      id: "a1",
      userId: "u1",
      accountId: "u1",
      providerId: "credential",
      password: oldHash,
      createdAt: now,
      updatedAt: now,
    });

    const res = await instance.handler(
      new Request("https://app.example.test/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.test" },
        body: JSON.stringify({ token: "the-token", newPassword: "new-password-12345" }),
      }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.verification).toHaveLength(0); // the link is spent
    expect(db.session).toHaveLength(0); // every session is gone
    expect(db.account?.[0]?.password).toBe(oldHash); // the old password stays
    expect(revokeCredentialsAfterPasswordReset).not.toHaveBeenCalled();
  });
});
