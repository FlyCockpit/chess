import type prismaInstance from "@cockpit-chess/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepMockProxy } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
const { env } = vi.hoisted(() => ({
  env: {
    CHESS_PROVIDER_KEY_SECRET: "11".repeat(32) as string | undefined,
    CHESS_PROVIDER_KEY_SECRET_PREVIOUS: undefined as string | undefined,
  },
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env }));
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const {
  hashProviderKey,
  loadOwnerOpenRouterKey,
  markOpenRouterKeyInvalid,
  openOwnerOpenRouterKey,
  openProviderKey,
  providerKeySecretId,
  sealProviderKey,
} = await import("./provider-key");

const CANARY = "sk-or-v1-CANARY0000000000000000000000000000000000000000000000000000";
const CURRENT = "11".repeat(32);
const PREVIOUS = "22".repeat(32);
const row = (userId: string, secret: string, key = CANARY) => ({
  id: "conn",
  ...sealProviderKey(userId, key, secret),
  keyHash: hashProviderKey(key),
  status: "active",
  updatedAt: new Date("2026-11-26T00:00:00Z"),
});

beforeEach(() => {
  vi.clearAllMocks();
  env.CHESS_PROVIDER_KEY_SECRET = CURRENT;
  env.CHESS_PROVIDER_KEY_SECRET_PREVIOUS = undefined;
});

describe("sealed provider keys", () => {
  it("round-trips and never stores the plaintext", () => {
    const sealed = sealProviderKey("user-a", CANARY, CURRENT);
    expect(Buffer.from(sealed.keyCiphertext).toString("utf8")).not.toContain("CANARY");
    expect(sealed.keyNonce).toHaveLength(12);
    expect(sealed.keySecretId).toBe(providerKeySecretId(CURRENT));
    expect(sealed.keySecretId).not.toContain(CURRENT.slice(0, 16));
    expect(openProviderKey("user-a", sealed, CURRENT)).toBe(CANARY);
  });

  it("binds the ciphertext to its user, its secret and its bytes", () => {
    const sealed = sealProviderKey("user-a", CANARY, CURRENT);
    expect(openProviderKey("user-b", sealed, CURRENT)).toBeNull();
    expect(openProviderKey("user-a", sealed, PREVIOUS)).toBeNull();
    const tampered = new Uint8Array(sealed.keyCiphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(openProviderKey("user-a", { ...sealed, keyCiphertext: tampered }, CURRENT)).toBeNull();
  });

  it("uses a fresh nonce per seal", () => {
    const a = sealProviderKey("user-a", CANARY, CURRENT);
    const b = sealProviderKey("user-a", CANARY, CURRENT);
    expect(Buffer.from(a.keyNonce).equals(Buffer.from(b.keyNonce))).toBe(false);
  });
});

describe("loadOwnerOpenRouterKey", () => {
  it("loads the owner's own row and opens it with the owner's id", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(row("user-a", CURRENT) as never);
    expect(await loadOwnerOpenRouterKey("user-a")).toEqual({
      apiKey: CANARY,
      keyHash: hashProviderKey(CANARY),
    });
    expect(db.openRouterConnection.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-a" } }),
    );
  });

  it("does not open another user's ciphertext copied onto this row", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue(row("user-a", CURRENT) as never);
    expect(await loadOwnerOpenRouterKey("user-b")).toBeNull();
  });

  it("leaves a row sealed with a secret this process lacks untouched (rolling rotation)", async () => {
    // Sealed with a secret this process does not hold: another replica may.
    db.openRouterConnection.findUnique.mockResolvedValue(row("user-a", PREVIOUS) as never);
    expect(await openOwnerOpenRouterKey("user-a")).toEqual({
      state: "unreadable",
      keyHash: hashProviderKey(CANARY),
    });
    expect(db.openRouterConnection.updateMany).not.toHaveBeenCalled();
  });

  it("marks a row a configured secret sealed but that does not open invalid", async () => {
    const sealed = row("user-a", CURRENT);
    const tampered = new Uint8Array(sealed.keyCiphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    db.openRouterConnection.findUnique.mockResolvedValue({
      ...sealed,
      keyCiphertext: tampered,
    } as never);
    db.openRouterConnection.updateMany.mockResolvedValue({ count: 1 });
    expect(await openOwnerOpenRouterKey("user-a")).toEqual({
      state: "unreadable",
      keyHash: hashProviderKey(CANARY),
    });
    expect(db.openRouterConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "conn",
        keyHash: hashProviderKey(CANARY),
        keySecretId: providerKeySecretId(CURRENT),
        status: "active",
      },
      data: { status: "invalid", lastCheckedAt: expect.any(Date) },
    });
  });

  it("changes nothing when no secret is configured here", async () => {
    env.CHESS_PROVIDER_KEY_SECRET = undefined;
    expect(await openOwnerOpenRouterKey("user-a")).toEqual({ state: "unconfigured" });
    expect(db.openRouterConnection.findUnique).not.toHaveBeenCalled();
    expect(db.openRouterConnection.updateMany).not.toHaveBeenCalled();
  });

  it("refuses inactive rows and missing secrets", async () => {
    db.openRouterConnection.findUnique.mockResolvedValue({
      ...row("user-a", CURRENT),
      status: "invalid",
    } as never);
    expect(await loadOwnerOpenRouterKey("user-a")).toBeNull();
    env.CHESS_PROVIDER_KEY_SECRET = undefined;
    expect(await loadOwnerOpenRouterKey("user-a")).toBeNull();
  });

  it("opens rows sealed with the previous secret and re-seals them with the current one", async () => {
    env.CHESS_PROVIDER_KEY_SECRET_PREVIOUS = PREVIOUS;
    db.openRouterConnection.findUnique.mockResolvedValue(row("user-a", PREVIOUS) as never);
    db.openRouterConnection.updateMany.mockResolvedValue({ count: 1 });
    expect((await loadOwnerOpenRouterKey("user-a"))?.apiKey).toBe(CANARY);
    const update = db.openRouterConnection.updateMany.mock.calls[0]?.[0];
    // The CAS names the exact row version read: a key reconnected in between survives.
    expect(update?.where).toEqual({
      id: "conn",
      keySecretId: providerKeySecretId(PREVIOUS),
      keyHash: hashProviderKey(CANARY),
      updatedAt: new Date("2026-11-26T00:00:00Z"),
    });
    expect(update?.data).toMatchObject({ keySecretId: providerKeySecretId(CURRENT) });
    expect(JSON.stringify(update)).not.toContain("CANARY");
  });

  it("marks a refused key invalid only while it is still the stored one", async () => {
    db.openRouterConnection.updateMany.mockResolvedValue({ count: 1 });
    await markOpenRouterKeyInvalid("user-a", "hash");
    expect(db.openRouterConnection.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-a", keyHash: "hash", status: "active" },
      data: { status: "invalid", lastCheckedAt: expect.any(Date) },
    });
  });
});
