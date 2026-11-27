import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Never a real DB: an in-memory verification table and user table, enough to
// see which rows a reset reads, writes and consumes.
type Row = { identifier: string; value: string; expiresAt: Date };
const state = vi.hoisted(() => ({
  verifications: [] as Row[],
  users: [] as {
    id: string;
    email: string;
    emailVerified: boolean;
    accounts?: { providerId: string }[];
    sessions?: { id: string }[];
  }[],
  locks: [] as string[],
  /** Every statement in order, to see what ran under the lock. */
  calls: [] as string[],
  /** Lock slots held right now (lock-slots.ts `withLockSlot`, mocked below). */
  slotsHeld: 0,
  /** For each `$transaction` call: the lock slots held when it started. */
  transactionSlots: [] as number[],
}));
const db = vi.hoisted(() => {
  const matches = (row: Row, where: Record<string, unknown>) => {
    if (typeof where.identifier === "string" && row.identifier !== where.identifier) return false;
    if (
      typeof where.identifier === "object" &&
      where.identifier !== null &&
      !row.identifier.startsWith((where.identifier as { startsWith: string }).startsWith)
    )
      return false;
    if (where.value !== undefined && row.value !== where.value) return false;
    const expiry = where.expiresAt as { gt: Date } | undefined;
    if (expiry && !(row.expiresAt > expiry.gt)) return false;
    return true;
  };
  const client = {
    verification: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        state.calls.push("verification.findFirst");
        return state.verifications.find((row) => matches(row, where)) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        state.calls.push("verification.create");
        state.verifications.push(data);
        return { id: "v" };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = state.verifications.length;
        state.verifications = state.verifications.filter((row) => !matches(row, where));
        return { count: before - state.verifications.length };
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        state.calls.push("user.findUnique");
        const user = state.users.find((u) => u.id === where.id);
        if (!user) return null;
        return {
          emailVerified: user.emailVerified,
          accounts: user.accounts ?? [{ providerId: "credential" }],
          sessions: user.sessions ?? [],
        };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; email: string };
          data: { emailVerified: boolean };
        }) => {
          const hit = state.users.filter((u) => u.id === where.id && u.email === where.email);
          for (const user of hit) user.emailVerified = data.emailVerified;
          return { count: hit.length };
        },
      ),
    },
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, key: string) => {
      state.locks.push(key);
      state.calls.push("lock");
      return 1;
    }),
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => {
    state.transactionSlots.push(state.slotsHeld);
    return operation(client);
  });
  return client;
});
vi.mock("@cockpit-chess/db", () => ({ default: db }));
// Every lock transaction runs in a lock slot (lock-slots.ts); a pass-through
// that counts the slots held, so a test can see the transaction ran in one.
const lockSlots = vi.hoisted(() => ({
  withLockSlot: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
    state.slotsHeld += 1;
    try {
      return await fn();
    } finally {
      state.slotsHeld -= 1;
    }
  }),
}));
vi.mock("./lock-slots", () => lockSlots);

const {
  isResetLinkRedeemable,
  recordResetLinkMailed,
  resetTokenOf,
  spentResetToken,
  verifyEmailIfResetLinkWasMailed,
} = await import("./password-reset-links");

const now = new Date("2026-11-26T00:00:00Z");
const expiresAt = new Date("2026-12-01T00:00:00Z");
/** A reset link as Better-Auth (or an invite) writes it. */
function link(token: string, userId = "u1") {
  state.verifications.push({ identifier: `reset-password:${token}`, value: userId, expiresAt });
}

beforeEach(() => {
  // Calls that take the default clock see the same day as `now`, so the
  // fixtures (expiring 2026-12-01) stay valid whenever the suite runs.
  vi.useFakeTimers({ now, toFake: ["Date"] });
  vi.clearAllMocks();
  state.verifications = [];
  state.users = [{ id: "u1", email: "ada@example.com", emailVerified: false }];
  state.locks = [];
  state.calls = [];
  state.slotsHeld = 0;
  state.transactionSlots = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recordResetLinkMailed", () => {
  it("records a mailed link beside it, keyed by the token's hash, expiring with it", async () => {
    link("tok-1");
    expect(
      await recordResetLinkMailed({ token: "tok-1", userId: "u1", email: "Ada@Example.com", now }),
    ).toBe(true);
    const mailed = state.verifications.find((row) =>
      row.identifier.startsWith("reset-password-mailed:"),
    );
    const hash = createHash("sha256").update("tok-1").digest("base64url");
    expect(mailed).toEqual({
      identifier: `reset-password-mailed:${hash}`,
      value: JSON.stringify({ userId: "u1", email: "ada@example.com" }),
      expiresAt,
    });
    // The token itself is stored once only: in Better-Auth's own row.
    expect(state.verifications.filter((row) => row.identifier.includes("tok-1"))).toHaveLength(1);
  });

  it("records nothing for a link that is already gone", async () => {
    expect(
      await recordResetLinkMailed({ token: "gone", userId: "u1", email: "ada@example.com" }),
    ).toBe(false);
    link("someone-else", "u2");
    expect(
      await recordResetLinkMailed({
        token: "someone-else",
        userId: "u1",
        email: "ada@example.com",
      }),
    ).toBe(false);
    expect(db.verification.create).not.toHaveBeenCalled();
  });

  it("checks the link and writes the record in one transaction, under the set-password-link lock", async () => {
    link("tok-1");
    await recordResetLinkMailed({ token: "tok-1", userId: "u1", email: "ada@example.com", now });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // The lock comes first, so a resend, reset or activation (which delete
    // links under it) cannot delete the link between the check and the insert.
    expect(state.calls).toEqual(["lock", "verification.findFirst", "verification.create"]);
    expect(state.locks).toEqual(["set-password-link:u1"]);
  });

  it("records nothing for an expired link", async () => {
    state.verifications.push({
      identifier: "reset-password:old",
      value: "u1",
      expiresAt: new Date(now.getTime() - 1),
    });
    expect(
      await recordResetLinkMailed({ token: "old", userId: "u1", email: "ada@example.com", now }),
    ).toBe(false);
    expect(db.verification.create).not.toHaveBeenCalled();
  });
});

