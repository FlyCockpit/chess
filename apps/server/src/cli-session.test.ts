import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";

const verifyApiKey = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());
vi.mock("@cockpit-chess/auth", () => ({ auth: { api: { verifyApiKey, getSession } } }));
vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-chess/env/server", () => ({ env: {} }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: {} }));

const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as unknown as DeepMockProxy<typeof prisma>;
const { resolveCliCredential, cliSessionMiddleware } = await import("./cli-session");
const { Hono } = await import("hono");

const API_KEY = `cockpit_chess_${"k".repeat(64)}`;

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    name: "Ada",
    email: "ada@example.com",
    emailVerified: true,
    image: null,
    role: "user",
    locale: "en-US",
    banned: false,
    banReason: null,
    banExpires: null,
    twoFactorEnabled: false,
    operationalAlerts: true,
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    token: "device-token",
    userId: "user-1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    expiresAt: new Date(Date.now() + 86_400_000),
    ipAddress: null,
    userAgent: null,
    impersonatedBy: null,
    origin: "device-flow",
    user: userRow(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReset(db);
});

describe("resolveCliCredential", () => {
  it("returns null without an Authorization header", async () => {
    await expect(resolveCliCredential(undefined)).resolves.toBeNull();
    await expect(resolveCliCredential("")).resolves.toBeNull();
  });

  it("returns null for a non-Bearer scheme", async () => {
    await expect(resolveCliCredential(`Basic ${API_KEY}`)).resolves.toBeNull();
    await expect(resolveCliCredential("Bearer")).resolves.toBeNull();
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(db.session.findUnique).not.toHaveBeenCalled();
  });

  describe("API keys", () => {
    it("returns null for an invalid key", async () => {
      verifyApiKey.mockResolvedValue({ valid: false, key: null, error: { code: "INVALID" } });
      await expect(resolveCliCredential(`Bearer ${API_KEY}`)).resolves.toBeNull();
      expect(verifyApiKey).toHaveBeenCalledWith({ body: { key: API_KEY } });
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it("maps a valid key to its owner and labels it api-key", async () => {
      const expiresAt = new Date("2027-01-01");
      verifyApiKey.mockResolvedValue({
        valid: true,
        key: { id: "key-1", referenceId: "user-1", expiresAt },
      });
      db.user.findUnique.mockResolvedValue(userRow() as never);

      const resolved = await resolveCliCredential(`Bearer ${API_KEY}`);

      expect(resolved?.credential).toBe("api-key");
      expect(resolved?.session.user.id).toBe("user-1");
      expect(resolved?.session.session).toMatchObject({
        id: "key-1",
        userId: "user-1",
        expiresAt,
      });
      expect(db.user.findUnique.mock.calls[0]?.[0]?.where).toEqual({ id: "user-1" });
      // The session-token path is never consulted for a key.
      expect(db.session.findUnique).not.toHaveBeenCalled();
    });

    it("returns null when the key's owner is gone", async () => {
      verifyApiKey.mockResolvedValue({ valid: true, key: { id: "k", referenceId: "gone" } });
      db.user.findUnique.mockResolvedValue(null);
      await expect(resolveCliCredential(`Bearer ${API_KEY}`)).resolves.toBeNull();
    });

    it("returns null for a banned owner — keys outlive a ban", async () => {
      verifyApiKey.mockResolvedValue({ valid: true, key: { id: "k", referenceId: "user-1" } });
      db.user.findUnique.mockResolvedValue(userRow({ banned: true, banExpires: null }) as never);
      await expect(resolveCliCredential(`Bearer ${API_KEY}`)).resolves.toBeNull();
    });
  });

  describe("device-flow session tokens", () => {
    it("resolves a live session row and labels it session-token", async () => {
      db.session.findUnique.mockResolvedValue(sessionRow() as never);

      const resolved = await resolveCliCredential("Bearer device-token");

      expect(resolved?.credential).toBe("session-token");
      expect(resolved?.session.session.id).toBe("session-1");
      expect(resolved?.session.user.email).toBe("ada@example.com");
      expect(db.session.findUnique.mock.calls[0]?.[0]?.where).toEqual({ token: "device-token" });
      expect(verifyApiKey).not.toHaveBeenCalled();
    });

    it("returns null for a browser sign-in session, even with a valid token", async () => {
      db.session.findUnique.mockResolvedValue(sessionRow({ origin: "sign-in" }) as never);
      await expect(resolveCliCredential("Bearer device-token")).resolves.toBeNull();
    });

    it("returns null for an impersonation session", async () => {
      db.session.findUnique.mockResolvedValue(
        sessionRow({ origin: "sign-in", impersonatedBy: "admin-1" }) as never,
      );
      await expect(resolveCliCredential("Bearer device-token")).resolves.toBeNull();
    });

    it("returns null for an unknown token", async () => {
      db.session.findUnique.mockResolvedValue(null);
      await expect(resolveCliCredential("Bearer nope")).resolves.toBeNull();
    });

    it("returns null for an expired session", async () => {
      db.session.findUnique.mockResolvedValue(
        sessionRow({ expiresAt: new Date(Date.now() - 1000) }) as never,
      );
      await expect(resolveCliCredential("Bearer device-token")).resolves.toBeNull();
    });

    it("returns null for a banned user", async () => {
      db.session.findUnique.mockResolvedValue(
        sessionRow({ user: userRow({ banned: true }) }) as never,
      );
      await expect(resolveCliCredential("Bearer device-token")).resolves.toBeNull();
    });
  });

  it("treats a lookup failure as anonymous", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.session.findUnique.mockRejectedValue(new Error("db down"));
    verifyApiKey.mockRejectedValue(new Error("db down"));
    await expect(resolveCliCredential("Bearer device-token")).resolves.toBeNull();
    await expect(resolveCliCredential(`Bearer ${API_KEY}`)).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe("cliSessionMiddleware", () => {
  function app() {
    const hono = new Hono();
    hono.use("*", cliSessionMiddleware);
    hono.get("/", (c) =>
      c.json({
        userId: (c.get("session" as never) as { user: { id: string } } | null)?.user.id ?? null,
        credential: c.get("credential" as never) ?? null,
      }),
    );
    return hono;
  }

  it("ignores cookies entirely", async () => {
    const res = await app().request("/", {
      headers: { cookie: "better-auth.session_token=device-token.sig" },
    });
    expect(await res.json()).toEqual({ userId: null, credential: null });
    expect(db.session.findUnique).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("stashes the resolved session and credential kind", async () => {
    db.session.findUnique.mockResolvedValue(sessionRow() as never);
    const res = await app().request("/", { headers: { authorization: "Bearer device-token" } });
    expect(await res.json()).toEqual({ userId: "user-1", credential: "session-token" });
  });
});
