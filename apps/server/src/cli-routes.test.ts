import type { Context, Next } from "hono";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepMockProxy } from "vitest-mock-extended";

const env = vi.hoisted(() => ({
  BETTER_AUTH_URL: "https://api.example.com",
  CORS_ORIGIN: "https://app.example.com",
}));
vi.mock("@cockpit-chess/env/server", () => ({ env }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: {} }));
vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const release = vi.hoisted(() => {
  class CliReleaseUnavailableError extends Error {}
  return {
    CliReleaseUnavailableError,
    isCliReleaseConfigured: vi.fn(() => true),
    resolveCliAssetUrl: vi.fn<(asset: string) => Promise<string | null>>(),
  };
});
vi.mock("@cockpit-chess/api/lib/cli-release", () => release);

const verifyCliInstallToken = vi.hoisted(() => vi.fn<(token: string) => string | null>());
vi.mock("@cockpit-chess/api/lib/cli-install-token", () => ({ verifyCliInstallToken }));
vi.mock("@cockpit-chess/api/routers/cli", () => ({ cliRouter: {} }));
vi.mock("@cockpit-chess/api/context", () => ({
  createContext: vi.fn(async () => ({ session: null })),
}));

// Pass-through limiters that record the order they run in: this file tests
// routing and auth, not budgets.
const calls = vi.hoisted(() => [] as string[]);
vi.mock("./rate-limit.js", () => ({
  cliLimiter: { name: "cli" },
  cliIpLimiter: { name: "cli-ip" },
  cliDownloadLimiter: { name: "cli-download" },
  createRateLimiterMiddleware: (limiter: { name: string }) => async (_c: Context, next: Next) => {
    calls.push(limiter.name);
    await next();
  },
}));

// Stand-in credential resolution: `Authorization: Bearer good` is a signed-in
// CLI; anything else is anonymous. cli-session.ts has its own tests.
vi.mock("./cli-session.js", () => ({
  cliSessionMiddleware: async (c: Context, next: Next) => {
    calls.push("session");
    const signedIn = c.req.header("authorization") === "Bearer good";
    c.set("session", signedIn ? { user: { id: "cli-user" }, session: {} } : null);
    c.set("credential", signedIn ? "session-token" : undefined);
    await next();
  },
}));

const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as unknown as DeepMockProxy<typeof prisma>;
const { mountCliRoutes } = await import("./cli-routes");

const TOKEN = "v1.payload.signature";

function app() {
  const hono = new Hono();
  mountCliRoutes(hono as never, { onOrpcError: () => {} });
  return hono;
}

/** Request init carrying an install token the way the install command sends it. */
function install(token: string) {
  return { headers: { authorization: `Install ${token}` } };
}

function validTokenFor(user: Record<string, unknown> | null) {
  verifyCliInstallToken.mockReturnValue(user ? String(user.id) : "missing-user");
  db.user.findUnique.mockResolvedValue(user as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  release.isCliReleaseConfigured.mockReturnValue(true);
  verifyCliInstallToken.mockReturnValue(null);
});

describe("limiter order", () => {
  it("throttles by IP before resolving a bearer, then by user", async () => {
    await app().request("/api/cli/rpc/whoami", {
      method: "POST",
      headers: { authorization: "Bearer good" },
    });
    expect(calls).toEqual(["cli-ip", "session", "cli"]);
  });

  it("applies the IP limiter ahead of credential lookup on downloads", async () => {
    await app().request("/api/cli/download/cockpit-chess-linux-x64", {
      headers: { authorization: "Bearer good" },
    });
    expect(calls.slice(0, 2)).toEqual(["cli-ip", "session"]);
    expect(calls).toContain("cli-download");
  });
});

