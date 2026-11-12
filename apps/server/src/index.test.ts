import type { Context, Next } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  fetch: undefined as ((request: Request) => Response | Promise<Response>) | undefined,
  getSession: vi.fn(),
  authHandler: vi.fn(),
  mutate: vi.fn(() => ({ ok: true })),
}));

// Import the real app/handlers without loading dotenv, starting a listener,
// background consumers, or connecting to Postgres/Redis.
vi.mock("@cockpit-chess/env/load-dotenv", () => ({}));
vi.mock("@cockpit-chess/env/server", () => ({
  env: { NODE_ENV: "development", CORS_ORIGIN: undefined },
  ADMIN_EMAILS: new Set(),
}));
vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-chess/auth", () => ({
  auth: { api: { getSession: state.getSession }, handler: state.authHandler },
}));
vi.mock("@cockpit-chess/queue", () => ({ QUEUE_NAMES: {}, redisConnection: {} }));
vi.mock("@cockpit-chess/queue/consumer-health", () => ({ hasExternalConsumer: vi.fn() }));
vi.mock("@cockpit-chess/api/routers/index", async () => {
  const { adminProcedure } = await import("@cockpit-chess/api");
  return {
    appRouter: {
      mutate: adminProcedure.route({ method: "POST", path: "/mutate" }).handler(state.mutate),
    },
  };
});
vi.mock("@hono/node-server", () => ({
  serve: ({ fetch }: { fetch: NonNullable<typeof state.fetch> }) => {
    state.fetch = fetch;
  },
}));
vi.mock("./lifecycle.js", () => ({
  createServerLifecycle: () => ({ start: async (listen: () => unknown) => listen() }),
}));
vi.mock("./build-commit.js", () => ({ readBuildCommit: () => null }));
vi.mock("./client-ip.js", () => ({ resolveClientIp: () => "127.0.0.1" }));
vi.mock("./cli-routes.js", () => ({ mountCliRoutes: vi.fn() }));
vi.mock("./seo.js", () => ({ registerSeoRoutes: vi.fn() }));
vi.mock("./ssr-cache.js", () => ({ handleSsrRequest: vi.fn() }));
vi.mock("./rate-limit.js", () => ({
  authLimiter: {},
  credentialBurstLimiter: {},
  credentialLimiter: {},
  devicePollLimiter: {},
  readyLimiter: {},
  rpcLimiter: {},
  signinRecipientLimiter: {},
  signupLimiter: {},
  signupRecipientLimiter: {},
  ssrLimiter: {},
  createRateLimiterMiddleware: () => async (_c: Context, next: Next) => next(),
}));
vi.mock("./email-recipient-limit.js", () => ({
  EMAIL_RECIPIENT_PATHS: [],
  FORM_OR_JSON_MEDIA_TYPES: [],
  SIGNIN_RECIPIENT_PATH: "/api/auth/sign-in/email",
  SIGNUP_RECIPIENT_PATH: "/api/auth/sign-up/email",
  signinSentMail: vi.fn(),
  emailRecipientLimit: () => async (_c: Context, next: Next) => next(),
}));
vi.mock("./signup-gate.js", () => ({
  adminBootstrapMarker: () => async (_c: Context, next: Next) => next(),
}));
vi.mock("./signin-failure-limit.js", () => ({
  SIGNIN_FAILURE_PATH: "/api/auth/sign-in/email",
  signinFailureLimit: () => async (_c: Context, next: Next) => next(),
}));
vi.mock("./two-factor-otp-limit.js", () => ({
  TWO_FACTOR_OTP_PATH: "/api/auth/two-factor/send-otp",
  twoFactorOtpLimit: () => async (_c: Context, next: Next) => next(),
}));

await import("./index");

