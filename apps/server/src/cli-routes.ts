import { createContext } from "@cockpit-chess/api/context";
import { verifyCliInstallToken } from "@cockpit-chess/api/lib/cli-install-token";
import {
  CliReleaseUnavailableError,
  isCliReleaseConfigured,
  resolveCliAssetUrl,
} from "@cockpit-chess/api/lib/cli-release";
import { cliRouter } from "@cockpit-chess/api/routers/cli";
import type { Session } from "@cockpit-chess/auth";
import { isUserBanned } from "@cockpit-chess/auth/ban";
import {
  CLI_CHECKSUMS_ASSET,
  CLI_INSTALL_AUTH_SCHEME,
  CLI_PLATFORMS,
  CLI_RPC_PREFIX,
} from "@cockpit-chess/config/cli";
import prisma from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/server";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Context, Env, Hono } from "hono";
import {
  expiredInstallPowerShellScript,
  expiredInstallShellScript,
  installPowerShellScript,
  installShellScript,
} from "./cli-install-scripts.js";
import { cliSessionMiddleware } from "./cli-session.js";
import { resolveClientIp } from "./client-ip.js";
import {
  cliDownloadLimiter,
  cliIpLimiter,
  cliLimiter,
  createRateLimiterMiddleware,
} from "./rate-limit.js";

// The companion-CLI surface. Everything under /api/cli/* authenticates with a
// bearer credential (cli-session.ts) or, for installs, a signed install token
// in `Authorization: Install <token>` — never a cookie, and never a query
// string (URLs land in access logs). See packages/api/src/routers/cli.ts.
//
//   POST /api/cli/rpc/*             oRPC `cliRouter` (typed client in apps/cli)
//   GET  /api/cli/install.sh        copy-paste installer/updater (macOS, Linux, WSL)
//   GET  /api/cli/install.ps1       same, for Windows PowerShell
//   GET  /api/cli/download/:asset   302 to the release asset (binary or SHA256SUMS)

const DOWNLOADABLE_ASSETS = new Set<string>([...Object.values(CLI_PLATFORMS), CLI_CHECKSUMS_ASSET]);

// A signed install token is `v1.<base64url>.<base64url>`. Checked before the
// signature so arbitrary header text never reaches the verifier or a script.
const INSTALL_TOKEN_SHAPE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const INSTALL_AUTHORIZATION = new RegExp(`^${CLI_INSTALL_AUTH_SCHEME}\\s+(\\S+)$`, "i");

/** The install token from `Authorization: Install <token>`, if that is the scheme. */
function installTokenFrom(c: Context): string | undefined {
  return INSTALL_AUTHORIZATION.exec(c.req.header("authorization")?.trim() ?? "")?.[1];
}

const webOrigin = env.CORS_ORIGIN ?? env.BETTER_AUTH_URL;
const settingsUrl = `${webOrigin}/settings/cli`;

/** The user an install token was minted for, if it is valid and they may still sign in. */
async function installTokenUser(token: string | undefined): Promise<string | null> {
  if (!token || !INSTALL_TOKEN_SHAPE.test(token)) return null;
  const userId = verifyCliInstallToken(token);
  if (!userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, banned: true, banExpires: true },
  });
  if (!user || isUserBanned(user)) return null;
  return user.id;
}

function noStore(c: Context) {
  c.header("Cache-Control", "no-store");
}

type CliEnv = { Variables: { session: Session | null } };

export function mountCliRoutes<E extends Env & CliEnv>(
  app: Hono<E>,
  options: { onOrpcError: (error: unknown) => void },
): Hono<E> {
  // No CSRF plugin and no batch plugin, on purpose: cookies are ignored here
  // (cli-session.ts), so there is no ambient credential to forge, and the CLI
  // makes one call at a time.
  const cliRpcHandler = new RPCHandler(cliRouter, {
    interceptors: [onError(options.onOrpcError)],
  });

  // IP-keyed first, so an invalid-token flood is throttled before each token
  // costs a lookup; then resolve the credential so `cliLimiter` keys on the user.
  const ipLimit = createRateLimiterMiddleware(cliIpLimiter, { resolveKey: resolveClientIp });
  app.use(`${CLI_RPC_PREFIX}/*`, ipLimit);
  app.use(`${CLI_RPC_PREFIX}/*`, cliSessionMiddleware);
  app.use(`${CLI_RPC_PREFIX}/*`, createRateLimiterMiddleware(cliLimiter));
  app.all(`${CLI_RPC_PREFIX}/*`, async (c) => {
    const context = await createContext({ context: c, clientIp: resolveClientIp(c) });
    const result = await cliRpcHandler.handle(c.req.raw, { prefix: CLI_RPC_PREFIX, context });
    if (result.matched) return c.newResponse(result.response.body, result.response);
    return c.json({ error: "Not found" }, 404);
  });

  // Installs are anonymous until the token is checked, so this bucket keys on
  // IP (no session middleware) — except `cockpit-chess update`, which presents its
  // bearer credential and is keyed on the user.
  app.use("/api/cli/download/*", ipLimit);
  app.use("/api/cli/download/*", cliSessionMiddleware);
  for (const path of ["/api/cli/install.sh", "/api/cli/install.ps1", "/api/cli/download/*"]) {
    app.use(path, createRateLimiterMiddleware(cliDownloadLimiter));
  }

  for (const [path, render, renderExpired] of [
    ["/api/cli/install.sh", installShellScript, expiredInstallShellScript],
    ["/api/cli/install.ps1", installPowerShellScript, expiredInstallPowerShellScript],
  ] as const) {
    app.get(path, async (c) => {
      noStore(c);
      c.header("Content-Type", "text/plain; charset=utf-8");
      if (!isCliReleaseConfigured()) {
        return c.text("CLI downloads are not configured on this server.\n", 503);
      }
      const token = installTokenFrom(c);
      // 200 with a script that explains itself: `curl -f … | sh` on a 401
      // would hand `sh` an empty script and fail silently.
      if (!(await installTokenUser(token)) || !token) return c.body(renderExpired(settingsUrl));
      return c.body(render({ base: env.BETTER_AUTH_URL, token }));
    });
  }

  app.get("/api/cli/download/:asset", async (c) => {
    noStore(c);
    const asset = c.req.param("asset");
    if (!DOWNLOADABLE_ASSETS.has(asset)) return c.json({ error: "Not found" }, 404);
    if (!isCliReleaseConfigured()) {
      return c.json({ error: "CLI downloads are not configured on this server." }, 503);
    }

    // Either a CLI credential (`cockpit-chess update`) or an install token.
    const userId = c.get("session")?.user.id ?? (await installTokenUser(installTokenFrom(c)));
    if (!userId) return c.json({ error: "Sign in or copy a fresh install command." }, 401);

    try {
      const url = await resolveCliAssetUrl(asset);
      if (!url) return c.json({ error: "This release does not include that file." }, 404);
      return c.redirect(url, 302);
    } catch (error) {
      if (error instanceof CliReleaseUnavailableError) {
        console.warn("[cli-routes] release unavailable:", error.message);
        return c.json({ error: "CLI downloads are temporarily unavailable." }, 503);
      }
      throw error;
    }
  });

  return app;
}
