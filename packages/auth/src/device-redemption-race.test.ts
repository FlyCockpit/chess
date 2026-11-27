import { beforeEach, describe, expect, it, vi } from "vitest";

// The race between a `cockpit-chess login` redemption and a password reset's
// credential revocation, played out against an in-memory database that models
// the two things the guarantee rests on: transaction-scoped advisory locks
// (a blocking `pg_advisory_xact_lock`, a non-blocking `pg_try_advisory_xact_lock`,
// both released when their transaction ends) and Prisma batch transactions
// running their statements in order. The real lock helper, the real
// revocation and the real session hooks run against it; only Better-Auth's
// `/device/token` handler is a stand-in with the same order of steps (claim
// the approved code, then insert the session through the session hooks).
// The same race on real Postgres with the real handler is the
// device-flow race check proposed for `pnpm runtime:test-operations`.

type DeviceCodeRow = { deviceCode: string; userId: string | null; status: string };
type SessionRow = { id: string; userId: string; origin: string; expiresAt?: Date };

const store = vi.hoisted(() => ({
  deviceCodes: [] as DeviceCodeRow[],
  sessions: [] as SessionRow[],
  apiKeys: [] as { id: string; referenceId: string }[],
  /** Advisory locks held, by key → release of the holding transaction. */
  locks: new Map<string, Promise<void>>(),
}));

const db = vi.hoisted(() => {
  type TxContext = { held: string[]; releases: (() => void)[] };
  /** A lazy statement: awaited alone it autocommits, in a batch it joins the tx. */
  const statement = <T>(run: (ctx: TxContext) => Promise<T>) => {
    const autocommit = async () => {
      const ctx: TxContext = { held: [], releases: [] };
      try {
        return await run(ctx);
      } finally {
        for (const release of ctx.releases) release();
      }
    };
    return {
      run,
      // biome-ignore lint/suspicious/noThenProperty: models a lazy PrismaPromise.
      then: <R>(onFulfilled: (value: T) => R, onRejected?: (error: unknown) => R) =>
        autocommit().then(onFulfilled, onRejected),
    };
  };
  const take = (key: string, ctx: TxContext) => {
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
    ctx.held.push(key);
    ctx.releases.push(release);
  };
  const lockKey = (strings: TemplateStringsArray, values: unknown[]) => {
    const sql = strings.join("?");
    if (!sql.includes("advisory_xact_lock(hashtext(?))")) throw new Error(`unexpected SQL ${sql}`);
    return String(values[0]);
  };
  const removed = (count: number) => ({ count });
  const deleteWhere = <T>(rows: T[], keep: (row: T) => boolean) => {
    const before = rows.length;
    const kept = rows.filter(keep);
    rows.splice(0, rows.length, ...kept);
    return removed(before - kept.length);
  };
  const blockingLock = async (strings: TemplateStringsArray, values: unknown[], ctx: TxContext) => {
    const key = lockKey(strings, values);
    // Blocking: wait until whoever holds it ends their transaction.
    for (let held = store.locks.get(key); held; held = store.locks.get(key)) await held;
    take(key, ctx);
    return 1;
  };
  return {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
      statement(async (ctx) =>
        strings.join("").includes('WITH "resetChallenges"') ||
        strings.join("").includes("pg_notify")
          ? 0
          : blockingLock(strings, values, ctx),
      ),
    async $transaction(
      work: { run: (ctx: TxContext) => Promise<unknown> }[] | ((tx: unknown) => Promise<unknown>),
    ) {
      const ctx: TxContext = { held: [], releases: [] };
      try {
        if (typeof work === "function") {
          return await work({
            $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
              const key = lockKey(strings, values);
              if (store.locks.has(key)) return [{ locked: false }];
              take(key, ctx);
              return [{ locked: true }];
            },
            $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
              blockingLock(strings, values, ctx),
            session: {
              findFirst: async ({
                where,
              }: {
                where: { id: string; userId: string; expiresAt: { gt: Date } };
              }) => {
                const row = store.sessions.find(
                  (s) =>
                    s.id === where.id &&
                    s.userId === where.userId &&
                    (s.expiresAt ?? new Date(8.64e15)) > where.expiresAt.gt,
                );
                return row ? { id: row.id } : null;
              },
            },
          });
        }
        const results = [];
        for (const item of work) results.push(await item.run(ctx));
        return results;
      } finally {
        for (const release of ctx.releases) release();
      }
    },
    runnerMachine: { updateMany: () => statement(async () => ({ count: 0 })) },
    chessMatch: {
      updateMany: (args: unknown) =>
        statement(async (ctx) => {
          expect(args).toEqual({
            where: { ownerId: USER, source: "hosted", status: { in: ["queued", "running"] } },
            data: {
              status: "stopped",
              runToken: null,
              terminalCause: "owner-reset",
              ending: { kind: "cancelled" },
            },
          });
          expect(ctx.held).toContain(`cli-credentials:${USER}`);
          return { count: 0 };
        }),
    },
    deviceCode: {
      findUnique: async ({ where }: { where: { deviceCode: string } }) => {
        const row = store.deviceCodes.find((code) => code.deviceCode === where.deviceCode);
        return row ? { userId: row.userId, status: row.status } : null;
      },
      deleteMany: ({ where }: { where: { userId: string } }) =>
        statement(async () => deleteWhere(store.deviceCodes, (row) => row.userId !== where.userId)),
    },
    session: {
      deleteMany: ({
        where,
      }: {
        where: {
          id?: string;
          userId?: string;
          origin?: string;
          OR?: { userId?: string; origin?: string; impersonatedBy?: string }[];
        };
      }) =>
        statement(async () =>
          deleteWhere(
            store.sessions,
            (row) =>
              !(
                (where.OR
                  ? where.OR.some((part) =>
                      Object.entries(part).every(
                        ([key, value]) => row[key as keyof typeof row] === value,
                      ),
                    )
                  : true) &&
                (where.id === undefined || row.id === where.id) &&
                (where.userId === undefined || row.userId === where.userId) &&
                (where.origin === undefined || row.origin === where.origin)
              ),
          ),
        ),
    },
    apiKey: {
      deleteMany: ({ where }: { where: { id?: string; referenceId: string } }) =>
        statement(async () =>
          deleteWhere(
            store.apiKeys,
            (row) =>
              !(
                row.referenceId === where.referenceId &&
                (where.id === undefined || row.id === where.id)
              ),
          ),
        ),
    },
    verification: { deleteMany: () => statement(async () => removed(0)) },
    user: { updateMany: () => statement(async () => removed(0)) },
  };
});

