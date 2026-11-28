import { isAccountDeletionPending } from "@cockpit-chess/auth/account-state";
import { isUserBanned } from "@cockpit-chess/auth/ban";
import { isAdminRole } from "@cockpit-chess/auth/roles";
import { ORPCError, os } from "@orpc/server";

import type { Context, CredentialKind } from "./context";
import { isTwoFactorPolicySatisfied } from "./lib/two-factor-policy";

export {
  invalidateForceTwoFactorSettingsCache,
  isForcedTwoFactorEnabledForRole,
  isTwoFactorPolicySatisfied,
} from "./lib/two-factor-policy";

const o = os.$context<Context>();

export type AdminAuthorityFailure =
  | "unauthenticated"
  | "banned"
  | "api-key"
  | "unverified"
  | "not-admin"
  | "two-factor";

/**
 * The admin authority rule, defined once: a signed-in user who is not banned,
 * not using an API key (a long-lived bearer that never went through sign-in or
 * 2FA), with a verified email, an admin role and the forced second factor.
 * `requireAdmin`, `requireAdminOr404` and the server's cookie-only
 * `requireVerifiedAdminSession` (apps/server/src/admin-session-gate.ts) all
 * call this and only map the failure to their own response.
 */
type AdminAuthoritySession = {
  user: Pick<
    NonNullable<Context["session"]>["user"],
    | "id"
    | "role"
    | "emailVerified"
    | "twoFactorEnabled"
    | "createdAt"
    | "banned"
    | "banExpires"
    | "deletionRequestedAt"
  >;
};

export async function checkAdminAuthority<S extends AdminAuthoritySession>(
  session: S | null | undefined,
  credential?: CredentialKind,
  policyDb?: Parameters<typeof isTwoFactorPolicySatisfied>[1],
): Promise<{ ok: true; session: S } | { ok: false; reason: AdminAuthorityFailure }> {
  if (!session?.user) return { ok: false, reason: "unauthenticated" };
  if (isUserBanned(session.user) || isAccountDeletionPending(session.user))
    return { ok: false, reason: "banned" };
  if (credential === "api-key") return { ok: false, reason: "api-key" };
  if (!session.user.emailVerified) return { ok: false, reason: "unverified" };
  if (!isAdminRole(session.user.role)) return { ok: false, reason: "not-admin" };
  if (!(await isTwoFactorPolicySatisfied(session.user, policyDb)))
    return { ok: false, reason: "two-factor" };
  return { ok: true, session };
}

export const publicProcedure = o;

const requireAuth = o.middleware(async ({ context, next }) => {
  if (
    !context.session?.user ||
    isUserBanned(context.session.user) ||
    isAccountDeletionPending(context.session.user)
  ) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return next({
    context: {
      session: context.session,
    },
  });
});

export const authenticatedProcedure = publicProcedure.use(requireAuth);

const requireRequiredTwoFactor = o.middleware(async ({ context, next }) => {
  if (!context.session?.user) {
    throw new ORPCError("UNAUTHORIZED");
  }
  if (!(await isTwoFactorPolicySatisfied(context.session.user))) {
    throw new ORPCError("FORBIDDEN", {
      message: "Two-factor authentication setup is required.",
    });
  }
  return next({
    context: {
      session: context.session,
    },
  });
});

export const protectedProcedure = authenticatedProcedure.use(requireRequiredTwoFactor);

const ADMIN_FORBIDDEN: Record<
  Exclude<AdminAuthorityFailure, "unauthenticated" | "banned">,
  string
> = {
  // packages/api/src/routers/cli.ts: admin procedures need a real session
  // (cookie or a device-flow token approved from a signed-in browser).
  "api-key": "API keys cannot be used for admin access.",
  unverified: "Email verification required for admin access.",
  "not-admin": "Admin access required.",
  "two-factor": "Two-factor authentication setup is required.",
};

