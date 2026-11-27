import { randomBytes } from "node:crypto";
import { DEVICE_FLOW_SESSION_ORIGIN } from "@cockpit-chess/config/cli";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { hashPassword } from "better-auth/crypto";
import { lockCliCredentials, withCliCredentialLockSlot } from "./device-redemption-lock.js";
import { deleteResetLinks, lockSetPasswordLinks } from "./set-password-link-lock.js";

/**
 * The Prisma writes that revoke every standing companion-CLI credential a user
 * holds, as one composable batch:
 *
 * - every API key (`ApiKey.referenceId`), which authenticates from its own row
 *   and so survives any session revocation;
 * - every device-flow session (`Session.origin = "device-flow"`, the
 *   `cockpit-chess login` token). Better-Auth's own session revocation usually
 *   removed these already; deleting them here keeps the guarantee independent
 *   of that;
 * - every device code bound to the user, so a `cockpit-chess login` that was
 *   approved before the revocation can't be redeemed for a fresh session a
 *   moment after it.
 *
 * The batch opens with the user's CLI-credential advisory lock, which a
 * device-flow redemption holds from before it claims the code until its
 * session row is committed (device-redemption-lock.ts). Without it, a
 * redemption that claimed the code just before this transaction could insert
 * its session just after, and the "revoked" user would still have a live CLI
 * login. Taking the lock first, before any row lock, keeps the wait
 * deadlock-free.
 *
 * Returned unexecuted so each caller can batch it with its own writes in one
 * `prisma.$transaction`; it must stay first in that batch.
 */
function cliCredentialRevocationWrites(userId: string) {
  return [
    lockCliCredentials(userId),
    prisma.apiKey.deleteMany({ where: { referenceId: userId } }),
    prisma.session.deleteMany({ where: { userId, origin: DEVICE_FLOW_SESSION_ORIGIN } }),
    prisma.deviceCode.deleteMany({ where: { userId } }),
  ] as const;
}

/** Better-Auth's two-factor sign-in challenge identifiers (`2fa-<random>`). */
const TWO_FACTOR_CHALLENGE_PREFIX = "2fa-";

/** Attempts per revocation, and the pause before each retry (ms). */
export const REVOCATION_ATTEMPTS = 3;
const REVOCATION_BACKOFF_MS = [100, 400] as const;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run one revocation transaction, retrying a failure. Every write in it is an
 * idempotent `deleteMany` / conditional `updateMany`, so re-running a batch
 * that partly happened (or fully happened and only the reply was lost) is
 * safe. The batch is rebuilt for every attempt: a Prisma batch promise runs
 * once.
 *
 * If every attempt fails it logs loudly — the user id and the error class and
 * message only, never the email or the error object (which can carry query
 * parameters) — and rethrows.
 */
async function runRevocation(
  label: string,
  userId: string,
  writes: () => Prisma.PrismaPromise<unknown>[],
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REVOCATION_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(REVOCATION_BACKOFF_MS[attempt - 1] ?? 400);
    try {
      // In a lock slot: the batch may wait for a redemption's CLI-credential
      // lock while holding a pooled connection (device-redemption-lock.ts).
      await withCliCredentialLockSlot(() => prisma.$transaction(writes()));
      return;
    } catch (error) {
      lastError = error;
    }
  }
  console.error(
    `[auth] SECURITY: ${label} credential revocation failed after ${REVOCATION_ATTEMPTS} attempts; the user's API keys and CLI logins may still be live. Revoke them by hand.`,
    {
      userId,
      error:
        lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : "unknown error",
    },
  );
  throw lastError;
}

/**
 * Runs after a password reset (`emailAndPassword.onPasswordReset`). Someone
 * who resets their password suspects it leaked, so every credential that could
 * still act as them goes, in one transaction.
 *
 * Every session and every pending two-factor sign-in challenge goes too, once
 * more after the new hash is committed: with the credential fence of a
 * password sign-in (password-sign-in-fence.ts) that means no session proved
 * by the old password survives, however its sign-in interleaved with the
 * reset. Every other outstanding reset link for the user is deleted as well,
 * under the set-password-link lock an invite resend holds while it mints one.
 *
 * Spending the link verifies the email only when that link was mailed, and
 * that happens in the `/reset-password` after-hook, which knows the token
 * (password-reset-links.ts `verifyEmailIfResetLinkWasMailed`): this callback
 * is told only the user. A link revealed to the admin (the invite mail was not
 * sent) proves nothing about the mailbox.
 *
 * Better-Auth calls this AFTER it has committed the new password and consumed
 * the reset token, so a throw here does not undo the reset: the password is
 * already changed, and the same link now answers INVALID_TOKEN. That is why
 * the transaction is retried (it is idempotent) before giving up. If it still
 * fails, the error is logged loudly and rethrown so the request reports a
 * failure rather than a clean success; the user's recovery is a fresh
 * forgot-password link, whose completion runs this revocation again.
 */
