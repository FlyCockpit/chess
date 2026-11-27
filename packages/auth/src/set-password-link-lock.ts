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
 * revocation takes the same lock and deletes every remaining reset link.
 * Whichever goes second sees the other: the mint finds an account that is no
 * longer a pending invite and refuses, or the revocation deletes the new link.
 *
 * The same lock covers the other writers and readers of a user's reset links
 * (password-reset-links.ts): recording a link as mailed, the redemption
 * check, the mailed link's email verification, and the tidy-up when an
 * account becomes active (account-activation.ts).
 */
export function setPasswordLinkLockKey(userId: string): string {
  return `set-password-link:${userId}`;
}

/** Better-Auth's verification identifier prefix for password-reset tokens. */
export const RESET_PASSWORD_IDENTIFIER_PREFIX = "reset-password:";

/**
 * The lock statement: for a batch `prisma.$transaction` (the default client),
 * or inside an interactive transaction (pass its `tx`). A transaction that
 * takes it runs in a lock slot (lock-slots.ts).
 */
export function lockSetPasswordLinks(
  userId: string,
  db: Pick<Prisma.TransactionClient, "$executeRaw"> = prisma,
): Prisma.PrismaPromise<number> {
  return db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${setPasswordLinkLockKey(userId)}))`;
}

/** Every reset link of the user, spent or not. Run under {@link lockSetPasswordLinks}. */
export function deleteResetLinks(
  userId: string,
  db: Pick<Prisma.TransactionClient, "verification"> = prisma,
) {
  return db.verification.deleteMany({
    where: { value: userId, identifier: { startsWith: RESET_PASSWORD_IDENTIFIER_PREFIX } },
  });
}
