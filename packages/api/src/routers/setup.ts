import { env, FORCE_SSO } from "@cockpit-chess/env/server";
import { ORPCError, type } from "@orpc/server";
import { z } from "zod";

import { publicProcedure } from "../index";
import { type ClaimFirstAdminResult, claimFirstAdmin } from "../lib/admin-bootstrap";
import { createProcedureBudget } from "../lib/procedure-budget";

/** Error code the web reset-password page treats as "this link is dead". */
const SETUP_LINK_INVALID = "SETUP_LINK_INVALID";

/** `[audit]` event name for claim attempts (the issuing route logs `setup.first_admin`). */
const SETUP_CLAIM_AUDIT_EVENT = "setup.first_admin_claim";

/**
 * Per-IP claim budget, charged before the token lookup and the password hash:
 * the hash is the expensive step, and one batched `/rpc` request can carry
 * many calls. Ten attempts per 15 minutes covers an owner fumbling the
 * password policy; fail-closed, like the issuing route's `setupLimiter`.
 */
const consumeClaimBudget = createProcedureBudget({
  keyPrefix: "rl:setup-claim",
  points: 10,
  durationSeconds: 15 * 60,
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `Too many attempts. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage: "Setup is temporarily unavailable. Please try again in a moment.",
  unavailableLog: "[setup] claim limiter unavailable, failing closed:",
});

type ClaimAuditOutcome =
  | ClaimFirstAdminResult["kind"]
  | "rate_limited"
  | "invalid_request"
  | "password_signin_disabled"
  | "error";

// Validated in the handler, after the 404 gate, the budget and the audit, so
// a malformed call is a 404 while SETUP_KEY is unset and an audited attempt
// otherwise. Better-Auth's length policy is enforced in claimFirstAdmin; this
// only bounds the request.
const claimInput = z.object({
  token: z.string().min(1).max(256),
  newPassword: z.string().max(1024),
});

/** One secret-free line per attempt: never the token or the password. */
function auditClaim(outcome: ClaimAuditOutcome, ip: string, userId?: string) {
  console.info(
    `[audit] ${JSON.stringify({ event: SETUP_CLAIM_AUDIT_EVENT, outcome, ip, ...(userId ? { userId } : {}) })}`,
  );
}

export const setupRouter = {
  /**
   * Spend a SETUP_KEY setup link (printed by `pnpm deploy:generate-admin`):
   * create the first admin with its password. Public on purpose — the link's
   * token is the credential, exactly like a password-reset link — and it only
   * ever works while no admin exists (lib/admin-bootstrap.ts). Like the
   * bootstrap route, it does not exist while SETUP_KEY is unset, so removing
   * the key also kills any unspent link.
   */
  claimFirstAdmin: publicProcedure
    .input(type<z.input<typeof claimInput>>())
    .handler(async ({ input: rawInput, context }) => {
      if (!env.SETUP_KEY) throw new ORPCError("NOT_FOUND");
      const ip = context.clientIp ?? "unknown";
      try {
        await consumeClaimBudget(ip);
      } catch (err) {
        auditClaim("rate_limited", ip);
        throw err;
      }
      // Like the issuing route: under FORCE_SSO a password-only admin could
      // never sign in, so the link is refused and left unspent.
      if (FORCE_SSO) {
        auditClaim("password_signin_disabled", ip);
        throw new ORPCError("CONFLICT", {
          message: "Password sign-in is disabled (FORCE_SSO), so this setup link cannot be used.",
        });
      }
      const parsed = claimInput.safeParse(rawInput);
      if (!parsed.success) {
        auditClaim("invalid_request", ip);
        throw new ORPCError("BAD_REQUEST", { message: "Invalid input." });
      }

      let result: ClaimFirstAdminResult;
      try {
        result = await claimFirstAdmin(parsed.data);
      } catch (err) {
        auditClaim("error", ip);
        throw err;
      }
      auditClaim(result.kind, ip, result.kind === "claimed" ? result.userId : undefined);

      if (result.kind === "invalid_token") {
        throw new ORPCError(SETUP_LINK_INVALID, {
          status: 400,
          message: "This setup link has expired, was replaced, or was already used.",
        });
      }
      if (result.kind !== "claimed") {
        throw new ORPCError("BAD_REQUEST", {
          message:
            result.kind === "password_too_short"
              ? "Password is too short."
              : "Password is too long.",
        });
      }
      return { success: true as const };
    }),
};