function request(path: string, init?: RequestInit) {
  if (!state.fetch) throw new Error("App fetch was not captured");
  return state.fetch(new Request(`https://app.example.test${path}`, init));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.getSession.mockResolvedValue({
    user: { id: "admin", role: "admin", emailVerified: true, twoFactorEnabled: true },
    session: { id: "cookie-session" },
  });
  state.authHandler.mockImplementation(() => new Response("auth ok"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(["/rpc", "/api-reference"])(
  "%s cookie CSRF protection without CORS_ORIGIN",
  (prefix) => {
    function mutation(format: string, csrf?: string): RequestInit {
      const headers = new Headers({
        cookie: "better-auth.session_token=test-session",
        origin: "https://hostile.example.test",
      });
      if (csrf) headers.set("x-csrf-token", csrf);
      const input = { published: true };
      if (format === "multipart") {
        const body = new FormData();
        body.set("data", JSON.stringify({ json: input }));
        return { method: "POST", headers, body };
      }
      headers.set("content-type", "application/json");
      return {
        method: "POST",
        headers,
        body: JSON.stringify(prefix === "/rpc" ? { json: input } : input),
      };
    }

    it.each(["multipart", "JSON"])(
      "rejects forged %s requests before any procedure runs",
      async (format) => {
        const res = await request(`${prefix}/mutate`, mutation(format));

        expect(res.status).toBe(403);
        expect(state.mutate).not.toHaveBeenCalled();
      },
    );

    it("rejects an incorrect header", async () => {
      const res = await request(`${prefix}/mutate`, mutation("JSON", "incorrect"));

      expect(res.status).toBe(403);
      expect(state.mutate).not.toHaveBeenCalled();
    });

    it.each(["multipart", "JSON"])("allows header-bearing %s requests", async (format) => {
      const res = await request(`${prefix}/mutate`, mutation(format, "orpc"));

      expect(res.status).toBe(200);
      expect(state.mutate).toHaveBeenCalledOnce();
    });
  },
);

describe("cookie RPC batches", () => {
  function batch(csrf?: string, innerCsrf?: string): RequestInit {
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orpc-batch": "buffered",
        cookie: "better-auth.session_token=test-session",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: JSON.stringify(
        [1, 2].map(() => ({
          url: "https://app.example.test/rpc/mutate",
          body: { json: { published: true } },
          headers: innerCsrf ? { "x-csrf-token": innerCsrf } : {},
        })),
      ),
    };
  }

  it("accepts the web client's CSRF header on a batch envelope", async () => {
    const res = await request("/rpc/__batch__", batch("orpc"));

    expect(res.status).toBe(207);
    expect(await res.json()).toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 }),
    ]);
    expect(state.mutate).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "orpc"])(
    "rejects a batch without an envelope header (inner header %s)",
    async (innerCsrf) => {
      const res = await request("/rpc/__batch__", batch(undefined, innerCsrf));

      expect(res.status).toBe(207);
      expect(await res.json()).toEqual([
        expect.objectContaining({ status: 403 }),
        expect.objectContaining({ status: 403 }),
      ]);
      expect(state.mutate).not.toHaveBeenCalled();
    },
  );
});

describe("request logging", () => {
  it.each([
    [
      "/api/auth/reset-password/PATH_SENTINEL?callbackURL=QUERY_SENTINEL",
      "/api/auth/reset-password/[redacted]",
    ],
    ["/api/auth/verify-email?token=TOKEN_SENTINEL", "/api/auth/verify-email"],
    [
      "/api/auth/callback/provider?code=CODE_SENTINEL&state=STATE_SENTINEL",
      "/api/auth/callback/provider",
    ],
  ])("omits credentials on success and onError for %s", async (path, label) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await request(path)).status).toBe(200);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`GET ${label} 200 `));

    state.authHandler.mockImplementation(() => {
      throw new Error("Synthetic auth failure");
    });
    expect((await request(path)).status).toBe(500);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`Unhandled error on GET ${label}:`),
      expect.stringContaining("Synthetic auth failure"),
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`GET ${label} 500 `));
    const output = JSON.stringify([vi.mocked(console.log).mock.calls, error.mock.calls]);
    expect(output).not.toContain("SENTINEL");
  });
});
