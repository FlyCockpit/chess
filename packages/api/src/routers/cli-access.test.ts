import type { Session } from "@cockpit-chess/auth";
import { createRouterClient, type ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
const env = vi.hoisted(
  () =>
    ({
      BETTER_AUTH_SECRET: "s".repeat(32),
      BETTER_AUTH_URL: "https://api.example.com",
    }) as Record<string, string | undefined>,
);
vi.mock("@cockpit-chess/env/server", () => ({ env, ADMIN_EMAILS: new Set<string>() }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: {} }));
const createApiKey = vi.hoisted(() => vi.fn());
vi.mock("@cockpit-chess/auth", () => ({ auth: { api: { createApiKey } } }));

const { default: db } = await import("@cockpit-chess/db");
const { API_KEY_EXPIRY_DAYS, MAX_API_KEYS_PER_USER, cliAccessRouter } = await import(
  "./cli-access"
);
const { verifyCliInstallToken } = await import("../lib/cli-install-token");
const { invalidateForceTwoFactorSettingsCache } = await import("../lib/two-factor-policy");

const now = new Date("2026-10-20T00:00:00Z");

function client(userId = "user-1") {
  const context: Context = {
    session: {
      user: {
        id: userId,
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: "auth-session",
        userId,
        token: "token",
        expiresAt: new Date("2027-01-01"),
        ipAddress: null,
        userAgent: null,
        createdAt: now,
        updatedAt: now,
      },
    } as Session,
  };
  return createRouterClient(cliAccessRouter, { context });
}

const anonymous = () => createRouterClient(cliAccessRouter, { context: { session: null } });

const isCode = (code: string) => (error: ORPCError<string, unknown>) => error.code === code;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateForceTwoFactorSettingsCache();
  db.appSetting.findMany.mockResolvedValue([]);
  delete env.CLI_RELEASE_REPO;
});

