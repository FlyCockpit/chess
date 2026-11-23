import { createHash, randomBytes } from "node:crypto";
import { auth } from "@cockpit-chess/auth";
import { DEFAULT_LOCALE } from "@cockpit-chess/config/locales";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/server";

import { adminUserExists } from "./admin-presence";

/**
 * First-admin bootstrap for `SETUP_KEY`: `bootstrapFirstAdmin` (called by
 * apps/server/src/setup-routes.ts) hands out a one-time setup link;
 * `claimFirstAdmin` (the public `setup.claimFirstAdmin` procedure, spent from
 * the web reset-password page) creates the first admin with its password.
 *
 * "Admin" means what `isAdminRole` (packages/auth/src/roles.ts) means; the SQL
 * mirrors it in `adminUserExists` (./admin-presence.ts).
 *
 * The rule the whole design rests on: no user row exists until the link is
 * spent. Issuing a link writes only a `setup-admin:<sha256(token)>`
 * verification row whose value is the address; the claim then creates the
 * admin user and its credential account in one transaction. So nothing
 * Better-Auth does (a reset, an SSO link or unlink, the admin plugin) can race
 * the bootstrap: all of those need a user row, and there is none until the
 * claim commits it together with its account. Once any admin exists the key is
 * closed for good, whatever later happens to that admin's accounts.
 *
 * The link is not a Better-Auth reset token and only its hash is stored, so no
 * Better-Auth endpoint can read or spend it. There is one live link at a time:
 * issuing a new one (for any address) replaces it.
 *
 * Concurrency. Issuing and claiming both take the bootstrap advisory lock and
 * re-check "no admin exists" under it, so two claims, or a claim and a
 * re-issue, never interleave. A sign-up racing a claim for the same address
 * is settled by the unique email: the claim then rolls back as invalid and
 * never promotes that account. A claim is one transaction (token check, user,
 * account, link deletion), so a timeout or crash leaves nothing half done.
 * Accepted: an `ADMIN_EMAILS` sign-up committing during a claim may leave two
 * admins; the operator authorized both.
 */

/** Serializes bootstrap calls so two can never both create an admin. */
const BOOTSTRAP_LOCK_KEY = "setup-key:first-admin";

/** Verification-row prefix of a setup link: `setup-admin:<sha256(token)>`. */
export const SETUP_TOKEN_PREFIX = "setup-admin:";

/** Better-Auth's id for an email/password account (`Account.providerId`). */
const CREDENTIAL_PROVIDER_ID = "credential";

/**
 * The outcome of a bootstrap call. Only `ready` hands out a link.
 *
 * - `admin_exists`: an admin exists. The bootstrap is over.
 * - `email_taken`: an account already uses the address. The bootstrap never
 *   promotes an existing account — whoever created it may hold its password,
 *   sessions, API keys or second factor.
 * - `ready`: `url` is a fresh one-time setup link for `email`; every earlier
 *   link stops working.
 */
export type AdminBootstrapResult =
  | { kind: "admin_exists" }
  | { kind: "email_taken" }
  | { kind: "ready"; url: string; expiresAt: Date };

/** The display name a bootstrap admin starts with: the address's local part. */
export function bootstrapAdminName(email: string): string {
  const local = email.split("@")[0]?.trim() ?? "";
  return (local || "Admin").slice(0, 100);
}

/** The stored identifier for a raw setup token: only its hash is kept. */
export function setupTokenIdentifier(token: string): string {
  return `${SETUP_TOKEN_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

/**
 * The setup link: the web app's reset-password page in setup mode. Absolute
 * against the web origin, so a split-origin deploy (`CORS_ORIGIN` set) lands on
 * the app, not the API host. The token rides in the query string, as Better-
 * Auth's own reset links put it once they redirect to that page.
 */
export function setupLinkUrl(token: string): string {
  const url = new URL(`/${DEFAULT_LOCALE}/reset-password`, env.CORS_ORIGIN ?? env.BETTER_AUTH_URL);
  url.searchParams.set("setup", "1");
  url.searchParams.set("token", token);
  return url.toString();
}

type Tx = Prisma.TransactionClient;

async function takeBootstrapLock(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BOOTSTRAP_LOCK_KEY}))`;
}

