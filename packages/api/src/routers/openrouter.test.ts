import type { Session } from "@cockpit-chess/auth";
import type prismaInstance from "@cockpit-chess/db";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepMockProxy } from "vitest-mock-extended";
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
    expect(await client().status()).toMatchObject({ status: "invalid", live: false });
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
    expect(await client().status()).toMatchObject({ status: "invalid", live: false });
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

describe("openrouter.disconnect", () => {
  it("deletes only the caller's row and returns the hash for the revoke link", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue({ keyHash: HASH } as never);
    db.openRouterConnection.deleteMany.mockResolvedValue({ count: 1 });
    expect(await client("user-c").disconnect()).toEqual({ disconnected: true, keyHash: HASH });
    expect(db.openRouterConnection.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-c" },
    });
  });
});
