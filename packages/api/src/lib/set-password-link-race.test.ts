import { beforeEach, describe, expect, it, vi } from "vitest";

// An admin's "Resend invite" racing the invitee finishing their password
// reset. The real `createSetPasswordLink` and the real reset-side revocation
// (`revokeCredentialsAfterPasswordReset`, packages/auth) run against an
// in-memory database that models what the guarantee rests on: blocking
// transaction-scoped advisory locks, released when their transaction ends,
// and batch transactions running their statements in order. Better-Auth's own
// part of the reset (spend the token, write the password) has already
// committed when its `onPasswordReset` runs the revocation, so it is not
// modelled beyond the spent token.

type Verification = { identifier: string; value: string };
const store = vi.hoisted(() => ({
  user: { emailVerified: false, banned: false as boolean, banExpires: null as Date | null },
  verifications: [] as Verification[],
  locks: new Map<string, Promise<void>>(),
  /** Awaited inside the revocation batch, after it holds both locks. */
  revocationPause: null as Promise<void> | null,
  /** Awaited by the mint right after its eligibility read. */
  mintPause: null as Promise<void> | null,
}));

const db = vi.hoisted(() => {
  type TxContext = { releases: (() => void)[] };
  const lock = async (strings: TemplateStringsArray, values: unknown[], ctx: TxContext) => {
    if (!strings.join("?").includes("pg_advisory_xact_lock(hashtext(?))")) {
      throw new Error(`unexpected SQL ${strings.join("?")}`);
    }
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
    ctx.releases.push(release);
    return 1;
  };
  /** A lazy statement for a batch transaction. */
  const statement = (run: (ctx: TxContext) => Promise<unknown>) => ({ run });
  const deleteResetLinks = (userId: string) => {
    const kept = store.verifications.filter(
      (v) => !(v.value === userId && v.identifier.startsWith("reset-password:")),
    );
    const count = store.verifications.length - kept.length;
    store.verifications.splice(0, store.verifications.length, ...kept);
    return { count };
  };
  const none = () => statement(async () => ({ count: 0 }));
  const interactive = (ctx: TxContext) => ({
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
      lock(strings, values, ctx),
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
    },
    verification: {
      deleteMany: async ({ where }: { where: { value: string } }) => deleteResetLinks(where.value),
      create: async ({ data }: { data: Verification }) => {
        store.verifications.push({ identifier: data.identifier, value: data.value });
        return { id: "v" };
      },
    },
  });
  return {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
      statement((ctx) => lock(strings, values, ctx)),
    async $transaction(
      work: { run: (ctx: TxContext) => Promise<unknown> }[] | ((tx: unknown) => Promise<unknown>),
    ) {
      const ctx: TxContext = { releases: [] };
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
      deleteMany: ({ where }: { where: { value: string } }) =>
        statement(async () => deleteResetLinks(where.value)),
    },
    user: {
      updateMany: () =>
        statement(async () => {
          if (store.revocationPause) await store.revocationPause;
          const changed = store.user.emailVerified ? 0 : 1;
          store.user.emailVerified = true;
          return { count: changed };
        }),
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

beforeEach(() => {
  store.user = { emailVerified: false, banned: false, banExpires: null };
  store.verifications.length = 0;
  store.locks.clear();
  store.revocationPause = null;
  store.mintPause = null;
});

describe("invite resend vs a finishing password reset", () => {
  it("a resend that minted its link first loses it to the reset that commits after", async () => {
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
    expect(store.user.emailVerified).toBe(true);
    // The fresh 7-day link is gone with the rest: no reset credential is left
    // for an account that is now set up.
    expect(resetLinks()).toHaveLength(0);
  });

  it("a resend that arrives while the reset is committing waits, then refuses", async () => {
    const revocationGate = gate();
    store.revocationPause = revocationGate.closed;
    const revoking = revokeCredentialsAfterPasswordReset(USER);
    await settle();
    let settled = false;
    const minting = createSetPasswordLink({ userId: USER, locale: "en-US" }).finally(() => {
      settled = true;
    });
    // The mint's own result is awaited below; keep the rejection handled.
    minting.catch(() => undefined);
    await settle();
    expect(settled).toBe(false); // waits for the reset's lock
    revocationGate.open();
    await revoking;
    await expect(minting).rejects.toThrow(new SetPasswordLinkRefusedError("not-pending"));
    expect(resetLinks()).toHaveLength(0);
  });

  it("a resend after the reset committed is refused outright", async () => {
    await revokeCredentialsAfterPasswordReset(USER);
    await expect(createSetPasswordLink({ userId: USER, locale: "en-US" })).rejects.toThrow(
      new SetPasswordLinkRefusedError("not-pending"),
    );
    expect(resetLinks()).toHaveLength(0);
  });

  it("a resend with no reset in sight mints exactly one working link", async () => {
    await createSetPasswordLink({ userId: USER, locale: "en-US" });
    await createSetPasswordLink({ userId: USER, locale: "en-US" });
    expect(resetLinks()).toHaveLength(1);
  });
});