describe("isResetLinkRedeemable", () => {
  const verified = () => {
    const user = state.users[0];
    if (user) user.emailVerified = true;
  };
  const mailedLink = async (token: string) => {
    link(token);
    await recordResetLinkMailed({ token, userId: "u1", email: "ada@example.com", now });
  };

  it("lets a mailed link work for an active account (forgot-password)", async () => {
    await mailedLink("forgot");
    verified();
    state.locks = [];
    expect(await isResetLinkRedeemable("forgot", now)).toBe(true);
    expect(state.locks).toEqual([]);
    expect(state.verifications.some((row) => row.identifier === "reset-password:forgot")).toBe(
      true,
    );
  });

  it("lets a shown link work while the invite is pending", async () => {
    link("shown");
    expect(await isResetLinkRedeemable("shown", now)).toBe(true);
  });

  it("refuses and deletes a shown link once the account is active, under the set-password-link lock", async () => {
    link("shown");
    verified();
    expect(await isResetLinkRedeemable("shown", now)).toBe(false);
    expect(state.verifications).toEqual([]);
    expect(state.locks).toEqual(["set-password-link:u1"]);
    // Link, mailed record, the lock, the mailed record again, then the invite state.
    expect(state.calls.slice(0, 5)).toEqual([
      "verification.findFirst",
      "verification.findFirst",
      "lock",
      "verification.findFirst",
      "user.findUnique",
    ]);
  });

  it("refuses a shown link once an IdP identity is linked or the user signed in", async () => {
    link("shown");
    const user = state.users[0];
    if (!user) throw new Error("seed");
    user.accounts = [{ providerId: "credential" }, { providerId: "sso" }];
    expect(await isResetLinkRedeemable("shown", now)).toBe(false);
    link("shown-2");
    user.accounts = undefined;
    user.sessions = [{ id: "s1" }];
    expect(await isResetLinkRedeemable("shown-2", now)).toBe(false);
  });

  it("does not take another user's mailed record, or an expired one, as this link's", async () => {
    link("shown");
    verified();
    const hash = createHash("sha256").update("shown").digest("base64url");
    state.verifications.push({
      identifier: `reset-password-mailed:${hash}`,
      value: JSON.stringify({ userId: "u2", email: "x@example.com" }),
      expiresAt,
    });
    expect(await isResetLinkRedeemable("shown", now)).toBe(false);
    link("late");
    const lateHash = createHash("sha256").update("late").digest("base64url");
    state.verifications.push({
      identifier: `reset-password-mailed:${lateHash}`,
      value: JSON.stringify({ userId: "u1", email: "ada@example.com" }),
      expiresAt: new Date(now.getTime() - 1),
    });
    expect(await isResetLinkRedeemable("late", now)).toBe(false);
  });

  it("admits a link whose mailed record committed while the check waited for the lock", async () => {
    link("racing");
    verified();
    const hash = createHash("sha256").update("racing").digest("base64url");
    // The record's writer held the set-password-link lock; it commits as the lock is granted.
    db.$executeRaw.mockImplementationOnce(async (_strings: TemplateStringsArray, key: string) => {
      state.locks.push(key);
      state.calls.push("lock");
      state.verifications.push({
        identifier: `reset-password-mailed:${hash}`,
        value: JSON.stringify({ userId: "u1", email: "ada@example.com" }),
        expiresAt,
      });
      return 1;
    });
    expect(await isResetLinkRedeemable("racing", now)).toBe(true);
    expect(state.verifications.some((row) => row.identifier === "reset-password:racing")).toBe(
      true,
    );
  });

  it("leaves an unknown or expired token to Better-Auth, which refuses it itself", async () => {
    expect(await isResetLinkRedeemable("nope", now)).toBe(true);
    state.verifications.push({
      identifier: "reset-password:expired",
      value: "u1",
      expiresAt: new Date(now.getTime() - 1),
    });
    verified();
    expect(await isResetLinkRedeemable("expired", now)).toBe(true);
    expect(state.locks).toEqual([]);
  });
});

