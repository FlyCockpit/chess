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
    deletionRequestedAt?: Date | null;
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
      (!row.identifier.startsWith((where.identifier as { startsWith: string }).startsWith) ||
        row.identifier === (where.identifier as { not?: string }).not)
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
          email: user.email,
          emailVerified: user.emailVerified,
          deletionRequestedAt: user.deletionRequestedAt ?? null,
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
  admitResetSpend,
  isInvitePending,
} = await import("./password-reset-links");

const { lockSetPasswordLinks } = await import("./set-password-link-lock");

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

describe("admitResetSpend", () => {
  const admit = (token: string) =>
    admitResetSpend(db as unknown as Parameters<typeof admitResetSpend>[0], token, now);
  it("commits mailed proof and other-link deletion on the supplied transaction", async () => {
    state.users = [{ id: "u1", email: "u@example.test", emailVerified: false }];
    link("mailed");
    link("other");
    await recordResetLinkMailed({ token: "mailed", userId: "u1", email: "u@example.test" });
    db.$transaction.mockClear();
    expect(await admit("mailed")).toBe(true);
    expect(state.users[0]?.emailVerified).toBe(true);
    expect(state.verifications.map((v) => v.identifier)).toEqual(["reset-password:mailed"]);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("shown links never verify and are rejected after verification or IdP linking", async () => {
    state.users = [{ id: "u1", email: "u@example.test", emailVerified: false }];
    link("shown");
    expect(await admit("shown")).toBe(true);
    expect(state.users[0]?.emailVerified).toBe(false);
    state.users[0]!.emailVerified = true;
    expect(await admit("shown")).toBe(false);
    state.users[0]!.emailVerified = false;
    state.users[0]!.accounts = [{ providerId: "credential" }, { providerId: "sso" }];
    expect(await admit("shown")).toBe(false);
  });
  it("does not trust a mailed record for a different mailbox", async () => {
    state.users = [{ id: "u1", email: "new@example.test", emailVerified: true }];
    link("mailed");
    await recordResetLinkMailed({ token: "mailed", userId: "u1", email: "old@example.test" });
    expect(await admit("mailed")).toBe(false);
  });
  it.each(["wrong-user", "expired", "malformed"])(
    "rejects %s mailed proof on an active user",
    async (kind) => {
      state.users[0]!.emailVerified = true;
      link("proof");
      state.verifications.push({
        identifier: `reset-password-mailed:${createHash("sha256").update("proof").digest("base64url")}`,
        value:
          kind === "malformed"
            ? "not-json"
            : JSON.stringify({
                userId: kind === "wrong-user" ? "peer" : "u1",
                email: "ada@example.com",
              }),
        expiresAt: kind === "expired" ? new Date(now.getTime() - 1) : expiresAt,
      });
      expect(await admit("proof")).toBe(false);
      expect(db.user.updateMany).not.toHaveBeenCalled();
      expect(state.verifications).toHaveLength(2);
    },
  );
  it("rechecks the live link and pending state after taking setup on this transaction", async () => {
    link("racing");
    expect(await isResetLinkRedeemable("racing", now)).toBe(true);
    db.$executeRaw.mockImplementationOnce(async () => {
      state.users[0]!.emailVerified = true;
      return 1;
    });
    expect(await admit("racing")).toBe(false);
    expect(db.user.updateMany).not.toHaveBeenCalled();
    state.users[0]!.emailVerified = false;
    state.verifications[0]!.expiresAt = new Date(now.getTime() - 1);
    expect(await admit("racing")).toBe(false);
  });
  it("consumes mailbox proof once; a still-present token cannot reverify an active user", async () => {
    link("once");
    await recordResetLinkMailed({ token: "once", userId: "u1", email: "ada@example.com" });
    expect(await admit("once")).toBe(true);
    expect(await admit("once")).toBe(false);
    expect(db.user.updateMany).toHaveBeenCalledOnce();
  });
});

describe("lockSetPasswordLinks", () => {
  it("is a transaction-scoped advisory lock keyed by the user", async () => {
    await lockSetPasswordLinks("u9", db as never);
    const [strings, key] = db.$executeRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(strings.join("?")).toBe("SELECT pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe("set-password-link:u9");
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
    await admitResetSpend(db as unknown as Parameters<typeof admitResetSpend>[0], "mailed", now);
    expect(lockSlots.withLockSlot).toHaveBeenCalledTimes(2);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    // One slot held around each transaction, and released after it.
    expect(state.transactionSlots).toEqual([1, 1]);
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

describe("strict pending invite admission", () => {
  it.each([
    { accounts: [] },
    { accounts: [{ providerId: "credential" }, { providerId: "credential" }] },
    { accounts: [{ providerId: "sso" }] },
  ])("requires exactly one credential account (%j)", async ({ accounts }) => {
    expect(isInvitePending({ emailVerified: false, accounts, sessions: [] })).toBe(false);
  });
});

it("refuses a valid mailed reset proof once deletion is pending", async () => {
  link("mailed-before-deletion");
  await recordResetLinkMailed({
    token: "mailed-before-deletion",
    userId: "u1",
    email: "ada@example.com",
    now,
  });
  const user = state.users[0];
  if (!user) throw new Error("Missing fixture user");
  user.deletionRequestedAt = now;
  expect(
    await admitResetSpend(
      db as unknown as Parameters<typeof admitResetSpend>[0],
      "mailed-before-deletion",
      now,
    ),
  ).toBe(false);
  expect(db.user.updateMany).not.toHaveBeenCalled();
  expect(user.emailVerified).toBe(false);
});
