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
import { authRouter } from "./auth";
import { chessRouter } from "./chess";
import { cliAccessRouter } from "./cli-access";
import { queueRouter } from "./queue";
import { settingsRouter } from "./settings";
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
  appConfig: publicProcedure.handler(() => {
    return {
      ssoEnabled: SSO_ENABLED,
      forceSso: FORCE_SSO,
      ssoProviderName: env.SSO_PROVIDER_NAME,
      signupEnabled: SIGNUP_ENABLED,
      adminBootstrapSignupEnabled: !SIGNUP_ENABLED && ADMIN_EMAILS.size > 0,
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
  queue: queueRouter,
  chess: chessRouter,
  users: usersRouter,
  // Web-side companion-CLI access (install command, API keys). The CLI's own
  // API is `cliRouter`, served on /api/cli/rpc — packages/api/src/routers/cli.ts.
  cliAccess: cliAccessRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