async function emailTaken(tx: Tx, email: string): Promise<boolean> {
  return (await tx.user.findUnique({ where: { email }, select: { id: true } })) !== null;
}

function deleteSetupLinks(tx: Tx) {
  return tx.verification.deleteMany({ where: { identifier: { startsWith: SETUP_TOKEN_PREFIX } } });
}

/**
 * Hand out a one-time setup link for `email`, replacing any earlier link.
 * `email` must already be normalized (trimmed, lowercased, validated) by the
 * caller. Writes no user: the admin is created when the link is spent.
 */
export async function bootstrapFirstAdmin(
  email: string,
  { ttlSeconds, now = new Date() }: { ttlSeconds: number; now?: Date },
): Promise<AdminBootstrapResult> {
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  // 32 random bytes, URL-safe: the token rides in a URL.
  const token = randomBytes(32).toString("base64url");
  const outcome = await prisma.$transaction(async (tx) => {
    await takeBootstrapLock(tx);
    if (await adminUserExists(tx)) return "admin_exists" as const;
    if (await emailTaken(tx, email)) return "email_taken" as const;
    await deleteSetupLinks(tx);
    await tx.verification.create({
      data: { identifier: setupTokenIdentifier(token), value: email, expiresAt },
      select: { id: true },
    });
    return "issued" as const;
  });
  if (outcome !== "issued") return { kind: outcome };
  return { kind: "ready", url: setupLinkUrl(token), expiresAt };
}

export type ClaimFirstAdminResult =
  | { kind: "claimed"; userId: string }
  | { kind: "invalid_token" }
  | { kind: "password_too_short" | "password_too_long" };

/**
 * Spend a setup link: create the first admin (email verified) with its
 * password. Refused (`invalid_token`) for an unknown, expired or replaced
 * link, once any admin exists, and when the address has been taken since the
 * link was issued.
 *
 * The password is checked against Better-Auth's length policy and hashed with
 * Better-Auth's own hasher, then written as the credential account Better-Auth
 * itself would create (`accountId` = user id), so sign-in, password change and
 * forgot-password all work on it as on any other account. The token is looked
 * up before hashing, so a caller without a live link cannot make the server
 * hash anything. Expiry is checked again with a fresh clock once the lock is
 * held.
 */
export async function claimFirstAdmin({
  token,
  newPassword,
  clock = () => new Date(),
}: {
  token: string;
  newPassword: string;
  clock?: () => Date;
}): Promise<ClaimFirstAdminResult> {
  const identifier = setupTokenIdentifier(token);
  const live = await prisma.verification.findFirst({
    where: { identifier, expiresAt: { gt: clock() } },
    select: { id: true },
  });
  if (!live) return { kind: "invalid_token" };

  const authContext = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = authContext.password.config;
  if (newPassword.length < minPasswordLength) return { kind: "password_too_short" };
  if (newPassword.length > maxPasswordLength) return { kind: "password_too_long" };
  // Hashed before the transaction: the slow step never holds the lock.
  const passwordHash = await authContext.password.hash(newPassword);

  try {
    return await prisma.$transaction(async (tx): Promise<ClaimFirstAdminResult> => {
      await takeBootstrapLock(tx);
      const link = await tx.verification.findFirst({
        where: { identifier, expiresAt: { gt: clock() } },
        select: { value: true },
      });
      if (!link) return { kind: "invalid_token" };
      const email = link.value;
      if ((await adminUserExists(tx)) || (await emailTaken(tx, email))) {
        return { kind: "invalid_token" };
      }
      const user = await tx.user.create({
        data: { email, name: bootstrapAdminName(email), emailVerified: true, role: "admin" },
        select: { id: true },
      });
      await tx.account.create({
        data: {
          userId: user.id,
          providerId: CREDENTIAL_PROVIDER_ID,
          accountId: user.id,
          password: passwordHash,
        },
        select: { id: true },
      });
      await deleteSetupLinks(tx);
      return { kind: "claimed", userId: user.id };
    });
  } catch (err) {
    // A sign-up for the same address committed after the check above.
    if (isUniqueViolation(err)) return { kind: "invalid_token" };
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}