describe("GET /api/cli/install.sh and install.ps1", () => {
  it("answers 503 when CLI downloads are not configured", async () => {
    release.isCliReleaseConfigured.mockReturnValue(false);
    for (const path of ["/api/cli/install.sh", "/api/cli/install.ps1"]) {
      const res = await app().request(path, install(TOKEN));
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it.each([
    ["missing", {}],
    ["malformed", install("not-a-token")],
    ["injection attempt", install("v1.a.b';rm-rf~;'")],
    ["bad signature or expired", install(TOKEN)],
    ["Bearer-scheme", { headers: { authorization: `Bearer ${TOKEN}` } }],
  ])("serves the self-explaining expired script for a %s token", async (_label, init) => {
    const res = await app().request("/api/cli/install.sh", init);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("expired or is invalid");
    expect(body).toContain("https://app.example.com/settings/cli");
    expect(body).not.toContain("rm -rf");
  });

  it("serves the expired script when the token's user is banned or gone", async () => {
    validTokenFor({ id: "u1", banned: true, banExpires: null });
    expect(await (await app().request("/api/cli/install.sh", install(TOKEN))).text()).toContain(
      "expired or is invalid",
    );

    validTokenFor(null);
    expect(await (await app().request("/api/cli/install.ps1", install(TOKEN))).text()).toContain(
      "expired or is invalid",
    );
  });

  it("serves the installer for a valid token", async () => {
    validTokenFor({ id: "u1", banned: false, banExpires: null });

    const sh = await app().request("/api/cli/install.sh", install(TOKEN));
    expect(sh.status).toBe(200);
    expect(sh.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(sh.headers.get("cache-control")).toBe("no-store");
    const shBody = await sh.text();
    expect(shBody).toContain("BASE='https://api.example.com/api/cli'");
    expect(shBody).toContain(`TOKEN='${TOKEN}'`);

    const ps1 = await (await app().request("/api/cli/install.ps1", install(TOKEN))).text();
    expect(ps1).toContain(`$Token = '${TOKEN}'`);
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" } }),
    );
  });

  it("ignores a token in the query string — it would land in access logs", async () => {
    validTokenFor({ id: "u1", banned: false, banExpires: null });
    const res = await app().request(`/api/cli/install.sh?token=${TOKEN}`);
    expect(await res.text()).toContain("expired or is invalid");
    expect(verifyCliInstallToken).not.toHaveBeenCalled();
  });
});

describe("GET /api/cli/download/:asset", () => {
  it("404s an asset that is not a CLI release file", async () => {
    const res = await app().request("/api/cli/download/..%2F..%2Fetc%2Fpasswd", install(TOKEN));
    expect(res.status).toBe(404);
    const other = await app().request("/api/cli/download/other-file", {
      headers: { authorization: "Bearer good" },
    });
    expect(other.status).toBe(404);
    expect(release.resolveCliAssetUrl).not.toHaveBeenCalled();
  });

  it("answers 503 when CLI downloads are not configured", async () => {
    release.isCliReleaseConfigured.mockReturnValue(false);
    const res = await app().request("/api/cli/download/cockpit-chess-linux-x64", {
      headers: { authorization: "Bearer good" },
    });
    expect(res.status).toBe(503);
  });

  it("401s without a credential or valid install token", async () => {
    expect((await app().request("/api/cli/download/cockpit-chess-linux-x64")).status).toBe(401);
    expect(
      (await app().request("/api/cli/download/cockpit-chess-linux-x64", install(TOKEN))).status,
    ).toBe(401);
    validTokenFor({ id: "u1", banned: false, banExpires: null });
    expect(
      (await app().request(`/api/cli/download/cockpit-chess-linux-x64?token=${TOKEN}`)).status,
    ).toBe(401);
    expect(release.resolveCliAssetUrl).not.toHaveBeenCalled();
  });

  it("redirects an install-token holder to the resolved asset URL", async () => {
    validTokenFor({ id: "u1", banned: false, banExpires: null });
    release.resolveCliAssetUrl.mockResolvedValue("https://objects.example/signed?sig=1");

    const res = await app().request("/api/cli/download/cockpit-chess-linux-x64", install(TOKEN));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://objects.example/signed?sig=1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(release.resolveCliAssetUrl).toHaveBeenCalledWith("cockpit-chess-linux-x64");
  });

  it("redirects a signed-in CLI (`cockpit-chess update`) without an install token", async () => {
    release.resolveCliAssetUrl.mockResolvedValue("https://objects.example/sums");
    const res = await app().request("/api/cli/download/SHA256SUMS", {
      headers: { authorization: "Bearer good" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://objects.example/sums");
    expect(verifyCliInstallToken).not.toHaveBeenCalled();
  });

  it("404s when the release lacks that file", async () => {
    release.resolveCliAssetUrl.mockResolvedValue(null);
    const res = await app().request("/api/cli/download/cockpit-chess-darwin-arm64", {
      headers: { authorization: "Bearer good" },
    });
    expect(res.status).toBe(404);
  });

  it("answers 503 when the release source is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    release.resolveCliAssetUrl.mockRejectedValue(
      new release.CliReleaseUnavailableError("GitHub down"),
    );
    const res = await app().request("/api/cli/download/cockpit-chess-linux-x64", {
      headers: { authorization: "Bearer good" },
    });
    expect(res.status).toBe(503);
    warn.mockRestore();
  });
});