describe("verifyEmailIfResetLinkWasMailed", () => {
  it("verifies the email of a mailed link and deletes the user's other reset links, under the set-password-link lock", async () => {
    link("mailed");
    await recordResetLinkMailed({ token: "mailed", userId: "u1", email: "ada@example.com" });
    state.locks = [];
    // Better-Auth consumed the spent token; another link (a resend) is still out.
    state.verifications = state.verifications.filter(
      (row) => row.identifier !== "reset-password:mailed",
    );
    link("other");

    expect(await verifyEmailIfResetLinkWasMailed("mailed")).toBe(true);
    expect(state.users[0]?.emailVerified).toBe(true);
    expect(state.verifications).toEqual([]);
    expect(state.locks).toEqual(["set-password-link:u1"]);
  });

  it("leaves the email unverified when the spent link was not mailed (shown to the admin)", async () => {
    link("shown");
    link("other");
    state.verifications = state.verifications.filter(
      (row) => row.identifier !== "reset-password:shown",
    );

    expect(await verifyEmailIfResetLinkWasMailed("shown")).toBe(false);
    expect(state.users[0]?.emailVerified).toBe(false);
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("verifies only the address the link went to", async () => {
    link("mailed");
    await recordResetLinkMailed({ token: "mailed", userId: "u1", email: "old@example.com" });
    expect(await verifyEmailIfResetLinkWasMailed("mailed")).toBe(false);
    expect(state.users[0]?.emailVerified).toBe(false);
  });

  it("counts a mailed link once", async () => {
    link("mailed");
    await recordResetLinkMailed({ token: "mailed", userId: "u1", email: "ada@example.com" });
    expect(await verifyEmailIfResetLinkWasMailed("mailed")).toBe(true);
    state.users[0] = { id: "u1", email: "ada@example.com", emailVerified: false };
    expect(await verifyEmailIfResetLinkWasMailed("mailed")).toBe(false);
    expect(state.users[0]?.emailVerified).toBe(false);
  });

  it("drops a malformed record without verifying anything", async () => {
    const hash = createHash("sha256").update("bad").digest("base64url");
    state.verifications.push({
      identifier: `reset-password-mailed:${hash}`,
      value: "u1",
      expiresAt,
    });
    expect(await verifyEmailIfResetLinkWasMailed("bad")).toBe(false);
    expect(state.verifications).toEqual([]);
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("lock slots", () => {
  // Each transaction takes the set-password-link lock (or may), so it must
  // run in a lock slot: lock transactions may never fill the pool.
  it("runs every lock transaction in a lock slot", async () => {
    link("mailed");
    await recordResetLinkMailed({ token: "mailed", userId: "u1", email: "ada@example.com", now });
    link("shown");
    const user = state.users[0];
    if (user) user.emailVerified = true;
    await isResetLinkRedeemable("shown", now);
    await verifyEmailIfResetLinkWasMailed("mailed");
    expect(lockSlots.withLockSlot).toHaveBeenCalledTimes(3);
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    // One slot held around each transaction, and released after it.
    expect(state.transactionSlots).toEqual([1, 1, 1]);
    expect(state.slotsHeld).toBe(0);
    expect(state.locks).toEqual([
      "set-password-link:u1",
      "set-password-link:u1",
      "set-password-link:u1",
    ]);
  });

  it("releases the slot when the transaction fails", async () => {
    db.$transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(isResetLinkRedeemable("any", now)).rejects.toThrow("db down");
    expect(lockSlots.withLockSlot).toHaveBeenCalledTimes(1);
    expect(state.slotsHeld).toBe(0);
  });
});

describe("resetTokenOf", () => {
  it("is the token a /reset-password request carries, before it ran", () => {
    expect(resetTokenOf({ path: "/reset-password", body: { token: "t" } })).toBe("t");
    expect(resetTokenOf({ path: "/reset-password", query: { token: "q" } })).toBe("q");
    expect(resetTokenOf({ path: "/reset-password", body: { token: 1 } })).toBe(null);
    expect(resetTokenOf({ path: "/request-password-reset", body: { token: "t" } })).toBe(null);
  });
});

describe("spentResetToken", () => {
  const ok = { status: true };
  it("is the token of a successful /reset-password, from the body or the query", () => {
    expect(spentResetToken({ path: "/reset-password", body: { token: "t" }, returned: ok })).toBe(
      "t",
    );
    expect(
      spentResetToken({ path: "/reset-password", body: {}, query: { token: "q" }, returned: ok }),
    ).toBe("q");
  });

  it("is null for a failed reset, another endpoint, or no token", () => {
    const error = { status: "BAD_REQUEST", body: { code: "INVALID_TOKEN" } };
    expect(
      spentResetToken({ path: "/reset-password", body: { token: "t" }, returned: error }),
    ).toBe(null);
    expect(spentResetToken({ path: "/change-password", body: { token: "t" }, returned: ok })).toBe(
      null,
    );
    expect(spentResetToken({ path: "/reset-password", body: {}, returned: ok })).toBe(null);
  });
});
