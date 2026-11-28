import {
  ADMIN_EMAILS,
  env,
  FORCE_SSO,
  SIGNUP_ENABLED,
  SSO_ENABLED,
} from "@cockpit-chess/env/server";
import { isEmailConfigured } from "@cockpit-chess/mailer";
import type { RouterClient } from "@orpc/server";

import { protectedProcedure, publicProcedure } from "../index";
import { adminExistsForAppConfig } from "../lib/admin-presence";
import { authRouter } from "./auth";
import { chessRouter } from "./chess";
import { chessModerationRouter } from "./chess-moderation";
import { cliAccessRouter } from "./cli-access";
import { openrouterRouter } from "./openrouter";
import { queueRouter } from "./queue";
import { settingsRouter } from "./settings";
import { setupRouter } from "./setup";
import { usersRouter } from "./users";

export const appRouter = {
  health: {
    // No RPC readiness probe: a DB-touching `ready` procedure would be an
    // anonymous datastore-drain vector bounded only by the generic /rpc
    // limiter. Readiness is the HTTP /ready route, which has its own
    // readyLimiter bucket (apps/server/src/rate-limit.ts).
    check: publicProcedure.handler(() => {
      return "OK";
    }),
  },
  appConfig: publicProcedure.handler(async () => {
    return {
      ssoEnabled: SSO_ENABLED,
      forceSso: FORCE_SSO,
      ssoProviderName: env.SSO_PROVIDER_NAME,
      signupEnabled: SIGNUP_ENABLED,
      // Sign-up is closed, `ADMIN_EMAILS` names the operator, and no admin
      // exists yet: sign-in offers "Sign up" so the operator can create the
      // first account. Once an admin exists this turns false and the pages
      // show the invite-only state, so an established server never offers a
      // sign-up nobody else can use. Revealing "no admin yet" is acceptable:
      // such a server is not usable by anyone else either. The DB read is
      // skipped unless the env makes bootstrap possible, and a "yes" is cached
      // (lib/admin-presence.ts).
      adminBootstrapSignupEnabled:
        !SIGNUP_ENABLED && ADMIN_EMAILS.size > 0 && !(await adminExistsForAppConfig()),
      // Gates the login challenge's "email me a code" affordance. The delivery
      // unreliability of Better-Auth's send-otp endpoint (it swallows SMTP
      // failures) is handled separately by the `auth.verifyEmailTransport`
      // preflight; this flag only reflects whether email is configured at all.
      emailEnabled: isEmailConfigured(),
    };
  }),
  privateData: protectedProcedure.handler(({ context }) => {
    return {
      message: "This is private",
      user: context.session?.user,
    };
  }),
  auth: authRouter,
  settings: settingsRouter,
  // First-admin setup link (SETUP_KEY) — lib/admin-bootstrap.ts.
  setup: setupRouter,
  queue: queueRouter,
  chess: chessRouter,
  chessModeration: chessModerationRouter,
  // The caller's own OpenRouter key (Settings → OpenRouter); connecting is the OAuth
  // flow in apps/server/src/openrouter-routes.ts.
  openrouter: openrouterRouter,
  users: usersRouter,
  // Web-side companion-CLI access (install command, API keys). The CLI's own
  // API is `cliRouter`, served on /api/cli/rpc — packages/api/src/routers/cli.ts.
  cliAccess: cliAccessRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
