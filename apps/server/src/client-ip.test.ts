import type { Context } from "hono";
import { Hono } from "hono";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import publicProxyFixtures from "./client-ip.public-proxy.fixture.json";

// Mutable env so each test can set TRUST_PROXY_HOPS independently.
const mockEnv: Record<string, number | undefined> = {
  TRUST_PROXY_HOPS: 0,
  RATE_LIMIT_AUTH_POINTS: 30,
  RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
  RATE_LIMIT_RPC_POINTS: 100,
  RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
  RATE_LIMIT_EMAIL_POINTS: 3,
  RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
};
vi.mock("@cockpit-chess/env/server", () => ({ env: mockEnv }));

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "10.0.0.1" } }));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: mockGetConnInfo }));

// Exercise the real anonymous middleware key selection without import-time IO.
vi.mock("@cockpit-chess/auth", () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("@cockpit-chess/queue", () => ({ redisConnection: {} }));
vi.mock("rate-limiter-flexible", async (importOriginal) => {
  const original = await importOriginal<typeof import("rate-limiter-flexible")>();
  return { ...original, RateLimiterRedis: original.RateLimiterMemory };
});

const { resolveClientIp } = await import("./client-ip.js");
const { createRateLimiterMiddleware } = await import("./rate-limit.js");

function ctx(opts: {
  socket?: string;
  xff?: string;
  headers?: Record<string, string | undefined>;
}): Context {
  mockGetConnInfo.mockReturnValue({ remote: { address: opts.socket ?? "" } });
  const headers: Record<string, string | undefined> = { ...opts.headers };
  if (opts.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as unknown as Context;
}

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => warn.mockClear());

describe("resolveClientIp (TRUST_PROXY_HOPS = 0, the default)", () => {
  beforeEach(() => {
    mockEnv.TRUST_PROXY_HOPS = 0;
  });

  it("uses the loopback socket peer in local dev (no X-Forwarded-For)", () => {
    expect(resolveClientIp(ctx({ socket: "127.0.0.1" }))).toBe("127.0.0.1");
  });

  it("ignores a spoofed X-Forwarded-For from a LAN client", () => {
    // A private-network caller must not pick its own bucket by sending a
    // public-looking X-Forwarded-For. With no trusted proxy it keys on the
    // socket.
    expect(resolveClientIp(ctx({ socket: "192.168.1.20", xff: "203.0.113.9" }))).toBe(
      "192.168.1.20",
    );
    expect(
      resolveClientIp(ctx({ socket: "192.168.1.20", xff: "8.8.8.8, 10.0.0.9, 198.51.100.7" })),
    ).toBe("192.168.1.20");
  });

  it("ignores a forged header on a bare public deployment", () => {
    expect(resolveClientIp(ctx({ socket: "198.51.100.50", xff: "203.0.113.1" }))).toBe(
      "198.51.100.50",
    );
  });

  it("treats an unset value like 0 (no heuristic, no leftmost-entry fallback)", () => {
    mockEnv.TRUST_PROXY_HOPS = undefined;
    expect(resolveClientIp(ctx({ socket: "10.0.0.5", xff: "10.0.0.9" }))).toBe("10.0.0.5");
    expect(resolveClientIp(ctx({ socket: "10.0.0.5", xff: "203.0.113.9, 198.51.100.7" }))).toBe(
      "10.0.0.5",
    );
  });

  it("keys every client on the proxy when a proxy exists but hops is 0 (shared bucket)", () => {
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.7" }))).toBe("10.0.0.2");
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.8" }))).toBe("10.0.0.2");
  });

  it("warns once when a private peer sends X-Forwarded-For (an uncounted proxy)", async () => {
    // A fresh module: the warning is once per process, and earlier tests fired it.
    vi.resetModules();
    const fresh = await import("./client-ip.js");
    // Public peer with a header, or a private peer without one: no warning.
    fresh.resolveClientIp(ctx({ socket: "198.51.100.50", xff: "203.0.113.9" }));
    fresh.resolveClientIp(ctx({ socket: "10.0.0.2" }));
    expect(warn).not.toHaveBeenCalled();
    fresh.resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.7" }));
    fresh.resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.8" }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/TRUST_PROXY_HOPS is 0/);
  });

  it("returns 'unknown' when there is no socket peer", () => {
    expect(resolveClientIp(ctx({ socket: "", xff: "203.0.113.9" }))).toBe("unknown");
  });
});

describe("resolveClientIp (TRUST_PROXY_HOPS = 1, one reverse proxy)", () => {
  beforeEach(() => {
    mockEnv.TRUST_PROXY_HOPS = 1;
  });

  it("returns the client address appended by the proxy", () => {
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.7" }))).toBe("198.51.100.7");
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "2001:db8::5" }))).toBe("2001:db8::5");
  });

  it("is not fooled by entries the client prepended", () => {
    expect(
      resolveClientIp(ctx({ socket: "10.0.0.2", xff: "8.8.8.8, 1.1.1.1 , 198.51.100.7" })),
    ).toBe("198.51.100.7");
  });

  it("keys a LAN client behind the proxy on its own address, not its spoofed header", () => {
    // LAN client 192.168.1.20 sends XFF 203.0.113.9; the proxy appends 192.168.1.20.
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "203.0.113.9, 192.168.1.20" }))).toBe(
      "192.168.1.20",
    );
  });

  it("falls back to the socket peer, never the leftmost entry, when the chain is too short", () => {
    // A direct caller bypassing the proxy sends no header: key on its socket.
    expect(resolveClientIp(ctx({ socket: "192.168.1.20" }))).toBe("192.168.1.20");
    mockEnv.TRUST_PROXY_HOPS = 2;
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "203.0.113.9" }))).toBe("10.0.0.2");
    mockEnv.TRUST_PROXY_HOPS = 9;
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "203.0.113.9" }))).toBe("10.0.0.2");
  });

  it("falls back to the socket peer when the trusted entry is malformed", () => {
    for (const xff of [
      "not-an-ip",
      "8.8.8.8, garbage",
      "garbage:443",
      "[garbage]:443",
      "[203.0.113.9]:443",
      "999.1.1.1:80",
      "203.0.113.9:99999",
      "203.0.113.9:",
      "2001:db8::5]:443",
      "198.51.100.7/32",
      ", ,",
      "1.2.3.4,,",
    ]) {
      const expected = xff === "1.2.3.4,," ? "1.2.3.4" : "10.0.0.2";
      expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff })), xff).toBe(expected);
    }
  });

  it("strips a proxy-appended port from the selected entry before validating it", () => {
    // IPv4 with a port (Azure Application Gateway's default format).
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "203.0.113.9:5678" }))).toBe(
      "203.0.113.9",
    );
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "8.8.8.8:1, 198.51.100.7:443" }))).toBe(
      "198.51.100.7",
    );
    // Bracketed IPv6, with and without a port.
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "[2001:db8::1]:5678" }))).toBe(
      "2001:db8::1",
    );
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "[2001:db8::5]" }))).toBe("2001:db8::5");
  });

  it("leaves a bare IPv6 literal alone, even when its last group looks like a port", () => {
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "2001:db8::1" }))).toBe("2001:db8::1");
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "2001:db8::5678" }))).toBe(
      "2001:db8::5678",
    );
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "::ffff:1.2.3.4" }))).toBe(
      "::ffff:1.2.3.4",
    );
  });

  it("takes exactly N from the right for a longer trusted chain", () => {
    // Cloudflare -> Traefik -> app: CF appends the client, Traefik appends CF.
    mockEnv.TRUST_PROXY_HOPS = 2;
    expect(
      resolveClientIp(ctx({ socket: "10.0.0.2", xff: "8.8.8.8, 198.51.100.7, 104.16.0.1" })),
    ).toBe("198.51.100.7");
  });
});