const requireAdmin = o.middleware(async ({ context, next }) => {
  // `requireAuth` is always chained before this middleware; the rule repeats
  // the session check anyway (checkAdminAuthority).
  const authority = await checkAdminAuthority(context.session, context.credential);
  if (!authority.ok) {
    if (authority.reason === "unauthenticated" || authority.reason === "banned")
      throw new ORPCError("UNAUTHORIZED");
    throw new ORPCError("FORBIDDEN", { message: ADMIN_FORBIDDEN[authority.reason] });
  }
  return next({
    context: {
      session: authority.session,
    },
  });
});

export const adminProcedure = publicProcedure.use(requireAuth).use(requireAdmin);

// `adminOr404Procedure` mirrors the role check in `requireAdmin` but throws
// NOT_FOUND for every failure mode (missing session, unverified email,
// non-admin role, active ban). Mount it on procedures that back a 404-hidden surface
// (e.g. the /admin route group) so existence of the endpoint is not leaked
// to non-admins.
const requireAdminOr404 = o.middleware(async ({ context, next }) => {
  const authority = await checkAdminAuthority(context.session, context.credential);
  if (!authority.ok) throw new ORPCError("NOT_FOUND", { message: "Not found" });
  return next({
    context: {
      session: authority.session,
    },
  });
});

export const adminOr404Procedure = publicProcedure.use(requireAdminOr404);

// `hostedPlayerProcedure` gates paid hosted work any signed-in user may start
// (chess.create, billed to their own OpenRouter key or, for admins, the
// operator's): a real session (no API key), a verified email and the forced
// second factor where the policy asks for one. Whether the user may bill this
// match (feature flag, connected key, admin-only operator billing, quotas) is
// the handler's to decide, so its errors can say what to do next.
const requireHostedPlayer = o.middleware(async ({ context, next }) => {
  const user = context.session?.user;
  if (!user || isUserBanned(user) || isAccountDeletionPending(user))
    throw new ORPCError("UNAUTHORIZED");
  if (context.credential === "api-key")
    throw new ORPCError("FORBIDDEN", { message: "API keys cannot start hosted matches." });
  if (!user.emailVerified)
    throw new ORPCError("FORBIDDEN", {
      message: "Email verification required.",
      data: { reason: "unverified" },
    });
  if (!(await isTwoFactorPolicySatisfied(user)))
    throw new ORPCError("FORBIDDEN", { message: "Two-factor authentication setup is required." });
  return next({
    context: {
      session: context.session as NonNullable<Context["session"]>,
    },
  });
});

export const hostedPlayerProcedure = publicProcedure.use(requireHostedPlayer);

// -- authorization registry --------------------------------------------------
//
// `pnpm policy:access-matrix` reads these two objects statically (it parses
// this file; it never imports it) and FAILS on any router procedure whose
// chain starts at a builder, or passes `.use()` a middleware, that is not
// listed here. That is deliberate: an authorization check that exists only
// inline in one router is invisible to the gate and to the next agent, and
// two hand-written copies of the same check drift. So the rule for auth is
// "register at two, not extract at three" — the second router that needs a
// role check gets an entry here (and a builder above), not a local helper.
// See packages/api/src/index.ts
//
// The level is the *minimum* a caller must hold to get past the gate. The
// access matrix in docs/access-matrix.md is checked against it.

export type ProcedureAccessLevel = "public" | "authenticated" | "admin";

/** Builders a router procedure chain may start from. Keep in sync with the exports above. */
export const procedureAccessLevels = {
  publicProcedure: "public",
  authenticatedProcedure: "authenticated",
  protectedProcedure: "authenticated",
  adminProcedure: "admin",
  adminOr404Procedure: "admin",
  hostedPlayerProcedure: "authenticated",
} as const satisfies Record<string, ProcedureAccessLevel>;

/** Middleware a router procedure may pass to `.use()`. Custom role helpers register here. */
export const middlewareAccessLevels = {
  requireAuth: "authenticated",
  requireRequiredTwoFactor: "authenticated",
  requireAdmin: "admin",
  requireAdminOr404: "admin",
  requireHostedPlayer: "authenticated",
} as const satisfies Record<string, ProcedureAccessLevel>;
