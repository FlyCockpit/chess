import { AsyncLocalStorage } from "node:async_hooks";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { APIError, createAuthEndpoint, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { deviceAuthorization } from "better-auth/plugins";
import { releaseSlots, tryAcquireSlots, withLockSlot } from "./lock-slots.js";
import { readBodyFields } from "./request-body-field.js";

/**
 * Serialize device-flow token redemption with CLI credential revocation.
 *
 * Better-Auth's `/device/token` endpoint claims (deletes) the approved device
 * code and only then inserts the session. A password reset that revokes the
 * user's CLI credentials between those two steps finds nothing to delete —
 * the code is already claimed and the session does not exist yet — and the
 * session that lands a moment later is a live CLI login minted after the
 * revocation.
 *
 * Both sides therefore take the same per-user transaction-scoped advisory
 * lock: revocation as the first statement of its transaction
 * (credential-revocation.ts), redemption around the whole Better-Auth handler
 * (`withDeviceRedemptionLock`, mounted by apps/server on the token endpoint).
 * Whichever goes second sees the other's committed result: revocation deletes
 * the freshly minted session, or redemption finds the device code gone.
 *
 * The session-create hook (`assertDeviceRedemptionLocked`) refuses a
 * device-flow session whose user's lock this request does not hold, so a
 * redemption that reaches Better-Auth any other way fails closed.
 */

/** Advisory-lock key shared by revocation and redemption for one user. */
export function cliCredentialLockKey(userId: string): string {
  return `cli-credentials:${userId}`;
}

/** The revocation side: run first inside the revoking transaction. */
export function lockCliCredentials(userId: string): Prisma.PrismaPromise<unknown> {
  return prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cliCredentialLockKey(userId)}))`;
}

/** The lock a redemption holds; `held` turns false the moment it is released. */
type HeldLock = { userId: string; held: boolean; expiresAt: number };
const heldFor = new AsyncLocalStorage<HeldLock>();

/**
 * How long the lock transaction may live. A redemption is a handful of
 * queries; the bound only matters if the database stalls.
 *
 * Prisma rolls an expired transaction back (releasing the lock) while it keeps
 * awaiting the callback, so "the transaction settled" comes too late to mark
 * the lock released. `held` is therefore cleared by our own timer a margin
 * BEFORE Prisma's: from then on the session hooks refuse (or remove) a mint,
 * and the lock is provably still held up to that point. Both are timers on
 * this event loop, so even a stalled loop fires ours first.
 */
const REDEMPTION_LOCK_TIMEOUT_MS = 30_000;
const REDEMPTION_HELD_FOR_MS = REDEMPTION_LOCK_TIMEOUT_MS - 5_000;

/**
 * Run a transaction that takes (and may wait for) a CLI credential lock
 * inside one of the process's lock slots (lock-slots.ts). Revocation uses
 * this; inside a password write it uses the slot that write reserved.
 */
export function withCliCredentialLockSlot<T>(fn: () => Promise<T>): Promise<T> {
  return withLockSlot(fn);
}

/**
 * The session a credential mint was authorized by is gone (signed out, or
 * deleted by a password reset or change) or expired. Callers answer it like
 * any other unauthenticated request.
 */
export class CliCredentialSessionRevokedError extends Error {
  constructor() {
    super("The session that asked for this CLI credential is no longer valid.");
    this.name = "CliCredentialSessionRevokedError";
  }
}

/**
 * Mint a CLI credential (today: an API key) for a signed-in browser session
 * so that it can never outlive a concurrent revocation.
 *
 * The caller's session was checked when the request arrived, possibly from
 * the 60-second cookie cache, so by the time the key is inserted a password
 * reset may already have deleted that session and run its revocation. The
 * mint therefore holds the user's CLI-credential lock (the one revocation
 * takes first) across "is the session still live?" and the insert:
 *
 * - revocation first: it committed after Better-Auth deleted the user's
 *   sessions, so the re-check finds the session gone and nothing is minted;
 * - mint first: the key is committed before the lock is released, and the
 *   revocation that waited for it deletes it.
 *
 * `mint` runs on the shared client (other pooled connections) while the lock
 * transaction holds one, inside a lock slot like every other CLI-credential
 * lock holder, so lock holders can never fill the pool. If the lock lapsed
 * before `mint` returned (the transaction timed out), a revocation may have
 * run in between, so the credential is handed to `discard` and the mint
 * fails. Waits for a busy lock (a revocation is a few statements; another
 * mint is one insert).
 */
export async function mintCliCredentialForSession<T>(
  session: { userId: string; sessionId: string },
  { mint, discard }: { mint: () => Promise<T>; discard: (minted: T) => Promise<unknown> },
): Promise<T> {
  return withCliCredentialLockSlot(async () => {
    const expiresAt = performance.now() + REDEMPTION_HELD_FOR_MS;
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cliCredentialLockKey(session.userId)}))`;
        const liveSession = () =>
          tx.session.findFirst({
            where: { id: session.sessionId, userId: session.userId, expiresAt: { gt: new Date() } },
            select: { id: true },
          });
        if (!(await liveSession())) throw new CliCredentialSessionRevokedError();
        if (performance.now() >= expiresAt) throw lockLapsed();
        const minted = await mint();
        if (performance.now() >= expiresAt) {
          await discard(minted);
          throw lockLapsed();
        }
        const liveAfter = await liveSession();
        if (!liveAfter || performance.now() >= expiresAt) {
          await discard(minted);
          if (!liveAfter) throw new CliCredentialSessionRevokedError();
          throw lockLapsed();
        }
        return minted;
      },
      { timeout: REDEMPTION_LOCK_TIMEOUT_MS },
    );
  });
}

class CliCredentialLockLapsedError extends Error {}