// The Cloudflare edge appends the visitor's address to any X-Forwarded-For the
// visitor sent and cloudflared forwards that header unchanged, so cloudflared
// counts as the one hop that wrote the trusted entry; a proxy behind it adds a
// second. Documented in:
// docs/deployment.md § Home server behind a Cloudflare Tunnel
describe("resolveClientIp behind a Cloudflare Tunnel", () => {
  it("cloudflared -> server: 1 hop keys on the visitor the edge appended", () => {
    mockEnv.TRUST_PROXY_HOPS = 1;
    // cloudflared as a Compose service (bridge peer) or on the host (loopback).
    for (const socket of ["172.18.0.5", "127.0.0.1", "::ffff:127.0.0.1"]) {
      expect(resolveClientIp(ctx({ socket, xff: "198.51.100.7" })), socket).toBe("198.51.100.7");
      expect(resolveClientIp(ctx({ socket, xff: "8.8.8.8, 198.51.100.7" })), socket).toBe(
        "198.51.100.7",
      );
    }
  });

  it("ignores CF-Connecting-IP: only the counted X-Forwarded-For chain selects the key", () => {
    mockEnv.TRUST_PROXY_HOPS = 1;
    const headers = { "cf-connecting-ip": "203.0.113.200" };
    expect(resolveClientIp(ctx({ socket: "172.18.0.5", xff: "198.51.100.7", headers }))).toBe(
      "198.51.100.7",
    );
    // A direct caller (no tunnel) cannot pick its key with the Cloudflare header.
    expect(resolveClientIp(ctx({ socket: "192.168.1.20", headers }))).toBe("192.168.1.20");
  });

  it("cloudflared -> Traefik -> server: 2 hops when Traefik trusts cloudflared", () => {
    mockEnv.TRUST_PROXY_HOPS = 2;
    // Traefik kept the edge's chain and appended cloudflared's address.
    expect(
      resolveClientIp(ctx({ socket: "10.0.1.3", xff: "8.8.8.8, 198.51.100.7, 10.0.1.9" })),
    ).toBe("198.51.100.7");
    // Traefik not trusting cloudflared replaces the chain with cloudflared's
    // address: the chain is too short, so every visitor shares the socket key.
    expect(resolveClientIp(ctx({ socket: "10.0.1.3", xff: "10.0.1.9" }))).toBe("10.0.1.3");
  });

  it("left at 0, keys every visitor on cloudflared and warns once", async () => {
    mockEnv.TRUST_PROXY_HOPS = 0;
    vi.resetModules();
    const fresh = await import("./client-ip.js");
    expect(fresh.resolveClientIp(ctx({ socket: "127.0.0.1", xff: "198.51.100.7" }))).toBe(
      "127.0.0.1",
    );
    expect(fresh.resolveClientIp(ctx({ socket: "127.0.0.1", xff: "198.51.100.8" }))).toBe(
      "127.0.0.1",
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// Synthetic app-boundary fixtures, not captures or a simulation of Traefik.
// The owner must verify the real ingress produces this chain before rollout:
// docs/public-hosting.md. Documentation addresses stand in for the edge/clients.
describe("public Cloudflare proxy topology contract", () => {
  it.each(publicProxyFixtures)("$id", (fixture) => {
    mockEnv.TRUST_PROXY_HOPS = fixture.hops;
    expect(resolveClientIp(ctx(fixture))).toBe(fixture.expectedClientIp);
  });

  it("keeps two visitors in separate anonymous buckets and cannot rotate a bucket with forged headers", async () => {
    mockEnv.TRUST_PROXY_HOPS = 2;
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.2" } });
    const limiter = new RateLimiterMemory({
      keyPrefix: "public-proxy-contract",
      points: 1,
      duration: 60,
    });
    const consume = vi.spyOn(limiter, "consume");
    const app = new Hono();
    app.use("/*", createRateLimiterMiddleware(limiter, { failClosed: true }));
    app.get("/ping", (c) => c.text("pong"));

    for (const visitor of ["198.51.100.7", "2001:db8::7"]) {
      const request = (forged: string) =>
        app.request("/ping", {
          headers: {
            "x-forwarded-for": `${forged}, ${visitor}, 192.0.2.10`,
            "cf-connecting-ip": forged,
            "x-real-ip": forged,
            forwarded: `for=${forged}`,
          },
        });
      expect((await request("203.0.113.200")).status).toBe(200);
      const blocked = await request("203.0.113.201");
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).toBeTruthy();
    }
    expect(consume.mock.calls.map(([key]) => key)).toEqual([
      "198.51.100.7",
      "198.51.100.7",
      "2001:db8::7",
      "2001:db8::7",
    ]);
  });

  it("does not authenticate a direct origin caller just because its forged chain has enough entries", () => {
    // This is why origin isolation and zone authentication are mandatory.
    // The resolver counts hops; it cannot enforce a firewall or authenticate TLS.
    mockEnv.TRUST_PROXY_HOPS = 2;
    expect(resolveClientIp(ctx({ socket: "203.0.113.50", xff: "198.51.100.7, 192.0.2.10" }))).toBe(
      "198.51.100.7",
    );
  });
});
