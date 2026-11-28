import type prismaInstance from "@cockpit-chess/db";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepMockProxy } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
const { env, admin } = vi.hoisted(() => ({
  env: {
    DATABASE_POOL_MAX: 3,
    OPENROUTER_ORIGIN: "https://openrouter.test",
    CHESS_PROVIDER_KEY_SECRET: "11".repeat(32) as string | undefined,
    CHESS_HOSTED_ENABLED: true,
    CHESS_USER_MATCHES_ENABLED: true,
  },
  admin: { value: false },
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env }));
vi.mock("@cockpit-chess/api", () => ({
  checkAdminAuthority: async () => (admin.value ? { ok: true } : { ok: false }),
  isTwoFactorPolicySatisfied: async () => true,
}));
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const { mountOpenRouterRoutes, OPENROUTER_CALLBACK_PATH, OPENROUTER_CONNECT_PATH } = await import(
  "./openrouter-routes.js"
);
const { pkceChallenge } = await import("@cockpit-chess/api/lib/openrouter-account");
const { sanitizedRequestPath } = await import("./request-log.js");

const CANARY = "sk-or-v1-CANARY3333333333333333333333333333333333333333333333333333";
type User = { id: string; emailVerified: boolean };
let currentUser: User | null;

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    set: vi.fn(async (key: string, value: string, _mode: "EX", _seconds: number) => {
      data.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    getdel: vi.fn(async (key: string) => {
      const value = data.get(key) ?? null;
      data.delete(key);
      return value;
    }),
  };
}

function build(publicOrigin = "https://chess.example", webOrigin?: string) {
  const store = memoryStore();
  const audit = vi.fn();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/v1/auth/keys")) {
      const body = JSON.parse(String(init?.body)) as { code: string; code_verifier: string };
      if (body.code !== "good-code") return new Response("{}", { status: 403 });
      exchanged.push(body.code_verifier);
      return new Response(JSON.stringify({ key: CANARY }));
    }
    if (url.endsWith("/api/v1/key"))
      return new Response(JSON.stringify({ data: { label: "L", limit: 10, usage: 0 } }));
    return new Response("{}", { status: 404 });
  });
  const exchanged: string[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("session" as never, (currentUser ? { user: currentUser, session: {} } : null) as never);
    await next();
  });
  mountOpenRouterRoutes(app, {
    store,
    publicOrigin,
    webOrigin,
    openRouterOrigin: "https://openrouter.test",
    fetch: fetcher as unknown as typeof fetch,
    audit,
  });
  return { app, store, audit, fetcher, exchanged };
}

const start = (app: Hono, headers: Record<string, string> = { "x-csrf-token": "orpc" }) =>
  app.request(OPENROUTER_CONNECT_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ limitUsd: 10, expiration: "90-days", lang: "es-MX" }),
  });

async function begin(ctx: ReturnType<typeof build>) {
  const response = await start(ctx.app);
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { url: new URL(url), cookie, state: new URL(url).searchParams.get("state") ?? "" };
}

const callback = (app: Hono, query: string, cookie?: string) =>
  app.request(`${OPENROUTER_CALLBACK_PATH}?${query}`, {
    headers: cookie ? { cookie } : {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    return run(db);
  });
  db.user.findUnique.mockResolvedValue({ deletionRequestedAt: null, banned: false } as never);
  db.$executeRaw.mockResolvedValue(0);
  db.openRouterConnection.upsert.mockClear();
  currentUser = { id: "user-a", emailVerified: true };
  admin.value = false;
  env.CHESS_USER_MATCHES_ENABLED = true;
  env.CHESS_PROVIDER_KEY_SECRET = "11".repeat(32);
  db.openRouterConnection.upsert.mockResolvedValue({ id: "c" } as never);
});

