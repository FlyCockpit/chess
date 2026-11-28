import { AsyncLocalStorage } from "node:async_hooks";
import type { Locale } from "@cockpit-chess/config/locales";
import type { Prisma } from "@cockpit-chess/db";
import { APIError } from "better-auth/api";

type UserCreationMode = "admin-bootstrap" | "admin-invite";

// One grant per wrapped call. `created` is set by the user.create database
// hook once a user row really exists, so the sign-up after-hook can tell a
// real bootstrap from Better-Auth's duplicate answer without a lookup whose
// cost would differ by address (signup-response.ts). `locale` is the language
// the server chose for the new account (an admin invite picks the invitee's);
// the user.create hook seeds `User.locale` from it instead of the request.
type UserCreationAuthorizer = (tx: Prisma.TransactionClient) => Promise<void>;
type UserCreationGrant = {
  mode: UserCreationMode;
  created: boolean;
  locale?: Locale;
  authorize?: UserCreationAuthorizer;
};

const userCreationModeStorage = new AsyncLocalStorage<UserCreationGrant>();

// Single source of truth for the signup-disabled rejection message. The
// Better-Auth database hook throws it, the admin-invite error translation in
// packages/api matches on it — keep the wording stable.
export const SIGNUP_DISABLED_MESSAGE =
  "Sign-up is currently disabled. Contact an admin if you need access.";

// Pure signup-disabled decision: returns the rejection message when user
// creation is blocked, null when it is allowed. Takes its inputs as params
// (instead of reading env) so it is unit-testable without env mocking; the
// Better-Auth hook and the server signup gate both delegate to it.
export function getUserCreationBlockReason(opts: { signupEnabled: boolean }): string | null {
  if (!opts.signupEnabled && !getAllowedUserCreationMode()) {
    return SIGNUP_DISABLED_MESSAGE;
  }
  return null;
}

export function getAllowedUserCreationMode(): UserCreationMode | undefined {
  return userCreationModeStorage.getStore()?.mode;
}

export function runWithAllowedUserCreation<T>(
  mode: UserCreationMode,
  fn: () => T | Promise<T>,
  options: { locale?: Locale; authorize?: UserCreationAuthorizer } = {},
): T | Promise<T> {
  return userCreationModeStorage.run(
    { mode, created: false, locale: options.locale, authorize: options.authorize },
    fn,
  );
}

/** The raw admin-invite INSERT must authorize on its committing transaction. */
export async function authorizeAdminInvite(tx: Prisma.TransactionClient): Promise<void> {
  const grant = userCreationModeStorage.getStore();
  if (grant?.mode !== "admin-invite" || !grant.authorize)
    throw new APIError("FORBIDDEN", { code: "ADMIN_INVITE_AUTHORITY_REQUIRED" });
  await grant.authorize(tx);
}

/**
 * The locale the current grant chose for the account being created, if any.
 * Server-chosen (an admin invite's language field), so it beats the request's
 * locale header, which on a server-side `auth.api.createUser` call is absent.
 */
export function getGrantedUserLocale(): Locale | undefined {
  return userCreationModeStorage.getStore()?.locale;
}

export function markUserCreatedUnderGrant(): void {
  const grant = userCreationModeStorage.getStore();
  if (grant) grant.created = true;
}

export function wasUserCreatedUnderGrant(): boolean {
  return userCreationModeStorage.getStore()?.created === true;
}

/** Better-Auth's admin route that creates a user (`auth.api.createUser`). */
const ADMIN_CREATE_USER_PATH = "/admin/create-user";

/**
 * Better-Auth routes where an IdP signs the user in: the OAuth/OIDC callback
 * (`/callback/<providerId>`, the genericOAuth SSO provider) and an ID-token
 * sign-in (`/sign-in/social`). Their `emailVerified` is the IdP's
 * `email_verified` claim, which this app trusts (docs/auth-and-routing.md
 * § Admin invites).
 */
function isIdpSignInPath(path: string | undefined): boolean {
  return path === "/sign-in/social" || (path?.startsWith("/callback/") ?? false);
}

/**
 * Two rules for every user row Better-Auth creates
 * (`databaseHooks.user.create.before`):
 *
 * - `/admin/create-user` runs only under the `admin-invite` grant, that is
 *   only from `users.invite` (packages/api) on the server. Admins invite
 *   through that procedure, which never lets anyone choose the password or
 *   the verification state. An HTTP call to Better-Auth's own route (an admin
 *   session can reach `/api/auth/admin/*`) is refused, sign-up enabled or not.
 * - A new user is created verified only on an IdP sign-in. Everywhere else
 *   (sign-up forces `false` itself; an admin could pass
 *   `data: { emailVerified: true }`) the address is unproved until the link
 *   mailed to it is used.
 *
 * Server code that writes the user table through Prisma (the SETUP_KEY
 * first-admin claim, packages/api/src/lib/admin-bootstrap.ts) does not pass
 * through here; see docs/auth-and-routing.md § Admin invites.
 */
export function refuseUnprovedUserCreation(
  user: { emailVerified?: unknown },
  context: { path?: string } | null | undefined,
): void {
  const path = context?.path;
  if (path === ADMIN_CREATE_USER_PATH && getAllowedUserCreationMode() !== "admin-invite") {
    throw new APIError("FORBIDDEN", {
      message: "Invite users from the admin dashboard.",
      code: "ADMIN_CREATE_USER_UNSUPPORTED",
    });
  }
  if (user.emailVerified === true && !isIdpSignInPath(path)) {
    throw new APIError("BAD_REQUEST", {
      message: "An email address is verified only through the link mailed to it.",
      code: "EMAIL_VERIFICATION_BY_MAIL_ONLY",
    });
  }
}
