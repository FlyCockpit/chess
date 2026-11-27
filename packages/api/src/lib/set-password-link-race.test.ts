import { beforeEach, describe, expect, it, vi } from "vitest";

// An admin's "Resend invite" racing the invitee finishing their own setup.
// The real `createSetPasswordLink`, the real reset-side revocation
// (`revokeCredentialsAfterPasswordReset`) and the real mailed-link
// verification (`verifyEmailIfResetLinkWasMailed`, the `/reset-password`
// after-hook) run against an in-memory database that models what the
// guarantee rests on: blocking transaction-scoped advisory locks, released
// when their transaction ends, and batch transactions running their
// statements in order. Better-Auth's own part of the reset (spend the token,
// write the password) has already committed when those run, so it is not
// modelled beyond the spent token.
//
// Only a mailed link verifies the address (password-reset-links.ts). So a
// reset alone leaves the invite pending, and a resend after it still mints;
// what activates the account is the mailed link's verification, which
// deletes every reset link under the same lock the mint takes.

type Verification = { identifier: string; value: string; expiresAt: Date };
type Where = {
  identifier?: string | { startsWith: string };
  value?: string;
  expiresAt?: { gt: Date };
};
const store = vi.hoisted(() => ({
  user: {
    id: "invitee",
    email: "invitee@example.test",
    emailVerified: false,
    banned: false as boolean,
    banExpires: null as Date | null,
  },
  verifications: [] as Verification[],
  locks: new Map<string, Promise<void>>(),
  /** Awaited by the mailed-link verification right before it marks the email verified. */
  verifyPause: null as Promise<void> | null,
  /** Awaited by the mint right after its eligibility read. */
  mintPause: null as Promise<void> | null,
}));

const db = vi.hoisted(() => {
  type TxContext = { releases: (() => void)[]; keys: Set<string> };
  const lock = async (strings: TemplateStringsArray, values: unknown[], ctx: TxContext) => {
    expect(strings.join("?")).toBe("SELECT pg_advisory_xact_lock(hashtext(?))");
    expect(values).toHaveLength(1);
    expect(values[0]).toMatch(/^(cli-credentials|set-password-link):.+$/);
    const key = String(values[0]);
    for (let held = store.locks.get(key); held; held = store.locks.get(key)) await held;
    let release: () => void = () => undefined;
    store.locks.set(
      key,
      new Promise<void>((resolve) => {
        release = () => {
          store.locks.delete(key);
          resolve();
        };
      }),
    );
    ctx.keys.add(key);
    ctx.releases.push(release);
    return 1;
  };
  const execute = async (strings: TemplateStringsArray, values: unknown[], ctx: TxContext) => {
    const sql = strings.join("?");
    if (sql === "SELECT pg_advisory_xact_lock(hashtext(?))") return lock(strings, values, ctx);
    // Accept only the complete cleanup statement, including both user predicates
    // and the materialized challenge snapshot used to find OTP/counter rows.
    expect(sql.replace(/\s+/g, " ").trim()).toBe(
      `WITH "resetChallenges" AS MATERIALIZED (
        SELECT "identifier" FROM "verification"
        WHERE "value" = ? AND "identifier" LIKE '2fa-%'
      )
      DELETE FROM "verification"
      WHERE ("value" = ? AND "identifier" LIKE 'trust-device-%')
         OR "identifier" IN (
           SELECT "identifier" FROM "resetChallenges"
           UNION ALL
           SELECT '2fa-otp-' || "identifier" FROM "resetChallenges"
           UNION ALL
           SELECT '2fa-attempts-' || "identifier" FROM "resetChallenges"
         )`
        .replace(/\s+/g, " ")
        .trim(),
    );
    expect(values).toHaveLength(2);
    const [userId] = values;
    expect(typeof userId).toBe("string");
    expect(values[1]).toBe(userId);
    expect(ctx.keys.has(`cli-credentials:${userId}`)).toBe(true);
    const challenges = store.verifications.filter(
      (v) => v.value === userId && v.identifier.startsWith("2fa-"),
    );
    const identifiers = new Set(
      challenges.flatMap(({ identifier }) => [
        identifier,
        `2fa-otp-${identifier}`,
        `2fa-attempts-${identifier}`,
      ]),
    );
    const kept = store.verifications.filter(
      (v) =>
        !(v.value === userId && v.identifier.startsWith("trust-device-")) &&
        !identifiers.has(v.identifier),
    );
    const count = store.verifications.length - kept.length;
    store.verifications.splice(0, store.verifications.length, ...kept);
    return count;
  };
  /** A lazy statement for a batch transaction. */
  const statement = (run: (ctx: TxContext) => Promise<unknown>) => ({ run });
  const matches = (v: Verification, where: Where) => {
    const { identifier, value, expiresAt } = where;
    if (value !== undefined && v.value !== value) return false;
    if (expiresAt && !(v.expiresAt > expiresAt.gt)) return false;
    if (typeof identifier === "string") return v.identifier === identifier;
    if (identifier) return v.identifier.startsWith(identifier.startsWith);
    return true;
  };
  const deleteVerifications = (where: Where) => {
    const kept = store.verifications.filter((v) => !matches(v, where));
    const count = store.verifications.length - kept.length;
    store.verifications.splice(0, store.verifications.length, ...kept);
    return { count };
  };
  const none = () => statement(async () => ({ count: 0 }));
  const interactive = (ctx: TxContext) => ({
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
      execute(strings, values, ctx),
    user: {
      findUnique: async () => {
        const row = {
          ...store.user,
          accounts: [{ providerId: "credential" }],
          sessions: [] as { id: string }[],
        };
        if (store.mintPause) await store.mintPause;
        return row;
      },
      updateMany: async ({ where }: { where: { id: string; email: string } }) => {
        if (store.verifyPause) await store.verifyPause;
        if (where.id !== store.user.id || where.email !== store.user.email) return { count: 0 };
        store.user.emailVerified = true;
        return { count: 1 };
      },
    },
    verification: {
      findFirst: async ({ where }: { where: Where }) =>
        store.verifications.find((v) => matches(v, where)) ?? null,
      deleteMany: async ({ where }: { where: Where }) => deleteVerifications(where),
      create: async ({ data }: { data: Verification }) => {
        store.verifications.push({ ...data });
        return { id: "v" };
      },
    },
  });
  return {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
      statement((ctx) => execute(strings, values, ctx)),
    async $transaction(
      work: { run: (ctx: TxContext) => Promise<unknown> }[] | ((tx: unknown) => Promise<unknown>),
    ) {
      const ctx: TxContext = { releases: [], keys: new Set() };
      try {
        if (typeof work === "function") return await work(interactive(ctx));
        const results = [];
        for (const item of work) results.push(await item.run(ctx));
        return results;
      } finally {
        for (const release of ctx.releases) release();
      }
    },
    apiKey: { deleteMany: none },
    session: { deleteMany: none },
    deviceCode: { deleteMany: none },
    verification: {
      deleteMany: ({ where }: { where: Where }) =>
        statement(async () => deleteVerifications(where)),
    },
  };
});

