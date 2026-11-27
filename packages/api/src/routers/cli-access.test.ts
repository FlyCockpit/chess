import type { Session } from "@cockpit-chess/auth";
import type { Prisma } from "@cockpit-chess/db";
import { createRouterClient, type ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";

import type { Context } from "../context";
import { encodeCursor } from "../lib/pagination";

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
// The lock itself is proven in packages/auth (device-redemption-race.test.ts);
// here it is a pass-through that records how the procedure uses it and can
// play a session that a password reset has already revoked.
const lock = vi.hoisted(() => ({
  calls: [] as Array<{ userId: string; sessionId: string }>,
  revoked: false,
  lapseAfterMint: false,
}));
const runnerLock = vi.hoisted(() => ({
  acquire: vi.fn(async () => {}),
  slot: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  revoke: vi.fn(async () => 1),
}));
vi.mock("@cockpit-chess/auth/runner-machine", () => ({
  revokeRunnerMachinesInTransaction: runnerLock.revoke,
}));
vi.mock("@cockpit-chess/auth/device-redemption-lock", () => {
  class CliCredentialSessionRevokedError extends Error {}
  return {
    CliCredentialSessionRevokedError,
    lockCliCredentials: runnerLock.acquire,
    withCliCredentialLockSlot: runnerLock.slot,
    mintCliCredentialForSession: async (
      session: { userId: string; sessionId: string },
      {
        mint,
        discard,
      }: { mint: () => Promise<unknown>; discard: (m: unknown) => Promise<unknown> },
    ) => {
      lock.calls.push(session);
      if (lock.revoked) throw new CliCredentialSessionRevokedError();
      const minted = await mint();
      if (lock.lapseAfterMint) {
        await discard(minted);
        throw new Error("lapsed");
      }
      return minted;
    },
  };
});

const { default: db } = await import("@cockpit-chess/db");
const { API_KEY_EXPIRY_DAYS, MAX_API_KEYS_PER_USER, cliAccessRouter } = await import(
  "./cli-access"
);
const { verifyCliInstallToken } = await import("../lib/cli-install-token");
const { invalidateForceTwoFactorSettingsCache } = await import("../lib/two-factor-policy");

const now = new Date("2026-10-20T00:00:00Z");
const tx = mockDeep<Prisma.TransactionClient>();

function client(
  userId = "user-1",
  userOverrides: Partial<Session["user"]> = {},
  credential?: Context["credential"],
) {
  const context: Context = {
    credential,
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
        ...userOverrides,
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
  mockReset(db);
  mockReset(tx);
  lock.calls.length = 0;
  lock.revoked = false;
  lock.lapseAfterMint = false;
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
    // Minted under the user's CLI-credential lock, for the session that asked.
    expect(lock.calls).toEqual([{ userId: "user-1", sessionId: "auth-session" }]);
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

  // The request was authorized (maybe from the cookie cache) before a password
  // reset deleted its session and revoked the user's keys.
  it("answers UNAUTHORIZED and mints nothing when the session is gone under the lock", async () => {
    lock.revoked = true;
    db.apiKey.count.mockResolvedValue(0);
    await expect(client().apiKeys.create({ name: "x", expiresInDays: 30 })).rejects.toSatisfy(
      isCode("UNAUTHORIZED"),
    );
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("discards exactly its own key when the lock lapsed", async () => {
    lock.lapseAfterMint = true;
    db.apiKey.count.mockResolvedValue(0);
    createApiKey.mockResolvedValue({
      id: "key-late",
      name: "x",
      start: null,
      expiresAt: null,
      key: "k",
    });
    await expect(client().apiKeys.create({ name: "x", expiresInDays: 30 })).rejects.toThrow();
    expect(db.apiKey.deleteMany).toHaveBeenCalledWith({
      where: { id: "key-late", referenceId: "user-1" },
    });
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
      () => anon.runners.list({}),
      () => anon.runners.revoke({ id: "machine-1" }),
    ]) {
      await expect(call()).rejects.toSatisfy(isCode("UNAUTHORIZED"));
    }
    expect(db.apiKey.findMany).not.toHaveBeenCalled();
    expect(db.apiKey.deleteMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(runnerLock.slot).not.toHaveBeenCalled();
    expect(runnerLock.revoke).not.toHaveBeenCalled();
    expect(createApiKey).not.toHaveBeenCalled();
  });
});

describe("cliAccess.runners", () => {
  const order: string[] = [];
  const machine = {
    id: "machine-1",
    displayName: "Laptop",
    credentialPrefix: "cockpit_chess_runner_abcd1234",
    createdAt: now,
    expiresAt: new Date("2099-01-01"),
    revokedAt: null,
    lastSeenAt: null,
  };
  beforeEach(() => {
    order.length = 0;
    runnerLock.slot.mockImplementation(async (run) => {
      order.push("slot");
      return run();
    });
    runnerLock.acquire.mockImplementation(async () => {
      order.push("lock");
    });
    runnerLock.revoke.mockImplementation(async () => {
      order.push("revoke");
      return 1;
    });
    db.$transaction.mockImplementation(
      async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => run(tx),
    );
    tx.session.findFirst.mockImplementation(async () => {
      order.push("session");
      return { user: { banned: false, banExpires: null } };
    });
    tx.runnerMachine.findMany.mockResolvedValue([]);
  });

  it("lists safe metadata with a bounded cursor, including active, expired and revoked status", async () => {
    tx.runnerMachine.findMany.mockImplementation(async () => {
      order.push("list");
      return [
        machine,
        { ...machine, id: "expired", expiresAt: new Date("2000-01-01") },
        { ...machine, id: "revoked", revokedAt: now },
        { ...machine, id: "lookahead" },
      ];
    });
    const page = await client().runners.list({ limit: 3 });
    expect(page.items.map(({ status }) => status)).toEqual(["active", "expired", "revoked"]);
    expect(page.nextCursor).toBe(encodeCursor({ id: "revoked", sortValue: now }));
    expect(tx.runnerMachine.findMany).toHaveBeenCalledWith({
      where: { AND: [{ userId: "user-1" }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 4,
      select: {
        id: true,
        displayName: true,
        credentialPrefix: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
        lastSeenAt: true,
      },
    });
    expect(page.items[0]).not.toHaveProperty("credentialDigest");
    expect(page.items[0]).not.toHaveProperty("userId");
    expect(runnerLock.slot).toHaveBeenCalledOnce();
    expect(runnerLock.acquire).toHaveBeenCalledExactlyOnceWith("user-1", tx);
    expect(db.$transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      timeout: 30_000,
    });
    expect(order).toEqual(["slot", "lock", "session", "list"]);
    expect(db.runnerMachine.findMany).not.toHaveBeenCalled();
  });

  it("keeps ownership on the next page and orders equal timestamps by ID", async () => {
    const cursor = encodeCursor({ id: "machine-1", sortValue: now });
    await expect(client().runners.list({ limit: 2, cursor })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(tx.runnerMachine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { userId: "user-1" },
            { OR: [{ createdAt: { lt: now } }, { createdAt: now, id: { lt: "machine-1" } }] },
          ],
        },
        take: 3,
      }),
    );
  });

  it("rejects unbounded or malformed pagination inputs", async () => {
    for (const input of [{ limit: 0 }, { limit: 101 }, { cursor: "invalid" }]) {
      await expect(client().runners.list(input)).rejects.toSatisfy(isCode("BAD_REQUEST"));
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("calls the transactional revocation/notification helper only for an owned machine", async () => {
    tx.runnerMachine.findFirst.mockResolvedValue({ id: "machine-1" });
    await expect(client().runners.revoke({ id: "machine-1" })).resolves.toEqual({ success: true });
    expect(tx.runnerMachine.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: "machine-1", userId: "user-1" },
      select: { id: true },
    });
    expect(runnerLock.revoke).toHaveBeenCalledExactlyOnceWith(tx, "user-1", "machine-1");
    expect(order).toEqual(["slot", "lock", "session", "revoke"]);
    expect(db.runnerMachine.findFirst).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for foreign or missing machines without publishing invalidation", async () => {
    tx.runnerMachine.findFirst.mockResolvedValue(null);
    await expect(client().runners.revoke({ id: "foreign" })).rejects.toSatisfy(isCode("NOT_FOUND"));
    expect(tx.runnerMachine.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign", userId: "user-1" },
      select: { id: true },
    });
    expect(runnerLock.revoke).not.toHaveBeenCalled();
  });

  it("allows repeated revoke of an owned revoked machine", async () => {
    tx.runnerMachine.findFirst.mockResolvedValue({ id: "machine-1" });
    runnerLock.revoke.mockResolvedValueOnce(0);
    await expect(client().runners.revoke({ id: "machine-1" })).resolves.toEqual({ success: true });
    expect(runnerLock.revoke).toHaveBeenCalledWith(tx, "user-1", "machine-1");
  });

  it("propagates notification failure so the transaction cannot report successful revocation", async () => {
    tx.runnerMachine.findFirst.mockResolvedValue({ id: "machine-1" });
    const failure = new Error("notification failed");
    runnerLock.revoke.mockRejectedValueOnce(failure);
    await expect(client().runners.revoke({ id: "machine-1" })).rejects.toBe(failure);
  });

  it.each(["list", "revoke"] as const)(
    "rejects a stale session on %s under the lock",
    async (action) => {
      tx.session.findFirst.mockResolvedValue(null);
      const runners = client().runners;
      await expect(
        action === "list" ? runners.list({}) : runners.revoke({ id: "machine-1" }),
      ).rejects.toSatisfy(isCode("UNAUTHORIZED"));
      expect(tx.session.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: {
          id: "auth-session",
          userId: "user-1",
          expiresAt: { gt: expect.any(Date) },
          origin: "sign-in",
          impersonatedBy: null,
        },
        select: { user: { select: { banned: true, banExpires: true } } },
      });
      expect(runnerLock.acquire).toHaveBeenCalledWith("user-1", tx);
      expect(tx.runnerMachine.findMany).not.toHaveBeenCalled();
      expect(tx.runnerMachine.findFirst).not.toHaveBeenCalled();
      expect(runnerLock.revoke).not.toHaveBeenCalled();
    },
  );

  it.each(["api-key", "session-token"] as const)(
    "refuses %s bearers on both browser procedures",
    async (credential) => {
      const runners = client("user-1", {}, credential).runners;
      await expect(runners.list({})).rejects.toSatisfy(isCode("UNAUTHORIZED"));
      await expect(runners.revoke({ id: "machine-1" })).rejects.toSatisfy(isCode("UNAUTHORIZED"));
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(runnerLock.revoke).not.toHaveBeenCalled();
    },
  );

  it.each(["list", "revoke"] as const)("rechecks fresh owner bans on %s", async (action) => {
    tx.session.findFirst.mockResolvedValue({ user: { banned: true, banExpires: null } });
    const runners = client().runners;
    await expect(
      action === "list" ? runners.list({}) : runners.revoke({ id: "machine-1" }),
    ).rejects.toSatisfy(isCode("UNAUTHORIZED"));
    expect(tx.runnerMachine.findMany).not.toHaveBeenCalled();
    expect(tx.runnerMachine.findFirst).not.toHaveBeenCalled();
    expect(runnerLock.revoke).not.toHaveBeenCalled();
  });

  it("permits an expired temporary ban, using the shared predicate", async () => {
    tx.session.findFirst.mockResolvedValue({
      user: { banned: true, banExpires: new Date("2000-01-01") },
    });
    await expect(client().runners.list({})).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("retains the banned-user and forced-2FA gates before taking a transaction slot", async () => {
    for (const [overrides, code] of [
      [{ banned: true, banExpires: null }, "UNAUTHORIZED"],
      [{ role: "admin", twoFactorEnabled: false, createdAt: new Date("2020-01-01") }, "FORBIDDEN"],
    ] as const) {
      const runners = client("user-1", overrides).runners;
      await expect(runners.list({})).rejects.toSatisfy(isCode(code));
      await expect(runners.revoke({ id: "machine-1" })).rejects.toSatisfy(isCode(code));
    }
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(runnerLock.slot).not.toHaveBeenCalled();
    expect(runnerLock.revoke).not.toHaveBeenCalled();
  });
});

describe("credential mint authority codes", () => {
  it("retains UNAUTHORIZED for a banned session before entering the mint lock", async () => {
    await expect(
      client("user-1", { banned: true, banExpires: null }).apiKeys.create({
        name: "key",
        expiresInDays: 30,
      }),
    ).rejects.toSatisfy(isCode("UNAUTHORIZED"));
    expect(createApiKey).not.toHaveBeenCalled();
    expect(lock.calls).toHaveLength(0);
  });
  it("retains FORBIDDEN for an established admin missing required 2FA", async () => {
    await expect(
      client("user-1", {
        role: "admin",
        twoFactorEnabled: false,
        createdAt: new Date("2020-01-01"),
      }).apiKeys.create({ name: "key", expiresInDays: 30 }),
    ).rejects.toSatisfy(isCode("FORBIDDEN"));
    expect(createApiKey).not.toHaveBeenCalled();
    expect(lock.calls).toHaveLength(0);
  });
});
