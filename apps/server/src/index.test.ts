import type { Context, Next } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  fetch: undefined as ((request: Request) => Response | Promise<Response>) | undefined,
  getSession: vi.fn(),
  authHandler: vi.fn(),
  withDeviceRedemptionLock: vi.fn(),
  withPasswordSignInFence: vi.fn(),
  withPasswordWriteLock: vi.fn(),
  order: [] as string[],
  mutate: vi.fn(() => ({ ok: true })),
  passwordPepper: {},
  syncPasswordPepper: vi.fn().mockResolvedValue(undefined),
  runnerServer: {},
  runnerCreate: vi.fn(),
  runnerStop: vi.fn(async () => {}),
  addTransportDrain: vi.fn<(drain: () => Promise<void>) => void>(),
  websocket: undefined as { server: unknown } | undefined,
  runnerBegin: vi.fn(),
}));

// Import the real app/handlers without loading dotenv, starting a listener,
// background consumers, or connecting to Postgres/Redis.
vi.mock("@cockpit-chess/env/load-dotenv", () => ({}));
vi.mock("@cockpit-chess/env/server", () => ({
  env: { NODE_ENV: "development", CORS_ORIGIN: undefined },
  ADMIN_EMAILS: new Set(),
  FORCE_SSO: false,
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 5 } }));
vi.mock("@cockpit-chess/auth/runner-claim", async (importOriginal) => {
  const original = await importOriginal<typeof import("@cockpit-chess/auth/runner-claim")>();
  return {
    ...original,
    runnerClaimService: { begin: state.runnerBegin, poll: vi.fn(), exchange: vi.fn() },
  };
});
vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-chess/auth", () => ({
  auth: { api: { getSession: state.getSession }, handler: state.authHandler },
  passwordPepper: state.passwordPepper,
}));
vi.mock("@cockpit-chess/auth/account-deletion", () => ({ isOwnerActive: async () => true }));
vi.mock("@cockpit-chess/auth/password-pepper-store", () => ({
  syncPasswordPepper: state.syncPasswordPepper,
}));
vi.mock("@cockpit-chess/auth/device-redemption-lock", () => ({
  withDeviceRedemptionLock: state.withDeviceRedemptionLock,
}));
vi.mock("@cockpit-chess/auth/password-sign-in-fence", () => ({
  withPasswordSignInFence: state.withPasswordSignInFence,
}));
vi.mock("@cockpit-chess/auth/password-write-lock", () => ({
  PASSWORD_WRITE_PATHS: new Set([
    "/change-password",
    "/reset-password",
    "/admin/set-user-password",
  ]),
  withPasswordWriteLock: state.withPasswordWriteLock,
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
  serve: ({
    fetch,
    websocket,
  }: {
    fetch: NonNullable<typeof state.fetch>;
    websocket?: { server: unknown };
  }) => {
    state.fetch = fetch;
    state.websocket = websocket;
  },
}));
vi.mock("./lifecycle.js", () => ({
  createServerLifecycle: () => ({
    start: async (listen: () => unknown) => listen(),
    addTransportDrain: state.addTransportDrain,
  }),
}));
vi.mock("./runner-ws-runtime.js", () => ({
  createRunnerWebSocketRuntime: (options: {
    isOwnerActive: (userId: string) => Promise<boolean>;
  }) => {
    state.runnerCreate(options);
    return { server: state.runnerServer, runtime: null, stop: state.runnerStop };
  },
}));
vi.mock("./build-commit.js", () => ({ readBuildCommit: () => null }));
vi.mock("./client-ip.js", () => ({ resolveClientIp: () => "127.0.0.1" }));
vi.mock("./cli-routes.js", () => ({ mountCliRoutes: vi.fn() }));
vi.mock("./openrouter-routes.js", () => ({ mountOpenRouterRoutes: vi.fn() }));
vi.mock("./seo.js", () => ({ registerSeoRoutes: vi.fn() }));
vi.mock("./ssr-cache.js", () => ({ handleSsrRequest: vi.fn() }));
vi.mock("./rate-limit.js", () => ({
  authLimiter: {},
  credentialBurstLimiter: {},
  credentialLimiter: {},
  devicePollLimiter: {},
  openrouterLimiter: {},
  readyLimiter: {},
  rpcLimiter: {},
  runnerClaimBeginLimiter: { name: "claim-begin" },
  runnerClaimPollLimiter: { name: "claim-poll" },
  runnerClaimExchangeLimiter: { name: "claim-exchange" },
  runnerWsConnectIpLimiter: {},
  runnerWsConnectMachineLimiter: {},
  signinRecipientLimiter: {},
  setupLimiter: {},
  signupLimiter: {},
  signupRecipientLimiter: {},
  ssrLimiter: {},
  createRateLimiterMiddleware: (limiter: { name?: string }) => async (_c: Context, next: Next) => {
    if (limiter.name) state.order.push(limiter.name);
    return next();
  },
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

let releasePepperSync!: () => void;
let notifyPepperSync!: () => void;
const pepperSyncStarted = new Promise<void>((resolve) => {
  notifyPepperSync = resolve;
});
const pepperSyncPending = new Promise<void>((resolve) => {
  releasePepperSync = resolve;
});
state.syncPasswordPepper.mockImplementationOnce(() => {
  notifyPepperSync();
  return pepperSyncPending;
});
const startup = import("./index");
await Promise.race([pepperSyncStarted, startup]);
const listenerBeforePepperSyncCompleted = state.fetch;
const pepperSyncCalls = [...state.syncPasswordPepper.mock.calls];
releasePepperSync();
await startup;
const runnerCreateCalls = [...state.runnerCreate.mock.calls];
const transportDrains = [...state.addTransportDrain.mock.calls];

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
  state.order.length = 0;
  state.runnerBegin.mockResolvedValue({ claimId: "run", claimToken: "b".repeat(64) });
  state.withDeviceRedemptionLock.mockImplementation(
    async (request: Request, run: () => Promise<Response>) => {
      const body = (await request.clone().json()) as { device_code?: string };
      state.order.push(`lock:${body.device_code}`);
      const response = await run();
      state.order.push("unlock");
      return response;
    },
  );
  state.withPasswordSignInFence.mockImplementation(
    async (_request: Request, run: () => Promise<Response>) => {
      state.order.push("fence");
      const response = await run();
      state.order.push("recheck");
      return response;
    },
  );
  state.withPasswordWriteLock.mockImplementation(
    async (
      path: string,
      _request: Request,
      run: () => Promise<Response>,
      { getSession }: { getSession: (headers: Headers) => Promise<unknown> },
    ) => {
      state.order.push(`write-lock:${path}`);
      await getSession(new Headers());
      const response = await run();
      state.order.push("write-unlock");
      return response;
    },
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("awaits password pepper synchronization before listening", async () => {
  const { default: prisma } = await import("@cockpit-chess/db");
  expect(pepperSyncCalls).toEqual([[prisma, state.passwordPepper]]);
  expect(listenerBeforePepperSyncCompleted).toBeUndefined();
  expect(state.fetch).toBeDefined();
});

it("registers the runner upgrade adapter and drain with the authoritative deletion fence", async () => {
  const { isOwnerActive } = await import("@cockpit-chess/auth/account-deletion");
  expect(runnerCreateCalls).toEqual([[{ isOwnerActive }]]);
  expect(state.websocket).toEqual({ server: state.runnerServer });
  expect(transportDrains).toHaveLength(1);
  await transportDrains[0]?.[0]();
  expect(state.runnerStop).toHaveBeenCalledOnce();
  const response = await request("/api/cli/runner/ws", {
    headers: { Upgrade: "websocket", Authorization: "Bearer runner-fixture" },
  });
  expect(response.status).toBe(503);
});

it("mounts the dedicated claim budget and body bound before the general body middleware", async () => {
  const proof = "a".repeat(64);
  const accepted = await request("/api/cli/runner/begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proof }),
  });
  expect(accepted.status).toBe(200);
  expect(state.runnerBegin).toHaveBeenCalledExactlyOnceWith({ proof });
  expect(state.order).toEqual(["claim-begin"]);
  const oversized = await request("/api/cli/runner/begin", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(11 * 1024 * 1024) },
    body: JSON.stringify({ proof }),
  });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({ error: "BAD_REQUEST" });
  expect(state.runnerBegin).toHaveBeenCalledOnce();
});

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

describe("/api/auth device-token redemption", () => {
  it("runs the token POST inside the CLI-credential lock, body intact and Authorization stripped", async () => {
    state.authHandler.mockImplementation(async (request: Request) => {
      state.order.push("handler");
      return Response.json({
        body: await request.json(),
        authorization: request.headers.get("authorization"),
      });
    });
    const body = { device_code: "dc-1", client_id: "cockpit-chess-cli" };

    const res = await request("/api/auth/device/token", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer untrusted" },
      body: JSON.stringify(body),
    });

    expect(await res.json()).toEqual({ body, authorization: null });
    expect(state.order).toEqual(["lock:dc-1", "handler", "unlock"]);
    expect(state.withDeviceRedemptionLock).toHaveBeenCalledOnce();
  });

  it.each([
    ["GET", "/api/auth/device/token"],
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/device/code"],
  ])("never takes the lock for %s %s", async (method, path) => {
    const res = await request(path, {
      method,
      ...(method === "POST"
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify({}) }
        : {}),
    });

    expect(await res.text()).toBe("auth ok");
    expect(state.authHandler).toHaveBeenCalledOnce();
    expect(state.withDeviceRedemptionLock).not.toHaveBeenCalled();
  });
});

