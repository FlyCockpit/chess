import { Hono } from "hono";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock heavy dependencies so the module loads without Redis / env / auth.
// ---------------------------------------------------------------------------

vi.mock("@cockpit-chess/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

// Mutable env stub. The factory returns the OBJECT, not a spread, so the
// family-scaling tests below can mutate a budget and re-import the module
// under test — a spread would snapshot the defaults at first factory run and
// silently ignore every later mutation.
const envMock: Record<string, string | number | undefined> = {
  BETTER_AUTH_SECRET: "disposable-unit-mail-counter-secret",
  RATE_LIMIT_AUTH_POINTS: 30,
  RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
  RATE_LIMIT_RPC_POINTS: 100,
  RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
  RATE_LIMIT_EMAIL_POINTS: 3,
  RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
  TRUST_PROXY_HOPS: undefined,
};

vi.mock("@cockpit-chess/env/server", () => ({
  env: envMock,
}));

vi.mock("@cockpit-chess/queue", () => ({
  redisConnection: {},
}));

describe("runner claim surface budgets", () => {
  it("separates begin, poll and replay exchange and fails closed without insurance", async () => {
    const limiters = await import("./rate-limit");
    for (const [name, prefix, points, duration] of [
      ["runnerClaimBeginLimiter", "rl:runner-claim-begin", 20, 3600],
      ["runnerClaimPollLimiter", "rl:runner-claim-poll", 1200, 60],
      ["runnerClaimExchangeLimiter", "rl:runner-claim-exchange", 120, 60],
    ] as const) {
      const limiter = limiters[name];
      expect(limiter.keyPrefix).toBe(prefix);
      expect(limiter.points).toBe(points);
      expect(limiter.duration).toBe(duration);
      expect(Reflect.get(limiter, "options")).not.toHaveProperty("insuranceLimiter");
    }
  });
});

describe("account export budget", () => {
  it("protects pre-authentication traffic with a separate fail-closed IP bucket", async () => {
    const { accountExportIpLimiter, accountExportLimiter } = await import("./rate-limit");
    expect(accountExportIpLimiter.keyPrefix).toBe("rl:account-export-ip");
    expect(accountExportIpLimiter.points).toBe(120);
    expect(accountExportIpLimiter.duration).toBe(60);
    expect(Reflect.get(accountExportIpLimiter, "options")).not.toHaveProperty("insuranceLimiter");
    expect(accountExportIpLimiter.keyPrefix).not.toBe(accountExportLimiter.keyPrefix);
  });
  it("has an independent fail-closed three-per-hour bucket", async () => {
    const { accountExportLimiter, rpcLimiter, openrouterLimiter } = await import("./rate-limit");
    expect(accountExportLimiter.keyPrefix).toBe("rl:account-export");
    expect(accountExportLimiter.points).toBe(3);
    expect(accountExportLimiter.duration).toBe(3600);
    expect(Reflect.get(accountExportLimiter, "options")).not.toHaveProperty("insuranceLimiter");
    expect(
      new Set([accountExportLimiter.keyPrefix, rpcLimiter.keyPrefix, openrouterLimiter.keyPrefix])
        .size,
    ).toBe(3);
  });
});

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "10.0.0.1" } }));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: mockGetConnInfo,
}));

// Mock RateLimiterRedis so module-level `authLimiter` and `rpcLimiter`
// instantiate without a real Redis connection. We don't test those instances
// directly — we test `createRateLimiterMiddleware` with a RateLimiterMemory.
vi.mock("rate-limiter-flexible", async (importOriginal) => {
  const original = await importOriginal<typeof import("rate-limiter-flexible")>();
  return {
    ...original,
    // Replace RateLimiterRedis with RateLimiterMemory so module-level
    // constructors don't need a live Redis client. The constructor options
    // are kept so tests can assert how each limiter was built.
    RateLimiterRedis: class extends original.RateLimiterMemory {
      readonly options: ConstructorParameters<typeof original.RateLimiterMemory>[0];
      constructor(options: ConstructorParameters<typeof original.RateLimiterMemory>[0]) {
        super(options);
        this.options = options;
      }
    },
  };
});

