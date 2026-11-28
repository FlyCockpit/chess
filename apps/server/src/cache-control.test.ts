import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountCacheControl } from "./cache-control.js";
import { mountSecurityHeaders } from "./security-headers.js";

vi.mock("@cockpit-chess/env/server", () => ({
  env: {
    SSR_CACHE_TTL_SECONDS: 60,
    BETTER_AUTH_URL: "https://app.example.com",
    RATE_LIMIT_AUTH_POINTS: 30,
    RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
    RATE_LIMIT_RPC_POINTS: 100,
    RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
    RATE_LIMIT_EMAIL_POINTS: 3,
    RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
  },
  resolveAppName: () => "App",
}));
vi.mock("@cockpit-chess/queue", () => ({ redisConnection: {} }));
vi.mock("rate-limiter-flexible", async (importOriginal) => {
  const original = await importOriginal<typeof import("rate-limiter-flexible")>();
  return { ...original, RateLimiterRedis: original.RateLimiterMemory };
});

const { clear, handleSsrRequest } = await import("./ssr-cache.js");
const { createRateLimiterMiddleware } = await import("./rate-limit.js");

function buildApp() {
  const app = new Hono();
  mountCacheControl(app);
  mountSecurityHeaders(app, { cspConnectSrc: ["'self'"], themeInitCspHash: "'sha256-test'" });
  return app;
}

beforeEach(() => clear());

describe("origin cache policy", () => {
  it("protects real body-limit and CORS early responses", async () => {
    const app = buildApp();
    app.use("/*", bodyLimit({ maxSize: 4, onError: (c) => c.text("too large", 413) }));
    app.use("/*", cors({ origin: "https://app.example.com" }));
    const handler = vi.fn((c: import("hono").Context) => c.text("route"));
    app.all("/*", handler);
    const oversized = await app.request("/api/upload", { method: "POST", body: "oversized" });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("cache-control")).toBe("private, no-store");
    const preflight = await app.request("/api/auth/get-session", {
      method: "OPTIONS",
      headers: { origin: "https://app.example.com", "access-control-request-method": "GET" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("cache-control")).toBe("private, no-store");
    expect(handler).not.toHaveBeenCalled();
  });

  it("protects actual limiter rejections before the route runs", async () => {
    const app = buildApp();
    app.use(
      "/*",
      createRateLimiterMiddleware(new RateLimiterMemory({ points: 1, duration: 60 }), {
        resolveKey: () => "cache-test",
      }),
    );
    const handler = vi.fn((c: import("hono").Context) => c.json({ ok: true }));
    app.get("/rpc/test", handler);
    expect((await app.request("/rpc/test")).status).toBe(200);
    const rejected = await app.request("/rpc/test");
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBeTruthy();
    expect(rejected.headers.get("cache-control")).toBe("private, no-store");
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(["/en-US", "/es-MX", "/en-US/settings", "/es-MX/runner/claim"])(
    "protects anonymous and signed-in SSR HTML at %s, including public cache hits",
    async (path) => {
      const app = buildApp();
      const render = vi.fn(
        async (request: Request) =>
          new Response(
            request.headers.has("cookie") ? "<html>account</html>" : "<html>public</html>",
            {
              headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" },
            },
          ),
      );
      app.all("/*", (c) =>
        handleSsrRequest({ request: c.req.raw, nonce: c.get("secureHeadersNonce"), render }),
      );
      for (const headers of [{}, {}, { cookie: "better-auth.session_token=test-session" }]) {
        const res = await app.request(path, { headers });
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("content-security-policy")).toContain("script-src 'nonce-");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await res.text()).toContain("cookie" in headers ? "account" : "public");
      }
      if (path === "/en-US" || path === "/es-MX") expect(render).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    "/api",
    "/api/auth/get-session",
    "/api/cli/rpc",
    "/rpc",
    "/rpc/chess/list",
    "/ready",
    "/health",
    "/version.json",
  ])("overrides accidental public caching on %s for GET, HEAD, POST and OPTIONS", async (path) => {
    const app = buildApp();
    app.all("/*", (c) => {
      c.header("Cache-Control", "public, max-age=600, s-maxage=600, stale-if-error=60");
      return c.json({ ok: true });
    });
    for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
      const res = await app.request(path, { method });
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it.each([401, 403, 404, 413, 429, 500, 503] as const)(
    "protects early errors and readiness failures (%s)",
    async (status) => {
      const app = buildApp();
      app.use("/*", async (c) => c.json({ error: "unavailable" }, status));
      for (const path of [
        "/api/auth/sign-in",
        "/rpc/chess/list",
        "/ready",
        "/assets/app-AbCd1234.js",
      ]) {
        const res = await app.request(path);
        expect(res.status).toBe(status);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
      }
    },
  );

  it("protects redirects, unhandled errors, and responses without a route policy", async () => {
    const app = buildApp();
    app.onError((_err, c) => c.text("failed", 500));
    app.get("/redirect", (c) => c.redirect("/en-US", 307));
    app.get("/error", () => {
      throw new Error("test");
    });
    app.get("/unknown-data", (c) => c.json({ account: true }));
    for (const path of ["/redirect", "/error", "/unknown-data", "/not-found"]) {
      const res = await app.request(path);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it.each(["/assets/app-AbCd1234.js", "/robots.txt", "/third-party/stockfish/Copying.txt"])(
    "never caches Set-Cookie at %s, even with immutable headers",
    async (path) => {
      const app = buildApp();
      app.get("/*", (c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
        c.header("Set-Cookie", "session=test; HttpOnly; Secure");
        return c.text("file");
      });
      const res = await app.request(path);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("set-cookie")).toContain("session=test");
    },
  );

  it("retains stricter route directives", async () => {
    const app = buildApp();
    app.get("/api/export", (c) => {
      c.header("Cache-Control", "private, no-store, no-cache, max-age=0, must-revalidate");
      return c.text("export");
    });
    expect((await app.request("/api/export")).headers.get("cache-control")).toBe(
      "private, no-store, no-cache, max-age=0, must-revalidate",
    );
  });
});