vi.mock("@cockpit-chess/db", () => ({ default: db }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));

const {
  withDeviceRedemptionLock,
  assertDeviceRedemptionLocked,
  removeDeviceSessionIfUnlocked,
  mintCliCredentialForSession,
  CliCredentialSessionRevokedError,
} = await import("./device-redemption-lock");
const { revokeCredentialsAfterPasswordReset } = await import("./credential-revocation");
const { deviceFlowSessionData } = await import("./device-session-origin");

const USER = "u1";
let sessionSeq = 0;

/**
 * Stand-in for Better-Auth's `/device/token` handler, in its order: claim
 * (delete) the approved code, then create the session through the same
 * session-create hooks `packages/auth/src/index.ts` registers. `betweenClaimAndInsert`
 * is where the race window is held open.
 */
async function deviceTokenHandler(
  deviceCode: string,
  betweenClaimAndInsert: () => Promise<void> = async () => undefined,
): Promise<Response> {
  const index = store.deviceCodes.findIndex(
    (row) => row.deviceCode === deviceCode && row.status === "approved",
  );
  const row = store.deviceCodes[index];
  if (!row?.userId) return Response.json({ error: "invalid_grant" }, { status: 400 });
  store.deviceCodes.splice(index, 1);
  await betweenClaimAndInsert();
  const context = { path: "/device/token" };
  const tagged = deviceFlowSessionData({ userId: row.userId }, context);
  if (tagged) assertDeviceRedemptionLocked(row.userId);
  const session = { id: `s${++sessionSeq}`, userId: row.userId, origin: "device-flow" };
  store.sessions.push(session);
  await removeDeviceSessionIfUnlocked(session);
  return Response.json({ access_token: session.id });
}

function redeem(deviceCode: string, betweenClaimAndInsert?: () => Promise<void>) {
  const request = new Request("http://app.test/api/auth/device/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode, client_id: "cockpit-chess-cli" }),
  });
  return withDeviceRedemptionLock(request, () =>
    deviceTokenHandler(deviceCode, betweenClaimAndInsert),
  );
}

const deviceSessions = () => store.sessions.filter((s) => s.origin === "device-flow").length;
const approve = (deviceCode: string) =>
  store.deviceCodes.push({ deviceCode, userId: USER, status: "approved" });
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  store.deviceCodes.length = 0;
  store.sessions.length = 0;
  store.apiKeys.length = 0;
  store.locks.clear();
});

