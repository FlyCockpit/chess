import { apiKey } from "@better-auth/api-key";
import { API_KEY_PREFIX, CLI_CLIENT_ID } from "@cockpit-chess/config/cli";
import prisma from "@cockpit-chess/db";
import {
  ADMIN_EMAILS,
  env,
  FORCE_SSO,
  SIGNUP_ENABLED,
  SSO_ENABLED,
} from "@cockpit-chess/env/server";
import {
  isEmailConfigured,
  renderResetPassword,
  renderTwoFactorOtp,
  renderVerifyEmail,
  sendEmail,
} from "@cockpit-chess/mailer";
import { BASE_ERROR_CODES, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSession } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { admin, genericOAuth, twoFactor } from "better-auth/plugins";
import {
  afterAccountCreate,
  afterUserUpdate,
  noteVerificationWrite,
} from "./account-activation.js";
import {
  passwordChangeRevocationTarget,
  revokeCredentialsAfterPasswordChange,
  revokeCredentialsAfterPasswordReset,
  revokeCredentialsBeforePasswordReset,
} from "./credential-revocation.js";
import { createCredentialSetupAdapter } from "./credential-setup-adapter.js";
import {
  assertDeviceRedemptionLocked,
  lockedDeviceAuthorization,
  removeDeviceSessionIfUnlocked,
} from "./device-redemption-lock.js";
import { deviceFlowSessionData } from "./device-session-origin.js";
import { refuseEmailChange } from "./email-change-policy.js";
import { createPasswordPepper } from "./password-pepper.js";
import {
  isResetLinkRedeemable,
  recordResetLinkMailed,
  resetTokenOf,
} from "./password-reset-links.js";
import {
  fencePasswordSessionAfter,
  fencePasswordSessionBefore,
  recordTwoFactorChallenge,
} from "./password-sign-in-fence.js";
import {
  confirmPasswordWriteLocked,
  guardPasswordAccountCreate,
  guardPasswordAccountUpdate,
} from "./password-write-lock.js";
import { resolveSignupLocale } from "./signup-locale.js";
import { neutralizeSignUpResponse, SIGN_UP_EMAIL_PATH } from "./signup-response.js";
import { TWO_FACTOR_ALLOW_PASSWORDLESS_ENROLLMENT } from "./two-factor-policy.js";
import {
  getAllowedUserCreationMode,
  getGrantedUserLocale,
  getUserCreationBlockReason,
  markUserCreatedUnderGrant,
  refuseUnprovedUserCreation,
} from "./user-creation-policy.js";
import { withVerificationCallback } from "./verification-callback.js";

const ssoEnabled = SSO_ENABLED;
const forceSso = FORCE_SSO;
const isCrossOrigin = !!env.CORS_ORIGIN;
// The web app's origin: CORS_ORIGIN when the SPA is served from a different
// host than this API, else the API origin itself (single-origin deploys).
const webOrigin = env.CORS_ORIGIN ?? env.BETTER_AUTH_URL;

// Better-Auth emits "user input failed validation" cases (wrong password, unknown
// email, unverified email, etc.) at level=error. Those are normal end-user mistakes,
// not server faults — downgrade them to warn so production error dashboards stay
// signal-y. Anything we don't recognize keeps its original level.
const USER_INPUT_ERROR_PATTERN =
  /invalid (password|email|credentials|token|otp|two[- ]?factor)|user not found|email not verified|password is incorrect|account not found|failed to verify|already exists|too many (requests|attempts)/i;

export const passwordPepper = createPasswordPepper({
  secret: env.BETTER_AUTH_SECRET,
  previousSecret: env.BETTER_AUTH_SECRET_PREVIOUS,
});

