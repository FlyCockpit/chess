import { BASE_ERROR_CODES } from "better-auth";
import { APIError, isAPIError } from "better-auth/api";
import { wasUserCreatedUnderGrant } from "./user-creation-policy.js";

export const SIGN_UP_EMAIL_PATH = "/sign-up/email";

// The one body `/sign-up/email` ever answers with on success. No client reads
// the success body (the web and native forms read only `error`, and with
// `requireEmailVerification` there is never a session to hand back).
const NEUTRAL_SIGN_UP_RESPONSE = { token: null, user: null } as const;

type SignUpAfterHookContext = {
  context: { returned?: unknown };
  json: (body: typeof NEUTRAL_SIGN_UP_RESPONSE) => unknown;
};

/**
 * After-hook for `/sign-up/email` that makes the response independent of
 * whether the address already has an account.
 *
 * With `requireEmailVerification`, Better-Auth answers a sign-up for a
 * registered address with a synthetic "pretend it worked" user. That user is
 * built without plugin defaults (the admin plugin's `role` is null instead of
 * "user"), so its body tells a registered address from a free one. Any future
 * plugin field would reopen that, so we replace every success body with one
 * fixed shape instead of patching the synthetic user.
 *
 * Better-Auth also returns that synthetic 200 *before* `createUser`, so when
 * sign-up is disabled the database hook's rejection (422
 * FAILED_TO_CREATE_USER) only ever reaches free addresses. While sign-up is
 * disabled a 200 therefore stands only if it really created the user (the
 * `ADMIN_EMAILS` bootstrap of a new address); every duplicate gets the same
 * 422, admin-listed or not, so a registered address reveals neither that it
 * is registered nor that it is on the admin list. "Really created" is the flag
 * the user.create database hook sets on the request's creation grant: no
 * database lookup here, so a duplicate costs no extra round trip that a free
 * address does not.
 *
 * Error responses are left alone: they are already address-independent.
 */
export async function neutralizeSignUpResponse(
  ctx: SignUpAfterHookContext,
  opts: { signupEnabled: boolean },
) {
  const { returned } = ctx.context;
  if (isAPIError(returned)) return;
  if (!opts.signupEnabled && !wasUserCreatedUnderGrant()) {
    throw APIError.from("UNPROCESSABLE_ENTITY", BASE_ERROR_CODES.FAILED_TO_CREATE_USER);
  }
  return ctx.json(NEUTRAL_SIGN_UP_RESPONSE);
}
