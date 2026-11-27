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
const quarantineUntrustedPasswordWrite = vi.fn(async (_userId: string, _opts?: unknown) => {});
vi.mock("./credential-revocation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credential-revocation")>()),
  revokeCredentialsAfterPasswordReset,
  revokeCredentialsAfterPasswordChange,
  quarantineUntrustedPasswordWrite,
}));
const recordResetLinkMailed = vi.fn(async (_input: unknown) => true);
const verifyEmailIfResetLinkWasMailed = vi.fn(async (_token: string) => true);
vi.mock("./password-reset-links.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./password-reset-links")>()),
  recordResetLinkMailed,
  verifyEmailIfResetLinkWasMailed,
}));
vi.mock("better-auth/plugins", () => ({
  admin: () => ({ id: "admin" }),
  deviceAuthorization: () => ({ id: "device-authorization" }),
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
        return typeof have === "string" && have.startsWith(String(want.startsWith));
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
      findUnique: async ({ where }: { where: { id: string } }) => {
        const user = table("user").find((row) => row.id === where.id);
        if (!user) return null;
        const now = new Date();
        return {
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
    user: { findUnique: async () => ({ locale: "en-US" }) },
    verification: {
      // The password-write lock's reset-token lookup (password-write-lock.ts).
      findFirst: findVerification,
      deleteMany: (args: unknown) => ({ op: "deleteResetLinks", args }),
    },
    $executeRaw: (..._sql: unknown[]) => ({ op: "lockSetPasswordLinks" }),
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

const { passwordPepper } = await import("./index");
const { sendEmail } = await import("@cockpit-chess/mailer");
const { withPasswordWriteLock } = await import("./password-write-lock");

/** The cleanup batches (`$transaction([...])`) recorded since the last clear. */
const cleanupBatches = () =>
  prismaStub.$transaction.mock.calls.map(([arg]) => arg).filter((arg) => Array.isArray(arg));
const cleanupBatchFor = (userId: string) => [
  { op: "lockSetPasswordLinks" },
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

type CapturedOptions = {
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
  hooks?: {
    before?: (ctx: { path: string; body: unknown; query?: unknown }) => Promise<void>;
    after?: (ctx: {
      path: string;
      body: unknown;
      query?: unknown;
      context: { returned: unknown };
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

  // A spent link verifies the email only if it was mailed (password-reset-links.ts).
  it("records a mailed forgot-password link, and checks every spent link after the reset", async () => {
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

    verifyEmailIfResetLinkWasMailed.mockClear();
    await options.hooks?.after?.({
      path: "/reset-password",
      body: { token: "tok", newPassword: "x" },
      context: { returned: { status: true } },
    });
    expect(verifyEmailIfResetLinkWasMailed).toHaveBeenCalledWith("tok");

    verifyEmailIfResetLinkWasMailed.mockClear();
    await options.hooks?.after?.({
      path: "/reset-password",
      body: { token: "tok", newPassword: "x" },
      context: { returned: { status: "BAD_REQUEST" } },
    });
    expect(verifyEmailIfResetLinkWasMailed).not.toHaveBeenCalled();
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

  it("keeps a finished reset a success when the verification step fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    verifyEmailIfResetLinkWasMailed.mockRejectedValueOnce(new Error("db down"));
    try {
      await expect(
        options.hooks?.after?.({
          path: "/reset-password",
          body: { token: "tok" },
          context: { returned: { status: true } },
        }),
      ).resolves.toBeUndefined();
      expect(errorLog).toHaveBeenCalledWith(
        "[auth] verifying the email of a mailed reset link failed:",
        "Error: db down",
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  // A link the admin was shown is spendable only while the invite is pending
  // (password-reset-links.ts `isResetLinkRedeemable`).
  it("refuses a shown reset link for an active account before Better-Auth spends it", async () => {
    const before = options.hooks?.before;
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
      verifyEmailIfResetLinkWasMailed.mockClear();

      const res = await resetPassword(instance, "shown-pending");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: true });
      expect(passwordOf(db, userId)).not.toBe(ownPassword);
      // The after-hook checked the spent token; shown, so it verified nothing.
      expect(verifyEmailIfResetLinkWasMailed).toHaveBeenCalledWith("shown-pending");
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
