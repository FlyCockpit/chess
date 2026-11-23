import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { beforeEach, describe, expect, it, vi } from "vitest";

// rate-limit.ts opens Redis at import time and the bootstrap helpers import
// Prisma/Better-Auth; every dependency is injected below instead.
vi.mock("./rate-limit.js", async () => {
  const { RateLimiterRes } = await import("rate-limiter-flexible");
  return {
    setupLimiter: { points: 0, consume: vi.fn() },
    createRateLimiterMiddleware:
      (limiter: { consume: (key: string) => Promise<unknown> }) =>
      async (
        c: { json: (body: unknown, status: number) => Response },
        next: () => Promise<void>,
      ) => {
        try {
          await limiter.consume("ip");
        } catch (err) {
          if (err instanceof RateLimiterRes) return c.json({ error: "Too many attempts" }, 429);
          return c.json({ error: "unavailable" }, 503);
        }
        await next();
      },
  };
});
vi.mock("./client-ip.js", () => ({ resolveClientIp: () => "203.0.113.5" }));
vi.mock("@cockpit-chess/api/lib/admin-bootstrap", () => ({ bootstrapFirstAdmin: vi.fn() }));

const {
  mountSetupRoutes,
  SETUP_ADMIN_PATH,
  SETUP_AUDIT_EVENT,
  SETUP_LINK_TTL_SECONDS,
  setupKeyMatches,
} = await import("./setup-routes.js");
const { bootstrapFirstAdmin } = await import("@cockpit-chess/api/lib/admin-bootstrap");

const KEY = "Qm7vT2xK9pL4wN8rB3cZ6hJ1dF5sG0yU-setup";
const LINK = {
  url: "https://app.example.com/api/auth/reset-password/tok?callbackURL=x",
  expiresAt: new Date("2026-11-23T13:00:00Z"),
};
const READY = { kind: "ready", ...LINK } as const;

function build(overrides: Partial<Parameters<typeof mountSetupRoutes>[1]> = {}) {
  const audit = vi.fn();
  const bootstrap = vi.fn().mockResolvedValue(READY);
  const limiter = new RateLimiterMemory({ points: 100, duration: 60 });
  const app = new Hono();
  mountSetupRoutes(app, {
    setupKey: KEY,
    passwordSignInEnabled: true,
    limiter: limiter as never,
    bootstrap,
    audit,
    ...overrides,
  });
  return { app, audit, bootstrap };
}

