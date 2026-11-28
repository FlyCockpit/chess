import { type Context, Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunnerTransport } from "./runner-ws.js";

vi.mock("@cockpit-chess/auth/runner-limits", () => ({
  RunnerLimitsError: class extends Error {},
}));
vi.mock("./client-ip.js", () => ({ resolveClientIp: () => "203.0.113.100" }));
const { mountRunnerWsRoutes } = await import("./runner-ws-routes.js");
const path = "/api/cli/runner/ws";

function fixture(enabled = true) {
  const identity = {
    machineId: "machine1",
    userId: "owner1",
    connectionGeneration: 1,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const authority = {
    resolve: vi.fn(async (authorization: string) =>
      authorization === "Bearer runner-fixture" ? identity : null,
    ),
    claim: vi.fn(async () => identity),
    ownsMatch: vi.fn(async () => false),
  };
  const leases = {
    reserveIp: vi.fn(async () => true),
    releaseIp: vi.fn(async () => {}),
    acquire: vi.fn(async () => true),
    validate: vi.fn(async () => true),
    release: vi.fn(async () => {}),
  };
  const transport = createRunnerTransport({ authority, leases, isAvailable: () => true });
  const budget = vi.fn<(machineId: string, context: Context) => Promise<Response | undefined>>(
    async () => undefined,
  );
  const ipBudget = vi.fn(async (_c, next) => {
    await next();
  });
  const upgrade = vi.fn((reservation) => async (c: import("hono").Context) => {
    await reservation.release();
    return c.json({ simulation: true });
  });
  const app = mountRunnerWsRoutes(new Hono(), {
    ipBudget,
    machineBudget: budget,
    runtime: enabled ? { authority, transport, isAvailable: () => true, upgrade } : null,
  });
  const get = (headers: Record<string, string> = {}, suffix = "") =>
    app.request(`${path}${suffix}`, {
      headers: { Upgrade: "websocket", Authorization: "Bearer runner-fixture", ...headers },
    });
  return { app, authority, leases, transport, budget, ipBudget, upgrade, get };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("runner HTTP upgrade boundary", () => {
  it("uses only purpose bearer auth and canonical client IP, with separate pre-auth and machine budgets", async () => {
    const h = fixture();
    expect((await h.get()).status).toBe(200);
    expect(h.ipBudget).toHaveBeenCalledOnce();
    expect(h.budget).toHaveBeenCalledWith("machine1", expect.anything());
    expect(h.leases.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "203.0.113.100", userId: "owner1" }),
    );
    expect(h.upgrade).toHaveBeenCalledOnce();
    await h.transport.drain();
  });

  it.each<Record<string, string>>([
    { Cookie: "session=browser" },
    { Cookie: "" },
    { Origin: "https://app.example.test" },
    { "Sec-WebSocket-Protocol": "bearer,secret" },
  ])("refuses browser and subprotocol credentials before authority IO %#", async (headers) => {
    const h = fixture();
    expect((await h.get(headers)).status).toBe(401);
    expect(h.authority.resolve).not.toHaveBeenCalled();
    expect(h.upgrade).not.toHaveBeenCalled();
  });

  it.each(["?token=secret", "?", "?authorization=secret"])(
    "never accepts query credentials %s",
    async (query) => {
      const h = fixture();
      const response = await h.get({}, query);
      // A bare trailing ? is normalized away by Request and carries no credential.
      expect(response.status).toBe(query === "?" ? 200 : 401);
      if (query !== "?") expect(h.authority.resolve).not.toHaveBeenCalled();
      await h.transport.drain();
    },
  );

  it.each(["Bearer browser-session", "Bearer general-api-key", "Bearer device-token", ""])(
    "rejects non-runner credentials %s",
    async (Authorization) => {
      const h = fixture();
      expect((await h.get({ Authorization })).status).toBe(401);
      expect(h.upgrade).not.toHaveBeenCalled();
    },
  );

  it("keeps live mounting disabled until the deletion fence exists", async () => {
    const h = fixture(false);
    const response = await h.get();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.authority.resolve).not.toHaveBeenCalled();
    expect(h.upgrade).not.toHaveBeenCalled();
  });

  it("refuses non-upgrade requests and storage/budget failures without secret-bearing errors", async () => {
    const h = fixture();
    expect((await h.get({ Upgrade: "" })).status).toBe(426);
    h.budget.mockRejectedValueOnce(new Error("private connection details"));
    const response = await h.get();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
    expect(h.upgrade).not.toHaveBeenCalled();
  });

  it("preserves a machine-specific 429 response before reserving a generation", async () => {
    const h = fixture();
    h.budget.mockResolvedValueOnce(
      new Response("limited", { status: 429, headers: { "Retry-After": "60" } }),
    );
    const response = await h.get();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(h.authority.claim).not.toHaveBeenCalled();
    expect(h.upgrade).not.toHaveBeenCalled();
  });

  it("bounds unresolved storage checks before an upgrade", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.authority.resolve.mockImplementationOnce(() => new Promise(() => {}));
    const request = h.get();
    await vi.advanceTimersByTimeAsync(5001);
    expect((await request).status).toBe(503);
    expect(h.upgrade).not.toHaveBeenCalled();
  });

  it("joins an in-flight HTTP credential lookup and never starts its budget after shutdown", async () => {
    const h = fixture();
    let finish: (() => void) | undefined;
    h.authority.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              machineId: "machine1",
              userId: "owner1",
              connectionGeneration: 1,
              expiresAt: new Date(Date.now() + 60_000),
            });
        }),
    );
    const request = h.get();
    await vi.waitFor(() => expect(h.authority.resolve).toHaveBeenCalled());
    const draining = h.transport.drain();
    finish?.();
    expect((await request).status).toBe(503);
    await draining;
    expect(h.budget).not.toHaveBeenCalled();
    expect(h.upgrade).not.toHaveBeenCalled();
  });
});
