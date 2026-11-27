import { randomBytes } from "node:crypto";
import { auth } from "@cockpit-chess/auth";
import { isUserBanned } from "@cockpit-chess/auth/ban";
import {
  RESET_PASSWORD_IDENTIFIER_PREFIX,
  setPasswordLinkLockKey,
} from "@cockpit-chess/auth/set-password-link-lock";
import { DEFAULT_LOCALE, isSupportedLocale } from "@cockpit-chess/config/locales";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/server";

/**
 * How long an admin-invite set-password link stays valid. Longer than a
 * forgot-password link (Better-Auth's 1-hour default, unchanged): an invite
 * often sits in an inbox over a weekend. Single-use either way, and re-sending
 * the invite kills the previous link.
 */
export const INVITE_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
export const INVITE_LINK_TTL_DAYS = INVITE_LINK_TTL_SECONDS / (24 * 60 * 60);

/** Better-Auth's id for an email/password account (`Account.providerId`). */
const CREDENTIAL_PROVIDER_ID = "credential";

/**
 * What decides whether a user is still an unfinished invite. Bounded: two
 * account rows are enough to tell "exactly one" from "more", and one live
 * session is enough to tell "never signed in" from "signed in".
 */
export function inviteStateSelect(now: Date) {
  return {
    emailVerified: true,
    accounts: { select: { providerId: true }, take: 2 },
    sessions: { where: { expiresAt: { gt: now } }, select: { id: true }, take: 1 },
  } satisfies Prisma.UserSelect;
}

/**
 * Pending invite = an account nobody has started using: email not verified,
 * exactly one Account row and it is the email/password ("credential") one, and
 * no live session.
 *
 * `emailVerified === false` alone is NOT enough. Better-Auth's genericOAuth
 * copies the IdP's `email_verified ?? false`, so an active SSO user can be
 * unverified; minting a set-password link for them would let whoever holds it
 * add a password next to the SSO identity — an account takeover that also
 * skips the IdP's MFA. The non-credential account rule covers that, and the
 * live-session rule covers an account in use by any other route.
 */
export function isInvitePending(row: {
  emailVerified: boolean;
  accounts: { providerId: string }[];
  sessions: { id: string }[];
}): boolean {
  return (
    !row.emailVerified &&
    row.accounts.length === 1 &&
    row.accounts[0]?.providerId === CREDENTIAL_PROVIDER_ID &&
    row.sessions.length === 0
  );
}

/**
 * Why no link was minted, decided under the per-user lock:
 *
 * - `missing`: the user no longer exists;
 * - `not-pending` (checked first): the account is already set up or used —
 *   verified, signed in, or linked to another provider. In particular a user
 *   who signs in through SSO never gets one: a set-password link would let
 *   whoever holds it add a password next to that identity, a second way in
 *   that skips the IdP and its MFA;
 * - `archived`: a pending invite whose user is banned (archived).
 */
export type SetPasswordLinkRefusal = "missing" | "archived" | "not-pending";

export class SetPasswordLinkRefusedError extends Error {
  readonly reason: SetPasswordLinkRefusal;
  constructor(reason: SetPasswordLinkRefusal) {
    super(`No set-password link was created (${reason}).`);
    this.name = "SetPasswordLinkRefusedError";
    this.reason = reason;
  }
}

