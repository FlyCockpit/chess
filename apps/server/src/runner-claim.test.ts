import { Hono, type MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-chess/db", () => ({ default: {} }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 5 } }));
const { RunnerClaimNotFoundError } = await import("@cockpit-chess/auth/runner-claim");
const { RunnerMachineInputError, RunnerMachineLimitError } = await import(
  "@cockpit-chess/auth/runner-machine"
);
const { mountRunnerClaimRoutes, RUNNER_CLAIM_BODY_MAX_BYTES } = await import("./runner-claim");
type Service = NonNullable<Parameters<typeof mountRunnerClaimRoutes>[1]["service"]>;
const proof = "a1".repeat(32);
const pair = { claimId: "claim1", proof };
const path = "/api/cli/runner";

function fixture() {
  const budgets = {
    begin: vi.fn<MiddlewareHandler>(async (_c, next) => next()),
    poll: vi.fn<MiddlewareHandler>(async (_c, next) => next()),
    exchange: vi.fn<MiddlewareHandler>(async (_c, next) => next()),
  };
  const service = {
    begin: vi.fn<Service["begin"]>(async () => ({
      claimId: "claim1",
      claimToken: "b2".repeat(32),
      expiresAt: "2026-11-27T23:00:00.000Z",
      pollIntervalMs: 2000,
    })),
    poll: vi.fn<Service["poll"]>(async () => ({ status: "pending" })),
    exchange: vi.fn<Service["exchange"]>(async () => ({
      machineId: "m1",
      credential: "runner-secret-fixture",
      expiresAt: "2026-12-27T23:00:00.000Z",
      claimant: { email: "private@example.test" },
      controlPath: "/en-US/settings/cli",
    })),
  };
  const app = mountRunnerClaimRoutes(new Hono(), { budgets, service });
  const post = (
    action: "begin" | "poll" | "exchange",
    body: unknown = action === "begin" ? { proof } : pair,
    headers: Record<string, string> = {},
  ) =>
    app.request(`${path}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { app, budgets, service, post };
}
afterEach(() => vi.useRealTimers());

describe("dedicated runner claim HTTP surface", () => {
  it("mounts three POST endpoints with independent budgets, no-store and no-referrer", async () => {
    const h = fixture();
    expect(await (await h.post("begin")).json()).toMatchObject({
      claimId: "claim1",
      pollIntervalMs: 2000,
    });
    expect(await (await h.post("poll")).json()).toEqual({ status: "pending" });
    const exchanged = await h.post("exchange");
    expect(await exchanged.json()).toMatchObject({
      machineId: "m1",
      credential: "runner-secret-fixture",
    });
    for (const action of ["begin", "poll", "exchange"] as const) {
      expect(h.budgets[action]).toHaveBeenCalledOnce();
      expect(h.service[action]).toHaveBeenCalledExactlyOnceWith(
        action === "begin" ? { proof } : pair,
      );
    }
    expect(exchanged.headers.get("cache-control")).toBe("no-store");
    expect(exchanged.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await h.app.request(`${path}/ws`)).status).toBe(404);
  });

  it.each(["begin", "poll", "exchange"] as const)(
    "rejects browsers, unrelated bearers and URL parameters on %s",
    async (action) => {
      const h = fixture();
      const forbidden: Record<string, string>[] = [
        { cookie: "browser-session" },
        { cookie: "" },
        { origin: "https://app.example.test" },
        { authorization: "Bearer device-or-api-key" },
      ];
      for (const headers of forbidden) {
        expect((await h.post(action, undefined, headers)).status).toBe(401);
      }
      const response = await h.app.request(`${path}/${action}?proof=${proof}`, { method: "POST" });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(proof);
      expect(h.service[action]).not.toHaveBeenCalled();
    },
  );

  it.each(["begin", "poll", "exchange"] as const)(
    "GET and preflight never create or claim anything on %s",
    async (action) => {
      const h = fixture();
      for (const method of ["GET", "OPTIONS", "PUT"]) {
        const response = await h.app.request(`${path}/${action}`, { method });
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("POST");
      }
      expect(h.service[action]).not.toHaveBeenCalled();
    },
  );

  it.each(["begin", "poll", "exchange"] as const)(
    "requires strict bounded proof objects on %s",
    async (action) => {
      const h = fixture();
      for (const body of [
        null,
        [],
        {},
        { proof: "x" },
        { ...pair, credential: "unexpected" },
        { ...pair, proof: "A1".repeat(32) },
        { ...pair, claimId: "x".repeat(129) },
      ])
        expect((await h.post(action, body)).status).toBe(400);
      expect(h.service[action]).not.toHaveBeenCalled();
    },
  );

  it("bounds actual bytes even with a lying Content-Length and rejects invalid content types/JSON", async () => {
    const h = fixture();
    expect((await h.post("begin", { proof }, { "content-type": "text/plain" })).status).toBe(400);
    expect((await h.post("begin", { proof }, { "content-length": "9999" })).status).toBe(413);
    expect((await h.post("begin", { proof }, { "content-length": "NaN" })).status).toBe(413);
    expect(
      (
        await h.post(
          "begin",
          { proof: "x".repeat(RUNNER_CLAIM_BODY_MAX_BYTES) },
          { "content-length": "1" },
        )
      ).status,
    ).toBe(413);
    const invalid = await h.app.request(`${path}/begin`, {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });
    expect(invalid.status).toBe(400);
    expect(h.service.begin).not.toHaveBeenCalled();
  });

  it("cancels a stalled body read after five seconds", async () => {
    vi.useFakeTimers();
    const h = fixture();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = new Request(`http://localhost${path}/begin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    const pending = h.app.request(request);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(5001);
    expect((await pending).status).toBe(408);
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.service.begin).not.toHaveBeenCalled();
  });

  it.each(["begin", "poll", "exchange"] as const)(
    "fails closed when %s budget refuses or throws",
    async (action) => {
      const h = fixture();
      h.budgets[action].mockImplementationOnce(async (c) =>
        c.json({ error: "TOO_MANY_REQUESTS" }, 429),
      );
      expect((await h.post(action)).status).toBe(429);
      h.budgets[action].mockRejectedValueOnce(new Error("redis connection private detail"));
      const refused = await h.post(action);
      expect(refused.status).toBe(503);
      expect(await refused.text()).not.toContain("private");
      expect(h.service[action]).not.toHaveBeenCalled();
    },
  );

  it("uses generic invalid/expired/revoked responses and never logs or returns secret-bearing errors", async () => {
    const h = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [error, status] of [
        [new RunnerClaimNotFoundError(), 404],
        [new RunnerMachineInputError(), 400],
        [new RunnerMachineLimitError(), 429],
        [new Error("sensitive proof in sql"), 503],
      ] as const) {
        h.service.exchange.mockRejectedValueOnce(error);
        const response = await h.post("exchange");
        expect(response.status).toBe(status);
        expect(await response.text()).not.toMatch(/sensitive|private@example|sql/);
      }
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
