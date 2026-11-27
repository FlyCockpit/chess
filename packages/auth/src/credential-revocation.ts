import { randomBytes } from "node:crypto";
import { DEVICE_FLOW_SESSION_ORIGIN } from "@cockpit-chess/config/cli";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { APIError } from "better-auth/api";
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
function cliCredentialRevocationWrites(userId: string, revokeAllSessions = false) {
  return [
    lockCliCredentials(userId),
    prisma.apiKey.deleteMany({ where: { referenceId: userId } }),
    prisma.session.deleteMany({
      where: {
        OR: [
          revokeAllSessions ? { userId } : { userId, origin: DEVICE_FLOW_SESSION_ORIGIN },
          { impersonatedBy: userId },
        ],
      },
    }),
    prisma.deviceCode.deleteMany({ where: { userId } }),
  ] as const;
}

/**
 * Better Auth 1.7.18 two-factor rows: challenges and trusted devices carry
 * userId in value, but pending OTPs and attempt counters carry a code/count
 * and key off the challenge identifier. Snapshot those identifiers and delete
 * all related rows in one statement, inside the credential-lock transaction.
 * Completed challenges may leave orphan counters; they cannot authorize sign-in.
 */
function passwordResetTwoFactorRevocationWrite(userId: string) {
  return prisma.$executeRaw`
    WITH "resetChallenges" AS MATERIALIZED (
      SELECT "identifier" FROM "verification"
      WHERE "value" = ${userId} AND "identifier" LIKE '2fa-%'
    )
    DELETE FROM "verification"
    WHERE ("value" = ${userId} AND "identifier" LIKE 'trust-device-%')
       OR "identifier" IN (
         SELECT "identifier" FROM "resetChallenges"
         UNION ALL
         SELECT '2fa-otp-' || "identifier" FROM "resetChallenges"
         UNION ALL
         SELECT '2fa-attempts-' || "identifier" FROM "resetChallenges"
       )`;
}

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
  failureWarning = "the user’s API keys and CLI logins may still be live. Revoke them by hand.",
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
    `[auth] SECURITY: ${label} credential revocation failed after ${REVOCATION_ATTEMPTS} attempts; ${failureWarning}`,
    {
      userId,
      error: lastError instanceof Error ? lastError.constructor.name : "UnknownError",
    },
  );
  throw lastError;
}

/**
 * Pre-commit sweep: fail closed before Better-Auth can consume the reset token
 * or change the password. Mirror 1.7.18's body-or-query token and strict expiry
 * comparison; invalid tokens are left to the endpoint to reject.
 */
export async function revokeCredentialsBeforePasswordReset(ctx: {
  path?: string;
  body?: unknown;
  query?: unknown;
  context: {
    internalAdapter: {
      findVerificationValue: (id: string) => Promise<{ value: string; expiresAt: Date } | null>;
    };
  };
}): Promise<void> {
  if (ctx.path !== "/reset-password") return;
  const token = (isRecord(ctx.body) && ctx.body.token) || (isRecord(ctx.query) && ctx.query.token);
  if (typeof token !== "string" || !token) return;
  try {
    const verification = await ctx.context.internalAdapter.findVerificationValue(
      `reset-password:${token}`,
    );
    if (!verification || verification.expiresAt < new Date()) return;
    // Reset only: delete ALL sessions in the same transaction under the
    // credential lock, so none can authorize a mint in the gap before
    // Better-Auth deletes sessions. Over-revocation if the reset later fails
    // is safe: signing in again beats leaving an attacker's credential alive.
    await runRevocation(
      "password-reset pre-commit",
      verification.value,
      () => [
        ...cliCredentialRevocationWrites(verification.value, true),
        passwordResetTwoFactorRevocationWrite(verification.value),
      ],
      defaultSleep,
    );
  } catch {
    throw new APIError("SERVICE_UNAVAILABLE", {
      message:
        "We couldn't finish securing your account. Your password is unchanged — try the link again. Existing sign-ins and API keys may already have been revoked.",
    });
  }
}

/**
 * Post-commit defense in depth after the pre-sweep revoked all old sessions.
 * Invalidate every other reset/set-password link under upstream's credential-
 * setup lock, with independent retries even if revocation exhausts its retries.
 * Mailbox verification is decided per mailed token in the after-hook, including
 * a failed post-sweep.
 * Final revocation failure is logged and propagated after link cleanup.
 */
export async function revokeCredentialsAfterPasswordReset(
  userId: string,
  { sleep = defaultSleep }: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  let revocationFailure: { error: unknown } | undefined;
  try {
    await runRevocation(
      "password-reset",
      userId,
      () => [
        ...cliCredentialRevocationWrites(userId, true),
        passwordResetTwoFactorRevocationWrite(userId),
      ],
      sleep,
    );
  } catch (error) {
    revocationFailure = { error };
  }
  // Keep cleanup and its retry budget independent of the post-sweep. Rebuild
  // both the lock and deletion promises on every attempt.
  try {
    await runRevocation(
      "password-reset link cleanup",
      userId,
      () => [lockSetPasswordLinks(userId), deleteResetLinks(userId)],
      sleep,
      "other password-reset links may still be live. Invalidate them by hand.",
    );
  } catch (error) {
    // Cleanup logs its own exhaustion; never replace the original failure.
    if (!revocationFailure) throw error;
  }
  if (revocationFailure) throw revocationFailure.error;
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
      passwordResetTwoFactorRevocationWrite(userId),
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