/**
 * Mint a one-time "set your password" link for an admin-invited user.
 *
 * This is Better-Auth's own password-reset machinery with a longer expiry: the
 * token is a `reset-password:<token>` verification row (exactly what
 * `requestPasswordReset` writes), so the emailed link goes through Better-Auth's
 * `GET /api/auth/reset-password/:token` validation and redirect, and the web
 * `/$lang/reset-password` page spends it with `authClient.resetPassword`. That
 * keeps every reset-side guarantee — single use, session revocation, the
 * `onPasswordReset` credential revocation and email verification — with no
 * second password-setting path.
 *
 * Minting directly (instead of calling `auth.api.requestPasswordReset`) is what
 * lets the invite pick its own expiry and email template without changing
 * forgot-password.
 *
 * Eligibility is decided inside the minting transaction, under the per-user
 * lock (`setPasswordLinkLockKey`) that a finishing password reset also takes
 * (packages/auth/src/credential-revocation.ts): the user must exist, not be
 * archived, and still be a pending invite ({@link isInvitePending}). A
 * caller's own earlier check is only a fast path; this one is race-free,
 * because the reset either verified the account before this check, or
 * deletes the link minted here right after.
 *
 * Every earlier unused reset link for the user is deleted in the same
 * transaction that writes the new one, under a per-user advisory lock, so a
 * re-sent invite invalidates the one before it and two concurrent resends can
 * never leave two working links: the second waits for the first to commit,
 * then deletes its row.
 *
 * The row is written directly in Better-Auth 1.7's format — what
 * `requestPasswordReset` stores through `internalAdapter.createVerificationValue`:
 * `identifier: "reset-password:<token>"`, `value: <userId>`, `expiresAt` — because
 * the internal adapter cannot join a Prisma transaction. That format holds only
 * while the identifier is stored in plain text and verification rows live in
 * Postgres (no `verification.storeIdentifier`, no `secondaryStorage`); both are
 * checked here so a config change fails loudly instead of minting dead links.
 *
 * Refuses with `SetPasswordLinkRefusedError`; see its reasons.
 */
export async function createSetPasswordLink({
  userId,
  locale,
  now = new Date(),
}: {
  userId: string;
  locale: unknown;
  now?: Date;
}): Promise<{ url: string; expiresAt: Date }> {
  const authContext = await auth.$context;
  // Widened on purpose: today's config sets neither key, so the inferred
  // options type has no such properties; this keeps the runtime guard for the
  // day someone adds one.
  const options: Record<string, unknown> = { ...authContext.options };
  const verification = options.verification;
  const transformsIdentifier =
    typeof verification === "object" &&
    verification !== null &&
    "storeIdentifier" in verification &&
    verification.storeIdentifier !== undefined;
  if (transformsIdentifier || options.secondaryStorage !== undefined) {
    throw new Error(
      "createSetPasswordLink writes plain-identifier verification rows to Postgres; update it for the new Better-Auth verification storage config.",
    );
  }

  // 32 random bytes, URL-safe: the token rides in a URL path segment.
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITE_LINK_TTL_SECONDS * 1000);
  const lockKey = setPasswordLinkLockKey(userId);
  await prisma.$transaction(async (tx) => {
    // Serializes link minting per user, and with a finishing reset, until
    // this transaction ends.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const target = await tx.user.findUnique({
      where: { id: userId },
      select: { banned: true, banExpires: true, ...inviteStateSelect(now) },
    });
    if (!target) throw new SetPasswordLinkRefusedError("missing");
    if (!isInvitePending(target)) throw new SetPasswordLinkRefusedError("not-pending");
    if (isUserBanned(target)) throw new SetPasswordLinkRefusedError("archived");
    await tx.verification.deleteMany({
      where: { value: userId, identifier: { startsWith: RESET_PASSWORD_IDENTIFIER_PREFIX } },
    });
    await tx.verification.create({
      data: {
        identifier: `${RESET_PASSWORD_IDENTIFIER_PREFIX}${token}`,
        value: userId,
        expiresAt,
      },
      select: { id: true },
    });
  });

  const callbackURL = inviteCallbackUrl(locale);
  const url = `${authContext.baseURL}/reset-password/${token}?callbackURL=${encodeURIComponent(callbackURL)}`;
  return { url, expiresAt };
}

/**
 * Where Better-Auth redirects after validating the token: the web app's
 * reset-password page in the invitee's locale, flagged as an invite so it
 * shows "set your password" copy. Absolute against the web origin, so a
 * split-origin deploy (`CORS_ORIGIN` set) lands on the app, not the API host;
 * both origins are in `trustedOrigins`, which Better-Auth's origin check
 * enforces on this value.
 */
export function inviteCallbackUrl(locale: unknown): string {
  const tag = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const webOrigin = env.CORS_ORIGIN ?? env.BETTER_AUTH_URL;
  return new URL(`/${tag}/reset-password?invite=1`, webOrigin).toString();
}