vi.mock("@cockpit-chess/db", () => ({ default: db }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));
vi.mock("@cockpit-chess/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://api.example.com" },
}));
vi.mock("@cockpit-chess/auth", () => ({
  auth: {
    $context: Promise.resolve({ baseURL: "https://api.example.com/api/auth", options: {} }),
  },
}));

const { createSetPasswordLink, SetPasswordLinkRefusedError } = await import("./set-password-link");
const { revokeCredentialsAfterPasswordReset } = await import(
  "@cockpit-chess/auth/credential-revocation"
);
const { recordResetLinkMailed, verifyEmailIfResetLinkWasMailed } = await import(
  "@cockpit-chess/auth/password-reset-links"
);

const USER = "invitee";
const resetLinks = () =>
  store.verifications.filter((v) => v.value === USER && v.identifier.startsWith("reset-password:"));
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const gate = () => {
  let open: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
};
/** A mailed invite link the invitee is about to spend (minted, then recorded as mailed). */
const mailedLink = async () => {
  const { token } = await createSetPasswordLink({ userId: USER, locale: "en-US" });
  expect(await recordResetLinkMailed({ token, userId: USER, email: store.user.email })).toBe(true);
  return token;
};
/** Better-Auth spent the token: its row is gone before the reset's callbacks run. */
const spend = (token: string) => {
  const at = store.verifications.findIndex((v) => v.identifier === `reset-password:${token}`);
  expect(at).toBeGreaterThanOrEqual(0);
  store.verifications.splice(at, 1);
};
/** What a successful reset with `token` runs: the revocation, then the after-hook. */
const finishReset = async (token: string) => {
  await revokeCredentialsAfterPasswordReset(USER);
  return verifyEmailIfResetLinkWasMailed(token);
};

beforeEach(() => {
  store.user = {
    id: USER,
    email: "invitee@example.test",
    emailVerified: false,
    banned: false,
    banExpires: null,
  };
  store.verifications.length = 0;
  store.locks.clear();
  store.verifyPause = null;
  store.mintPause = null;
});

