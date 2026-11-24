import { describe, expect, it, vi } from "vitest";

// Capture the options object handed to `betterAuth` without constructing a
// real instance (which would need a database adapter and a validated env).
const betterAuth = vi.fn((options: unknown) => ({ options }));
vi.mock("better-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("better-auth")>()),
  betterAuth,
}));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => ({}) }));
// Identity: the captured hook is then the plain handler, re-wrapped below.
vi.mock("better-auth/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("better-auth/api")>()),
  createAuthMiddleware: (fn: unknown) => fn,
}));
vi.mock("better-auth/plugins", () => ({
  admin: () => ({ id: "admin" }),
  deviceAuthorization: () => ({ id: "device-authorization" }),
  genericOAuth: () => ({ id: "generic-oauth" }),
  twoFactor: () => ({ id: "two-factor" }),
}));
vi.mock("@better-auth/api-key", () => ({ apiKey: () => ({ id: "api-key" }) }));
vi.mock("@cockpit-chess/db", () => ({ default: {} }));
const envState = vi.hoisted(() => ({ signupEnabled: true }));
vi.mock("@cockpit-chess/env/server", () => ({
  ADMIN_EMAILS: new Set<string>(),
  FORCE_SSO: false,
  get SIGNUP_ENABLED() {
    return envState.signupEnabled;
  },
  SSO_ENABLED: false,
  env: { BETTER_AUTH_URL: "https://app.example.test", NODE_ENV: "test" },
}));
vi.mock("@cockpit-chess/mailer", () => ({
  isEmailConfigured: () => false,
  renderResetPassword: vi.fn(),
  renderTwoFactorOtp: vi.fn(),
  renderVerifyEmail: vi.fn(),
  sendEmail: vi.fn(),
}));

await import("./index");

type CapturedOptions = {
  emailAndPassword?: Record<string, unknown>;
  user?: Record<string, unknown>;
  hooks?: { after?: unknown };
  databaseHooks?: { user?: Record<string, unknown> };
};

const options = betterAuth.mock.calls[0]?.[0] as CapturedOptions;

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
    const instance = realBetterAuth({
      baseURL: "https://app.example.test",
      secret: "disposable-unit-test-secret-with-no-external-use",
      database: countingAdapter,
      rateLimit: { enabled: false },
      user: options.user,
      emailAndPassword: { ...options.emailAndPassword, enabled: true },
      emailVerification: { sendOnSignUp: true, sendVerificationEmail: async () => {} },
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
    return { db, signUp, countAdapterCalls };
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
});
