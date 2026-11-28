import { type Context, Hono, type Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  assert: vi.fn(),
  stream: vi.fn(),
  budget: vi.fn<(c: Context, next: Next) => Promise<Response | undefined>>(),
  session: { user: { id: "owner" }, session: { id: "browser-session" } } as {
    user: { id: string };
    session: { id: string };
  } | null,
}));
vi.mock("@cockpit-chess/api/lib/account-export", () => ({
  AccountExportError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  assertAccountExportAuthority: fixture.assert,
  streamAccountExport: fixture.stream,
}));
const { AccountExportError } = await import("@cockpit-chess/api/lib/account-export");
const { ACCOUNT_EXPORT_PATH, mountAccountExportRoutes } = await import("./account-export-routes");

function app() {
  const server = new Hono<{ Variables: { session: typeof fixture.session } }>();
  server.use("*", async (c, next) => {
    c.set("session", fixture.session);
    await next();
  });
  mountAccountExportRoutes(server, { budget: fixture.budget });
  return server;
}
function request(
  query = "format=json",
  headers: NonNullable<RequestInit["headers"]> = { "x-csrf-token": "orpc" },
  body?: string,
) {
  return app().request(`${ACCOUNT_EXPORT_PATH}?${query}`, { method: "POST", headers, body });
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.session = { user: { id: "owner" }, session: { id: "browser-session" } };
  fixture.assert.mockResolvedValue(undefined);
  fixture.budget.mockImplementation(async (_c, next) => {
    await next();
    return undefined;
  });
  fixture.stream.mockImplementation(async function* () {
    yield '{"account":';
    yield '{"id":"owner"}}';
  });
});
describe("account export downloads", () => {
  it("streams a private attachment using only the cookie identity", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="cockpit-chess-account.json"',
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ account: { id: "owner" } });
    expect(fixture.assert).toHaveBeenCalledWith(
      { userId: "owner", sessionId: "browser-session" },
      { signal: expect.any(AbortSignal) },
    );
    expect(fixture.stream).toHaveBeenCalledWith(
      { userId: "owner", sessionId: "browser-session" },
      "json",
      { signal: expect.any(AbortSignal) },
    );
  });
  it("accepts the empty request stream supplied by the Node HTTP adapter", async () => {
    const raw = new Request(`https://chess.example${ACCOUNT_EXPORT_PATH}?format=json`, {
      method: "POST",
      headers: { "x-csrf-token": "orpc", "content-length": "0" },
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    const response = await app().fetch(raw);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: { id: "owner" } });
  });
  it("names PGN downloads independently", async () => {
    const response = await request("format=pgn");
    expect(response.headers.get("content-disposition")).toContain(".pgn");
    expect(response.headers.get("content-type")).toContain("application/x-chess-pgn");
    await response.text();
    expect(fixture.stream.mock.calls[0]?.[1]).toBe("pgn");
  });
  it("refuses anonymous and bearer-only callers", async () => {
    fixture.session = null;
    expect(
      (await request("format=json", { authorization: "Bearer credential", "x-csrf-token": "orpc" }))
        .status,
    ).toBe(401);
    expect(fixture.assert).not.toHaveBeenCalled();
    expect(fixture.budget).not.toHaveBeenCalled();
  });
  it("requires the CSRF header", async () => {
    expect((await request("format=json", {})).status).toBe(403);
    expect(fixture.assert).not.toHaveBeenCalled();
    expect(fixture.budget).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "format=zip",
    "format=json&userId=other",
    "format=json&format=pgn",
    "format=json&extra=x",
  ])("rejects unsupported query %s", async (query) => {
    expect((await request(query)).status).toBe(400);
    expect(fixture.assert).not.toHaveBeenCalled();
    expect(fixture.budget).not.toHaveBeenCalled();
  });
  it("does not charge the owner for top-level GETs with a Lax cookie", async () => {
    const response = await app().request(`${ACCOUNT_EXPORT_PATH}?format=json`);
    expect(response.status).toBe(404);
    expect(fixture.budget).not.toHaveBeenCalled();
    expect(fixture.assert).not.toHaveBeenCalled();
  });
  it("allows three valid downloads and fails the next before exporting", async () => {
    let requests = 0;
    fixture.budget.mockImplementation(async (c, next) => {
      if (++requests > 3) return c.json({ code: "RATE_LIMITED" }, 429);
      await next();
      return undefined;
    });
    for (let count = 0; count < 3; count++) {
      const response = await request();
      expect(response.status).toBe(200);
      await response.text();
    }
    const denied = await request();
    expect(denied.status).toBe(429);
    expect(denied.headers.get("content-disposition")).toBeNull();
    expect(fixture.budget).toHaveBeenCalledTimes(4);
    expect(fixture.stream).toHaveBeenCalledTimes(3);
    expect(fixture.assert).toHaveBeenCalledTimes(3);
  });
  it("fails closed before export when the budget store is unavailable", async () => {
    fixture.budget.mockImplementation(async (c) => c.json({ code: "UNAVAILABLE" }, 503));
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(fixture.assert).not.toHaveBeenCalled();
    expect(fixture.stream).not.toHaveBeenCalled();
  });
  it("rejects a body rather than accepting an alternate identity", async () => {
    expect(
      (await request("format=json", { "x-csrf-token": "orpc" }, '{"userId":"other"}')).status,
    ).toBe(400);
    expect(fixture.assert).not.toHaveBeenCalled();
  });
  it.each([
    ["UNAUTHORIZED", 401],
    ["REAUTH_REQUIRED", 412],
    ["FORBIDDEN", 403],
    ["LIMIT_EXCEEDED", 413],
    ["ABORTED", 408],
  ] as const)("maps preflight %s before writing attachment headers", async (code, status) => {
    fixture.assert.mockRejectedValue(new AccountExportError(code));
    const response = await request();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code });
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(fixture.stream).not.toHaveBeenCalled();
  });
  it("returns a secret-free unavailable response on failed preflight", async () => {
    fixture.assert.mockRejectedValue(new Error("private-database-detail"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-database-detail");
    warning.mockRestore();
  });
  it("fails a partial stream instead of completing a malformed download", async () => {
    fixture.stream.mockImplementation(async function* () {
      yield "{";
      throw new Error("private-detail");
    });
    const response = await request();
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow("Account export interrupted");
  });
  it("does not query beyond demand and closes the generator on cancellation", async () => {
    const next = vi.fn().mockResolvedValue({ done: false, value: "chunk" });
    const close = vi.fn().mockResolvedValue({ done: true, value: undefined });
    fixture.stream.mockReturnValue({ next, return: close });
    const response = await request();
    expect(next).toHaveBeenCalledTimes(1);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    expect(next).toHaveBeenCalledTimes(1);
    await reader?.cancel();
    expect(close).toHaveBeenCalledTimes(1);
    expect(fixture.stream.mock.calls[0]?.[2]?.signal.aborted).toBe(true);
  });
});