describe("/api/auth password sign-in", () => {
  it("runs the sign-in POST inside the credential fence, body intact and Authorization stripped", async () => {
    state.authHandler.mockImplementation(async (request: Request) => {
      state.order.push("handler");
      return Response.json({
        body: await request.json(),
        authorization: request.headers.get("authorization"),
      });
    });
    const body = { email: "a@example.test", password: "correct horse battery" };

    const res = await request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer untrusted" },
      body: JSON.stringify(body),
    });

    expect(await res.json()).toEqual({ body, authorization: null });
    expect(state.order).toEqual(["fence", "handler", "recheck"]);
    const [fenced] = state.withPasswordSignInFence.mock.calls[0] as [Request];
    expect(fenced.headers.get("authorization")).toBeNull();
  });

  it.each([
    ["POST", "/api/auth/sign-up/email"],
    ["POST", "/api/auth/two-factor/verify-totp"],
    ["POST", "/api/auth/device/token"],
  ])("never fences %s %s", async (method, path) => {
    await request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: "dc-1" }),
    });

    expect(state.authHandler).toHaveBeenCalledOnce();
    expect(state.withPasswordSignInFence).not.toHaveBeenCalled();
  });
});

describe("/api/auth password writes", () => {
  it.each(["/change-password", "/reset-password", "/admin/set-user-password"])(
    "runs POST /api/auth%s inside the password-write lock, body intact and Authorization stripped",
    async (path) => {
      state.authHandler.mockImplementation(async (request: Request) => {
        state.order.push("handler");
        return Response.json({
          body: await request.json(),
          authorization: request.headers.get("authorization"),
        });
      });
      const body = { newPassword: "a-new-password-123", token: "t", userId: "u1" };

      const res = await request(`/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer untrusted" },
        body: JSON.stringify(body),
      });

      expect(await res.json()).toEqual({ body, authorization: null });
      expect(state.order).toEqual([`write-lock:${path}`, "handler", "write-unlock"]);
      const [, locked] = state.withPasswordWriteLock.mock.calls[0] as [string, Request];
      expect(locked.headers.get("authorization")).toBeNull();
      // The session lookup it is given is Better-Auth's.
      expect(state.getSession).toHaveBeenCalled();
    },
  );

  it.each([
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/two-factor/disable"],
    ["GET", "/api/auth/reset-password/tok"],
    ["POST", "/api/auth/request-password-reset"],
  ])("never takes the password-write lock for %s %s", async (method, path) => {
    await request(path, {
      method,
      ...(method === "POST"
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify({}) }
        : {}),
    });
    expect(state.authHandler).toHaveBeenCalledOnce();
    expect(state.withPasswordWriteLock).not.toHaveBeenCalled();
  });
});
