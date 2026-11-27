import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Capture the options object handed to `betterAuth` without constructing a
// real instance (which would need a database adapter and a validated env).
const cookieSurfaceGetSession = vi.hoisted(() => vi.fn());
const betterAuth = vi.fn((options: unknown) => ({
  options,
  api: { getSession: cookieSurfaceGetSession },
}));
vi.mock("better-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("better-auth")>()),
  betterAuth,
}));
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter:
      (_db: unknown, _config: unknown) => (opts: Parameters<ReturnType<typeof memoryAdapter>>[0]) =>
        memoryAdapter(prismaStub.memory.db ?? {})(opts),
  };
});
// Identity: the captured hook is then the plain handler, re-wrapped below.
vi.mock("better-auth/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("better-auth/api")>()),
  createAuthMiddleware: (fn: unknown) => fn,
}));
const revokeCredentialsAfterPasswordReset = vi.fn(async (_userId: string) => {});
const revokeCredentialsAfterPasswordChange = vi.fn(
  async (_target: { userId: string; keepSessionToken: string }) => {},
);
const quarantineUntrustedPasswordWrite = vi.fn(async (_userId: string, _opts?: unknown) => {});
vi.mock("./credential-revocation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credential-revocation")>()),
  revokeCredentialsAfterPasswordReset,
  revokeCredentialsAfterPasswordChange,
  quarantineUntrustedPasswordWrite,
}));
const recordResetLinkMailed = vi.fn(async (_input: unknown) => true);
vi.mock("./password-reset-links.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./password-reset-links")>()),
  recordResetLinkMailed,
}));
vi.mock("better-auth/plugins", async (importOriginal) => ({
  admin: () => ({ id: "admin" }),
  deviceAuthorization: (await importOriginal<typeof import("better-auth/plugins")>())
    .deviceAuthorization,
  genericOAuth: () => ({ id: "generic-oauth" }),
  twoFactor: () => ({ id: "two-factor" }),
}));
vi.mock("@better-auth/api-key", () => ({ apiKey: () => ({ id: "api-key" }) }));
// The account-activation after-hooks (account-activation.ts) run their
// lock + reset-link delete batch through this stub: each statement is a tag,
// and `$transaction` records the batch. An interactive transaction (the
// password-write lock, the password-reset-links.ts reads and writes) runs
// against the real handler's in-memory tables (`memory.db`, set by realAuth),
// so both sides see one state.
const prismaStub = vi.hoisted(() => {
  type Table = Record<string, unknown>[];
  const memory = { db: null as Record<string, Table> | null };
  const table = (model: string): Table => memory.db?.[model] ?? [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, want]) => {
      const have = row[key];
      if (typeof want === "object" && want !== null && "startsWith" in want) {
        return (
          typeof have === "string" &&
          have.startsWith(String(want.startsWith)) &&
          have !== (want as { not?: string }).not
        );
      }
      if (typeof want === "object" && want !== null && "gt" in want) {
        return have instanceof Date && want.gt instanceof Date && have > want.gt;
      }
      return have === want;
    });
  const findVerification = async ({ where }: { where: Record<string, unknown> }) =>
    table("verification").find((row) => matches(row, where)) ?? null;
  const tx = {
    $executeRaw: async (..._sql: unknown[]) => 1,
    // The password-write lock's `pg_try_advisory_xact_lock` and its probe.
    $queryRaw: vi.fn(async (..._sql: unknown[]) => [{ locked: true }]),
    session: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        table("session").find((row) => matches(row, where)) ?? null,
    },
    verification: {
      findFirst: findVerification,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `v-${table("verification").length + 1}-${Date.now()}`;
        const at = new Date();
        table("verification").push({ id, createdAt: at, updatedAt: at, ...data });
        return { id };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const rows = table("verification");
        const keep = rows.filter((row) => !matches(row, where));
        const count = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return { count };
      },
    },
    user: {
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const rows = table("user").filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const user = table("user").find((row) => row.id === where.id);
        if (!user) return null;
        const now = new Date();
        return {
          email: user.email,
          emailVerified: user.emailVerified,
          accounts: table("account")
            .filter((row) => row.userId === user.id)
            .map((row) => ({ providerId: row.providerId }))
            .slice(0, 2),
          sessions: table("session")
            .filter(
              (row) =>
                row.userId === user.id && row.expiresAt instanceof Date && row.expiresAt > now,
            )
            .map((row) => ({ id: row.id }))
            .slice(0, 1),
        };
      },
    },
  };
  const runTransaction = async (arg: unknown, _options?: unknown) =>
    typeof arg === "function" ? (arg as (client: typeof tx) => unknown)(tx) : arg;
  return {
    memory,
    tx,
    runTransaction,
    apiKey: { deleteMany: vi.fn(() => "keys") },
    deviceCode: { deleteMany: vi.fn(() => "codes") },
    session: {
      deleteMany: vi.fn(
        (input: {
          where: { OR: { userId?: string; origin?: string; impersonatedBy?: string }[] };
        }) => ({
          kind: "sessions" as const,
          where: input.where,
        }),
      ),
    },

    user: { findUnique: async () => ({ locale: "en-US" }) },
    verification: {
      // The password-write lock's reset-token lookup (password-write-lock.ts).
      findFirst: findVerification,
      deleteMany: vi.fn((args: unknown) => ({ op: "deleteResetLinks" as const, args })),
    },
    $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: string[]) =>
      strings.join("").includes('WITH "resetChallenges"')
        ? { kind: "verification-sql" as const, sql: strings.join("?"), values }
        : "lock",
    ),

    $transaction: vi.fn(runTransaction),
  };
});
vi.mock("@cockpit-chess/db", () => ({ default: prismaStub }));
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
  renderResetPassword: vi.fn(() => ({ subject: "Reset", html: "<p>reset</p>" })),
  renderTwoFactorOtp: vi.fn(),
  renderVerifyEmail: vi.fn(),
  sendEmail: vi.fn(),
}));

const revocationDb = prismaStub;
const { passwordPepper } = await import("./index");
const { sendEmail } = await import("@cockpit-chess/mailer");
const { withPasswordWriteLock } = await import("./password-write-lock");

/** The cleanup batches (`$transaction([...])`) recorded since the last clear. */
const cleanupBatches = () =>
  prismaStub.$transaction.mock.calls.map(([arg]) => arg).filter((arg) => Array.isArray(arg));
const cleanupBatchFor = (userId: string) => [
  "lock",
  {
    op: "deleteResetLinks",
    args: { where: { value: userId, identifier: { startsWith: "reset-password:" } } },
  },
];

/**
 * Run `run` holding the password-write lock of the user named in `body`, as
 * apps/server does for every password-writing Better-Auth endpoint.
 */
const inPasswordWriteLock = (
  path: string,
  request: Request,
  run: () => Promise<Response>,
): Promise<Response> => withPasswordWriteLock(path, request, run, { getSession: async () => null });

// Load the server middleware as an integration boundary without adding its
// source files to this composite package's TypeScript project.
type IdentityContext = {
  req: { raw: Request; path: string; header: (name: string) => string | null };
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => unknown;
  json: (body: unknown, status: number) => Response;
};
const { expectedIdentity } = await vi.importActual<{
  expectedIdentity: (
    context: IdentityContext,
    next: () => Promise<void>,
  ) => Promise<Response | undefined>;
}>(new URL("../../../apps/server/src/expected-identity.ts", import.meta.url).pathname);

