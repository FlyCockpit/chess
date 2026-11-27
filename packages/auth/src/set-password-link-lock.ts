import prisma, { type Prisma } from "@cockpit-chess/db";

/**
 * The per-user lock that serializes minting an admin-invite set-password link
 * (packages/api/src/lib/set-password-link.ts) with finishing a password reset
 * (credential-revocation.ts).
 *
 * A resend decides "this is still a pending invite" and then writes a fresh
 * 7-day `reset-password:` link. If the invitee finishes their reset between
 * those steps, the new link would be a working reset credential for an
 * account that is already set up (and, with no mailer, it is shown to the
 * admin). So the mint re-checks eligibility under this lock, and the reset's
 * revocation takes the same lock, marks the email verified and deletes every
 * remaining reset link. Whichever goes second sees the other: the mint finds
 * a verified account and refuses, or the revocation deletes the new link.
 */
export function setPasswordLinkLockKey(userId: string): string {
  return `set-password-link:${userId}`;
}

/** Better-Auth's verification identifier prefix for password-reset tokens. */
export const RESET_PASSWORD_IDENTIFIER_PREFIX = "reset-password:";

/** The lock statement for a batch `prisma.$transaction`. */
export function lockSetPasswordLinks(userId: string): Prisma.PrismaPromise<unknown> {
  return prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${setPasswordLinkLockKey(userId)}))`;
}