describe("POST /api/openrouter/connect", () => {
  it("refuses OAuth setup for a deletion-pending owner before creating state", async () => {
    db.user.findUnique.mockResolvedValue({ deletionRequestedAt: new Date() } as never);
    const ctx = build();
    expect((await start(ctx.app)).status).toBe(401);
    expect(ctx.store.set).not.toHaveBeenCalled();
    expect(ctx.fetcher).not.toHaveBeenCalled();
  });
  it("returns OpenRouter's consent URL with an S256 challenge and the suggested caps", async () => {
    const ctx = build();
    const { url, cookie, state } = await begin(ctx);
    expect(url.origin + url.pathname).toBe("https://openrouter.test/auth");
    expect(url.searchParams.get("callback_url")).toBe(
      "https://chess.example/api/openrouter/callback",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("expiration")).toBe("90-days");
    expect(url.searchParams.get("key_label")).toBe("Cockpit Chess (chess.example)");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatch(/^__Host-or_oauth=[0-9a-f]{64}$/);
    // The stored record holds the verifier; the URL only its challenge.
    const [key, raw, mode, ttl] = ctx.store.set.mock.calls[0] ?? [];
    expect(key).not.toContain(state);
    expect(mode).toBe("EX");
    expect(ttl).toBe(600);
    const record = JSON.parse(String(raw)) as { verifier: string; userId: string };
    expect(record.userId).toBe("user-a");
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(record.verifier));
    expect(url.toString()).not.toContain(record.verifier);
  });

  it("marks the cookie Secure + __Host- on https and plain on http dev", async () => {
    const response = await start(build("http://localhost:3000").app);
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^or_oauth=/);
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    const secure = (await start(build().app)).headers.get("set-cookie") ?? "";
    expect(secure).toMatch(/Secure/);
  });

  it("requires the CSRF header, a session and a verified email", async () => {
    const ctx = build();
    expect((await start(ctx.app, {})).status).toBe(403);
    currentUser = { id: "user-a", emailVerified: false };
    expect((await start(ctx.app)).status).toBe(403);
    currentUser = null;
    expect((await start(ctx.app)).status).toBe(401);
    expect(ctx.store.set).not.toHaveBeenCalled();
  });

  it("is closed to users until the operator opens user matches (admins may connect)", async () => {
    env.CHESS_USER_MATCHES_ENABLED = false;
    const ctx = build();
    expect(await (await start(ctx.app)).json()).toEqual({ error: "disabled" });
    admin.value = true;
    expect((await start(ctx.app)).status).toBe(200);
  });

  it("rejects malformed bodies", async () => {
    const ctx = build();
    const response = await ctx.app.request(OPENROUTER_CONNECT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "orpc" },
      body: JSON.stringify({ limitUsd: 5000, expiration: "forever", lang: "en-US" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /api/openrouter/callback", () => {
  it("rechecks deletion under the owner lock at the actual code-exchange request", async () => {
    const ctx = build();
    const { cookie, state } = await begin(ctx);
    db.user.findUnique
      .mockResolvedValueOnce({ deletionRequestedAt: null, banned: false } as never)
      .mockResolvedValue({ deletionRequestedAt: new Date() } as never);
    const response = await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    expect(response.headers.get("location")).toBe("/es-MX/settings/openrouter?error=unavailable");
    expect(ctx.exchanged).toEqual([]);
    expect(db.openRouterConnection.upsert).not.toHaveBeenCalled();
  });
  it("refuses a callback begun before deletion without exchanging its code", async () => {
    const ctx = build();
    const { cookie, state } = await begin(ctx);
    db.user.findUnique.mockResolvedValue({ deletionRequestedAt: new Date() } as never);
    const response = await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    expect(response.headers.get("location")).toBe("/es-MX/settings/openrouter?error=mismatch");
    expect(ctx.exchanged).toEqual([]);
    expect(db.openRouterConnection.upsert).not.toHaveBeenCalled();
  });
  it("returns to the web app's origin in a separate-origin deployment", async () => {
    const ctx = build("https://api.chess.example", "https://chess.example");
    const { cookie, state } = await begin(ctx);
    const response = await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    expect(response.headers.get("location")).toBe(
      "https://chess.example/es-MX/settings/openrouter?connected=1",
    );
    // Failures go there too, with the fixed path.
    const denied = await callback(ctx.app, "error=access_denied", cookie);
    expect(denied.headers.get("location")).toBe(
      "https://chess.example/en-US/settings/openrouter?error=denied",
    );
  });

  it("stays relative when the web app and the API share an origin", async () => {
    const ctx = build("https://chess.example", "https://chess.example");
    const { cookie, state } = await begin(ctx);
    const response = await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    expect(response.headers.get("location")).toBe("/es-MX/settings/openrouter?connected=1");
  });

  it("exchanges the code with the stored verifier, verifies and seals the key", async () => {
    const ctx = build();
    const { cookie, state } = await begin(ctx);
    const response = await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/es-MX/settings/openrouter?connected=1");
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(ctx.exchanged).toHaveLength(1);
    expect(db.openRouterConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-a" } }),
    );
    const everything = JSON.stringify([
      response.headers.get("location"),
      ctx.audit.mock.calls,
      await response.text(),
    ]);
    expect(everything).not.toContain("CANARY");
  });

  it("is single use: a replayed state fails", async () => {
    const ctx = build();
    const { cookie, state } = await begin(ctx);
    await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    const replay = await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    expect(replay.headers.get("location")).toBe("/en-US/settings/openrouter?error=used");
    expect(ctx.exchanged).toHaveLength(1);
  });

  it("refuses a callback finished by another signed-in user", async () => {
    const ctx = build();
    const { cookie, state } = await begin(ctx);
    currentUser = { id: "user-b", emailVerified: true };
    const response = await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    expect(response.headers.get("location")).toBe("/es-MX/settings/openrouter?error=mismatch");
    expect(ctx.fetcher).not.toHaveBeenCalled();
    // And the state is spent, so the right user cannot be tricked into it later either.
    currentUser = { id: "user-a", emailVerified: true };
    const again = await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    expect(again.headers.get("location")).toContain("error=used");
  });

  it("refuses a callback in a browser that did not start the flow", async () => {
    const ctx = build();
    const { state } = await begin(ctx);
    for (const cookie of [undefined, `__Host-or_oauth=${"0".repeat(64)}`]) {
      const fresh = await begin(ctx);
      const response = await callback(ctx.app, `code=good-code&state=${fresh.state}`, cookie);
      expect(response.headers.get("location")).toContain("error=mismatch");
    }
    expect(state).toBeTruthy();
    expect(ctx.fetcher).not.toHaveBeenCalled();
  });

  it("reads an expired (TTL-evicted) state as expired", async () => {
    const ctx = build();
    const { cookie, state } = await begin(ctx);
    ctx.store.data.clear();
    const response = await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    expect(response.headers.get("location")).toContain("error=expired");
  });

  it("treats an unknown state as expired", async () => {
    const response = await callback(build().app, "code=good-code&state=unknown");
    expect(response.headers.get("location")).toContain("error=expired");
  });

  it("reports a declined consent (no code, no state)", async () => {
    const response = await callback(build().app, "error=access_denied");
    expect(response.headers.get("location")).toBe("/en-US/settings/openrouter?error=denied");
  });

  it("maps a refused code to exchange and stores nothing", async () => {
    const ctx = build();
    const { cookie, state } = await begin(ctx);
    const response = await callback(ctx.app, `code=bad-code&state=${state}`, cookie);
    expect(response.headers.get("location")).toContain("error=exchange");
    expect(db.openRouterConnection.upsert).not.toHaveBeenCalled();
  });

  it("maps a key OpenRouter will not confirm to verify", async () => {
    const ctx = build();
    ctx.fetcher.mockImplementation(async (url: string) =>
      url.endsWith("/auth/keys")
        ? new Response(JSON.stringify({ key: CANARY }))
        : new Response("{}", { status: 401 }),
    );
    const { cookie, state } = await begin(ctx);
    const response = await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    expect(response.headers.get("location")).toContain("error=verify");
    expect(db.openRouterConnection.upsert).not.toHaveBeenCalled();
  });

  it("never logs a storage failure's message", async () => {
    const ctx = build();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.openRouterConnection.upsert.mockRejectedValue(new Error(`db said ${CANARY}`));
    const { cookie, state } = await begin(ctx);
    const response = await callback(ctx.app, `code=good-code&state=${state}`, cookie);
    expect(response.headers.get("location")).toContain("error=unavailable");
    expect(JSON.stringify([log.mock.calls, ctx.audit.mock.calls])).not.toContain("CANARY");
    log.mockRestore();
  });

  it("keeps the code and state out of the request log", () => {
    expect(
      sanitizedRequestPath("https://chess.example/api/openrouter/callback?code=secret&state=s"),
    ).toBe("/api/openrouter/callback");
  });
});
