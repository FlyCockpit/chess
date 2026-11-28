import { beforeEach, describe, expect, it, vi } from "vitest";

// Real minting, consume admission and reset revocation on an in-memory client
// with blocking transaction-scoped advisory locks. Password/token/proof decisions
// share the supplied transaction; actual pinned handler rollback is covered by
// packages/auth/src/reset-spend.integration.test.ts. A resend that wins setup
// invalidates the earlier token; one queued behind mailed activation refuses.

type Verification = { identifier: string; value: string; expiresAt: Date };
type Where = {
  identifier?: string | { startsWith: string; not?: string };
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
  password: "initial",
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
    if (sql === "SELECT pg_notify(?, ?)") {
      expect(values[0]).toBe("runner_machine_revoked");
      const event = JSON.parse(String(values[1])) as { userId: string };
      expect(event).toEqual({ userId: store.user.id });
      expect(ctx.keys.has(`cli-credentials:${event.userId}`)).toBe(true);
      return 1;
    }
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
    if (identifier)
      return v.identifier.startsWith(identifier.startsWith) && v.identifier !== identifier.not;
    return true;
  };
  const deleteVerifications = (where: Where) => {
    const kept = store.verifications.filter((v) => !matches(v, where));
    const count = store.verifications.length - kept.length;
    store.verifications.splice(0, store.verifications.length, ...kept);
    return { count };
  };
  const none = () => statement(async () => ({ count: 0 }));
  const cancelMatches = async (args: unknown, ctx: TxContext) => {
    expect(args).toEqual({
      where: { ownerId: store.user.id, source: "hosted", status: { in: ["queued", "running"] } },
      data: {
        status: "stopped",
        runToken: null,
        turnType: "idle",
        turnId: null,
        turnSide: null,
        turnExpectedSeq: null,
        turnStartedAt: null,
        turnDeadline: null,
        pendingMove: expect.anything(),
        terminalCause: "owner-reset",
        ending: { kind: "cancelled" },
      },
    });
    expect(ctx.keys.has(`cli-credentials:${store.user.id}`)).toBe(true);
    return { count: 0 };
  };
  const interactive = (ctx: TxContext) => ({
    runnerMachine: { updateMany: async () => ({ count: 0 }) },
    chessMatch: { updateMany: (args: unknown) => cancelMatches(args, ctx) },
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
    chessMatch: { updateMany: (args: unknown) => statement((ctx) => cancelMatches(args, ctx)) },
    runnerMachine: { updateMany: none },
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
const { recordResetLinkMailed, admitResetSpend } = await import(
  "@cockpit-chess/auth/password-reset-links"
);

const { lockCliCredentials } = await import("@cockpit-chess/auth/device-redemption-lock");

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
/** Model the bound consume/password decision, then the post-commit sweep. */
const finishReset = async (token: string) => {
  const admitted = await db.$transaction(async (client) => {
    const tx = client as Parameters<typeof admitResetSpend>[0];
    await lockCliCredentials(USER, tx);
    if (!(await admitResetSpend(tx, token))) return false;
    const spent = await tx.verification.deleteMany({
      where: { identifier: `reset-password:${token}` },
    });
    if (spent.count === 0) return false; // Better Auth refuses missing tokens.
    store.password = "reset-password";
    return true;
  });
  if (admitted) await revokeCredentialsAfterPasswordReset(USER);
  return admitted;
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
  store.password = "initial";
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

  it("a resend that mints first invalidates the earlier reset before password or mailbox commit", async () => {
    const token = await mailedLink();
    const mintGate = gate();
    store.mintPause = mintGate.closed;
    const minting = createSetPasswordLink({ userId: USER, locale: "en-US" });
    await settle();
    let finished = false;
    const resetting = finishReset(token).then((result) => {
      finished = true;
      return result;
    });
    await settle();
    expect(finished).toBe(false); // consume waits for the resend's setup lock
    mintGate.open();
    const replacement = await minting;
    expect(await resetting).toBe(false);
    expect(store.password).toBe("initial");
    expect(store.user.emailVerified).toBe(false);
    expect(resetLinks().map((row) => row.identifier)).toEqual([
      `reset-password:${replacement.token}`,
    ]);
  });

  it("successful mailed consume retires competing links before the post-commit sweep", async () => {
    const token = await mailedLink();
    store.verifications.push({
      identifier: "reset-password:competing",
      value: USER,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const verifyGate = gate();
    store.verifyPause = verifyGate.closed;
    const resetting = finishReset(token);
    await settle();
    // Paused at mailbox verification inside consume, before password and sweep.
    expect(resetLinks().map((row) => row.identifier)).toEqual([`reset-password:${token}`]);
    expect(store.password).toBe("initial");
    expect(store.user.emailVerified).toBe(false);
    verifyGate.open();
    expect(await resetting).toBe(true);
    expect(store.password).toBe("reset-password");
    expect(store.user.emailVerified).toBe(true);
    expect(resetLinks()).toHaveLength(0);
  });

  it("a resend that arrives while the verification is committing waits, then refuses", async () => {
    const token = await mailedLink();
    const verifyGate = gate();
    store.verifyPause = verifyGate.closed;
    const verifying = finishReset(token);
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
    expect(await finishReset(token)).toBe(true);
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