describe("device-flow redemption vs password-reset revocation", () => {
  it("a normal login mints one CLI session", async () => {
    approve("dc-ok");
    const response = await redeem("dc-ok");
    expect(response.status).toBe(200);
    expect(deviceSessions()).toBe(1);
  });

  it("a reset that starts after the code was claimed waits, then removes the session minted under the lock", async () => {
    approve("dc-race");
    let reachedWindow: () => void = () => undefined;
    const inWindow = new Promise<void>((resolve) => {
      reachedWindow = resolve;
    });
    let openWindow: () => void = () => undefined;
    const windowClosed = new Promise<void>((resolve) => {
      openWindow = resolve;
    });

    const pending = redeem("dc-race", async () => {
      reachedWindow();
      await windowClosed;
    });
    await inWindow;
    // The code is claimed and no session exists yet: without the lock the
    // revocation would find nothing to delete here.
    expect(store.deviceCodes).toHaveLength(0);
    let revoked = false;
    const revoking = revokeCredentialsAfterPasswordReset(USER).then(() => {
      revoked = true;
    });
    await settle();
    expect(revoked).toBe(false); // waiting on the redemption's lock

    openWindow();
    const raced = await pending;
    expect(raced.status).toBe(200); // the redemption itself completes…
    await revoking;
    expect(deviceSessions()).toBe(0); // …but its session is gone with the rest
  });

  it("a reset that commits between approval and redemption leaves nothing to redeem", async () => {
    approve("dc-late");
    await revokeCredentialsAfterPasswordReset(USER);
    const refused = await redeem("dc-late");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_grant" });
    expect(deviceSessions()).toBe(0);
  });

  it("a second redemption for the same user while one holds the lock is told to slow down", async () => {
    approve("dc-a");
    approve("dc-b");
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = redeem("dc-a", () => hold);
    await settle();
    const busy = await redeem("dc-b");
    expect(await busy.json()).toMatchObject({ error: "slow_down" });
    release();
    expect((await first).status).toBe(200);
  });

  it("a mint that reaches the handler without the lock is refused", async () => {
    approve("dc-bypass");
    await expect(deviceTokenHandler("dc-bypass")).rejects.toThrow(/did not hold/);
    expect(deviceSessions()).toBe(0);
  });
});

// API keys are minted by an oRPC procedure (packages/api cliAccess.apiKeys.create)
// for a browser session checked when the request arrived, possibly from the
// 60 s cookie cache. A password reset deletes the user's sessions (Better-Auth)
// and then runs the revocation; the mint must not land a key after both.
describe("API-key mint vs password-reset revocation", () => {
  const WEB_SESSION = "web-1";
  let keySeq = 0;
  const signIn = () =>
    store.sessions.push({
      id: WEB_SESSION,
      userId: USER,
      origin: "sign-in",
      expiresAt: new Date(Date.now() + 60_000),
    });
  /** Better-Auth's half of a reset: delete every session, then onPasswordReset. */
  const resetPassword = async () => {
    store.sessions.splice(
      0,
      store.sessions.length,
      ...store.sessions.filter((s) => s.userId !== USER),
    );
    await revokeCredentialsAfterPasswordReset(USER);
  };
  const mintKey = (beforeInsert: () => Promise<void> = async () => undefined) =>
    mintCliCredentialForSession(
      { userId: USER, sessionId: WEB_SESSION },
      {
        mint: async () => {
          await beforeInsert();
          const key = { id: `k${++keySeq}`, referenceId: USER };
          store.apiKeys.push(key);
          return key;
        },
        discard: async (key) => {
          await db.apiKey.deleteMany({ where: { id: key.id, referenceId: USER } });
        },
      },
    );

  it("mints a key for a live session", async () => {
    signIn();
    await mintKey();
    expect(store.apiKeys).toHaveLength(1);
  });

  it("refuses a mint whose session a finished reset already deleted (cached or in-flight authorization)", async () => {
    signIn();
    await resetPassword();
    await expect(mintKey()).rejects.toBeInstanceOf(CliCredentialSessionRevokedError);
    expect(store.apiKeys).toHaveLength(0);
  });

  it("refuses an expired session", async () => {
    store.sessions.push({
      id: WEB_SESSION,
      userId: USER,
      origin: "sign-in",
      expiresAt: new Date(Date.now() - 1),
    });
    await expect(mintKey()).rejects.toBeInstanceOf(CliCredentialSessionRevokedError);
    expect(store.apiKeys).toHaveLength(0);
  });

  it("a reset that starts while a key is being inserted waits, then deletes that key", async () => {
    signIn();
    let reachedInsert: () => void = () => undefined;
    const atInsert = new Promise<void>((resolve) => {
      reachedInsert = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const minting = mintKey(async () => {
      reachedInsert();
      await released;
    });
    await atInsert;
    let revoked = false;
    const resetting = resetPassword().then(() => {
      revoked = true;
    });
    await settle();
    expect(revoked).toBe(false); // waiting on the mint's lock
    release();
    // Core session revocation may precede the credential-lock wait. The
    // post-insert session check refuses the key in that case.
    await expect(minting).rejects.toBeInstanceOf(CliCredentialSessionRevokedError);
    await resetting;
    expect(store.apiKeys).toHaveLength(0);
  });

  it("discards the key and fails when the lock lapsed before the insert returned", async () => {
    signIn();
    const now = vi.spyOn(performance, "now");
    try {
      const start = performance.now();
      now.mockReturnValue(start);
      await expect(
        mintKey(async () => {
          now.mockReturnValue(start + 60_000);
        }),
      ).rejects.toThrow(/lapsed/);
      expect(store.apiKeys).toHaveLength(0);
    } finally {
      now.mockRestore();
    }
  });
});
