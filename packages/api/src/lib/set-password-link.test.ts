import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
const env = vi.hoisted(
  () =>
    ({ BETTER_AUTH_URL: "https://api.example.com" }) as {
      BETTER_AUTH_URL: string;
      CORS_ORIGIN?: string;
    },
);
vi.mock("@cockpit-chess/env/server", () => ({ env }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));
// The real lock slots, observed: the mint's transaction must run inside one.
const slot = vi.hoisted(() => ({ held: 0, transactionsInSlot: 0 }));
vi.mock("@cockpit-chess/auth/lock-slots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cockpit-chess/auth/lock-slots")>();
  return {
    ...actual,
    withLockSlot: vi.fn(async <T>(fn: () => Promise<T>, options?: { nested?: number }) =>
      actual.withLockSlot(async () => {
        slot.held += 1;
        try {
          return await fn();
        } finally {
          slot.held -= 1;
        }
      }, options),
    ),
  };
});
const authOptions = vi.hoisted(
  () => ({}) as { verification?: { storeIdentifier?: string }; secondaryStorage?: object },
);
vi.mock("@cockpit-chess/auth", () => ({
  auth: {
    $context: Promise.resolve({
      baseURL: "https://api.example.com/api/auth",
      options: authOptions,
    }),
  },
}));

const { default: prisma } = await import("@cockpit-chess/db");
const { withLockSlot } = await import("@cockpit-chess/auth/lock-slots");
const {
  createSetPasswordLink,
  INVITE_LINK_TTL_DAYS,
  INVITE_LINK_TTL_SECONDS,
  inviteCallbackUrl,
  SetPasswordLinkRefusedError,
} = await import("./set-password-link");

const db = prisma as unknown as {
  $transaction: MockInstance;
  $executeRaw: MockInstance;
  user: { findUnique: MockInstance };
  verification: { deleteMany: MockInstance; create: MockInstance };
};

const pendingInvitee = {
  emailVerified: false,
  banned: false,
  banExpires: null,
  accounts: [{ providerId: "credential" }],
  sessions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  slot.held = 0;
  slot.transactionsInSlot = 0;
  delete env.CORS_ORIGIN;
  delete authOptions.verification;
  delete authOptions.secondaryStorage;
  // The interactive transaction runs its callback against the same mock.
  db.$transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => {
    if (slot.held > 0) slot.transactionsInSlot += 1;
    return operation(db);
  });
  db.$executeRaw.mockResolvedValue(1);
  db.user.findUnique.mockResolvedValue(pendingInvitee);
  db.verification.deleteMany.mockResolvedValue({ count: 0 });
  db.verification.create.mockResolvedValue({ id: "v1" });
});