function post(app: Hono, body: unknown, init: RequestInit = {}) {
  return app.request(SETUP_ADMIN_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

function outcomes(audit: ReturnType<typeof vi.fn>) {
  return audit.mock.calls.map((call) => call[0].outcome);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setup route — existence", () => {
  it("is absent (404 for every method) while SETUP_KEY is unset", async () => {
    const { app, audit, bootstrap } = build({ setupKey: undefined });

    expect((await post(app, { key: KEY, email: "owner@example.com" })).status).toBe(404);
    expect((await app.request(SETUP_ADMIN_PATH)).status).toBe(404);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("answers only POST while SETUP_KEY is set", async () => {
    const { app, audit } = build();

    const res = await app.request(SETUP_ADMIN_PATH);
    expect(res.status).toBe(405);
    expect(outcomes(audit)).toEqual(["invalid_request"]);
  });
});

describe("setup route — key", () => {
  it("refuses a wrong key before reading anything else, and audits it", async () => {
    const { app, audit, bootstrap } = build();

    const res = await post(app, { key: `${KEY}x`, email: "owner@example.com" });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_key" });
    expect(bootstrap).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    const entry = audit.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      event: SETUP_AUDIT_EVENT,
      outcome: "invalid_key",
      status: 401,
      ip: "203.0.113.5",
    });
    // No secret and no caller-supplied address in the audit line.
    expect(JSON.stringify(entry)).not.toContain(KEY);
    expect(JSON.stringify(entry)).not.toContain("owner@example.com");
  });

  it("treats a missing, non-string or malformed body as a wrong key", async () => {
    const { app, audit } = build();

    expect((await post(app, { email: "owner@example.com" })).status).toBe(401);
    expect((await post(app, { key: 123, email: "owner@example.com" })).status).toBe(401);
    expect((await post(app, "not json")).status).toBe(401);
    expect(outcomes(audit)).toEqual(["invalid_key", "invalid_key", "invalid_key"]);
  });

  it("compares through equal-length digests (constant-time path for any length)", () => {
    expect(setupKeyMatches(KEY, KEY)).toBe(true);
    expect(setupKeyMatches(KEY.slice(0, -1), KEY)).toBe(false);
    expect(setupKeyMatches(`${KEY}${"x".repeat(500)}`, KEY)).toBe(false);
    expect(setupKeyMatches("", KEY)).toBe(false);
    expect(setupKeyMatches(undefined, KEY)).toBe(false);
  });
});

describe("setup route — bootstrap", () => {
  it("returns a one-time link; the audit line holds no email or link", async () => {
    const { app, audit, bootstrap } = build();

    const res = await post(app, { key: KEY, email: "  Owner@Example.com " });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      url: LINK.url,
      expiresAt: LINK.expiresAt.toISOString(),
      email: "owner@example.com",
    });
    expect(bootstrap).toHaveBeenCalledWith("owner@example.com");
    const entry = audit.mock.calls[0]?.[0];
    expect(entry).toMatchObject({ outcome: "link_issued", status: 200 });
    expect(JSON.stringify(entry)).not.toContain("owner@example.com");
    expect(JSON.stringify(entry)).not.toContain("reset-password");
  });

  it("is refused once an admin exists", async () => {
    const { app, audit } = build({
      bootstrap: vi.fn().mockResolvedValue({ kind: "admin_exists" }),
    });

    const res = await post(app, { key: KEY, email: "owner@example.com" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "admin_exists" });
    expect(outcomes(audit)).toEqual(["admin_exists"]);
  });

  it("refuses an address that belongs to an existing account", async () => {
    const { app } = build({ bootstrap: vi.fn().mockResolvedValue({ kind: "email_taken" }) });
    const res = await post(app, { key: KEY, email: "owner@example.com" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "email_taken" });
  });

  it("validates the email only after the key", async () => {
    const { app, audit, bootstrap } = build();
    const res = await post(app, { key: KEY, email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(outcomes(audit)).toEqual(["invalid_request"]);
  });

  it("refuses under FORCE_SSO, where a password admin could never sign in", async () => {
    const { app, bootstrap, audit } = build({ passwordSignInEnabled: false });
    const res = await post(app, { key: KEY, email: "owner@example.com" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "password_signin_disabled" });
    expect(bootstrap).not.toHaveBeenCalled();
    expect(outcomes(audit)).toEqual(["password_signin_disabled"]);
  });

  it("answers a generic 500 and audits it when the bootstrap throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, audit } = build({ bootstrap: vi.fn().mockRejectedValue(new Error("db down")) });
    const res = await post(app, { key: KEY, email: "owner@example.com" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(outcomes(audit)).toEqual(["error"]);
  });

  it("uses the short setup link expiry by default", async () => {
    vi.mocked(bootstrapFirstAdmin).mockResolvedValue(READY);
    const app = new Hono();
    mountSetupRoutes(app, {
      setupKey: KEY,
      passwordSignInEnabled: true,
      limiter: new RateLimiterMemory({ points: 10, duration: 60 }) as never,
      audit: vi.fn(),
    });
    expect((await post(app, { key: KEY, email: "owner@example.com" })).status).toBe(200);
    expect(bootstrapFirstAdmin).toHaveBeenCalledWith("owner@example.com", {
      ttlSeconds: SETUP_LINK_TTL_SECONDS,
    });
    expect(SETUP_LINK_TTL_SECONDS).toBeLessThanOrEqual(60 * 60);
  });

  it("accepts the longest key the env schema allows", async () => {
    const longKey = "Z".repeat(512);
    const { app } = build({ setupKey: longKey });
    expect((await post(app, { key: longKey, email: "owner@example.com" })).status).toBe(200);
  });
});

describe("setup route — rate limit", () => {
  it("blocks after the budget, audits the refusal, and never reaches the key check", async () => {
    const { app, audit, bootstrap } = build({
      limiter: new RateLimiterMemory({ points: 2, duration: 900 }) as never,
    });

    expect((await post(app, { key: "wrong", email: "a@example.com" })).status).toBe(401);
    expect((await post(app, { key: "wrong", email: "a@example.com" })).status).toBe(401);
    const blocked = await post(app, { key: KEY, email: "owner@example.com" });

    expect(blocked.status).toBe(429);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(outcomes(audit)).toEqual(["invalid_key", "invalid_key", "rate_limited"]);
  });

  it("caps the body size", async () => {
    const { app, audit } = build();
    const res = await post(app, { key: KEY, email: "owner@example.com", pad: "x".repeat(8192) });
    expect(res.status).toBe(413);
    expect(outcomes(audit)).toEqual(["invalid_request"]);
  });
});

describe("setup route — position in the app", () => {
  /** The app's own order: setup first, then the global body limit and CORS. */
  function withGlobalMiddleware(setupKey: string | undefined) {
    const audit = vi.fn();
    const app = new Hono();
    mountSetupRoutes(app, {
      setupKey,
      passwordSignInEnabled: true,
      limiter: new RateLimiterMemory({ points: 100, duration: 60 }) as never,
      bootstrap: vi.fn().mockResolvedValue(READY),
      audit,
    });
    app.use("/*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));
    app.use("/*", cors({ origin: "https://web.example.com", credentials: true }));
    return { app, audit };
  }

  it("404s a CORS preflight while SETUP_KEY is unset", async () => {
    const { app } = withGlobalMiddleware(undefined);
    const res = await app.request(SETUP_ADMIN_PATH, {
      method: "OPTIONS",
      headers: { origin: "https://web.example.com", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(404);
  });

  it("audits an oversized body itself instead of leaving it to the global limit", async () => {
    const { app, audit } = withGlobalMiddleware(KEY);
    const res = await post(app, { key: KEY, email: "o@example.com", pad: "x".repeat(64 * 1024) });
    expect(res.status).toBe(413);
    expect(outcomes(audit)).toEqual(["invalid_request"]);
  });

  it("is mounted in index.ts before the global body limit and CORS", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const mount = source.indexOf("mountSetupRoutes(app,");
    expect(mount).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(source.indexOf("bodyLimit({"));
    expect(mount).toBeLessThan(source.indexOf("cors({"));
  });
});