export async function revokeCredentialsAfterPasswordReset(
  userId: string,
  { sleep = defaultSleep }: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  await runRevocation(
    "password-reset",
    userId,
    () => [
      ...cliCredentialRevocationWrites(userId),
      // EVERY session, not only device-flow ones. Better-Auth deleted them
      // before it wrote the new hash, but a password sign-in still verifying
      // the old hash can insert its session in between; deleting again now,
      // after the write, is what makes the sign-in credential fence
      // (password-sign-in-fence.ts) complete.
      prisma.session.deleteMany({ where: { userId } }),
      // Every pending two-factor sign-in challenge (`2fa-…`, value = user id)
      // and its credential fence row: a password step passed with the old
      // password must not be finished with a code after the reset.
      prisma.verification.deleteMany({
        where: { value: userId, identifier: { startsWith: TWO_FACTOR_CHALLENGE_PREFIX } },
      }),
      // Serialized with an admin's invite resend (set-password-link-lock.ts):
      // a link minted while this reset was finishing is deleted here. A resend
      // after it mints again only while the account is still a pending invite
      // (a revealed link verifies nothing); a mailed link's verification, in
      // the /reset-password after-hook, deletes the user's links once more
      // under the same lock (password-reset-links.ts).
      // Taken after the CLI-credential lock, which nothing that holds this one
      // ever waits for, so the order cannot deadlock.
      lockSetPasswordLinks(userId),
      // The reset is spent; any other reset link for the user (an older
      // forgot-password mail, an invite link) dies with it.
      deleteResetLinks(userId),
    ],
    sleep,
  );
}

/**
 * Runs after a signed-in password change that signed out the user's other
 * devices (an after-hook, so the new password is already committed). Retried
 * and logged exactly like {@link revokeCredentialsAfterPasswordReset}; the
 * user's recovery from a final failure is to change the password again.
 */
export async function revokeCredentialsAfterPasswordChange(
  { userId, keepSessionToken }: PasswordChangeRevocationTarget,
  { sleep = defaultSleep }: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  await runRevocation(
    "password-change",
    userId,
    () => [
      ...cliCredentialRevocationWrites(userId),
      // Every session but the one the change just issued to the device that
      // made it (what `revokeOtherSessions` promises). Better-Auth deleted the
      // others before it wrote the new hash; a password sign-in that inserted
      // its session in between goes here (password-sign-in-fence.ts).
      prisma.session.deleteMany({ where: { userId, token: { not: keepSessionToken } } }),
    ],
    sleep,
  );
}

/**
 * Runs when a password write committed after its password-write lock lapsed
 * (password-write-lock.ts, `confirmPasswordWriteLocked`): a reset may have
 * completed in between, so the hash just written may be an attacker's.
 * Neither it nor anything before it can be trusted, so:
 *
 * 1. the credential gets the hash of a random secret nobody knows (a valid
 *    hash, so sign-in just answers "invalid password"), committed on its own
 *    first;
 * 2. then every session, every pending two-factor challenge and every CLI
 *    credential goes, in the CLI-credential revocation batch.
 *
 * In that order for the same reason as a reset: a password sign-in whose
 * credential re-check still saw the untrusted hash had committed its session
 * before step 1, so step 2 deletes it; one that re-checks later sees the
 * changed hash and is refused (password-sign-in-fence.ts). The account owner
 * recovers with Forgot password. Takes no password-write lock (the request
 * running this may still hold it). Both steps are idempotent and retried.
 */
export async function quarantineUntrustedPasswordWrite(
  userId: string,
  {
    sleep = defaultSleep,
    hash = hashPassword,
  }: {
    sleep?: (ms: number) => Promise<void>;
    /** The app's password hash (index.ts passes the pepper's), so the scrambled value has the stored format. */
    hash?: (password: string) => Promise<string>;
  } = {},
): Promise<void> {
  const unusable = await hash(randomBytes(32).toString("base64url"));
  await runRevocation(
    "untrusted-password-write (credential scramble)",
    userId,
    () => [
      prisma.account.updateMany({
        where: { userId, providerId: "credential" },
        data: { password: unusable },
      }),
    ],
    sleep,
  );
  await runRevocation(
    "untrusted-password-write",
    userId,
    () => [
      ...cliCredentialRevocationWrites(userId),
      prisma.session.deleteMany({ where: { userId } }),
      prisma.verification.deleteMany({
        where: { value: userId, identifier: { startsWith: TWO_FACTOR_CHALLENGE_PREFIX } },
      }),
    ],
    sleep,
  );
}

/** Who a finished password change revokes, and the session it keeps. */
export type PasswordChangeRevocationTarget = { userId: string; keepSessionToken: string };

const CHANGE_PASSWORD_PATH = "/change-password";

/**
 * The user whose CLI credentials (and other sessions) a finished Better-Auth
 * request should revoke, with the session token the change issued to keep, or
 * `null`. Only a *successful* `/change-password` that asked to sign out
 * other sessions (`revokeOtherSessions: true`, which the web settings form
 * always sends) qualifies: a change that keeps other sessions alive is the
 * user saying the old password did not leak.
 *
 * `returned` is the endpoint's result as an after-hook sees it: the JSON body
 * (`{ token, user }`) on success, an `APIError` on failure — which has no
 * `user`, so a rejected change never revokes anything. A success with
 * `revokeOtherSessions` always carries the new session's token.
 */
export function passwordChangeRevocationTarget(ctx: {
  path?: string;
  body?: unknown;
  returned?: unknown;
}): PasswordChangeRevocationTarget | null {
  if (ctx.path !== CHANGE_PASSWORD_PATH) return null;
  if (!isRecord(ctx.body) || ctx.body.revokeOtherSessions !== true) return null;
  if (!isRecord(ctx.returned) || !isRecord(ctx.returned.user)) return null;
  const id = ctx.returned.user.id;
  const token = ctx.returned.token;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  return { userId: id, keepSessionToken: token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
