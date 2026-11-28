import type prismaInstance from "@cockpit-chess/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepMockProxy } from "vitest-mock-extended";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
const { env } = vi.hoisted(() => ({
  env: {
    DATABASE_POOL_MAX: 3,
    OPENROUTER_ORIGIN: "https://openrouter.test",
    CHESS_PROVIDER_KEY_SECRET: "11".repeat(32) as string | undefined,
    CHESS_HOSTED_ENABLED: true,
    CHESS_USER_MATCHES_ENABLED: false,
  },
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env }));
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const account = await import("./openrouter-account");
const { openProviderKey } = await import("./provider-key");

const CANARY = "sk-or-v1-CANARY1111111111111111111111111111111111111111111111111111";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  db.openRouterConnection.upsert.mockClear();
  db.$transaction.mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    return run(db);
  });
  db.user.findUnique.mockResolvedValue({ deletionRequestedAt: null, banned: false } as never);
  db.$executeRaw.mockResolvedValue(0);
  env.CHESS_PROVIDER_KEY_SECRET = "11".repeat(32);
  env.CHESS_HOSTED_ENABLED = true;
  env.CHESS_USER_MATCHES_ENABLED = false;
});

describe("PKCE", () => {
  it("derives the S256 challenge OpenRouter documents", () => {
    // RFC 7636 appendix B test vector.
    expect(account.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(account.newPkceSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("exchangeOpenRouterCode", () => {
  it("posts the code and verifier to the fixed origin and returns the key", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ key: CANARY }));
    expect(await account.exchangeOpenRouterCode("code-1", "verifier-1", fetcher)).toBe(CANARY);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://openrouter.test/api/v1/auth/keys");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(init.body)).toEqual({
      code: "code-1",
      code_verifier: "verifier-1",
      code_challenge_method: "S256",
    });
  });

  it.each([
    [403, "exchange"],
    [400, "exchange"],
    [500, "unavailable"],
  ] as const)("maps HTTP %i to %s without echoing anything", async (status, code) => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: { message: CANARY } }, status));
    const error = await account.exchangeOpenRouterCode("c", "v", fetcher).catch((e) => e);
    expect(error).toMatchObject({ code });
    expect(String(error.message)).not.toContain("CANARY");
  });

  it("maps a network failure to unavailable", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(`boom ${CANARY}`));
    const error = await account.exchangeOpenRouterCode("c", "v", fetcher).catch((e) => e);
    expect(error).toMatchObject({ code: "unavailable" });
    expect(String(error.message)).not.toContain("CANARY");
  });
});

describe("fetchOpenRouterKeyInfo", () => {
  it("reads the key's numbers in micros", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        data: {
          label: "Cockpit Chess (chess.example)",
          limit: 10,
          limit_remaining: 7.5,
          usage: 2.5,
          usage_daily: 0.25,
          expires_at: "2027-02-24T00:00:00Z",
        },
      }),
    );
    expect(await account.fetchOpenRouterKeyInfo(CANARY, fetcher)).toEqual({
      label: "Cockpit Chess (chess.example)",
      limitMicros: 10_000_000,
      limitRemainingMicros: 7_500_000,
      usageMicros: 2_500_000,
      usageDailyMicros: 250_000,
      expiresAt: new Date("2027-02-24T00:00:00Z"),
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://openrouter.test/api/v1/key");
    expect(fetcher.mock.calls[0]?.[1].headers).toEqual({ authorization: `Bearer ${CANARY}` });
  });

  it("reads a key with no limit or expiry as nulls, and a 401 as rejected", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ data: { limit: null, usage: 0 } }))
      .mockResolvedValueOnce(json({}, 401));
    expect(await account.fetchOpenRouterKeyInfo(CANARY, fetcher)).toMatchObject({
      limitMicros: null,
      expiresAt: null,
    });
    await expect(account.fetchOpenRouterKeyInfo(CANARY, fetcher)).rejects.toMatchObject({
      code: "rejected",
    });
  });
});

describe("saveOpenRouterConnection", () => {
  it("stores only the sealed key, its hash and its hint", async () => {
    db.openRouterConnection.upsert.mockResolvedValue({ id: "c" } as never);
    await account.saveOpenRouterConnection("user-a", CANARY, {
      label: "L",
      limitMicros: 10_000_000,
      limitRemainingMicros: null,
      usageMicros: null,
      usageDailyMicros: null,
      expiresAt: null,
    });
    const args = db.openRouterConnection.upsert.mock.calls[0]?.[0];
    expect(args?.where).toEqual({ userId: "user-a" });
    expect(
      JSON.stringify(args, (_key, value) => (typeof value === "bigint" ? String(value) : value)),
    ).not.toContain("CANARY");
    expect(args?.update).toMatchObject({ keyHint: CANARY.slice(-4), status: "active" });
    const update = args?.update as { keyCiphertext: Uint8Array; keyNonce: Uint8Array };
    expect(openProviderKey("user-a", update, "11".repeat(32))).toBe(CANARY);
  });

  it("refuses a late callback once the owner is pending deletion", async () => {
    db.user.findUnique.mockResolvedValue({ deletionRequestedAt: new Date() } as never);
    await expect(
      account.saveOpenRouterConnection("user-a", CANARY, {
        label: null,
        limitMicros: null,
        limitRemainingMicros: null,
        usageMicros: null,
        usageDailyMicros: null,
        expiresAt: null,
      }),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(db.openRouterConnection.upsert).not.toHaveBeenCalled();
    expect(db.$executeRaw).toHaveBeenCalled();
  });

  it("refuses without a sealing secret", async () => {
    env.CHESS_PROVIDER_KEY_SECRET = undefined;
    await expect(
      account.saveOpenRouterConnection("user-a", CANARY, {
        label: null,
        limitMicros: null,
        limitRemainingMicros: null,
        usageMicros: null,
        usageDailyMicros: null,
        expiresAt: null,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(db.openRouterConnection.upsert).not.toHaveBeenCalled();
  });
});

describe("ownOpenRouterAvailable", () => {
  it("opens to admins with hosted inference, and to users only when the operator opts in", () => {
    expect(account.ownOpenRouterAvailable(true)).toBe(true);
    expect(account.ownOpenRouterAvailable(false)).toBe(false);
    env.CHESS_USER_MATCHES_ENABLED = true;
    expect(account.ownOpenRouterAvailable(false)).toBe(true);
    env.CHESS_PROVIDER_KEY_SECRET = undefined;
    expect(account.ownOpenRouterAvailable(true)).toBe(false);
  });
});