export const auth = betterAuth({
  // Global adapter transactions remain off for signup locale visibility and SMTP.
  // Only reset consumption/password commit is transactional; activation writes
  // use short transactions on the same password → CLI → setup lock order.
  database: createCredentialSetupAdapter(),

  logger: {
    log(level, message, ...args) {
      const effective =
        level === "error" && USER_INPUT_ERROR_PATTERN.test(message) ? "warn" : level;
      if (effective === "error") console.error(`[auth] ${message}`, ...args);
      else if (effective === "warn") console.warn(`[auth] ${message}`, ...args);
      else if (effective === "info") console.info(`[auth] ${message}`, ...args);
    },
  },

  trustedOrigins: isCrossOrigin ? [env.CORS_ORIGIN!, env.BETTER_AUTH_URL] : [env.BETTER_AUTH_URL],
  user: {
    additionalFields: {
      // Surface the Prisma `User.locale` column on the typed session so the
      // web app can read `session.user.locale` (and the i18n hook can sync it
      // into i18next). Default mirrors the Prisma `@default("en-US")` so a
      // pre-existing user that hasn't picked a locale yet reads as en-US.
      locale: {
        type: "string",
        required: false,
        defaultValue: "en-US",
        input: false, // not settable via signUp/updateUser; goes through the dedicated procedure
      },
      operationalAlerts: {
        type: "boolean",
        required: false,
        defaultValue: true,
        input: false,
      },
    },
  },
  emailAndPassword: {
    enabled: !forceSso,
    requireEmailVerification: true,
    // Better-Auth's default floor is 8. There is no breached-password check in
    // this app, so length is the only guessing cost. The signup and
    // reset-password forms mirror this; the login form deliberately does not,
    // since an account created under an older policy must still be able to
    // authenticate.
    minPasswordLength: 12,
    password: { hash: passwordPepper.hash, verify: passwordPepper.verify },
    // Token consumption, mailbox proof, competing-link deletion and password
    // commit share the selective adapter transaction. A failed password write
    // rolls those back, so the same link can be retried. Pre-sweep revocations
    // may already have committed. Existing sign-in/2FA and password-write fences
    // still refuse delayed old-password sessions and overlapping writes.
    revokeSessionsOnPasswordReset: true,
    // Post-commit defense in depth revokes API keys, device codes, sessions and
    // pending two-factor proofs again. Mailbox verification already committed
    // with the password; a failed sweep cannot undo it. Exhausted retries log
    // and fail the request; recovery uses a fresh forgot-password link.
    onPasswordReset: async ({ user }) => {
      try {
        await revokeCredentialsAfterPasswordReset(user.id);
      } catch {
        const error = new APIError("INTERNAL_SERVER_ERROR", {
          message: "We couldn't finish securing your account. Request a new password reset link.",
        });
        throw error;
      }
    },
    // Reset links (forgot-password) keep Better-Auth's 1-hour default. Admin
    // invites mint their own, longer-lived set-password token through the same
    // `reset-password:` verification rows (packages/api/src/lib/set-password-link.ts).
    sendResetPassword: async ({ user, url, token }) => {
      // Same locale-resolution dance as sendVerificationEmail: Better-Auth's
      // callback `user` is typed against the base user shape, so `locale`
      // (an additionalField) isn't on it. Fetch the row via Prisma so the
      // reset email routes through the recipient's preferred locale (the
      // renderer falls back to en-US for any unsupported / missing value).
      //
      // `url` already points at Better-Auth's /api/auth/reset-password/:token
      // endpoint, which validates the token and redirects to the `redirectTo`
      // passed by the client (the web /$lang/reset-password page) with
      // `?token=` appended (or `?error=INVALID_TOKEN` on a bad token).
      const row = await prisma.user.findUnique({
        where: { id: user.id },
        select: { locale: true },
      });
      const { subject, html } = renderResetPassword({
        url,
        locale: row?.locale ?? "en-US",
      });
      await sendEmail({
        to: user.email,
        subject,
        html,
      });
      // The link went to the mailbox, so spending it proves the address, and
      // it stays spendable once the account is active (password-reset-links.ts).
      // The mail is already out: a failed record must not fail the request. The
      // link then counts as not mailed (refused for an active account, fail
      // closed); the user requests another.
      try {
        await recordResetLinkMailed({ token, userId: user.id, email: user.email });
      } catch (err) {
        console.error(
          "[auth] recording a mailed reset link failed:",
          err instanceof Error ? `${err.name}: ${err.message}` : "unknown error",
        );
      }
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      // Better-Auth's `additionalFields` are present at runtime but the
      // sendVerificationEmail callback's `user` is typed against the base
      // user shape — `locale` isn't on it. Fetch the row via Prisma so the
      // recipient's preferred locale routes through to the renderer (which
      // falls back to en-US for any unsupported / missing value).
      const row = await prisma.user.findUnique({
        where: { id: user.id },
        select: { locale: true },
      });
      const { subject, html } = renderVerifyEmail({
        // `url` points at Better-Auth's /api/auth/verify-email endpoint, which
        // validates the token and then redirects to the `callbackURL` query
        // param — defaulting to `/` if nobody sets one. Rewrite it here (rather
        // than at each call site) so every verification email, whatever
        // triggered it, lands on the web /$lang/verify-email page with either a
        // confirmation or Better-Auth's `?error=` code.
        // CORS_ORIGIN is the web app's origin when it is served from a
        // different host than this API. Passing it makes the callback absolute
        // so the emailed link lands on the app, not on the API hostname.
        url: withVerificationCallback(url, row?.locale, env.CORS_ORIGIN),
        locale: row?.locale ?? "en-US",
      });
      await sendEmail({
        to: user.email,
        subject,
        html,
      });
    },
    sendOnSignUp: true,
    // `requireEmailVerification` above rejects a correct password on an
    // unverified account. Without this, that rejection is a dead end: the
    // original link expires after an hour and nothing re-sends it. The login
    // form additionally links to /$lang/verify-email for the case where the
    // re-sent mail doesn't arrive either.
    sendOnSignIn: true,
  },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  session: {
    // session:30d, refresh every 1d
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    // Short-lived signed cookie cache: skips the session DB lookup on most
    // requests; revocations/role changes propagate within 60s.
    cookieCache: {
      enabled: true,
      maxAge: 60,
    },
    additionalFields: {
      // How the session was issued (`Session.origin` in auth.prisma).
      // Server-set only; the device-flow hook in `databaseHooks` below is the
      // one writer of a non-default value.
      origin: {
        type: "string",
        required: false,
        defaultValue: "sign-in",
        input: false,
      },
    },
  },
  advanced: {
    defaultCookieAttributes: isCrossOrigin
      ? { sameSite: "none", secure: true, httpOnly: true }
      : { httpOnly: true, secure: env.NODE_ENV === "production" },
  },
  // Better-Auth ships its own rate limiter, enabled by default in production
  // only. We turn it OFF and rely on the Redis-backed limiters in
  // `apps/server/src/rate-limit.ts`, which cover the same routes. This is a
  // consolidation, not a removal — see apps/server/src/rate-limit.ts.
  //
  // Why: the built-in limiter defaults to `storage: "memory"` and keys on
  // `${ip}|${path}`. Two problems compound in a real deployment.
  //   1. Memory storage is per-process, so the effective limit multiplies by
  //      replica count and resets on every deploy.
  //   2. Its IP resolution returns null when `X-Forwarded-For` carries more
  //      than one entry and no `trustedProxies` is configured — the normal
  //      case behind Render or any two-hop proxy. The key then degenerates to
  //      the literal string "no-trusted-ip", SHARED BY EVERY CLIENT. Its
  //      built-in rule of 3 sign-ins per 10s would then apply to the whole
  //      deployment at once: a self-inflicted outage that is also no defense,
  //      announced by a single startup warning.
  // The limiters in apps/server are Redis-backed (correct across replicas,
  // survive deploys), key on the app's own proxy-aware `resolveClientIp`, and
  // are tunable via RATE_LIMIT_* env vars. Running both would double-count
  // and make 429s impossible to attribute.
  //
  // If you re-enable this, configure `advanced.ipAddress.trustedProxies` AND
  // a `secondaryStorage` first — the defaults are not safe behind a proxy.
  rateLimit: { enabled: false },
  hooks: {
    // A reset link the admin was shown (not mailed) is spendable only while
    // the account is a pending invite, so one left over after activation is
    // dead here even if the activation's tidy-up failed. Refused exactly like
    // an expired token, which the reset page already handles
    // (password-reset-links.ts `isResetLinkRedeemable`).
    before: createAuthMiddleware(async (ctx) => {
      const path = ctx.path;
      const expected =
        path === "/get-session" || path === "/sign-out"
          ? null
          : ctx.headers?.get("X-Expected-User");
      const method = ctx.method ?? ctx.request?.method;
      // Anonymous credential/recovery endpoints must work with stale cookies.
      // Optional-session endpoints still validate a cookie before a write can
      // renew it. Keep this authoritative check ahead of identity comparison.
      const validateWrite =
        method &&
        method !== "GET" &&
        !(
          path?.startsWith("/sign-in/") ||
          path?.startsWith("/sign-up/") ||
          path?.startsWith("/callback/") ||
          path === "/sign-out" ||
          path === "/reset-password" ||
          path === "/request-password-reset" ||
          path === "/device/code" ||
          path === "/device/token"
        );
      if (validateWrite) {
        // Better Auth 1.7.18 /update-user can renew a cached session. Verify
        // its signed token's database row to prevent a revoked-cache chain.
        const token = await ctx.getSignedCookie(
          ctx.context.authCookies.sessionToken.name,
          ctx.context.secret,
        );
        if (token) {
          const session = await ctx.context.internalAdapter.findSession(token).catch(() => {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: "SESSION_UNAVAILABLE",
              message: "Session verification unavailable",
            });
          });
          if (!session || session.session.expiresAt <= new Date()) {
            deleteSessionCookie(ctx);
            // Before-hook dispatch does not merge accumulated error headers.
            throw new APIError(
              "UNAUTHORIZED",
              { code: "UNAUTHORIZED", message: "Unauthorized" },
              ctx.responseHeaders,
            );
          }
          ctx.context.session = session;
        }
      }
      if (expected) {
        // getSessionFromCtx reuses ctx.context.session, so the endpoint and
        // this comparison share the authoritative write lookup above. For
        // other endpoints use its underlying resolver directly: unlike
        // getSessionFromCtx it propagates lookup errors instead of swallowing
        // them as anonymity, and still caches the answer on ctx.context.
        const session =
          ctx.context.session ??
          (await getSession()({
            ...ctx,
            headers: ctx.headers ?? ctx.request?.headers ?? new Headers(),
            method: "GET",
            asResponse: false,
            returnHeaders: false,
            returnStatus: false,
            query: {},
          }).catch(() => {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: "SESSION_UNAVAILABLE",
              message: "Session verification unavailable",
            });
          }));
        if (session?.user.id && session.user.id !== expected) {
          throw new APIError("CONFLICT", {
            code: "IDENTITY_CHANGED",
            message: "Document identity changed",
          });
        }
      }
      // Check upstream's link policy before revoking sessions: deleting them
      // first could make an active unverified account look like a pending invite.
      const token = resetTokenOf({ path: ctx.path, body: ctx.body, query: ctx.query });
      if (token) {
        let redeemable: boolean;
        try {
          redeemable = await isResetLinkRedeemable(token);
        } catch {
          throw new APIError("SERVICE_UNAVAILABLE", {
            code: "RESET_UNAVAILABLE",
            message: "Password reset verification unavailable; try this link again.",
          });
        }
        if (!redeemable) throw APIError.from("BAD_REQUEST", BASE_ERROR_CODES.INVALID_TOKEN);
      }
      // Identity must match before the reset pre-sweep revokes anything.
      await revokeCredentialsBeforePasswordReset(ctx);
    }),
    // A password change that signs out other devices (the web settings form
    // always asks for that) means "my old password may have leaked": revoke
    // the user's CLI credentials too. Better-Auth already deleted the session
    // rows; API keys live in their own table. Runs only after the endpoint
    // succeeded — a rejected change has no `user` in its result — so the new
    // password is already committed; the revocation retries and logs loudly
    // exactly as it does for a reset (credential-revocation.ts).
    after: createAuthMiddleware(async (ctx) => {
      // Sign-up answers byte-identically for a free and a registered address,
      // so it is no account-existence oracle (signup-response.ts).
      if (ctx.path === SIGN_UP_EMAIL_PATH) {
        return neutralizeSignUpResponse(ctx, { signupEnabled: SIGNUP_ENABLED });
      }
      const target = passwordChangeRevocationTarget({
        path: ctx.path,
        body: ctx.body,
        returned: ctx.context.returned,
      });
      if (target) await revokeCredentialsAfterPasswordChange(target);
    }),
  },
  plugins: [
    admin({
      defaultRole: "user",
    }),
    twoFactor({
      issuer: "Cockpit Chess",
      // SSO-only users have no credential password to confirm. Better Auth
      // still requires a password whenever a credential account exists, so
      // this lets an authenticated SSO session enroll without weakening the
      // password-confirmation boundary for email/password accounts.
      allowPasswordless: TWO_FACTOR_ALLOW_PASSWORDLESS_ENROLLMENT,
      // Email OTP as a second factor — only wired when SMTP is configured.
      // TOTP + backup codes always remain available regardless.
      //
      // Caveat (documented, mitigated elsewhere): Better-Auth's send-otp
      // endpoint catches a thrown/rejected sendOTP and still returns
      // { status: true } (otp/index.ts) — it will NOT surface an SMTP failure to
      // the caller. The login challenge therefore preflights SMTP reachability
      // via `auth.verifyEmailTransport` (→ mailer `verifyTransport()`) before
      // claiming a code was sent. Here we just do the real send and let a
      // failure throw so it is logged server-side.
      ...(isEmailConfigured()
        ? {
            otpOptions: {
              // Hash codes at rest rather than storing them in plaintext
              // (Better-Auth's default).
              storeOTP: "hashed" as const,
              sendOTP: async ({
                user,
                otp,
              }: {
                user: { id: string; email: string };
                otp: string;
              }) => {
                // additionalFields like `locale` aren't on the callback's typed
                // user shape — fetch the row so the code email is localized
                // (renderer falls back to en-US for missing/unsupported values).
                const row = await prisma.user.findUnique({
                  where: { id: user.id },
                  select: { locale: true },
                });
                const { subject, html } = renderTwoFactorOtp({
                  otp,
                  locale: row?.locale ?? "en-US",
                });
                await sendEmail({ to: user.email, subject, html });
              },
            },
          }
        : {}),
    }),
    // -- Companion-CLI credentials (packages/api/src/routers/cli.ts) --------
    //
    // These two plugins mint bearer-style credentials. They are honoured ONLY
    // on the CLI surface (`/api/cli/*`, apps/server/src/cli-session.ts), which
    // resolves and labels the credential itself; every cookie surface (/rpc,
    // /api/auth/*, assets, admin gates) strips `Authorization`.
    //
    // Deliberately NOT the `bearer` plugin: its after-hook copies the session
    // token into a CORS-exposed `set-auth-token` header on every response that
    // sets a session cookie (sign-in included), which hands browser JavaScript
    // the token that `httpOnly` exists to hide.
    // RFC 8628 device flow: `cockpit-chess login` gets a user code, the user approves
    // it at /$lang/device in a signed-in browser (which already passed 2FA),
    // and the CLI receives an ordinary session token. Only our CLI's
    // client_id is accepted.
    lockedDeviceAuthorization({
      expiresIn: "10m",
      interval: "5s",
      verificationUri: `${webOrigin}/device`,
      validateClient: (clientId) => clientId === CLI_CLIENT_ID,
    }),
    // Long-lived keys for CI and scripts. Managed only through the
    // `apiKeys` oRPC router (protectedProcedure → 2FA policy applies); the
    // plugin's own /api/auth/api-key/* HTTP routes are 404-gated in
    // apps/server. `enableSessionForAPIKeys` stays OFF: it would mock a
    // session from a header on every getSession call. The CLI surface
    // verifies keys explicitly instead and labels them "api-key", which
    // `requireAdmin` rejects.
    apiKey({
      defaultPrefix: API_KEY_PREFIX,
      requireName: true,
      maximumNameLength: 64,
      // Every key is created server-side with an explicit `expiresIn` from a
      // fixed menu (`API_KEY_EXPIRY_DAYS` in the apiKeys router); these bound
      // it again. There is deliberately no "never expires" option.
      keyExpiration: {
        minExpiresIn: 1,
        maxExpiresIn: 365,
      },
      // The Redis `rl:cli` bucket in apps/server limits the surface; the
      // plugin's per-key DB counter (default: 10 requests/day) would only add
      // a write per request and a second, unattributable 429.
      rateLimit: { enabled: false },
      schema: { apikey: { modelName: "apiKey" } },
    }),
    ...(ssoEnabled && env.SSO_CLIENT_ID && env.SSO_CLIENT_SECRET && env.SSO_ISSUER
      ? [
          genericOAuth({
            config: [
              {
                providerId: "sso",
                discoveryUrl: `${env.SSO_ISSUER}/.well-known/openid-configuration`,
                clientId: env.SSO_CLIENT_ID,
                clientSecret: env.SSO_CLIENT_SECRET,
                scopes: ["openid", "profile", "email"],
              },
            ],
          }),
        ]
      : []),
  ],
  databaseHooks: {
    session: {
      create: {
        // Tag sessions minted by the device flow's token endpoint. The CLI
        // surface (apps/server/src/cli-session.ts) accepts only these as
        // bearers, so a browser session token is never a CLI credential.
        // A device-flow mint must also hold the user's CLI-credential lock,
        // so it cannot land after a concurrent revocation
        // (device-redemption-lock.ts); otherwise it is refused.
        // Every other session must be proved too, or it is refused (or removed
        // once committed): a password sign-in and its two-factor code step by
        // an unchanged credential, a rotation of a signed-in session (2FA
        // enable/disable, enrolment, impersonation) by a parent row that still
        // exists, a password change by the password-write lock; only an SSO
        // callback mints a session with none of these
        // (password-sign-in-fence.ts).
        before: async (session, context) => {
          const tagged = deviceFlowSessionData(session, context);
          if (tagged) assertDeviceRedemptionLocked(session.userId);
          await fencePasswordSessionBefore(session, context);
          return tagged;
        },
        after: async (session, context) => {
          if (deviceFlowSessionData(session, context)) await removeDeviceSessionIfUnlocked(session);
          await fencePasswordSessionAfter(session, context);
        },
      },
    },
    account: {
      // Password writes for one user are serialized (password-write-lock.ts):
      // apps/server holds the user's password-write lock across every
      // endpoint that writes one, and a write without it (or after it
      // lapsed) is refused. Creating the credential of a NEW user (sign-up,
      // admin create-user) needs no lock: nothing else can write it yet.
      // Once the write has committed, the after hook confirms the lock was
      // still held; a write that landed after it lapsed is quarantined
      // (scrambled hash, every session revoked) and the request fails.
      // Linking an IdP identity activates an invited account: its leftover
      // set-password links die (account-activation.ts).
      create: {
        before: async (account, context) => guardPasswordAccountCreate(account, context),
        after: async (account) => {
          await confirmPasswordWriteLocked({ hash: passwordPepper.hash });
          await afterAccountCreate(account);
        },
      },
      update: {
        before: async (data) => guardPasswordAccountUpdate(data),
        after: async () => confirmPasswordWriteLocked({ hash: passwordPepper.hash }),
      },
    },
    verification: {
      create: {
        // A two-factor challenge opened by a password sign-in carries that
        // sign-in's credential snapshot (password-sign-in-fence.ts).
        after: async (verification) => recordTwoFactorChallenge(verification),
      },
    },
    user: {
      // No email change in this app, and no admin-asserted verification
      // (email-change-policy.ts). A write that verifies the email activates
      // the account: its leftover set-password links die once it is
      // committed (account-activation.ts).
      update: {
        before: async (data, context) => {
          refuseEmailChange(data, context);
          noteVerificationWrite(data, context);
        },
        after: async (user, context) => afterUserUpdate(user, context),
      },
      create: {
        before: async (user, context) => {
          // Only users.invite reaches /admin/create-user, and only an IdP
          // sign-in creates a verified user (user-creation-policy.ts).
          refuseUnprovedUserCreation(user, context);
          const email = user.email?.toLowerCase();
          const creationMode = getAllowedUserCreationMode();
          const blockReason = getUserCreationBlockReason({ signupEnabled: SIGNUP_ENABLED });
          if (blockReason) {
            throw new Error(blockReason);
          }
          // An admin invite chooses the invitee's language; a sign-up uses the
          // locale the client is rendering.
          const locale = getGrantedUserLocale() ?? resolveSignupLocale(context?.headers);
          // ADMIN_EMAILS promotion is only for the explicit email/password
          // bootstrap path wrapped by the server signup guard. Never infer it
          // from SSO/JIT user creation or from emailVerified claims.
          if (creationMode === "admin-bootstrap" && email && ADMIN_EMAILS.has(email)) {
            return {
              data: {
                ...user,
                locale,
                role: "admin",
              },
            };
          }
          return { data: { ...user, locale } };
        },
        // While sign-up is disabled, the sign-up after-hook lets a 200 stand
        // only when this fired (signup-response.ts).
        after: async () => markUserCreatedUnderGrant(),
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
