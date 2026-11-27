import type { Session } from "@cockpit-chess/auth";
import type prismaInstance from "@cockpit-chess/db";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";
import type { Context } from "../context";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
const { env } = vi.hoisted(() => ({
  env: {
    OPENROUTER_ORIGIN: "https://openrouter.test",
    CHESS_PROVIDER_KEY_SECRET: "11".repeat(32) as string | undefined,
    CHESS_PROVIDER_KEY_SECRET_PREVIOUS: undefined,
    CHESS_HOSTED_ENABLED: true,
    CHESS_USER_MATCHES_ENABLED: true,
  },
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env }));
const { fake } = vi.hoisted(() => ({
  fake: {} as {
    valkey: ReturnType<
      typeof import("@cockpit-chess/queue/chess-key-revocation/test-support").fakeValkey
    >;
  },
}));
vi.mock("@cockpit-chess/queue", async () => {
  const { fakeValkey } = await import("@cockpit-chess/queue/chess-key-revocation/test-support");
  fake.valkey = fakeValkey();
  return { redisConnection: fake.valkey.connection };
});
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => async () => {} }));
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const { openrouterRouter, resetOpenRouterStatusCache } = await import("./openrouter");
const { hashProviderKey, sealProviderKey } = await import("../lib/provider-key");
const { invalidateForceTwoFactorSettingsCache } = await import("../index");

const CANARY = "sk-or-v1-CANARY2222222222222222222222222222222222222222222222222222";
const HASH = hashProviderKey(CANARY);
function context(id: string, role = "user"): Context {
  return {
    clientIp: "127.0.0.1",
    session: {
      user: {
        id,
        name: "Test",
        email: `${id}@example.com`,
        emailVerified: true,
        role,
        twoFactorEnabled: true,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
      },
      session: {
        id: "s",
        userId: id,
        token: "t",
        expiresAt: new Date("2027-01-01"),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
    } as Session,
  };
}
const client = (id = "user-a") => createRouterClient(openrouterRouter, { context: context(id) });
const stored = (userId: string) => ({
  id: "conn",
  ...sealProviderKey(userId, CANARY, "11".repeat(32)),
  keyHash: HASH,
  keyHint: CANARY.slice(-4),
  label: "Cockpit Chess (stored)",
  limitMicros: 10_000_000n,
  expiresAt: null,
  status: "active",
  createdAt: new Date("2026-11-26T00:00:00Z"),
});
const keyResponse = (status = 200) =>
  new Response(
    JSON.stringify({
      data: { label: "Live label", limit: 10, limit_remaining: 6, usage: 4, usage_daily: 1 },
    }),
    { status },
  );

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mockReset(db);
  resetOpenRouterStatusCache();
  invalidateForceTwoFactorSettingsCache();
  db.appSetting.findMany.mockResolvedValue([]);
  env.CHESS_USER_MATCHES_ENABLED = true;
});