describe("createSetPasswordLink", () => {
  it("requires actor authorization after the setup lock and before any link mutation", async () => {
    const order: string[] = [];
    db.$executeRaw.mockImplementation(async () => {
      order.push("setup");
      return 1;
    });
    const authorizeActor = vi.fn(async (tx) => {
      expect(tx).toBe(db);
      order.push("actor");
      throw new Error("actor revoked");
    });
    await expect(
      createSetPasswordLink({ userId: "u1", locale: "en-US", authorizeActor }),
    ).rejects.toThrow("actor revoked");
    expect(order).toEqual(["setup", "actor"]);
    expect(db.verification.create).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  const now = new Date("2026-11-04T12:00:00Z");

  // Better-Auth 1.7.14 `requestPasswordReset` stores exactly this row through
  // `internalAdapter.createVerificationValue`, and `resetPassword` looks up
  // `reset-password:<token>` and reads the user id from `value`.
  it("writes a Better-Auth reset-password row that expires after the invite TTL", async () => {
    const {
      url,
      expiresAt,
      token: returned,
    } = await createSetPasswordLink({
      authorizeActor: async () => {},
      userId: "u1",
      locale: "es-MX",
      now,
    });

    expect(INVITE_LINK_TTL_DAYS).toBe(7);
    expect(expiresAt).toEqual(new Date(now.getTime() + INVITE_LINK_TTL_SECONDS * 1000));
    const written = db.verification.create.mock.calls[0]?.[0].data;
    expect(written.value).toBe("u1");
    expect(written.expiresAt).toEqual(expiresAt);
    expect(written.identifier).toMatch(/^reset-password:[A-Za-z0-9_-]{43}$/);

    // The link is Better-Auth's own token callback, redirecting to the web
    // reset page in the invitee's locale, flagged as an invite.
    const token = written.identifier.slice("reset-password:".length);
    // The caller records the token as mailed once the invite mail went out
    // (recordResetLinkMailed); only then does spending it verify the address.
    expect(returned).toBe(token);
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      `https://api.example.com/api/auth/reset-password/${token}`,
    );
    expect(parsed.searchParams.get("callbackURL")).toBe(
      "https://api.example.com/es-MX/reset-password?invite=1",
    );
  });

  it("invalidates earlier links and writes the new one in one transaction, under a per-user lock", async () => {
    await createSetPasswordLink({
      authorizeActor: async () => {},
      userId: "u1",
      locale: "en-US",
      now,
    });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // pg_advisory_xact_lock(hashtext('set-password-link:u1')) — tagged template.
    const [strings, key] = db.$executeRaw.mock.calls[0] ?? [];
    expect((strings as string[]).join("?")).toBe("SELECT pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe("set-password-link:u1");
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: { value: "u1", identifier: { startsWith: "reset-password:" } },
    });
    const order = (mock: MockInstance) => mock.mock.invocationCallOrder[0] ?? 0;
    // Eligibility is read after the lock is taken, inside the transaction.
    expect(order(db.$executeRaw)).toBeLessThan(order(db.user.findUnique));
    expect(order(db.user.findUnique)).toBeLessThan(order(db.verification.deleteMany));
    expect(order(db.verification.deleteMany)).toBeLessThan(order(db.verification.create));
  });

  // The transaction pins a pooled connection while it may wait for the lock,
  // so it runs in a lock slot (lock-slots.ts), with no nested reservation.
  it("runs the locked transaction in one lock slot", async () => {
    await createSetPasswordLink({
      authorizeActor: async () => {},
      userId: "u1",
      locale: "en-US",
      now,
    });
    expect(withLockSlot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withLockSlot).mock.calls[0]?.[1]).toBeUndefined();
    expect(slot.transactionsInSlot).toBe(1);
    expect(slot.held).toBe(0);
  });

  // Decided under the lock a finishing password reset also takes, so an
  // invitee who set their password a moment ago (verified now) or signed in
  // is never handed a fresh link, and an SSO-linked user never gains a
  // password that bypasses the IdP and its MFA.
  it.each([
    ["an account already set up (verified)", { emailVerified: true }, "not-pending"],
    ["a user who signed in", { sessions: [{ id: "s1" }] }, "not-pending"],
    ["an SSO-linked user", { accounts: [{ providerId: "oidc" }] }, "not-pending"],
    [
      "a credential user with SSO linked too",
      { accounts: [{ providerId: "credential" }, { providerId: "oidc" }] },
      "not-pending",
    ],
    ["an archived invitee", { banned: true }, "archived"],
  ])("refuses %s inside the transaction and writes nothing", async (_label, patch, reason) => {
    db.user.findUnique.mockResolvedValue({ ...pendingInvitee, ...patch });

    await expect(
      createSetPasswordLink({ authorizeActor: async () => {}, userId: "u1", locale: "en-US", now }),
    ).rejects.toThrow(expect.objectContaining({ name: "SetPasswordLinkRefusedError", reason }));
    expect(db.user.findUnique.mock.calls[0]?.[0].where).toEqual({ id: "u1" });
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
    expect(db.verification.create).not.toHaveBeenCalled();
  });

  it("refuses a user that no longer exists", async () => {
    db.user.findUnique.mockResolvedValue(null);
    await expect(
      createSetPasswordLink({ authorizeActor: async () => {}, userId: "u1", locale: "en-US", now }),
    ).rejects.toThrow(new SetPasswordLinkRefusedError("missing"));
    expect(db.verification.create).not.toHaveBeenCalled();
  });

  it("fails loudly if Better-Auth stops storing verification rows as plain Postgres rows", async () => {
    authOptions.verification = { storeIdentifier: "hashed" };
    await expect(
      createSetPasswordLink({ authorizeActor: async () => {}, userId: "u1", locale: "en-US", now }),
    ).rejects.toThrow(/verification storage/);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("mints a different token every time", async () => {
    await createSetPasswordLink({
      authorizeActor: async () => {},
      userId: "u1",
      locale: "en-US",
      now,
    });
    await createSetPasswordLink({
      authorizeActor: async () => {},
      userId: "u1",
      locale: "en-US",
      now,
    });
    const [first, second] = db.verification.create.mock.calls.map(
      (call) => call[0].data.identifier,
    );
    expect(first).not.toBe(second);
  });
});

describe("inviteCallbackUrl", () => {
  it("lands on the web origin when the SPA is served from another host", () => {
    env.CORS_ORIGIN = "https://app.example.com";
    expect(inviteCallbackUrl("en-US")).toBe(
      "https://app.example.com/en-US/reset-password?invite=1",
    );
  });

  it("falls back to the default locale for an unsupported or missing tag", () => {
    expect(inviteCallbackUrl("../../evil")).toBe(
      "https://api.example.com/en-US/reset-password?invite=1",
    );
    expect(inviteCallbackUrl(undefined)).toBe(
      "https://api.example.com/en-US/reset-password?invite=1",
    );
  });
});