describe("cliAccess.installCommand", () => {
  it("reports unavailable when no release source is configured", async () => {
    await expect(client().installCommand()).resolves.toEqual({ available: false });
  });

  it("returns copy-paste commands carrying a fresh, valid token for the caller", async () => {
    env.CLI_RELEASE_REPO = "acme/app";

    const first = await client().installCommand();
    if (!first.available) throw new Error("expected available");
    expect(first.unix).toMatch(
      /^curl -fsSL -H "Authorization: Install v1\.[^"]+" "https:\/\/api\.example\.com\/api\/cli\/install\.sh" \| sh$/,
    );
    expect(first.windows).toMatch(
      /^irm -Headers @\{ Authorization = "Install v1\.[^"]+" \} "https:\/\/api\.example\.com\/api\/cli\/install\.ps1" \| iex$/,
    );
    const token = /Authorization: Install (\S+)"/.exec(first.unix)?.[1] ?? "";
    expect(verifyCliInstallToken(token)).toBe("user-1");
    expect(first.expiresAt.getTime()).toBeGreaterThan(Date.now());

    vi.useFakeTimers({ now: Date.now() + 1000 });
    try {
      const second = await client().installCommand();
      if (!second.available) throw new Error("expected available");
      expect(second.unix).not.toBe(first.unix);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cliAccess.apiKeys", () => {
  it("lists only the caller's keys, bounded, with the disclosure-safe projection", async () => {
    db.apiKey.findMany.mockResolvedValue([]);
    await client().apiKeys.list();

    const args = db.apiKey.findMany.mock.calls[0]?.[0];
    expect(args?.where).toEqual({ referenceId: "user-1" });
    expect(args?.take).toBe(MAX_API_KEYS_PER_USER);
    expect(args?.select).not.toHaveProperty("key");
    expect(args?.select).not.toHaveProperty("referenceId");
  });

  it("creates a key for the session user with the chosen lifetime in seconds", async () => {
    db.apiKey.count.mockResolvedValue(0);
    createApiKey.mockResolvedValue({
      id: "key-1",
      name: "CI",
      start: "starte",
      expiresAt: new Date("2027-01-18"),
      key: "cockpit_chess_plaintext",
      referenceId: "user-1",
    });

    const created = await client().apiKeys.create({ name: " CI ", expiresInDays: 90 });

    expect(createApiKey).toHaveBeenCalledWith({
      body: { name: "CI", expiresIn: 90 * 24 * 60 * 60, userId: "user-1" },
    });
    expect(created).toEqual({
      id: "key-1",
      name: "CI",
      start: "starte",
      expiresAt: new Date("2027-01-18"),
      key: "cockpit_chess_plaintext",
    });
  });

  it("ignores a userId smuggled into the input", async () => {
    db.apiKey.count.mockResolvedValue(0);
    createApiKey.mockResolvedValue({ id: "k", name: "x", start: null, expiresAt: null, key: "k" });

    await client().apiKeys.create({
      name: "x",
      expiresInDays: 30,
      userId: "someone-else",
    } as never);

    expect(createApiKey.mock.calls[0]?.[0].body.userId).toBe("user-1");
  });

  it("only offers the fixed lifetimes", async () => {
    expect([...API_KEY_EXPIRY_DAYS]).toEqual([30, 90, 365]);
    for (const expiresInDays of [0, 1, 89, 366, 3650]) {
      await expect(
        client().apiKeys.create({ name: "x", expiresInDays: expiresInDays as 30 }),
      ).rejects.toSatisfy(isCode("BAD_REQUEST"));
    }
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("refuses to exceed the per-user cap", async () => {
    db.apiKey.count.mockResolvedValue(MAX_API_KEYS_PER_USER);
    await expect(client().apiKeys.create({ name: "x", expiresInDays: 30 })).rejects.toSatisfy(
      isCode("BAD_REQUEST"),
    );
    expect(db.apiKey.count).toHaveBeenCalledWith({ where: { referenceId: "user-1" } });
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("undoes its own insert when a concurrent create overshot the cap", async () => {
    db.apiKey.count
      .mockResolvedValueOnce(MAX_API_KEYS_PER_USER - 1)
      .mockResolvedValueOnce(MAX_API_KEYS_PER_USER + 1);
    createApiKey.mockResolvedValue({
      id: "key-race",
      name: "x",
      start: null,
      expiresAt: null,
      key: "k",
    });
    db.apiKey.deleteMany.mockResolvedValue({ count: 1 });

    await expect(client().apiKeys.create({ name: "x", expiresInDays: 30 })).rejects.toSatisfy(
      isCode("BAD_REQUEST"),
    );
    expect(db.apiKey.deleteMany).toHaveBeenCalledWith({
      where: { id: "key-race", referenceId: "user-1" },
    });
  });

  it("keeps a key that lands exactly at the cap", async () => {
    db.apiKey.count
      .mockResolvedValueOnce(MAX_API_KEYS_PER_USER - 1)
      .mockResolvedValueOnce(MAX_API_KEYS_PER_USER);
    createApiKey.mockResolvedValue({
      id: "key-25",
      name: "x",
      start: null,
      expiresAt: null,
      key: "k",
    });

    await expect(client().apiKeys.create({ name: "x", expiresInDays: 30 })).resolves.toMatchObject({
      id: "key-25",
    });
    expect(db.apiKey.deleteMany).not.toHaveBeenCalled();
  });

  it("revokes only within the caller's own keys", async () => {
    db.apiKey.deleteMany.mockResolvedValue({ count: 1 });
    await expect(client().apiKeys.revoke({ id: "key-1" })).resolves.toEqual({ success: true });
    expect(db.apiKey.deleteMany).toHaveBeenCalledWith({
      where: { id: "key-1", referenceId: "user-1" },
    });
  });

  it("answers NOT_FOUND for a key the caller does not own", async () => {
    db.apiKey.deleteMany.mockResolvedValue({ count: 0 });
    await expect(client().apiKeys.revoke({ id: "foreign" })).rejects.toSatisfy(isCode("NOT_FOUND"));
  });
});

describe("cliAccess auth", () => {
  it("rejects anonymous callers on every procedure before touching the database", async () => {
    const anon = anonymous();
    for (const call of [
      () => anon.installCommand(),
      () => anon.apiKeys.list(),
      () => anon.apiKeys.create({ name: "x", expiresInDays: 30 }),
      () => anon.apiKeys.revoke({ id: "key-1" }),
    ]) {
      await expect(call()).rejects.toSatisfy(isCode("UNAUTHORIZED"));
    }
    expect(db.apiKey.findMany).not.toHaveBeenCalled();
    expect(db.apiKey.deleteMany).not.toHaveBeenCalled();
    expect(createApiKey).not.toHaveBeenCalled();
  });
});
