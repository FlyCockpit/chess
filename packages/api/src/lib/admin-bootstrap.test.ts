import { createHash } from "node:crypto";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@cockpit-chess/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://app.example.com" },
}));
vi.mock("@cockpit-chess/auth", () => ({
  auth: {
    $context: Promise.resolve({
      password: {
        hash: async (password: string) => `hashed:${password}`,
        config: { minPasswordLength: 12, maxPasswordLength: 128 },
      },
    }),
  },
}));

const { default: prisma } = await import("@cockpit-chess/db");
const { bootstrapAdminName, bootstrapFirstAdmin, claimFirstAdmin, setupTokenIdentifier } =
  await import("./admin-bootstrap");

const db = prisma as unknown as {
  $transaction: MockInstance;
  $executeRaw: MockInstance;
  $queryRaw: MockInstance;
  user: { findUnique: MockInstance; create: MockInstance };
  account: { create: MockInstance };
  verification: { findFirst: MockInstance; deleteMany: MockInstance; create: MockInstance };
};

/** The SQL text of a tagged-template raw call. */
function sqlOf(call: unknown[] | undefined): string {
  const strings = call?.[0] as TemplateStringsArray | undefined;
  return strings ? strings.join("?") : "";
}

/** The order calls happened in, by mock. */
function order(...mocks: MockInstance[]): number[] {
  return mocks.map((mock) => mock.mock.invocationCallOrder[0] ?? -1);
}

const adminExists = (flag: boolean) => db.$queryRaw.mockResolvedValueOnce([{ exists: flag }]);

const NOW = new Date("2026-11-23T12:00:00Z");
const TTL = 3600;
const run = (email = "owner@example.com") =>
  bootstrapFirstAdmin(email, { ttlSeconds: TTL, now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation(db));
  db.$executeRaw.mockResolvedValue(1);
  db.$queryRaw.mockReset();
  db.user.findUnique.mockResolvedValue(null);
  db.user.create.mockResolvedValue({ id: "new-admin" });
  db.account.create.mockResolvedValue({ id: "acc" });
  db.verification.findFirst.mockResolvedValue(null);
  db.verification.deleteMany.mockResolvedValue({ count: 0 });
  db.verification.create.mockResolvedValue({ id: "v1" });
});

describe("bootstrapFirstAdmin", () => {
  it("writes no user, only the hash of a one-hour setup token naming the address", async () => {
    adminExists(false);

    const result = await run();

    expect(result.kind).toBe("ready");
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.account.create).not.toHaveBeenCalled();
    if (result.kind !== "ready") throw new Error("expected ready");
    const link = new URL(result.url);
    expect(`${link.origin}${link.pathname}`).toBe("https://app.example.com/en-US/reset-password");
    expect(link.searchParams.get("setup")).toBe("1");
    const token = link.searchParams.get("token") ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const written = db.verification.create.mock.calls[0]?.[0].data;
    // Only the hash is stored, under a prefix no Better-Auth endpoint reads.
    expect(written).toEqual({
      identifier: `setup-admin:${createHash("sha256").update(token).digest("base64url")}`,
      value: "owner@example.com",
      expiresAt: new Date(NOW.getTime() + TTL * 1000),
    });
    expect(written.identifier).not.toContain(token);
    expect(result.expiresAt).toEqual(written.expiresAt);
  });

  it("replaces every earlier link: one live link at a time", async () => {
    adminExists(false);
    await run();
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: { identifier: { startsWith: "setup-admin:" } },
    });
    const [deleted, created] = order(db.verification.deleteMany, db.verification.create);
    expect(deleted).toBeLessThan(created ?? 0);
  });

  it("takes the bootstrap advisory lock before checking for an admin", async () => {
    adminExists(false);
    await run();
    expect(sqlOf(db.$executeRaw.mock.calls[0])).toContain("pg_advisory_xact_lock");
    const [locked, checked] = order(db.$executeRaw, db.$queryRaw);
    expect(locked).toBeLessThan(checked ?? 0);
  });

  it("is closed for good once any admin exists, whatever its accounts", async () => {
    adminExists(true);
    expect(await run()).toEqual({ kind: "admin_exists" });
    expect(db.verification.create).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  it("never issues a link for an address an account already uses", async () => {
    adminExists(false);
    db.user.findUnique.mockResolvedValueOnce({ id: "someone" });
    expect(await run()).toEqual({ kind: "email_taken" });
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { email: "owner@example.com" },
      select: { id: true },
    });
    expect(db.verification.create).not.toHaveBeenCalled();
  });

  it("matches the admin token the way isAdminRole does", async () => {
    adminExists(false);
    await run();
    const sql = sqlOf(db.$queryRaw.mock.calls[0]);
    expect(sql).toContain("string_to_array(u.role, ',')");
    expect(sql).toContain("~* '^\\s*admin\\s*$'");
  });
});