type CapturedOptions = {
  database?: ReturnType<typeof import("./credential-setup-adapter").createCredentialSetupAdapter>;
  emailAndPassword?: {
    revokeSessionsOnPasswordReset?: boolean;
    minPasswordLength?: number;
    onPasswordReset?: (data: { user: { id: string } }) => Promise<void>;
    password?: { hash: unknown; verify: unknown };
    sendResetPassword?: (data: {
      user: { id: string; email: string };
      url: string;
      token: string;
    }) => Promise<void>;
  };
  user?: Record<string, unknown>;
  session?: { cookieCache?: { enabled?: boolean; maxAge?: number } };
  hooks?: {
    before?: (
      ctx: Parameters<typeof import("better-auth/api").getSessionFromCtx>[0],
    ) => Promise<void>;
    after?: (ctx: {
      path: string;
      body: unknown;
      query?: unknown;
      context: { returned?: unknown };
    }) => Promise<void>;
  };
  databaseHooks?: {
    user?: {
      update?: {
        before?: (data: Record<string, unknown>, context: object | null) => Promise<void>;
        after?: (user: Record<string, unknown>, context: object | null) => Promise<void>;
      };
      create?: {
        before?: (
          user: Record<string, unknown>,
          context: { path?: string } | null,
        ) => Promise<unknown>;
      };
      [key: string]: unknown;
    };
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

  it("applies full reset revocation after a successful admin password reset", async () => {
    revokeCredentialsAfterPasswordReset.mockClear();
    await options.hooks?.after?.({
      path: "/admin/set-user-password",
      body: { userId: "target-user" },
      context: { returned: { status: true } },
    });
    expect(revokeCredentialsAfterPasswordReset).toHaveBeenCalledExactlyOnceWith("target-user");
  });

  it.each([null, { status: false }, new Error("denied")])(
    "does not revoke credentials after a refused admin password reset (%s)",
    async (returned) => {
      revokeCredentialsAfterPasswordReset.mockClear();
      await options.hooks?.after?.({
        path: "/admin/set-user-password",
        body: { userId: "target-user" },
        context: { returned },
      });
      expect(revokeCredentialsAfterPasswordReset).not.toHaveBeenCalled();
    },
  );

  it("fails an admin reset when its post-write revocation fails", async () => {
    revokeCredentialsAfterPasswordReset.mockRejectedValueOnce(new Error("sweep failed"));
    await expect(
      options.hooks?.after?.({
        path: "/admin/set-user-password",
        body: { userId: "target-user" },
        context: { returned: { status: true } },
      }),
    ).rejects.toThrow("sweep failed");
  });

  // A spent link verifies the email only if it was mailed (password-reset-links.ts).
  it("records mailbox delivery before spending a forgot-password link", async () => {
    recordResetLinkMailed.mockClear();
    vi.mocked(sendEmail).mockClear();
    await options.emailAndPassword?.sendResetPassword?.({
      user: { id: "u1", email: "ada@example.com" },
      url: "https://app.example.test/api/auth/reset-password/tok",
      token: "tok",
    });
    expect(recordResetLinkMailed).toHaveBeenCalledWith({
      token: "tok",
      userId: "u1",
      email: "ada@example.com",
    });
    // Recorded only once the mail was handed over.
    expect(vi.mocked(sendEmail).mock.invocationCallOrder[0]).toBeLessThan(
      recordResetLinkMailed.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps a mailed reset link's request a success when recording it fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    recordResetLinkMailed.mockRejectedValueOnce(new Error("db down"));
    try {
      await expect(
        options.emailAndPassword?.sendResetPassword?.({
          user: { id: "u1", email: "ada@example.com" },
          url: "https://app.example.test/api/auth/reset-password/tok",
          token: "tok",
        }),
      ).resolves.toBeUndefined();
      expect(errorLog).toHaveBeenCalledWith(
        "[auth] recording a mailed reset link failed:",
        "Error: db down",
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  // A link the admin was shown is spendable only while the invite is pending
  // (password-reset-links.ts `isResetLinkRedeemable`).
  it("refuses a shown reset link for an active account before Better-Auth spends it", async () => {
    const rawBefore = options.hooks?.before;
    const before =
      rawBefore &&
      ((ctx: { path: string; body: unknown; query?: unknown }) =>
        rawBefore({
          ...ctx,
          context: {
            internalAdapter: {
              findVerificationValue: async (id: string) =>
                prismaStub.memory.db?.verification?.find((row) => row.identifier === id) ?? null,
            },
          },
        } as unknown as Parameters<typeof rawBefore>[0]));
    if (!before) throw new Error("before hook missing");
    const at = new Date();
    const expiresAt = new Date(at.getTime() + 3_600_000);
    const db: Record<string, Record<string, unknown>[]> = {
      user: [
        { id: "active", emailVerified: true },
        { id: "pending", emailVerified: false },
      ],
      account: [
        { userId: "active", providerId: "credential" },
        { userId: "pending", providerId: "credential" },
      ],
      session: [],
      verification: [
        { identifier: "reset-password:shown-active", value: "active", expiresAt },
        { identifier: "reset-password:shown-pending", value: "pending", expiresAt },
      ],
    };
    prismaStub.memory.db = db;
    try {
      await expect(
        before({ path: "/reset-password", body: { token: "shown-active" } }),
      ).rejects.toMatchObject({ body: { code: "INVALID_TOKEN" } });
      // Better-Auth reads `body.token || query.token`; so does the hook.
      db.verification?.push({
        identifier: "reset-password:shown-active",
        value: "active",
        expiresAt,
      });
      await expect(
        before({ path: "/reset-password", body: {}, query: { token: "shown-active" } }),
      ).rejects.toMatchObject({ body: { code: "INVALID_TOKEN" } });
      await expect(
        before({ path: "/reset-password", body: { token: "shown-pending" } }),
      ).resolves.toBeUndefined();
      // Other routes, and an unknown token (Better-Auth refuses it itself), pass.
      await expect(
        before({ path: "/sign-in/email", body: { token: "shown-active" } }),
      ).resolves.toBeUndefined();
      await expect(
        before({ path: "/reset-password", body: { token: "unknown" } }),
      ).resolves.toBeUndefined();
    } finally {
      prismaStub.memory.db = null;
    }
  });

  it("refuses an email change, and an admin-asserted verification, through Better-Auth's update routes", async () => {
    const before = options.databaseHooks?.user?.update?.before;
    if (!before) throw new Error("user update hook missing");
    await expect(
      before({ email: "new@example.com" }, { path: "/admin/update-user" }),
    ).rejects.toThrow(/does not change account email/);
    await expect(before({ email: "new@example.com" }, { path: "/update-user" })).rejects.toThrow(
      /does not change account email/,
    );
    await expect(
      before({ emailVerified: true }, { path: "/admin/update-user" }),
    ).rejects.toMatchObject({ body: { code: "EMAIL_VERIFICATION_BY_MAIL_ONLY" } });
    await expect(before({ name: "Ada" }, { path: "/update-user" })).resolves.toBeUndefined();
    await expect(
      before({ emailVerified: true }, { path: "/verify-email" }),
    ).resolves.toBeUndefined();
  });

  // Activation kills the user's leftover set-password links (account-activation.ts).
  it("deletes the reset links of an account a write activated", async () => {
    const update = options.databaseHooks?.user?.update;
    const accountAfter = options.databaseHooks?.account?.create?.after;
    if (!update?.before || !update.after || !accountAfter) throw new Error("hooks missing");
    prismaStub.$transaction.mockClear();

    // A user update that verified the email.
    const verifying = { path: "/verify-email" };
    await update.before({ emailVerified: true }, verifying);
    await update.after({ id: "u1", emailVerified: true }, verifying);
    expect(cleanupBatches()).toEqual([cleanupBatchFor("u1")]);

    // A different write to an already-verified user activates nothing.
    prismaStub.$transaction.mockClear();
    const renaming = { path: "/update-user" };
    await update.before({ name: "Ada" }, renaming);
    await update.after({ id: "u1", emailVerified: true }, renaming);
    expect(cleanupBatches()).toEqual([]);

    // An IdP identity linked to the user activates it; a credential does not.
    await accountAfter({ userId: "u2", providerId: "credential" }, { path: "/sign-up/email" });
    expect(cleanupBatches()).toEqual([]);
    await accountAfter({ userId: "u2", providerId: "sso" }, { path: "/callback/sso" });
    expect(cleanupBatches()).toEqual([cleanupBatchFor("u2")]);
  });

  // The lock confirmation comes first: a password write that committed after
  // its lock lapsed fails the request before anything else runs.
  it("confirms the password-write lock before an account create's activation cleanup", async () => {
    const accountBefore = options.databaseHooks?.account?.create?.before;
    const accountAfter = options.databaseHooks?.account?.create?.after;
    if (!accountBefore || !accountAfter) throw new Error("account hooks missing");
    const setPassword = () =>
      new Request("https://app.example.test/api/auth/admin/set-user-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "u3", newPassword: "x" }),
      });
    const context = { path: "/admin/set-user-password" };
    const credentialFor = { password: "hash", userId: "u3", providerId: "sso" };

    for (const lapsed of [true, false]) {
      prismaStub.$transaction.mockClear();
      quarantineUntrustedPasswordWrite.mockClear();
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      let outcome: unknown;
      try {
        await inPasswordWriteLock("/admin/set-user-password", setPassword(), async () => {
          await accountBefore(credentialFor, context);
          // The probe after the write: the lock transaction no longer holds it.
          if (lapsed) prismaStub.tx.$queryRaw.mockResolvedValueOnce([{ locked: false }]);
          outcome = await accountAfter(credentialFor, context).catch((error: unknown) => error);
          return new Response(null, { status: 204 });
        });
      } finally {
        errorLog.mockRestore();
      }
      if (lapsed) {
        expect(outcome).toMatchObject({ body: { code: "PASSWORD_WRITE_UNCONFIRMED" } });
        expect(quarantineUntrustedPasswordWrite).toHaveBeenCalledWith("u3", expect.anything());
        expect(cleanupBatches()).toEqual([]);
      } else {
        expect(outcome).toBeUndefined();
        expect(quarantineUntrustedPasswordWrite).not.toHaveBeenCalled();
        expect(cleanupBatches()).toEqual([cleanupBatchFor("u3")]);
      }
    }
  });

  // Only users.invite reaches /admin/create-user, and only an IdP sign-in
  // creates a verified user (user-creation-policy.ts). Checked before any
  // other creation rule, so the refusal is the same with sign-up off.
  it("refuses an unproved user creation before every other creation rule", async () => {
    const create = options.databaseHooks?.user?.create?.before;
    if (!create) throw new Error("user create hook missing");
    envState.signupEnabled = false;
    try {
      await expect(
        create({ email: "made@example.test" }, { path: "/admin/create-user" }),
      ).rejects.toMatchObject({ body: { code: "ADMIN_CREATE_USER_UNSUPPORTED" } });
      await expect(
        create({ email: "self@example.test", emailVerified: true }, { path: "/sign-up/email" }),
      ).rejects.toMatchObject({ body: { code: "EMAIL_VERIFICATION_BY_MAIL_ONLY" } });
    } finally {
      envState.signupEnabled = true;
    }
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

// The production auth options (user fields, requireEmailVerification, hooks,
// user and account database hooks) on a real Better-Auth handler with its
// in-memory adapter. The session hooks (CLI-credential lock, password-sign-in
// fence) are left out: they need the server's sign-in wrappers, and these
// tests sign the admin in directly. Every sign-up pays a real scrypt hash,
// hence the roomier timeouts below.
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
  const before = options.hooks?.before;
  if (!after || !before) throw new Error("auth hooks missing");
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  prismaStub.memory.db = db;
  // Back to the stub's own behaviour: a one-off implementation a failed test
  // left unconsumed must not leak into the next one.
  prismaStub.$transaction.mockReset();
  prismaStub.tx.$queryRaw.mockReset();
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
    hooks: {
      before: createAuthMiddleware(before as Parameters<typeof createAuthMiddleware>[0]),
      after: createAuthMiddleware(after as Parameters<typeof createAuthMiddleware>[0]),
    },
    databaseHooks: {
      user: options.databaseHooks?.user,
      account: options.databaseHooks?.account,
    },
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
  // An admin with a live session cookie, as `/api/auth/admin/*` sees one.
  const signedInAdmin = async () => {
    envState.signupEnabled = true;
    await signUp("admin@example.test");
    const row = db.user?.find((u) => u.email === "admin@example.test");
    if (!row) throw new Error("admin seed missing");
    Object.assign(row, { emailVerified: true, role: "admin" });
    const res = await instance.handler(
      new Request("https://app.example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.test" },
        body: JSON.stringify({ email: "admin@example.test", password: "same-password-12345" }),
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return { cookie };
  };
  return { db, signUp, countAdapterCalls, instance, sendVerificationEmail, signedInAdmin };
}

// `/sign-up/email` must not tell a free address from a registered one.
describe("sign-up response is the same for free and registered addresses", {
  timeout: 20_000,
}, () => {
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

// Reset transaction rollback and same-link retry are exercised with the actual
// production adapter/hooks in reset-spend.integration.test.ts. Signup stays
// outside transactions there so locale reads/SMTP retain their visibility.
// Only users.invite creates users through the admin plugin, nothing but an IdP
// sign-in creates a verified one, and activation kills leftover reset links.
describe("user creation and activation on the real handler", { timeout: 20_000 }, () => {
  // Admins invite through users.invite, which never lets anyone choose the
  // password or the verification state (user-creation-policy.ts).
  it("refuses Better-Auth's admin create-user route over HTTP, even for an admin with sign-up on", async () => {
    const { db, instance, signedInAdmin } = await realAuth();
    const { cookie } = await signedInAdmin();
    for (const data of [{ emailVerified: true }, undefined]) {
      const res = await instance.handler(
        new Request("https://app.example.test/api/auth/admin/create-user", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://app.example.test",
            cookie,
          },
          body: JSON.stringify({
            email: "made@example.test",
            password: "admin-chosen-password-123",
            name: "Made",
            ...(data ? { data } : {}),
          }),
        }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "ADMIN_CREATE_USER_UNSUPPORTED" });
    }
    expect(db.user?.map((u) => u.email)).toEqual(["admin@example.test"]);
  });

  it("never creates a verified user outside an IdP sign-in, the invite grant included", async () => {
    const { db, instance } = await realAuth();
    const api = instance.api as unknown as {
      createUser: (req: {
        body: { email: string; password: string; name: string; data?: Record<string, unknown> };
      }) => Promise<unknown>;
    };
    const { runWithAllowedUserCreation } = await import("./user-creation-policy");
    await expect(
      runWithAllowedUserCreation("admin-invite", () =>
        api.createUser({
          body: {
            email: "asserted@example.test",
            password: "unusable-random-password-0123456789",
            name: "Asserted",
            data: { emailVerified: true },
          },
        }),
      ),
    ).rejects.toMatchObject({ body: { code: "EMAIL_VERIFICATION_BY_MAIL_ONLY" } });
    expect(db.user).toHaveLength(0);
  });

  // A revealed-link invitee who verifies through the ordinary mail must not
  // leave an admin's later resend link working (account-activation.ts).
  it("deletes the user's reset links under the set-password-link lock once verify-email has committed", async () => {
    envState.signupEnabled = true;
    const { db, instance, signUp, sendVerificationEmail } = await realAuth();
    prismaStub.$transaction.mockClear();
    await signUp("verify@example.test");
    // Sign-up's own credential account activates nothing.
    expect(prismaStub.$transaction).not.toHaveBeenCalled();
    const sent = (sendVerificationEmail.mock.calls[0] as unknown as [{ token: string }])[0];
    const row = db.user?.find((u) => u.email === "verify@example.test");
    if (!row) throw new Error("user missing");
    const verifiedAtCleanup: unknown[] = [];
    prismaStub.$transaction.mockImplementationOnce(async (batch: unknown) => {
      verifiedAtCleanup.push(row.emailVerified);
      return batch;
    });
    const res = await instance.handler(
      new Request(
        `https://app.example.test/api/auth/verify-email?token=${encodeURIComponent(sent.token)}`,
      ),
    );
    expect(res.status).toBe(200);
    expect(row.emailVerified).toBe(true);
    expect(prismaStub.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaStub.$transaction.mock.calls[0]?.[0]).toEqual(cleanupBatchFor(String(row.id)));
    // The cleanup ran after the verified write, so a mint that re-reads the
    // user under the same lock afterwards sees the account active.
    expect(verifiedAtCleanup).toEqual([true]);
  });

  // Correctness must not hang on that cleanup: a link the admin was shown is
  // spendable only while the invite is pending (password-reset-links.ts
  // `isResetLinkRedeemable`, the /reset-password before-hook).
  describe("a reset link is spent only by who it may serve", () => {
    const shownLink = (
      db: Record<string, Record<string, unknown>[]>,
      userId: string,
      token: string,
    ) => {
      const at = new Date();
      db.verification?.push({
        id: `shown-${token}`,
        identifier: `reset-password:${token}`,
        value: userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        createdAt: at,
        updatedAt: at,
      });
    };
    // As apps/server mounts it: the whole handler holds the user's
    // password-write lock, which the account hooks require of a password write.
    const resetPassword = (
      instance: Awaited<ReturnType<typeof realAuth>>["instance"],
      token: string,
    ) => {
      const request = new Request("https://app.example.test/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.test" },
        body: JSON.stringify({ token, newPassword: "link-holder-password-123" }),
      });
      return inPasswordWriteLock("/reset-password", request, () => instance.handler(request));
    };
    const passwordOf = (db: Record<string, Record<string, unknown>[]>, userId: string) =>
      db.account?.find((a) => a.userId === userId && a.providerId === "credential")?.password;

    it("refuses a shown link left over after activation whose cleanup failed", async () => {
      envState.signupEnabled = true;
      const { db, instance, signUp, sendVerificationEmail } = await realAuth();
      await signUp("leftover@example.test");
      const row = db.user?.find((u) => u.email === "leftover@example.test");
      if (!row) throw new Error("user missing");
      const userId = String(row.id);
      shownLink(db, userId, "shown-leftover");
      const ownPassword = passwordOf(db, userId);
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      // Every cleanup attempt fails; interactive transactions still work.
      prismaStub.$transaction.mockImplementation(async (arg: unknown, txOptions?: unknown) => {
        if (typeof arg === "function") return prismaStub.runTransaction(arg, txOptions);
        throw new Error("db down");
      });
      try {
        const sent = (sendVerificationEmail.mock.calls[0] as unknown as [{ token: string }])[0];
        const verifyUrl = `https://app.example.test/api/auth/verify-email?token=${encodeURIComponent(sent.token)}`;
        // The verification is committed and reported as one.
        expect((await instance.handler(new Request(verifyUrl))).status).toBe(200);
        expect(row.emailVerified).toBe(true);
        expect(errorLog).toHaveBeenCalledWith(
          expect.stringContaining("refused at redemption"),
          expect.objectContaining({ userId }),
        );
        // The cleanup left the link behind, and a retry does not retry it.
        expect((await instance.handler(new Request(verifyUrl))).status).toBe(200);
        expect(db.verification?.some((v) => v.identifier === "reset-password:shown-leftover")).toBe(
          true,
        );

        const res = await resetPassword(instance, "shown-leftover");
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: "INVALID_TOKEN" });
        expect(passwordOf(db, userId)).toBe(ownPassword);
        expect(db.verification?.some((v) => v.identifier === "reset-password:shown-leftover")).toBe(
          false,
        );
      } finally {
        prismaStub.$transaction.mockImplementation(prismaStub.runTransaction);
        errorLog.mockRestore();
      }
    });

    it("lets a shown link set the password while the invite is pending", async () => {
      envState.signupEnabled = true;
      const { db, instance, signUp } = await realAuth();
      await signUp("pending@example.test");
      const row = db.user?.find((u) => u.email === "pending@example.test");
      if (!row) throw new Error("user missing");
      const userId = String(row.id);
      shownLink(db, userId, "shown-pending");
      const ownPassword = passwordOf(db, userId);

      const res = await resetPassword(instance, "shown-pending");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: true });
      expect(passwordOf(db, userId)).not.toBe(ownPassword);
      // The after-hook checked the spent token; shown, so it verified nothing.
      expect(row.emailVerified).toBe(false);
    });

    it("lets a mailed forgot-password link reset an active account", async () => {
      envState.signupEnabled = true;
      const { db, instance, signUp } = await realAuth();
      await signUp("active@example.test");
      const row = db.user?.find((u) => u.email === "active@example.test");
      if (!row) throw new Error("user missing");
      row.emailVerified = true;
      const userId = String(row.id);
      const ownPassword = passwordOf(db, userId);
      const actual =
        await vi.importActual<typeof import("./password-reset-links")>("./password-reset-links");
      recordResetLinkMailed.mockClear();
      recordResetLinkMailed.mockImplementationOnce((input) =>
        actual.recordResetLinkMailed(input as Parameters<typeof actual.recordResetLinkMailed>[0]),
      );

      const requested = await instance.handler(
        new Request("https://app.example.test/api/auth/request-password-reset", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://app.example.test" },
          body: JSON.stringify({
            email: "active@example.test",
            redirectTo: "/en-US/reset-password",
          }),
        }),
      );
      expect(requested.status).toBe(200);
      await vi.waitFor(() => expect(recordResetLinkMailed).toHaveBeenCalledTimes(1));
      const { token } = (recordResetLinkMailed.mock.calls[0]?.[0] ?? {}) as { token: string };
      await expect(recordResetLinkMailed.mock.results[0]?.value).resolves.toBe(true);

      const res = await resetPassword(instance, token);
      expect(res.status).toBe(200);
      expect(passwordOf(db, userId)).not.toBe(ownPassword);
    });
  });
});

const runPasswordReset = async (
  instance: {
    handler: (request: Request) => Promise<Response>;
    api: {
      getSession: (input: {
        headers: Headers;
      }) => Promise<{ user: { id: string }; session: { id: string } } | null>;
    };
  },
  request: Request,
) => {
  const { withPasswordWriteLock } = await import("./password-write-lock");
  return withPasswordWriteLock("/reset-password", request, () => instance.handler(request), {
    getSession: (headers) => instance.api.getSession({ headers }),
  });
};

describe("password reset ordering (real pinned endpoint, memory adapter)", () => {
  async function resetFixture(failLookup = false, withTwoFactor = false) {
    const { betterAuth: realBetterAuth } =
      await vi.importActual<typeof import("better-auth")>("better-auth");
    const { createAuthMiddleware } =
      await vi.importActual<typeof import("better-auth/api")>("better-auth/api");
    const actual =
      await vi.importActual<typeof import("./credential-revocation")>("./credential-revocation");
    const keys = new Set(["old-key"]);
    const db: Record<string, Record<string, unknown>[]> = {
      user: [
        { id: "reset-user", email: "reset@example.test", emailVerified: false, name: "Reset" },
      ],
      account: [
        {
          id: "account",
          userId: "reset-user",
          providerId: "credential",
          accountId: "reset-user",
          password: "old-hash",
        },
      ],
      session: [
        {
          id: "session",
          userId: "reset-user",
          token: "session-token",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
      verification: [
        {
          id: "verification",
          identifier: "reset-password:retry-token",
          value: "reset-user",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    };
    prismaStub.memory.db = db;
    const before = options.hooks?.before;
    const after = options.hooks?.after;
    if (!before || !after) throw new Error("reset hooks missing");
    const actualLinks =
      await vi.importActual<typeof import("./password-reset-links")>("./password-reset-links");
    // This reset came from a real mail, so it remains spendable with a live session.
    await actualLinks.recordResetLinkMailed({
      token: "retry-token",
      userId: "reset-user",
      email: "reset@example.test",
    });
    // Execute the production deletion SQL in memory, with no Postgres or I/O.
    // The statement uses SQL supported by both SQLite and PostgreSQL.
    const deleteVerifications = (write: { sql: string; values: string[] }) => {
      const sql = new DatabaseSync(":memory:");
      try {
        sql.exec('CREATE TABLE "verification" ("id" TEXT, "identifier" TEXT, "value" TEXT)');
        const insert = sql.prepare('INSERT INTO "verification" VALUES (?, ?, ?)');
        for (const row of db.verification ?? []) {
          insert.run(String(row.id), String(row.identifier), String(row.value));
        }
        sql.prepare(write.sql).run(...write.values);
        const remaining = new Set(
          sql
            .prepare('SELECT "id" FROM "verification"')
            .all()
            .map((row) => row.id),
        );
        db.verification = db.verification?.filter((row) => remaining.has(String(row.id))) ?? [];
      } finally {
        sql.close();
      }
    };
    type RevocationWrite =
      | string
      | ReturnType<typeof revocationDb.$executeRaw>
      | ReturnType<typeof revocationDb.session.deleteMany>
      | ReturnType<typeof revocationDb.verification.deleteMany>;
    revocationDb.$transaction.mockReset();
    revocationDb.$transaction.mockImplementation(async (work: unknown) => {
      if (!Array.isArray(work)) return prismaStub.runTransaction(work);
      const writes: RevocationWrite[] = work;
      if (writes.some((write) => typeof write === "object" && "op" in write)) {
        db.verification =
          db.verification?.filter(
            (row) =>
              row.value !== "reset-user" || !String(row.identifier).startsWith("reset-password:"),
          ) ?? [];
        return;
      }
      expect(writes.slice(0, 4)).toEqual([
        "lock",
        "keys",
        expect.objectContaining({ kind: "sessions" }),
        "codes",
      ]);
      for (const write of writes) {
        if (typeof write !== "string" && "kind" in write && write.kind === "verification-sql") {
          deleteVerifications(write);
        }
      }
      keys.clear();
      const sessionWrite = writes[2];
      if (
        typeof sessionWrite !== "object" ||
        !("kind" in sessionWrite) ||
        sessionWrite.kind !== "sessions"
      ) {
        throw new Error("Session revocation statement missing");
      }
      db.session =
        db.session?.filter(
          (session) =>
            !sessionWrite.where.OR.some((where) =>
              Object.entries(where).every(([key, value]) => session[key] === value),
            ),
        ) ?? [];
    });
    revokeCredentialsAfterPasswordReset.mockImplementation(
      actual.revokeCredentialsAfterPasswordReset,
    );
    const hash = vi.fn(async (password: string) => `hash:${password}`);
    const { twoFactor } =
      await vi.importActual<typeof import("better-auth/plugins")>("better-auth/plugins");
    const otps = new Map<string, string>();
    if (withTwoFactor) {
      Object.assign(db.user?.[0] ?? {}, { emailVerified: true, twoFactorEnabled: true });
      db.twoFactor = [];
    }
    const instance = realBetterAuth({
      baseURL: "https://app.example.test",
      secret: "disposable-reset-test-secret-with-no-external-use",
      database: options.database,
      logger: { disabled: true },
      rateLimit: { enabled: false },
      emailAndPassword: {
        ...options.emailAndPassword,
        enabled: true,
        password: { hash, verify: async () => true },
      },
      hooks: { before: createAuthMiddleware(before), after: createAuthMiddleware(after) },
      plugins: withTwoFactor
        ? [
            twoFactor({
              allowPasswordless: true,
              otpOptions: {
                storeOTP: "hashed",
                sendOTP: async ({ user, otp }) => {
                  otps.set(user.id, otp);
                },
              },
            }),
          ]
        : [],
    });
    if (failLookup) {
      const context = await instance.$context;
      vi.spyOn(context.internalAdapter, "findVerificationValue").mockRejectedValueOnce(
        new Error("private lookup details"),
      );
    }
    const reset = (token = "retry-token", query = false) =>
      runPasswordReset(
        instance,
        new Request(
          `https://app.example.test/api/auth/reset-password${query ? `?token=${token}` : ""}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              newPassword: "new-password-12345",
              ...(query ? {} : { token }),
            }),
          },
        ),
      );
    const call = (path: string, cookies = "", body: Record<string, unknown> = {}) =>
      instance.handler(
        new Request(`https://app.example.test/api/auth${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://app.example.test",
            cookie: cookies,
          },
          body: JSON.stringify(body),
        }),
      );
    return { db, keys, hash, reset, call, otps };
  }

  it.each(["pre-sweep", "post-sweep"])(
    "%s kills pending 2FA sign-ins and trusted devices, preserving other users",
    async (phase) => {
      const { db, hash, reset, call, otps } = await resetFixture(false, true);
      const cookies = (response: Response) =>
        response.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; ");
      const signIn = async (email: string, cookie = "") => {
        const response = await call("/sign-in/email", cookie, {
          email,
          password: "old-password-12345",
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
        return cookies(response);
      };
      const pending = async (email: string, userId: string) => {
        const cookie = await signIn(email);
        expect((await call("/two-factor/send-otp", cookie)).status).toBe(200);
        const code = otps.get(userId);
        if (!code) throw new Error("OTP not delivered");
        return { cookie, code };
      };
      db.user?.push({
        id: "peer",
        email: "peer@example.test",
        emailVerified: true,
        twoFactorEnabled: true,
        name: "Peer",
      });
      db.account?.push({
        id: "peer-account",
        userId: "peer",
        accountId: "peer",
        providerId: "credential",
        password: "peer-hash",
      });
      const peerTrusted = await pending("peer@example.test", "peer");
      expect(
        (
          await call("/two-factor/verify-otp", peerTrusted.cookie, {
            code: peerTrusted.code,
            trustDevice: true,
          })
        ).status,
      ).toBe(200);
      const peer = await pending("peer@example.test", "peer");
      const peerRows = db.verification
        ?.filter((row) => !String(row.identifier).startsWith("reset-password"))
        .map((row) => ({ ...row }));
      // An unrelated verification for the resetting user must also survive.
      db.verification?.push({
        id: "unrelated",
        identifier: "verify-email:unrelated",
        value: "reset-user",
        expiresAt: new Date(Date.now() + 60_000),
      });
      let oldPending: { cookie: string; code: string }[] = [];
      let trustedCookie = "";
      let completedAttemptRows: Record<string, unknown>[] = [];
      const prepare = async () => {
        const trusted = await pending("reset@example.test", "reset-user");
        const trustedResponse = await call("/two-factor/verify-otp", trusted.cookie, {
          code: trusted.code,
          trustDevice: true,
        });
        expect(trustedResponse.status).toBe(200);
        trustedCookie = cookies(trustedResponse)
          .split("; ")
          .filter((cookie) => cookie.includes("trust_device="))
          .join("; ");
        expect(trustedCookie).not.toBe("");
        // Core leaves the consumed sign-in's attempt counter behind. It no
        // longer has a user binding and cannot authorize a pending sign-in.
        completedAttemptRows =
          db.verification?.filter(
            (row) =>
              String(row.identifier).startsWith("2fa-attempts-") &&
              !peerRows?.some((peerRow) => peerRow.id === row.id),
          ) ?? [];
        oldPending = [
          await pending("reset@example.test", "reset-user"),
          await pending("reset@example.test", "reset-user"),
        ];
        const rows = db.verification ?? [];
        const challenges = rows.filter(
          (row) => row.value === "reset-user" && /^2fa-/.test(String(row.identifier)),
        );
        expect(challenges).toHaveLength(2);
        for (const challenge of challenges) {
          expect(rows).toContainEqual(
            expect.objectContaining({
              identifier: `2fa-attempts-${challenge.identifier}`,
              value: "0",
            }),
          );
          expect(rows).toContainEqual(
            expect.objectContaining({
              identifier: `2fa-otp-${challenge.identifier}`,
              value: expect.stringMatching(/:0$/),
            }),
          );
        }
        expect(rows).toContainEqual(
          expect.objectContaining({
            identifier: expect.stringMatching(/^trust-device-/),
            value: "reset-user",
          }),
        );
      };
      try {
        if (phase === "pre-sweep") {
          await prepare();
          hash.mockRejectedValue(new Error("stop before password commit"));
        } else {
          // A challenge created after the pre-sweep must be caught independently.
          hash.mockImplementation(async () => {
            await prepare();
            return "new-hash";
          });
        }
        expect((await reset()).status).toBe(phase === "pre-sweep" ? 500 : 200);
        expect(db.verification).toEqual(expect.arrayContaining(peerRows ?? []));
        expect(db.verification).toContainEqual(expect.objectContaining({ id: "unrelated" }));
        expect(
          db.verification?.filter((row) => /^(2fa-|trust-device-)/.test(String(row.identifier))),
        ).toEqual([...(peerRows ?? []), ...completedAttemptRows]);
        for (const challenge of oldPending) {
          const response = await call("/two-factor/verify-otp", challenge.cookie, {
            code: challenge.code,
          });
          expect(response.status).toBe(401);
          expect(await response.json()).toMatchObject({ code: "INVALID_TWO_FACTOR_COOKIE" });
        }
        await signIn("reset@example.test", trustedCookie);
        expect(
          (await call("/two-factor/verify-otp", peer.cookie, { code: peer.code })).status,
        ).toBe(200);
      } finally {
        revokeCredentialsAfterPasswordReset.mockImplementation(async () => {});
        prismaStub.$transaction.mockImplementation(prismaStub.runTransaction);
      }
    },
  );

  it("returns the retryable 503 on verification lookup failure before consuming the token", async () => {
    const { db, keys, hash, reset } = await resetFixture(true);
    try {
      const failed = await reset();
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({
        message:
          "We couldn't finish securing your account. Your password is unchanged — try the link again. Existing sign-ins and API keys may already have been revoked.",
      });
      expect(hash).not.toHaveBeenCalled();
      expect(
        revocationDb.$transaction.mock.calls.filter(([work]) => Array.isArray(work)),
      ).toHaveLength(0);
      expect(db.account?.[0]?.password).toBe("old-hash");
      expect(db.verification).toHaveLength(2);
      expect(db.session).toHaveLength(1);
      expect(keys.has("old-key")).toBe(true);
      expect((await reset()).status).toBe(200);
      expect(db.account?.[0]?.password).toBe("hash:new-password-12345");
      expect(db.verification).toHaveLength(0);
    } finally {
      revokeCredentialsAfterPasswordReset.mockImplementation(async () => {});
      prismaStub.$transaction.mockImplementation(prismaStub.runTransaction);
    }
  });

  it("refuses before commit on exhausted revocation retries; the very same link then works", async () => {
    const { db, keys, hash, reset } = await resetFixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const transact = revocationDb.$transaction.getMockImplementation();
    if (!transact) throw new Error("transaction mock missing");
    try {
      revocationDb.$transaction.mockImplementation((work: unknown) => {
        if (Array.isArray(work)) return Promise.reject(new TypeError("private query details"));
        return transact(work);
      });
      const failed = await reset();
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({
        message:
          "We couldn't finish securing your account. Your password is unchanged — try the link again. Existing sign-ins and API keys may already have been revoked.",
      });
      expect(
        revocationDb.$transaction.mock.calls.filter(([work]) => Array.isArray(work)),
      ).toHaveLength(3);
      expect(hash).not.toHaveBeenCalled();
      expect(db.account?.[0]?.password).toBe("old-hash");
      expect(db.verification).toHaveLength(2);
      expect(db.session).toHaveLength(1);
      expect(keys.has("old-key")).toBe(true);
      expect(log.mock.calls[0]?.[1]).toEqual({ userId: "reset-user", error: "TypeError" });
      revocationDb.$transaction.mockImplementation(transact);
      expect((await reset()).status).toBe(200);
      expect(db.account?.[0]?.password).toBe("hash:new-password-12345");
      expect(db.verification).toHaveLength(0);
      expect(db.session).toHaveLength(0);
      expect(keys.size).toBe(0);
    } finally {
      log.mockRestore();
      revokeCredentialsAfterPasswordReset.mockImplementation(async () => {});
      prismaStub.$transaction.mockImplementation(prismaStub.runTransaction);
    }
  });

  it("keeps the post-sweep after revoking all old sessions before password hashing", async () => {
    const { keys, hash, reset, db } = await resetFixture();
    try {
      hash.mockImplementation(async () => {
        expect(keys.size).toBe(0);
        expect(db.session).toHaveLength(0);
        // Simulate an independent fresh login, rather than an old session
        // (which the pre-sweep already prevents from authorizing a mint).
        keys.add("minted-in-gap");
        return "new-hash";
      });
      expect((await reset()).status).toBe(200);
      expect(hash).toHaveBeenCalledOnce();
      expect(
        revocationDb.$transaction.mock.calls.filter(([work]) => Array.isArray(work)),
      ).toHaveLength(3);
      expect(keys.size).toBe(0);
    } finally {
      revokeCredentialsAfterPasswordReset.mockImplementation(async () => {});
      prismaStub.$transaction.mockImplementation(prismaStub.runTransaction);
    }
  });

  it("keeps old sessions revoked when the password commits but all post-sweep retries fail", async () => {
    const { keys, hash, reset, db } = await resetFixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      hash.mockImplementation(async () => {
        expect(db.session).toHaveLength(0);
        const transact = revocationDb.$transaction.getMockImplementation();
        revocationDb.$transaction.mockImplementation((work: unknown) => {
          if (Array.isArray(work)) throw new Error("post-sweep unavailable");
          if (!transact) throw new Error("transaction mock missing");
          return transact(work);
        });
        return "new-hash";
      });
      expect((await reset()).status).toBe(500);
      expect(db.account?.[0]?.password).toBe("new-hash");
      expect(db.verification).toEqual([]);
      expect(db.user?.[0]?.emailVerified).toBe(true);
      expect(db.session).toHaveLength(0);
      expect(keys.size).toBe(0);
      // One pre-sweep, three post-sweep attempts, then three cleanup attempts.
      expect(
        revocationDb.$transaction.mock.calls.filter(([work]) => Array.isArray(work)),
      ).toHaveLength(7);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("SECURITY: password-reset credential revocation failed"),
        { userId: "reset-user", error: "Error" },
      );
    } finally {
      log.mockRestore();
      revokeCredentialsAfterPasswordReset.mockImplementation(async () => {});
      prismaStub.$transaction.mockImplementation(prismaStub.runTransaction);
    }
  });

  it.each(["mailed", "shown"])(
    "finalizes a %s link after post-sweep failure, verifying only mailbox proof",
    async (delivery) => {
      const { hash, reset, db } = await resetFixture();
      if (delivery === "shown") {
        db.session = [];
        db.verification =
          db.verification?.filter(
            (row) => !String(row.identifier).startsWith("reset-password-mailed:"),
          ) ?? [];
      }
      db.verification?.push(
        {
          id: "other",
          identifier: "reset-password:other-token",
          value: "reset-user",
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          id: "peer",
          identifier: "reset-password:peer-token",
          value: "peer",
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          id: "unrelated",
          identifier: "verify-email:unrelated",
          value: "reset-user",
          expiresAt: new Date(Date.now() + 60_000),
        },
      );
      const transact = revocationDb.$transaction.getMockImplementation();
      if (!transact) throw new Error("transaction mock missing");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        hash.mockImplementation(async () => {
          revocationDb.$transaction.mockImplementation(async (writes: unknown) => {
            if (Array.isArray(writes) && writes.includes("keys"))
              throw new Error("post-sweep unavailable");
            return transact(writes);
          });
          return "new-hash";
        });
        expect((await reset()).status).toBe(500);
        expect(db.account?.[0]?.password).toBe("new-hash");
        expect(db.user?.[0]?.emailVerified).toBe(delivery === "mailed");
        expect(db.verification?.map((row) => row.identifier)).toEqual([
          "reset-password:peer-token",
          "verify-email:unrelated",
        ]);
        expect(revocationDb.verification.deleteMany).toHaveBeenCalledWith({
          where: { value: "reset-user", identifier: { startsWith: "reset-password:" } },
        });
        expect((await reset("other-token")).status).toBe(400);
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("SECURITY: password-reset credential revocation failed"),
          { userId: "reset-user", error: "Error" },
        );
      } finally {
        log.mockRestore();
        revokeCredentialsAfterPasswordReset.mockImplementation(async () => {});
        prismaStub.$transaction.mockImplementation(prismaStub.runTransaction);
      }
    },
  );

  it("keeps the pre-sweep's revocation even if the reset later fails before commit", async () => {
    const { keys, hash, reset, db } = await resetFixture();
    try {
      hash.mockRejectedValue(new Error("hash unavailable"));
      expect((await reset()).status).toBe(500);
      expect(db.account?.[0]?.password).toBe("old-hash");
      expect(db.verification).toHaveLength(2);
      expect(db.session).toHaveLength(0);
      expect(keys.size).toBe(0);
      expect(
        revocationDb.$transaction.mock.calls.filter(([work]) => Array.isArray(work)),
      ).toHaveLength(1);
    } finally {
      revokeCredentialsAfterPasswordReset.mockImplementation(async () => {});
      prismaStub.$transaction.mockImplementation(prismaStub.runTransaction);
    }
  });

  it("refuses a shown link for an active unverified account before the pre-sweep can erase its live session", async () => {
    const { db, keys, hash, reset } = await resetFixture();
    db.verification =
      db.verification?.filter(
        (row) => !String(row.identifier).startsWith("reset-password-mailed:"),
      ) ?? [];
    try {
      const response = await reset();
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_TOKEN" });
      expect(db.session).toHaveLength(1);
      expect(keys.has("old-key")).toBe(true);
      expect(hash).not.toHaveBeenCalled();
      expect(
        revocationDb.$transaction.mock.calls.filter(([work]) => Array.isArray(work)),
      ).toHaveLength(0);
    } finally {
      revokeCredentialsAfterPasswordReset.mockImplementation(async () => {});
      prismaStub.$transaction.mockImplementation(prismaStub.runTransaction);
    }
  });

  it("leaves invalid/expired tokens to the endpoint and handles its query-token form", async () => {
    const { db, reset } = await resetFixture();
    try {
      expect((await reset("unknown")).status).toBe(400);
      const verification = db.verification?.[0];
      if (!verification) throw new Error("verification missing");
      verification.expiresAt = new Date(0);
      expect((await reset()).status).toBe(400);
      expect(
        revocationDb.$transaction.mock.calls.filter(([work]) => Array.isArray(work)),
      ).toHaveLength(0);
      const queryFixture = await resetFixture();
      expect((await queryFixture.reset("retry-token", true)).status).toBe(200);
    } finally {
      revokeCredentialsAfterPasswordReset.mockImplementation(async () => {});
      prismaStub.$transaction.mockImplementation(prismaStub.runTransaction);
    }
  });
});

describe("cookie cache renewal on Better Auth writes (real pinned handler)", () => {
  async function fixture(withGuard = true) {
    const { betterAuth: realBetterAuth } =
      await vi.importActual<typeof import("better-auth")>("better-auth");
    const { createAuthMiddleware } =
      await vi.importActual<typeof import("better-auth/api")>("better-auth/api");
    const { memoryAdapter } = await import("better-auth/adapters/memory");
    const before = options.hooks?.before;
    if (!before) throw new Error("before hook missing");
    const db: Record<string, Record<string, unknown>[]> = {
      user: [],
      account: [],
      session: [],
      verification: [],
    };
    const instance = realBetterAuth({
      baseURL: "https://app.example.test",
      secret: "disposable-cache-test-secret-with-no-external-use",
      database: memoryAdapter(db),
      logger: { disabled: true },
      rateLimit: { enabled: false },
      // Keep exercising the write guard with legacy cookies, even after the
      // production read path stops accepting the cache.
      session: { ...options.session, cookieCache: { enabled: true, maxAge: 60 } },
      emailAndPassword: {
        enabled: true,
        password: { hash: async (p) => p, verify: async () => true },
      },
      hooks: withGuard ? { before: createAuthMiddleware(before) } : undefined,
    });
    // Run any production Hono identity mount before the real Better Auth
    // handler. Its getSession boundary delegates to this same real instance,
    // so an accidentally restored Hono precheck adds a measurable DB lookup.
    const middleware: (typeof expectedIdentity)[] = [];
    const serverSource = readFileSync(
      new URL("../../../apps/server/src/index.ts", import.meta.url),
      "utf8",
    );
    for (const mount of serverSource.matchAll(
      /^app\.use\("\/api\/auth\/\*", expectedIdentity\);$/gm,
    )) {
      runInNewContext(mount[0], {
        app: { use: (_path: string, handler: typeof expectedIdentity) => middleware.push(handler) },
        expectedIdentity,
      });
    }
    cookieSurfaceGetSession.mockImplementation(instance.api.getSession);
    const call = async (
      path: string,
      method = "POST",
      cookie = "",
      body: unknown = {},
      expectedUser?: string,
    ) => {
      const request = new Request(`https://app.example.test/api/auth${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.test",
          cookie,
          ...(expectedUser ? { "X-Expected-User": expectedUser } : {}),
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      });
      const stash = new Map<string, unknown>();
      const context = {
        req: {
          raw: request,
          path: new URL(request.url).pathname,
          header: (name: string) => request.headers.get(name),
        },
        get: (key: string) => stash.get(key),
        set: (key: string, value: unknown) => stash.set(key, value),
        json: (body: unknown, status: number) => Response.json(body, { status }),
      } satisfies IdentityContext;
      let response: Response | undefined;
      const next = async (index: number): Promise<void> => {
        const handler = middleware[index];
        if (!handler) {
          response = await instance.handler(request);
          return;
        }
        const result = await handler(context, () => next(index + 1));
        if (result instanceof Response) response = result;
      };
      await next(0);
      if (!response) throw new Error("Auth handler did not respond");
      return response;
    };
    const response = await call("/sign-up/email", "POST", "", {
      email: "cache@example.test",
      name: "Before",
      password: "test-password-12345",
    });
    expect(response.status).toBe(200);
    const cookies = response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    expect(cookies).toContain("session_data=");
    return { db, call, cookies, instance };
  }

  it.each(["revoked", "expired"])(
    "production reads immediately refuse a %s session with a previously issued cache cookie",
    async (state) => {
      const { db, cookies } = await fixture(false);
      const { betterAuth: realBetterAuth } =
        await vi.importActual<typeof import("better-auth")>("better-auth");
      const { memoryAdapter } = await import("better-auth/adapters/memory");
      const instance = realBetterAuth({
        baseURL: "https://app.example.test",
        secret: "disposable-cache-test-secret-with-no-external-use",
        database: memoryAdapter(db),
        logger: { disabled: true },
        session: options.session,
      });
      const headers = new Headers({ cookie: cookies });
      expect(await instance.api.getSession({ headers })).toMatchObject({
        user: { name: "Before" },
      });
      if (state === "revoked") db.session = [];
      else if (db.session?.[0]) db.session[0].expiresAt = new Date(0);
      // Same session call as the server shell guard, with no query bypass.
      expect(await instance.api.getSession({ headers })).toBeNull();
      const response = await instance.handler(
        new Request("https://app.example.test/api/auth/get-session", { headers }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
    },
  );

  it("disables cookie caching for all production session consumers", () => {
    expect(options.session?.cookieCache?.enabled).toBe(false);
  });

  it("demonstrates the upstream renewal chain with the guard removed", async () => {
    const { db, call, cookies } = await fixture(false);
    db.session = [];
    const response = await call("/update-user", "POST", cookies, { name: "Renewed" });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(
      expect.arrayContaining([expect.stringMatching(/session_data=.+;.*Max-Age=60/i)]),
    );
  });

  it.each(["revoked", "expired"])(
    "rejects a %s session before it can renew its cache",
    async (state) => {
      const { db, call, cookies } = await fixture();
      if (state === "revoked") db.session = [];
      else if (db.session?.[0]) db.session[0].expiresAt = new Date(0);
      // The same signed cache still answers reads; only authenticated writes are fenced.
      const cached = await call("/get-session", "GET", cookies);
      expect(cached.status).toBe(200);
      expect(await cached.json()).toMatchObject({ user: { name: "Before" } });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await call("/update-user", "POST", cookies, { name: "Renewed" });
        expect(response.status).toBe(401);
        const setCookies = response.headers.getSetCookie();
        expect(setCookies).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/session_token=;.*Max-Age=0/i),
            expect.stringMatching(/session_data=;.*Max-Age=0/i),
          ]),
        );
        expect(
          setCookies
            .filter((entry) => /session_(token|data)=/.test(entry))
            .every((entry) => /Max-Age=0/i.test(entry)),
        ).toBe(true);
      }
      expect(db.user?.[0]?.name).toBe("Before");
    },
  );

  it.each(["present", "absent", "expired"])(
    "matches the expected owner and writes with one session lookup (%s cache)",
    async (cache) => {
      const { db, call, cookies, instance } = await fixture();
      const context = await instance.$context;
      const lookup = vi.spyOn(context.internalAdapter, "findSession");
      let cookie = cookies;
      if (cache === "absent")
        cookie = cookies
          .split("; ")
          .filter((c) => !c.includes("session_data="))
          .join("; ");
      if (cache === "expired") {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 61_000);
      }
      try {
        const response = await call(
          "/update-user",
          "POST",
          cookie,
          { name: "After" },
          String(db.user?.[0]?.id),
        );
        expect(response.status).toBe(200);
        expect(db.user?.[0]?.name).toBe("After");
        expect(lookup).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["/update-user", "/send-verification-email"])(
    "rejects a different expected owner before %s runs",
    async (path) => {
      const { db, call, cookies, instance } = await fixture();
      const context = await instance.$context;
      const lookup = vi.spyOn(context.internalAdapter, "findSession");
      const response = await call(
        path,
        "POST",
        cookies,
        { name: "Wrong", email: "cache@example.test" },
        "another-user",
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "IDENTITY_CHANGED" });
      expect(db.user?.[0]?.name).toBe("Before");
      expect(lookup).toHaveBeenCalledTimes(1);
    },
  );

  it("compares identity before the reset pre-sweep can revoke credentials", async () => {
    const { call, cookies, instance } = await fixture();
    const context = await instance.$context;
    const verification = vi.spyOn(context.internalAdapter, "findVerificationValue");
    const response = await call(
      "/reset-password",
      "POST",
      cookies,
      { token: "unused", newPassword: "test-password-54321" },
      "another-user",
    );
    expect(response.status).toBe(409);
    expect(verification).not.toHaveBeenCalled();
  });

  it.each(["/get-session", "/sign-out"])(
    "exempts %s from expected identity comparison",
    async (path) => {
      const { call, cookies } = await fixture();
      const response = await call(
        path,
        path === "/get-session" ? "GET" : "POST",
        cookies,
        {},
        "another-user",
      );
      expect(response.status).toBe(200);
    },
  );

  it.each(["/update-user", "/request-password-reset"])(
    "fails closed on a lookup outage before %s can run",
    async (path) => {
      const { db, call, cookies, instance } = await fixture();
      const context = await instance.$context;
      const lookup = vi
        .spyOn(context.internalAdapter, "findSession")
        .mockRejectedValue(new Error("private db details"));
      const tokenOnly = cookies
        .split("; ")
        .filter((c) => !c.includes("session_data="))
        .join("; ");
      const response = await call(
        path,
        "POST",
        tokenOnly,
        { name: "Wrong", email: "cache@example.test" },
        String(db.user?.[0]?.id),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "SESSION_UNAVAILABLE" });
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(db.user?.[0]?.name).toBe("Before");
      expect(lookup).toHaveBeenCalledTimes(1);
    },
  );

  it("allows a live session to update and renew normally", async () => {
    const { call, cookies } = await fixture();
    expect((await call("/update-user", "POST", cookies, { name: "After" })).status).toBe(200);
  });

  it("allows anonymous sign-in and sign-out with stale session cookies", async () => {
    const { db, call, cookies } = await fixture();
    db.session = [];
    expect(
      (
        await call("/sign-in/email", "POST", cookies, {
          email: "cache@example.test",
          password: "test-password-12345",
        })
      ).status,
    ).toBe(200);
    expect((await call("/sign-out", "POST", cookies)).status).toBe(200);
  });

  it("fails closed if the authoritative lookup fails, without renewing cookies", async () => {
    const { call, cookies, instance } = await fixture();
    const context = await instance.$context;
    vi.spyOn(context.internalAdapter, "findSession").mockRejectedValue(
      new Error("private db details"),
    );
    const response = await call("/update-user", "POST", cookies, { name: "After" });
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.text()).not.toContain("private db details");
  });
});