describe("invite resend vs a finishing password reset", () => {
  it("revokes reset-side 2FA rows while preserving other users and unrelated verifications", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const revoked = [
      { identifier: "2fa-challenge-a", value: USER },
      { identifier: "2fa-otp-2fa-challenge-a", value: "123456" },
      { identifier: "2fa-attempts-2fa-challenge-a", value: "2" },
      { identifier: "2fa-challenge-b", value: USER },
      { identifier: "2fa-otp-2fa-challenge-b", value: "654321" },
      { identifier: "2fa-attempts-2fa-challenge-b", value: "1" },
      { identifier: "trust-device-invitee", value: USER },
    ].map((row) => ({ ...row, expiresAt }));
    const retained = [
      { identifier: "2fa-other", value: "other-user" },
      { identifier: "2fa-otp-2fa-other", value: "123456" },
      { identifier: "2fa-attempts-2fa-other", value: "2" },
      { identifier: "trust-device-other", value: "other-user" },
      { identifier: "2fa-attempts-orphan", value: "3" },
      { identifier: "email-verification", value: USER },
      { identifier: "unrelated", value: "2fa-challenge-a" },
    ].map((row) => ({ ...row, expiresAt }));
    store.verifications.push(...revoked, ...retained);

    await revokeCredentialsAfterPasswordReset(USER);

    expect(store.verifications).toEqual(retained);
    expect(store.locks.size).toBe(0);
  });

  it("a resend that minted its link first loses it to the reset's revocation", async () => {
    const token = await mailedLink();
    spend(token);
    const mintGate = gate();
    store.mintPause = mintGate.closed;
    // The resend has read "still pending" and is about to write its link...
    const minting = createSetPasswordLink({ userId: USER, locale: "en-US" });
    await settle();
    // ...when the invitee's reset finishes and runs its revocation.
    let revoked = false;
    const revoking = revokeCredentialsAfterPasswordReset(USER).then(() => {
      revoked = true;
    });
    await settle();
    expect(revoked).toBe(false); // waits for the resend's lock
    mintGate.open();
    await minting;
    await revoking;
    // The fresh 7-day link is gone with the rest.
    expect(resetLinks()).toHaveLength(0);
    // The mailed link's after-hook then activates the account.
    expect(await verifyEmailIfResetLinkWasMailed(token)).toBe(true);
    expect(store.user.emailVerified).toBe(true);
    expect(resetLinks()).toHaveLength(0);
  });

  it("a resend that minted its link first loses it to the mailed link's verification", async () => {
    const token = await mailedLink();
    spend(token);
    await revokeCredentialsAfterPasswordReset(USER);
    const mintGate = gate();
    store.mintPause = mintGate.closed;
    // Still pending after the revocation alone, so the resend mints...
    const minting = createSetPasswordLink({ userId: USER, locale: "en-US" });
    await settle();
    // ...while the after-hook verifies the mailed link's address.
    let verified: boolean | undefined;
    const verifying = verifyEmailIfResetLinkWasMailed(token).then((result) => {
      verified = result;
    });
    await settle();
    expect(verified).toBeUndefined(); // waits for the resend's lock
    mintGate.open();
    await minting;
    await verifying;
    expect(verified).toBe(true);
    expect(store.user.emailVerified).toBe(true);
    // No reset credential is left for an account that is now active.
    expect(resetLinks()).toHaveLength(0);
  });

  it("a resend that arrives while the verification is committing waits, then refuses", async () => {
    const token = await mailedLink();
    spend(token);
    await revokeCredentialsAfterPasswordReset(USER);
    const verifyGate = gate();
    store.verifyPause = verifyGate.closed;
    const verifying = verifyEmailIfResetLinkWasMailed(token);
    await settle();
    let settled = false;
    const minting = createSetPasswordLink({ userId: USER, locale: "en-US" }).finally(() => {
      settled = true;
    });
    // The mint's own result is awaited below; keep the rejection handled.
    minting.catch(() => undefined);
    await settle();
    expect(settled).toBe(false); // waits for the verification's lock
    verifyGate.open();
    expect(await verifying).toBe(true);
    await expect(minting).rejects.toThrow(new SetPasswordLinkRefusedError("not-pending"));
    expect(resetLinks()).toHaveLength(0);
  });

  it("a resend after a mailed reset committed is refused outright", async () => {
    const token = await mailedLink();
    spend(token);
    expect(await finishReset(token)).toBe(true);
    await expect(createSetPasswordLink({ userId: USER, locale: "en-US" })).rejects.toThrow(
      new SetPasswordLinkRefusedError("not-pending"),
    );
    expect(resetLinks()).toHaveLength(0);
  });

  // A link the admin was shown sets the password and proves no mailbox: the
  // invite stays pending, so a resend (which mails a link that does verify)
  // still works.
  it("a resend after a revealed link's reset still mints, and the account stays unverified", async () => {
    const { token } = await createSetPasswordLink({ userId: USER, locale: "en-US" });
    spend(token);
    expect(await finishReset(token)).toBe(false);
    expect(store.user.emailVerified).toBe(false);
    await createSetPasswordLink({ userId: USER, locale: "en-US" });
    expect(resetLinks()).toHaveLength(1);
  });

  it("a resend with no reset in sight mints exactly one working link", async () => {
    await createSetPasswordLink({ userId: USER, locale: "en-US" });
    await createSetPasswordLink({ userId: USER, locale: "en-US" });
    expect(resetLinks()).toHaveLength(1);
  });
});