describe("claimFirstAdmin", () => {
  const PASSWORD = "a-long-new-password";
  const EMAIL = "owner@example.com";
  const identifier = setupTokenIdentifier("tok");
  const claim = (newPassword = PASSWORD, clock = () => NOW) =>
    claimFirstAdmin({ token: "tok", newPassword, clock });
  /** The pre-lock lookup, then the re-read under the lock. */
  const links = (first: unknown, second: unknown) => {
    db.verification.findFirst.mockResolvedValueOnce(first);
    db.verification.findFirst.mockResolvedValueOnce(second);
  };

  it("refuses an unknown or expired link before hashing or locking anything", async () => {
    db.verification.findFirst.mockResolvedValueOnce(null);

    expect((await claim()).kind).toBe("invalid_token");
    expect(db.verification.findFirst).toHaveBeenCalledWith({
      where: { identifier, expiresAt: { gt: NOW } },
      select: { id: true },
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("enforces Better-Auth's password length policy before the transaction", async () => {
    db.verification.findFirst.mockResolvedValue({ id: "v1" });

    expect(await claim("short")).toEqual({ kind: "password_too_short" });
    expect((await claim("x".repeat(129))).kind).toBe("password_too_long");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("creates the verified admin and its password atomically, then spends every link", async () => {
    links({ id: "v1" }, { value: EMAIL });
    adminExists(false);

    expect(await claim()).toEqual({ kind: "claimed", userId: "new-admin" });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(sqlOf(db.$executeRaw.mock.calls[0])).toContain("pg_advisory_xact_lock");
    // Lock → re-read the link → admin check → create, in that order.
    const [locked, checked, created] = order(db.$executeRaw, db.$queryRaw, db.user.create);
    const reread = db.verification.findFirst.mock.invocationCallOrder[1];
    expect(locked).toBeLessThan(reread ?? 0);
    expect(reread).toBeLessThan(checked ?? 0);
    expect(checked).toBeLessThan(created ?? 0);
    expect(db.verification.findFirst.mock.calls[1]?.[0]).toEqual({
      where: { identifier, expiresAt: { gt: NOW } },
      select: { value: true },
    });
    expect(db.user.create).toHaveBeenCalledWith({
      data: { email: EMAIL, name: "owner", emailVerified: true, role: "admin" },
      select: { id: true },
    });
    expect(db.account.create).toHaveBeenCalledWith({
      data: {
        userId: "new-admin",
        providerId: "credential",
        accountId: "new-admin",
        password: `hashed:${PASSWORD}`,
      },
      select: { id: true },
    });
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: { identifier: { startsWith: "setup-admin:" } },
    });
  });

  it("re-checks expiry with a fresh clock once the lock is held", async () => {
    links({ id: "v1" }, null);
    const later = new Date(NOW.getTime() + 60_000);
    const times = [NOW, later];
    const clock = () => times.shift() ?? later;

    expect((await claim(PASSWORD, clock)).kind).toBe("invalid_token");
    expect(db.verification.findFirst.mock.calls[1]?.[0].where.expiresAt).toEqual({ gt: later });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("refuses if the link was replaced before the lock was granted", async () => {
    links({ id: "v1" }, null);
    expect((await claim()).kind).toBe("invalid_token");
    expect(db.user.create).not.toHaveBeenCalled();
  });

  // An unspent link must die once another admin exists (ADMIN_EMAILS, say).
  it("refuses once any admin exists, checked under the lock", async () => {
    links({ id: "v1" }, { value: EMAIL });
    adminExists(true);
    expect((await claim()).kind).toBe("invalid_token");
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.account.create).not.toHaveBeenCalled();
  });

  it("never promotes an account that took the address after the link was issued", async () => {
    links({ id: "v1" }, { value: EMAIL });
    adminExists(false);
    db.user.findUnique.mockResolvedValueOnce({ id: "signed-up" });
    expect((await claim()).kind).toBe("invalid_token");
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { email: EMAIL },
      select: { id: true },
    });
  });

  it("treats a sign-up that wins the unique email mid-claim as a dead link", async () => {
    links({ id: "v1" }, { value: EMAIL });
    adminExists(false);
    db.user.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    expect((await claim()).kind).toBe("invalid_token");
    expect(db.account.create).not.toHaveBeenCalled();
  });

  it("rethrows any other failure (the transaction rolls back)", async () => {
    links({ id: "v1" }, { value: EMAIL });
    adminExists(false);
    db.account.create.mockRejectedValueOnce(new Error("db down"));
    await expect(claim()).rejects.toThrow("db down");
  });
});

describe("bootstrapAdminName", () => {
  it("uses the local part, bounded", () => {
    expect(bootstrapAdminName("jane.doe@example.com")).toBe("jane.doe");
    expect(bootstrapAdminName(`${"x".repeat(150)}@example.com`)).toHaveLength(100);
  });
});