const { createRateLimiterMiddleware } = await import("./rate-limit.js");

describe("mail recipient key privacy", () => {
  const vectors = [
    ["emailRecipientLimiter", "rl:email-to", 3, "em:zSdF73qncG9XOatmvrV14tSUaoYZ8cj1sWrzPLhhkw8"],
    ["signupRecipientLimiter", "rl:signup-to", 6, "em:byvSj0ipOD-pRjw-RcR6ITZ7nWFppPAW0YIquUtGGXA"],
    [
      "signinRecipientLimiter",
      "rl:signin-to",
      10,
      "em:NgVWfJD4a8dBTWyQoIZ1qfeIoGBU9IZzj_Tze6sBLCg",
    ],
  ] as const;

  it("matches independently generated HMAC-SHA256 vectors with a distinct purpose per mail namespace", async () => {
    const { emailRateLimitKey } = await import("./rate-limit.js");
    const keys = vectors.map(([, purpose, , expected]) => {
      const key = emailRateLimitKey("  Victim@Example.COM  ", purpose);
      expect(key).toBe(expected);
      expect(key).toMatch(/^em:[A-Za-z0-9_-]{43}$/);
      expect(key).not.toContain("victim");
      expect(key).not.toContain("@");
      return key;
    });
    expect(new Set(keys).size).toBe(3);
  });

  it("is stable across replica module loads, changes with the secret and preserves distinct mailboxes/tags", async () => {
    const { emailRateLimitKey } = await import("./rate-limit.js");
    const secret = envMock.BETTER_AUTH_SECRET;
    const original = emailRateLimitKey("victim@example.com", "rl:email-to");
    try {
      vi.resetModules();
      const replica = await import("./rate-limit.js");
      expect(replica.emailRateLimitKey("VICTIM@example.com", "rl:email-to")).toBe(original);
      for (const email of ["other@example.com", "victim+tag@example.com", "vic.tim@example.com"]) {
        expect(replica.emailRateLimitKey(email, "rl:email-to")).not.toBe(original);
      }
      envMock.BETTER_AUTH_SECRET = "another-disposable-unit-mail-secret";
      expect(replica.emailRateLimitKey("victim@example.com", "rl:email-to")).not.toBe(original);
    } finally {
      envMock.BETTER_AUTH_SECRET = secret;
      vi.resetModules();
    }
  });

  it.each(vectors)(
    "%s passes only its opaque digest to the counter and keeps its budget/window",
    async (name, purpose, points, expected) => {
      const l = await import("./rate-limit.js");
      const { emailRecipientLimit } = await import("./email-recipient-limit.js");
      const limiter = l[name];
      expect(limiter.keyPrefix).toBe(purpose);
      expect(limiter.points).toBe(points);
      expect(limiter).toHaveProperty("duration", 3600);
      expect(limiter).toHaveProperty("blockDuration", 0);
      const consume = vi.spyOn(limiter, "consume");
      const app = new Hono();
      app.use("/mail", emailRecipientLimit(limiter));
      app.post("/mail", (c) => c.json({ status: true }));
      try {
        expect(
          (
            await app.request("/mail", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email: "Victim@Example.com" }),
            })
          ).status,
        ).toBe(200);
        expect(consume).toHaveBeenCalledExactlyOnceWith(expected);
      } finally {
        consume.mockRestore();
      }
    },
  );

  it("refunds deferred sign-in on the same opaque key it reserved", async () => {
    const { signinRecipientLimiter } = await import("./rate-limit.js");
    const { emailRecipientLimit, FORM_OR_JSON_MEDIA_TYPES } = await import(
      "./email-recipient-limit.js"
    );
    const consume = vi.spyOn(signinRecipientLimiter, "consume");
    const reward = vi.spyOn(signinRecipientLimiter, "reward");
    const app = new Hono();
    app.use(
      "/mail",
      emailRecipientLimit(signinRecipientLimiter, FORM_OR_JSON_MEDIA_TYPES, () => false),
    );
    app.post("/mail", (c) => c.json({ status: true }));
    try {
      expect(
        (
          await app.request("/mail", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "victim@example.com" }),
          })
        ).status,
      ).toBe(200);
      const key = vectors[2][3];
      expect(consume).toHaveBeenCalledExactlyOnceWith(key);
      expect(reward).toHaveBeenCalledExactlyOnceWith(key);
    } finally {
      consume.mockRestore();
      reward.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Test: rate limiter middleware returns 429 with correct headers
// ---------------------------------------------------------------------------
// Trade-off: We use RateLimiterMemory instead of a real Redis-backed limiter.
// This means the test does NOT verify Redis round-trips, but it does exercise
// the full Hono middleware path including header serialisation, 429 body, and
// the consume → reject flow. For a true integration test against Redis, spin
// up a test container and replace RateLimiterMemory with RateLimiterRedis.
// ---------------------------------------------------------------------------

const LIMIT = 3;

describe("createRateLimiterMiddleware", () => {
  let app: Hono;

  beforeEach(() => {
    envMock.TRUST_PROXY_HOPS = undefined;
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.1" } });

    // Fresh limiter + app per test so counters reset.
    const limiter = new RateLimiterMemory({
      keyPrefix: "test",
      points: LIMIT,
      duration: 60,
    });

    app = new Hono();
    app.use("/*", createRateLimiterMiddleware(limiter));
    app.get("/ping", (c) => c.text("pong"));
  });

  it("allows requests within the limit and returns rate-limit headers", async () => {
    const res = await app.request("/ping");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(LIMIT));
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("returns 429 with all rate-limit headers on the (limit + 1)th request", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.2" } });

    // Exhaust the allowance
    for (let i = 0; i < LIMIT; i++) {
      const res = await app.request("/ping");
      expect(res.status).toBe(200);
    }

    // The next request should be rejected
    const rejected = await app.request("/ping");

    expect(rejected.status).toBe(429);

    // Verify all four rate-limit headers are present and non-empty
    expect(rejected.headers.get("X-RateLimit-Limit")).toBe(String(LIMIT));
    expect(rejected.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(rejected.headers.get("X-RateLimit-Reset")).toBeTruthy();
    expect(rejected.headers.get("Retry-After")).toBeTruthy();

    // Verify numeric values are sensible
    const reset = Number(rejected.headers.get("X-RateLimit-Reset"));
    expect(reset).toBeGreaterThan(0);

    const retryAfter = Number(rejected.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);

    // Verify response body
    const body = await rejected.json();
    expect(body).toEqual({ error: "Too many attempts. Please wait a moment and try again." });
  });

  it("tracks limits per IP independently", async () => {
    // Exhaust allowance for IP A
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.3" } });
    for (let i = 0; i < LIMIT; i++) {
      await app.request("/ping");
    }

    // IP A is blocked
    const blockedA = await app.request("/ping");
    expect(blockedA.status).toBe(429);

    // IP B still has its full allowance
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.4" } });
    const allowedB = await app.request("/ping");
    expect(allowedB.status).toBe(200);
  });

  it("behind one counted proxy (TRUST_PROXY_HOPS=1), keys on the proxy-appended client IP — not the spoofable leftmost X-Forwarded-For", async () => {
    // Socket peer is the proxy. A trusted proxy appends the real client IP as
    // the rightmost entry; the client controls only the left.
    envMock.TRUST_PROXY_HOPS = 1;
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.5" } });

    for (let i = 0; i < LIMIT; i++) {
      const res = await app.request("/ping", {
        // Vary the spoofed leftmost entry every request; the proxy-appended
        // real client (198.51.100.7) stays constant.
        headers: { "x-forwarded-for": `203.0.113.${i}, 198.51.100.7` },
      });
      expect(res.status).toBe(200);
    }

    const rejected = await app.request("/ping", {
      headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.7" },
    });
    // Throttled despite a fresh spoofed leftmost value: the key is the constant
    // proxy-appended client IP, so X-Forwarded-For spoofing can't escape it.
    expect(rejected.status).toBe(429);
  });

  it("with TRUST_PROXY_HOPS unset (0), a private peer cannot pick its bucket via X-Forwarded-For", async () => {
    // A LAN caller varying a public-looking X-Forwarded-For still
    // shares its socket bucket (behind an uncounted proxy, everyone does).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetConnInfo.mockReturnValue({ remote: { address: "192.168.1.20" } });
    for (let i = 0; i < LIMIT; i++) {
      const res = await app.request("/ping", {
        headers: { "x-forwarded-for": `198.51.100.${i}` },
      });
      expect(res.status).toBe(200);
    }
    const rejected = await app.request("/ping", {
      headers: { "x-forwarded-for": "198.51.100.99" },
    });
    expect(rejected.status).toBe(429);
    warn.mockRestore();
  });

  it("on a bare deployment (public socket peer), ignores X-Forwarded-For entirely", async () => {
    // No proxy: the socket peer is the real, public client. A forged
    // X-Forwarded-For must not let it dodge the limit.
    mockGetConnInfo.mockReturnValue({ remote: { address: "198.51.100.50" } });

    for (let i = 0; i < LIMIT; i++) {
      const res = await app.request("/ping", {
        headers: { "x-forwarded-for": `203.0.113.${i}` },
      });
      expect(res.status).toBe(200);
    }

    const rejected = await app.request("/ping", {
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    expect(rejected.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Test: Redis-outage fail mode (fail-open vs fail-closed)
// ---------------------------------------------------------------------------
// A `RateLimiterRes` throw means "over the limit" (→ 429). Any OTHER throw
// means the backing store (Redis) is unavailable. Fail-open limiters let that
// request through; fail-closed limiters (auth/signup) reject it with a 503 so
// credential-stuffing / signup-spam protection can't silently vanish. We drive
// both by stubbing a limiter whose `consume` rejects with a plain Error.
// ---------------------------------------------------------------------------

describe("createRateLimiterMiddleware — Redis outage handling", () => {
  function makeApp(consumeReject: unknown, options?: { failClosed?: boolean }) {
    const limiter = {
      points: LIMIT,
      consume: vi.fn().mockRejectedValue(consumeReject),
    };
    const app = new Hono();
    app.use("/*", createRateLimiterMiddleware(limiter, options));
    app.get("/ping", (c) => c.text("pong"));
    return app;
  }

  it("fails open by default when the store errors (request passes through)", async () => {
    const app = makeApp(new Error("redis connection refused"));
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });

  it("fails closed with a 503 + Retry-After when configured and the store errors", async () => {
    const app = makeApp(new Error("redis connection refused"), { failClosed: true });
    const res = await app.request("/ping");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body).toEqual({
      error: "Service temporarily unavailable. Please try again in a moment.",
    });
  });

  it("still returns 429 (not 503) for an over-limit RateLimiterRes even when failClosed", async () => {
    // An over-limit rejection must stay a 429 regardless of fail mode — the
    // fail-closed branch is only for store connectivity errors.
    const overLimit = new RateLimiterRes(0, 1000, LIMIT, undefined);
    const app = makeApp(overLimit, { failClosed: true });
    const res = await app.request("/ping");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "Too many attempts. Please wait a moment and try again.",
    });
  });
});

// ---------------------------------------------------------------------------
// Test: each surface limiter has its own bucket
// ---------------------------------------------------------------------------
// The regression this guards: a shared `rpcLimiter` mounted on
// multiple surfaces, so every surface shared a single 100/min bucket keyed
// `rl:rpc`. One busy surface exhausted the entire API budget for
// the minute.
// ---------------------------------------------------------------------------

describe("surface limiters", () => {
  it("do not share a key prefix or a budget", async () => {
    const { rpcLimiter, cliLimiter, ssrLimiter } = await import("./rate-limit.js");
    const limiters = [rpcLimiter, cliLimiter, ssrLimiter];
    const prefixes = limiters.map((l) => (l as unknown as { keyPrefix: string }).keyPrefix);
    expect(new Set(prefixes).size).toBe(limiters.length);

    const key = "same-caller";
    for (let i = 0; i < rpcLimiter.points; i++) await rpcLimiter.consume(key);
    await expect(rpcLimiter.consume(key)).rejects.toBeInstanceOf(RateLimiterRes);
    await expect(cliLimiter.consume(key)).resolves.toBeDefined();
  });
});

describe("rate-limit budget families", () => {
  async function importLimiters() {
    return import("./rate-limit.js");
  }

  afterEach(() => {
    vi.resetModules();
    Object.assign(envMock, {
      RATE_LIMIT_AUTH_POINTS: 30,
      RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
      RATE_LIMIT_RPC_POINTS: 100,
      RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
      RATE_LIMIT_EMAIL_POINTS: 3,
      RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
    });
  });

  it("builds fail-closed limiters without an in-memory insurance limiter", async () => {
    const l = await importLimiters();
    const options = (limiter: unknown) => (limiter as { options: Record<string, unknown> }).options;
    // Insurance would absorb a Redis outage before `failClosed` could 503.
    expect(options(l.authLimiter).insuranceLimiter).toBeUndefined();
    expect(options(l.signupLimiter).insuranceLimiter).toBeUndefined();
    expect(options(l.signupRecipientLimiter).insuranceLimiter).toBeUndefined();
    expect(options(l.devicePollLimiter).insuranceLimiter).toBeUndefined();
    expect(options(l.runnerWsConnectIpLimiter).insuranceLimiter).toBeUndefined();
    expect(options(l.runnerWsConnectMachineLimiter).insuranceLimiter).toBeUndefined();
    // Fail-open surfaces keep it.
    expect(options(l.cliLimiter).insuranceLimiter).toBeDefined();
  });

  it("reproduces every shipped default when no budget is overridden", async () => {
    const l = await importLimiters();
    // AUTH family (reference: general auth 30/60s, 5-min block).
    expect(l.authLimiter.points).toBe(30);
    expect(l.credentialLimiter.points).toBe(10);
    expect(l.credentialBurstLimiter.points).toBe(3);
    expect(l.signupLimiter.points).toBe(10);
    expect(l.twoFactorOtpLimiter.points).toBe(3);
    expect(l.twoFactorOtpLimiter).toHaveProperty("duration", 900);
    // EMAIL family (reference: 3 per hour).
    expect(l.emailRecipientLimiter.points).toBe(3);
    expect(l.signupRecipientLimiter.points).toBe(6);
    expect(l.signinRecipientLimiter.points).toBe(10);
    expect(l.emailRecipientLimiter).toHaveProperty("blockDuration", 0);

    expect(l.rpcLimiter.points).toBe(100);
    expect(l.readyLimiter.points).toBe(60);
    expect(l.ssrLimiter.points).toBe(300);
  });

  it("doubling RATE_LIMIT_AUTH_POINTS doubles every auth-family limiter's points, windows untouched", async () => {
    envMock.RATE_LIMIT_AUTH_POINTS = 60; // 2x the 30 reference
    const l = await importLimiters();
    // Reference member and every relative member scale by the same 2x.
    expect(l.authLimiter.points).toBe(60);
    expect(l.credentialLimiter.points).toBe(20);
    expect(l.credentialBurstLimiter.points).toBe(6);
    expect(l.signupLimiter.points).toBe(20);
    expect(l.twoFactorOtpLimiter.points).toBe(6);
    // Points-only override: windows and blocks keep their designed values.
    expect(l.credentialLimiter).toHaveProperty("duration", 60);
    expect(l.credentialLimiter).toHaveProperty("blockDuration", 300);
    expect(l.signupLimiter).toHaveProperty("duration", 3600);
    expect(l.credentialBurstLimiter).toHaveProperty("duration", 10);
    // Other families are untouched.
    expect(l.rpcLimiter.points).toBe(100);
    expect(l.emailRecipientLimiter.points).toBe(3);
  });

  it("doubling RATE_LIMIT_AUTH_WINDOW_SECONDS doubles every auth-family window and block", async () => {
    envMock.RATE_LIMIT_AUTH_WINDOW_SECONDS = 120; // 2x the 60s reference
    const l = await importLimiters();
    expect(l.authLimiter).toHaveProperty("duration", 120);
    expect(l.authLimiter).toHaveProperty("blockDuration", 600);
    expect(l.credentialBurstLimiter).toHaveProperty("duration", 20);
    expect(l.signupLimiter).toHaveProperty("duration", 7200);
    expect(l.signupLimiter).toHaveProperty("blockDuration", 1800);
    expect(l.twoFactorOtpLimiter).toHaveProperty("duration", 1800);
    // Points are untouched by a window override.
    expect(l.credentialLimiter.points).toBe(10);
  });

  it("RATE_LIMIT_EMAIL_POINTS=0 disables the whole recipient family", async () => {
    envMock.RATE_LIMIT_EMAIL_POINTS = 0;
    const l = await importLimiters();
    expect(l.emailRecipientLimiter.points).toBe(0);
    expect(l.signupRecipientLimiter.points).toBe(0);
    expect(l.signinRecipientLimiter.points).toBe(0);
  });
});

describe("public signup abuse controls together", () => {
  async function signupApp() {
    vi.resetModules();
    envMock.TRUST_PROXY_HOPS = undefined;
    mockGetConnInfo.mockReturnValue({ remote: { address: "198.51.100.10" } });
    const l = await import("./rate-limit.js");
    const { emailRecipientLimit, FORM_OR_JSON_MEDIA_TYPES } = await import(
      "./email-recipient-limit.js"
    );
    const { adminBootstrapMarker } = await import("./signup-gate.js");
    const app = new Hono();
    const delivered = vi.fn();
    // Same order and fail modes as server/index.ts. Memory replaces only the
    // Redis store; the shipped budgets and middleware are exercised together.
    app.use("/api/auth/sign-up/email", adminBootstrapMarker(new Set(["admin@example.test"])));
    app.use(
      "/api/auth/sign-up/*",
      l.createRateLimiterMiddleware(l.signupLimiter, { failClosed: true }),
    );
    app.use("/api/auth/*", l.createRateLimiterMiddleware(l.authLimiter, { failClosed: true }));
    app.use(
      "/api/auth/sign-up/email",
      emailRecipientLimit(l.signupRecipientLimiter, FORM_OR_JSON_MEDIA_TYPES),
    );
    app.post("/api/auth/sign-up/email", async (c) => {
      delivered(await c.req.json());
      return c.json({ token: null, user: null });
    });
    app.post("/api/auth/request-password-reset", (c) => c.json({ status: true }));
    const signup = (email: string) =>
      app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "long-enough-password" }),
      });
    return { app, l, signup, delivered };
  }

  it("shares ten signup attempts behind a NAT without spending the independent recovery allowance", async () => {
    const { app, signup, delivered } = await signupApp();
    for (let i = 0; i < 10; i++) {
      expect((await signup(`person-${i}@example.test`)).status).toBe(200);
    }
    const blocked = await signup("admin@example.test");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(delivered).toHaveBeenCalledTimes(10);
    // More rejected attempts than the general auth bucket could absorb if
    // signup rejection were mounted after it. Recovery must still work.
    for (let i = 0; i < 30; i++) {
      expect((await signup(`blocked-${i}@example.test`)).status).toBe(429);
    }
    // The signup limiter rejects before charging the more generous auth
    // bucket. A shared-NAT signup flood must leave recovery reachable.
    expect((await app.request("/api/auth/request-password-reset", { method: "POST" })).status).toBe(
      200,
    );
    mockGetConnInfo.mockReturnValue({ remote: { address: "198.51.100.11" } });
    expect((await signup("new-network@example.test")).status).toBe(200);
  });

  it("keeps the six-per-recipient ceiling across changing caller IPs, including admin-listed addresses", async () => {
    const { signup, delivered } = await signupApp();
    for (let i = 0; i < 7; i++) {
      mockGetConnInfo.mockReturnValue({ remote: { address: `198.51.100.${20 + i}` } });
      const response = await signup("admin@example.test");
      expect(response.status).toBe(i < 6 ? 200 : 429);
    }
    expect(delivered).toHaveBeenCalledTimes(6);
  });

  it.each(["signupLimiter", "authLimiter"] as const)(
    "fails closed before delivery when %s loses Valkey",
    async (name) => {
      const { l, signup, delivered } = await signupApp();
      const consume = vi
        .spyOn(l[name], "consume")
        .mockRejectedValue(new Error("Valkey unavailable"));
      const recipient = vi.spyOn(l.signupRecipientLimiter, "consume");
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        for (const email of ["new@example.test", "admin@example.test", "not-an-address"]) {
          const response = await signup(email);
          expect(response.status).toBe(503);
          expect(response.headers.get("Retry-After")).toBe("5");
        }
        expect(delivered).not.toHaveBeenCalled();
        expect(recipient).not.toHaveBeenCalled();
      } finally {
        consume.mockRestore();
        recipient.mockRestore();
        error.mockRestore();
      }
    },
  );

  it("allows delivery when only the recipient store fails while the IP ceiling still applies", async () => {
    const { l, signup, delivered } = await signupApp();
    const consume = vi
      .spyOn(l.signupRecipientLimiter, "consume")
      .mockRejectedValue(new Error("recipient store unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 10; i++) {
        expect((await signup("same@example.test")).status).toBe(200);
      }
      expect((await signup("same@example.test")).status).toBe(429);
      expect(delivered).toHaveBeenCalledTimes(10);
      expect(consume).toHaveBeenCalledTimes(10);
    } finally {
      consume.mockRestore();
      error.mockRestore();
    }
  });
});

describe("runner WebSocket connection budgets", () => {
  it("separates pre-auth IP, authenticated machine and existing CLI/RPC buckets", async () => {
    const l = await import("./rate-limit.js");
    expect(l.runnerWsConnectIpLimiter.keyPrefix).toBe("rl:runner-ws-connect-ip");
    expect(l.runnerWsConnectMachineLimiter.keyPrefix).toBe("rl:runner-ws-connect-machine");
    expect(l.runnerWsConnectIpLimiter.points).toBe(240);
    expect(l.runnerWsConnectMachineLimiter.points).toBe(12);
    const key = "runner-budget-fixture";
    for (let i = 0; i < l.runnerWsConnectMachineLimiter.points; i++)
      await l.runnerWsConnectMachineLimiter.consume(key);
    await expect(l.runnerWsConnectMachineLimiter.consume(key)).rejects.toBeInstanceOf(
      RateLimiterRes,
    );
    await expect(l.runnerWsConnectIpLimiter.consume(key)).resolves.toBeDefined();
    await expect(l.cliIpLimiter.consume(key)).resolves.toBeDefined();
    await expect(l.rpcLimiter.consume(key)).resolves.toBeDefined();
  });
});