describe("openrouter.status", () => {
  it("reports not connected", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(null);
    expect(await client().status()).toEqual({ available: true, connected: false });
  });

  it("shows OpenRouter's live numbers and never the key", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(stored("user-a") as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(keyResponse());
    const status = await client().status();
    expect(status).toEqual({
      available: true,
      connected: true,
      status: "active",
      invalidReason: null,
      label: "Live label",
      keyHint: CANARY.slice(-4),
      keyHash: HASH,
      limitMicros: 10_000_000,
      limitRemainingMicros: 6_000_000,
      usageMicros: 4_000_000,
      usageDailyMicros: 1_000_000,
      expiresAt: null,
      connectedAt: "2026-11-26T00:00:00.000Z",
      live: true,
    });
    expect(JSON.stringify(status)).not.toContain("CANARY");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Cached: a second read within a minute does not call OpenRouter again.
    await client().status();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("only ever reads the caller's own row", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(null);
    await client("user-b").status();
    for (const call of db.openRouterConnection.findUnique.mock.calls)
      expect(call[0]?.where).toEqual({ userId: "user-b" });
  });

  it("does not open another user's ciphertext", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(stored("user-a") as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(keyResponse());
    const status = await client("user-b").status();
    expect(fetchSpy).not.toHaveBeenCalled();
    // A row that does not open for its user reads as needing a reconnect.
    expect(status).toMatchObject({ status: "invalid", live: false, limitMicros: 10_000_000 });
  });

  it("asks for a reconnect when the sealing secret was rotated away", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue({
      ...stored("user-a"),
      ...sealProviderKey("user-a", CANARY, "33".repeat(32)),
    } as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(keyResponse());
    expect(await client().status()).toMatchObject({
      status: "invalid",
      invalidReason: "unreadable",
      live: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    // Another replica may still hold that secret mid-rotation: the shared row stays active.
    expect(db.openRouterConnection.updateMany).not.toHaveBeenCalled();
  });

  it("shares one OpenRouter call among concurrent cold reads", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(stored("user-a") as never);
    let release: (response: Response) => void = () => undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const reads = Array.from({ length: 10 }, () => client().status());
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    release(keyResponse());
    for (const read of reads) expect(await read).toMatchObject({ live: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("marks a key OpenRouter refuses invalid, so the page asks to reconnect", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(stored("user-a") as never);
    db.openRouterConnection.updateMany.mockResolvedValue({ count: 1 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(keyResponse(401));
    expect(await client().status()).toMatchObject({
      status: "invalid",
      invalidReason: "rejected",
      live: false,
    });
    expect(db.openRouterConnection.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-a", keyHash: HASH, status: "active" },
      data: { status: "invalid", lastCheckedAt: expect.any(Date) },
    });
  });

  it("falls back to the stored numbers when OpenRouter is unreachable", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(stored("user-a") as never);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(`down ${CANARY}`));
    const status = await client().status();
    expect(status).toMatchObject({
      status: "active",
      live: false,
      label: "Cockpit Chess (stored)",
    });
    expect(JSON.stringify(status)).not.toContain("CANARY");
  });

  it("reads as unavailable for users while the operator has not opened user matches", async () => {
    env.CHESS_USER_MATCHES_ENABLED = false;
    db.openRouterConnection.findUnique.mockResolvedValue(null);
    expect(await client().status()).toEqual({ available: false, connected: false });
  });

  it("requires a signed-in user", async () => {
    await expect(
      createRouterClient(openrouterRouter, {
        context: { session: null, clientIp: "1" },
      }).status(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

const LEASES = "cockpit-chess:openrouter-key-use:";
const REVOKED = "cockpit-chess:openrouter-key-revoked:";
/** A live lease in the fake Valkey, as a worker or a status read would hold it. */
const holdLease = (userId: string, member: string, ms = 30_000) => {
  const set = fake.valkey.sets.get(`${LEASES}${userId}`) ?? new Map<string, number>();
  set.set(member, Date.now() + ms);
  fake.valkey.sets.set(`${LEASES}${userId}`, set);
  return () => set.delete(member);
};

describe("openrouter.disconnect", () => {
  const revocations = () =>
    fake.valkey.published.map(([channel, raw]) => ({ channel, ...JSON.parse(raw) }));
  beforeEach(() => {
    fake.valkey.sets.clear();
    fake.valkey.published.length = 0;
    fake.valkey.state.down = false;
    fake.valkey.state.uptimeSeconds = 3600;
    db.$transaction.mockImplementation((async (run: (tx: typeof db) => unknown) =>
      run(db)) as never);
    db.openRouterConnection.findUnique
      .mockResolvedValueOnce({ keyHash: HASH } as never)
      .mockResolvedValue(null);
    db.openRouterConnection.deleteMany.mockResolvedValue({ count: 1 });
    db.chessMatch.updateMany.mockResolvedValue({ count: 0 });
  });

  it("records the key as revoked, deletes that exact key and tells every worker", async () => {
    expect(await client("user-c").disconnect()).toEqual({
      disconnected: true,
      keyHash: HASH,
      stopped: "none",
    });
    expect([...(fake.valkey.sets.get(`${REVOKED}user-c`)?.keys() ?? [])]).toEqual([HASH]);
    expect(db.openRouterConnection.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-c", keyHash: HASH },
    });
    expect(revocations()).toEqual([
      { channel: "cockpit-chess:openrouter-key-revoked", userId: "user-c", keyHashes: [HASH] },
    ]);
    expect(JSON.stringify(fake.valkey.published)).not.toContain("CANARY");
  });

  it("waits for the active match row lock before exposing key revocation to a worker", async () => {
    let release: (rows: never[]) => void = () => undefined;
    const blocked = new Promise<never[]>((resolve) => {
      release = resolve;
    });
    db.$queryRaw.mockResolvedValueOnce([]).mockImplementationOnce(() => blocked);
    const pending = client("user-c").disconnect();
    await vi.waitFor(() => expect(db.$queryRaw).toHaveBeenCalledTimes(2));
    const lock = db.$queryRaw.mock.calls[1]?.[0];
    expect(String(lock)).toContain("FOR UPDATE");
    expect(fake.valkey.sets.get(`${REVOKED}user-c`)).toBeUndefined();
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    release([]);
    await expect(pending).resolves.toMatchObject({ disconnected: true });
    expect(fake.valkey.sets.get(`${REVOKED}user-c`)?.has(HASH)).toBe(true);
  });

  it("fences queued and running own-key matches as owner withdrawals in the delete's transaction", async () => {
    await client("user-c").disconnect();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.chessMatch.updateMany).toHaveBeenCalledWith({
      where: {
        ownerId: "user-c",
        credentialSource: "owner-openrouter",
        status: { in: ["queued", "running"] },
      },
      data: {
        status: "error",
        runToken: null,
        ending: { kind: "credential-revoked" },
        terminalCause: "owner-disconnect",
      },
    });
    expect(db.openRouterConnection.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.chessMatch.updateMany.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("takes the create lock before reading or deleting anything", async () => {
    db.$queryRaw.mockResolvedValue([{ locked: "" }] as never);
    await client("user-c").disconnect();
    const lock = db.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(lock[0].join("?")).toContain("pg_advisory_xact_lock");
    expect(lock[1]).toBe("cockpit-chess:chess-create");
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.openRouterConnection.findUnique.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("says pending while Valkey has just restarted (leases may be missing)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      fake.valkey.state.uptimeSeconds = 3;
      const pending = client("user-c").disconnect();
      await vi.advanceTimersByTimeAsync(10_100);
      expect(await pending).toMatchObject({ stopped: "pending" });
    } finally {
      vi.useRealTimers();
      fake.valkey.state.uptimeSeconds = 3600;
    }
  });

  it("keeps a key another tab connected meanwhile, and its queued match", async () => {
    db.openRouterConnection.findUnique.mockReset();
    db.openRouterConnection.findUnique
      .mockResolvedValueOnce({ keyHash: HASH } as never)
      .mockResolvedValue({ keyHash: "hash-new" } as never);
    db.openRouterConnection.deleteMany.mockResolvedValue({ count: 0 });
    const newer = holdLease("user-c", "m9|hash-new");
    expect(await client("user-c").disconnect()).toMatchObject({ stopped: "none" });
    expect(db.chessMatch.updateMany).not.toHaveBeenCalled();
    // Only the old key is revoked: the run on the new one never blocks or stops.
    expect(revocations()[0]?.keyHashes).toEqual([HASH]);
    newer();
  });

  it("refuses without deleting anything when the revocation cannot be recorded", async () => {
    fake.valkey.state.down = true;
    await expect(client("user-c").disconnect()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(db.openRouterConnection.deleteMany).not.toHaveBeenCalled();
  });

  it("answers only once no run holds the revoked key", async () => {
    const release = holdLease("user-c", `m1|${HASH}`);
    const pending = client("user-c").disconnect();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(settled).toBe(false);
    release();
    expect(await pending).toMatchObject({ stopped: "stopped" });
  });

  it("waits for a run still loading a key and for a status read holding it", async () => {
    const loading = holdLease("user-c", "m2|loading");
    const read = holdLease("user-c", "read-1|loading");
    const pending = client("user-c").disconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));
    loading();
    await new Promise((resolve) => setTimeout(resolve, 200));
    read();
    expect(await pending).toMatchObject({ stopped: "stopped" });
  });

  it("treats an expired lease as ended (its holder fenced itself before)", async () => {
    holdLease("user-c", `m3|${HASH}`, -1);
    expect(await client("user-c").disconnect()).toMatchObject({ stopped: "none" });
  });

  it("says pending, within the deadline, when a holder does not answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      holdLease("user-c", `m4|${HASH}`, 60_000);
      const pending = client("user-c").disconnect();
      await vi.advanceTimersByTimeAsync(10_100);
      expect(await pending).toMatchObject({ stopped: "pending" });
    } finally {
      vi.useRealTimers();
    }
    expect(db.openRouterConnection.deleteMany).toHaveBeenCalled();
  });

  it("says pending, never 'none', when Valkey cannot tell", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      db.$transaction.mockImplementation((async (run: (tx: typeof db) => unknown) => {
        const result = await run(db);
        fake.valkey.state.down = true;
        return result;
      }) as never);
      const pending = client("user-c").disconnect();
      await vi.advanceTimersByTimeAsync(10_100);
      expect(await pending).toMatchObject({ stopped: "pending" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still waits on a run on a disconnected key when the revoked list was lost", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      // Valkey restarted: no revoked list, no row; a worker that missed the message
      // still renews its lease on the old key.
      db.openRouterConnection.findUnique.mockReset();
      db.openRouterConnection.findUnique.mockResolvedValue(null);
      holdLease("user-c", "m6|hash-lost", 60_000);
      const pending = client("user-c").disconnect();
      await vi.advanceTimersByTimeAsync(10_100);
      expect(await pending).toMatchObject({ stopped: "pending" });
      expect(revocations()[0]?.keyHashes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers within the deadline when the database stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      db.$transaction.mockImplementation((() => new Promise(() => {})) as never);
      const pending = client("user-c").disconnect();
      const outcome = expect(pending).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(6000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("repeats the broadcast for recently revoked keys when called again", async () => {
    fake.valkey.sets.set(`${REVOKED}user-c`, new Map([[HASH, Date.now()]]));
    db.openRouterConnection.findUnique.mockReset();
    db.openRouterConnection.findUnique.mockResolvedValue(null);
    const release = holdLease("user-c", `m5|${HASH}`);
    const pending = client("user-c").disconnect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    expect(await pending).toEqual({ disconnected: true, keyHash: null, stopped: "stopped" });
    expect(revocations()[0]?.keyHashes).toEqual([HASH]);
    expect(db.openRouterConnection.deleteMany).not.toHaveBeenCalled();
  });
});

describe("openrouter.status key-use lease", () => {
  beforeEach(() => {
    fake.valkey.sets.clear();
    fake.valkey.state.down = false;
  });

  it("holds a loading lease while it calls OpenRouter with the key, and releases it", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(stored("user-a") as never);
    let during: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      during = [...(fake.valkey.sets.get(`${LEASES}user-a`)?.keys() ?? [])];
      expect(init?.signal).toBeDefined();
      return keyResponse();
    });
    await client().status();
    expect(during).toHaveLength(1);
    expect(during[0]).toMatch(/\|loading$/);
    expect([...(fake.valkey.sets.get(`${LEASES}user-a`)?.keys() ?? [])]).toEqual([]);
  });

  it("releases a lease whose take was applied but whose reply was lost", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(stored("user-a") as never);
    fake.valkey.state.failAfterApplying = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(keyResponse());
    try {
      await client().status();
    } finally {
      fake.valkey.state.failAfterApplying = false;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect([...(fake.valkey.sets.get(`${LEASES}user-a`)?.keys() ?? [])]).toEqual([]);
  });

  it("makes no keyed call when the lease cannot be taken", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(stored("user-a") as never);
    fake.valkey.state.down = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(keyResponse());
    expect(await client().status()).toMatchObject({ status: "active", live: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