function lockLapsed(): Error {
  return new CliCredentialLockLapsedError(
    "The CLI credential lock lapsed before the credential was committed.",
  );
}

/** RFC 8628 answer while another redemption for the same user holds the lock. */
function slowDown(): Response {
  return Response.json(
    {
      error: "slow_down",
      error_description: "Another sign-in for this account is finishing; retry shortly.",
    },
    { status: 400, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

/**
 * Run a device-token redemption (`run` calls the Better-Auth handler) while
 * holding the code owner's CLI-credential lock.
 *
 * The `device_code` is read from a clone of the body (JSON or form; the
 * original is left for the handler), and its owner from the device code row
 * before the handler runs. A body without a usable code, or a code that is
 * unknown, still pending, or denied has no owner to lock yet and runs
 * unlocked: Better-Auth answers it with an error and mints nothing. If the
 * user approves in the instant between this read and the handler's own read,
 * the session hook refuses the unlocked mint and the CLI reports a failed
 * login (a fresh `cockpit-chess login` works).
 *
 * The lock is TRIED, never waited for: a second concurrent redemption for the
 * same user, or one that finds every lock slot taken, answers `slow_down`
 * (the CLI polls again) instead of parking a pooled connection. The lock
 * lives in its own interactive transaction (one pooled connection) while the
 * handler's queries run on others, so the pool needs at least two connections
 * (`DATABASE_POOL_MAX` enforces that) and lock transactions never take the
 * last one (lock-slots.ts). It is released when `run` settles or the
 * transaction times out; it stops counting as held shortly before the latter.
 */
export async function withDeviceRedemptionLock(
  request: Request,
  run: () => Promise<Response>,
): Promise<Response> {
  const { device_code: deviceCode } = await readBodyFields(request.clone(), { device_code: 512 });
  const owner = deviceCode
    ? await prisma.deviceCode.findUnique({
        where: { deviceCode },
        select: { userId: true, status: true },
      })
    : null;
  const userId = owner?.status === "approved" ? owner.userId : null;
  if (!userId) return run();
  if (!tryAcquireSlots()) return slowDown();
  // The deadline starts BEFORE the transaction does, so it is never later
  // than Prisma's own (which starts once the transaction has begun).
  const lock: HeldLock = {
    userId,
    held: false,
    expiresAt: performance.now() + REDEMPTION_HELD_FOR_MS,
  };
  let lapse: NodeJS.Timeout | undefined;
  try {
    return await prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${cliCredentialLockKey(userId)})) AS locked`;
        const remaining = lock.expiresAt - performance.now();
        if (!row?.locked || remaining <= 0) return slowDown();
        lock.held = true;
        lapse = setTimeout(() => {
          lock.held = false;
        }, remaining);
        return heldFor.run(lock, run);
      },
      { timeout: REDEMPTION_LOCK_TIMEOUT_MS },
    );
  } finally {
    clearTimeout(lapse);
    lock.held = false;
    releaseSlots();
  }
}

/**
 * Throw unless the current request holds `userId`'s CLI-credential lock.
 * Called from the session-create hook for device-flow sessions only.
 */
export function assertDeviceRedemptionLocked(userId: string): void {
  if (!deviceRedemptionLockHeld(userId)) {
    throw new Error(
      "Device-flow session refused: redemption did not hold the CLI credential lock (see device-redemption-lock.ts).",
    );
  }
}

/** Whether the current request still holds `userId`'s CLI-credential lock. */
export function deviceRedemptionLockHeld(userId: string): boolean {
  const lock = heldFor.getStore();
  // The clock check backs up the timer: a stalled event loop cannot keep an
  // expired lock looking held.
  return lock?.userId === userId && lock.held && performance.now() < lock.expiresAt;
}

/**
 * The session-create AFTER hook's half of the guarantee. The before hook has
 * already refused an unlocked mint, but the lock can still lapse (transaction
 * timeout) between that check and the insert committing, and a revocation may
 * have run in that gap. If the lock is no longer held once the row exists,
 * delete it: the CLI then holds a token for a session that is already gone.
 */
export async function removeDeviceSessionIfUnlocked(session: {
  id: string;
  userId: string;
}): Promise<void> {
  if (deviceRedemptionLockHeld(session.userId)) return;
  await prisma.session.deleteMany({ where: { id: session.id } });
  console.error(
    "[auth] SECURITY: a device-flow session was created after its CLI credential lock lapsed; it was removed.",
    { userId: session.userId },
  );
}

/** Fence browser approval as well as redemption; preserve the pinned endpoint's validation. */
export function lockedDeviceAuthorization(
  options: Parameters<typeof deviceAuthorization<undefined>>[0],
): ReturnType<typeof deviceAuthorization<undefined>> {
  const plugin = deviceAuthorization(options);
  const approve = plugin.endpoints.deviceApprove;
  return {
    ...plugin,
    endpoints: {
      ...plugin.endpoints,
      deviceApprove: createAuthEndpoint(approve.path, approve.options, async (ctx) => {
        const session = await getAuthoritativeSessionFromCtx(ctx);
        if (!session) throw new APIError("UNAUTHORIZED");
        try {
          // Approval authorizes a future credential: reuse this app's existing
          // mint fence instead of adding a second implementation of the lock.
          return await mintCliCredentialForSession(
            { userId: session.user.id, sessionId: session.session.id },
            {
              mint: () => approve(ctx),
              // Approval only updates an existing code. If the lock lapses,
              // revocation deletes it; a late update cannot resurrect it.
              discard: async () => {},
            },
          );
        } catch (error) {
          if (
            error instanceof CliCredentialSessionRevokedError ||
            error instanceof CliCredentialLockLapsedError
          )
            throw new APIError("UNAUTHORIZED");
          throw error;
        }
      }),
    },
  };
}
