import { createHash, timingSafeEqual } from "node:crypto";
import {
  type AdminBootstrapResult,
  bootstrapFirstAdmin,
} from "@cockpit-chess/api/lib/admin-bootstrap";
import type { Context, Env, Hono, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { resolveClientIp } from "./client-ip.js";
import { createRateLimiterMiddleware, setupLimiter } from "./rate-limit.js";

/**
 * `SETUP_KEY` first-admin bootstrap — the email-free way to get the first admin
 * onto a fresh deploy. `pnpm deploy:generate-admin` (scripts/) is its client.
 *
 *   POST /api/setup/admin   { "key": "<SETUP_KEY>", "email": "owner@example.com" }
 *   → 200 { url, expiresAt, email }   a one-time setup link
 *
 * The rules, each enforced here or in `bootstrapFirstAdmin`:
 *   - The route exists only while SETUP_KEY is set: unset → 404 for every
 *     method, before the limiter, the body, or the key are looked at.
 *   - It works only while no admin exists; after that every correct-key call
 *     is refused (409 `admin_exists`). It creates no user: the admin is
 *     created, with its password, only when the link is spent
 *     (admin-bootstrap.ts). Re-running issues a fresh link and the earlier one
 *     dies, so a lost or expired link is recoverable without opening anything
 *     else.
 *   - The key is compared in constant time (SHA-256 of both sides, then
 *     `timingSafeEqual`, so length differences don't leak either) and checked
 *     FIRST: without it the caller learns nothing about admins or emails.
 *   - Rate limited per client IP (`setupLimiter`, fail-closed).
 *   - Every attempt — refused by the limiter, wrong key, bad input, refusal,
 *     success, error — writes one `[audit]` log line. Never the key, the
 *     email, or the link.
 *   - No password crosses the wire. The response carries a one-time setup
 *     link with a short expiry (`SETUP_LINK_TTL_SECONDS`). It is not a
 *     Better-Auth reset token: only `setup.claimFirstAdmin` can spend it, and
 *     only while no admin exists (admin-bootstrap.ts).
 *   - Mounted before the app's global body limit and CORS middleware
 *     (apps/server/src/index.ts), so neither can answer for it: an unset key
 *     404s even a preflight, and every request here is limited and audited.
 *   - Bootstrap only. Do not hang any other action off SETUP_KEY: it is a
 *     deploy-time credential that is supposed to be deleted, not an API key.
 */

export const SETUP_ADMIN_PATH = "/api/setup/admin";

/** How long the printed set-password link stays valid. */
export const SETUP_LINK_TTL_SECONDS = 60 * 60;

/** `[audit]` line event name; log pipelines can filter on it. */
export const SETUP_AUDIT_EVENT = "setup.first_admin";

export type SetupAuditOutcome =
  | "rate_limited"
  | "invalid_key"
  | "invalid_request"
  | "password_signin_disabled"
  | Exclude<AdminBootstrapResult["kind"], "ready">
  | "link_issued"
  | "error";

interface SetupAuditEntry {
  event: typeof SETUP_AUDIT_EVENT;
  outcome: SetupAuditOutcome;
  status: number;
  ip: string;
  requestId: string;
}

type RateLimiter = Parameters<typeof createRateLimiterMiddleware>[0];

export interface SetupRouteOptions {
  /** `env.SETUP_KEY`. Unset = the route does not exist. */
  setupKey: string | undefined;
  /** False under FORCE_SSO: a password-only admin could never sign in. */
  passwordSignInEnabled: boolean;
  limiter?: RateLimiter;
  bootstrap?: (email: string) => Promise<AdminBootstrapResult>;
  audit?: (entry: SetupAuditEntry) => void;
}

// The key is checked separately (and first); its length is bounded by the
// route's body limit and by SETUP_KEY's own schema.
const requestSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
});

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time key check. Hashing first makes both sides the same length. */
export function setupKeyMatches(provided: unknown, expected: string): boolean {
  const candidate = typeof provided === "string" ? provided : "";
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

function defaultAudit(entry: SetupAuditEntry) {
  console.info(`[audit] ${JSON.stringify(entry)}`);
}

function defaultBootstrap(email: string) {
  return bootstrapFirstAdmin(email, { ttlSeconds: SETUP_LINK_TTL_SECONDS });
}

export function mountSetupRoutes<E extends Env>(app: Hono<E>, options: SetupRouteOptions) {
  const {
    setupKey,
    passwordSignInEnabled,
    limiter = setupLimiter,
    bootstrap = defaultBootstrap,
    audit = defaultAudit,
  } = options;

  if (!setupKey) {
    // Absent, not forbidden: the same 404 an unknown path gets.
    app.all(SETUP_ADMIN_PATH, (c) => c.json({ error: "Not found" }, 404));
    return;
  }

  const record = (c: Context, outcome: SetupAuditOutcome, status: number) => {
    audit({
      event: SETUP_AUDIT_EVENT,
      outcome,
      status,
      ip: resolveClientIp(c),
      requestId: (c.get("requestId" as never) as string | undefined) ?? "-",
    });
  };

  // Answers from the limiter (429, or 503 while Redis is down) are attempts
  // too; they are audited here, after the limiter has answered.
  app.use(SETUP_ADMIN_PATH, async (c: Context, next: Next) => {
    c.header("Cache-Control", "no-store");
    await next();
    if (c.res.status === 429 || c.res.status === 503) record(c, "rate_limited", c.res.status);
  });
  app.use(SETUP_ADMIN_PATH, createRateLimiterMiddleware(limiter, { failClosed: true }));
  app.use(
    SETUP_ADMIN_PATH,
    bodyLimit({
      maxSize: 4 * 1024,
      onError: (c) => {
        record(c, "invalid_request", 413);
        return c.json({ error: "invalid_request" }, 413);
      },
    }),
  );

  app.all(SETUP_ADMIN_PATH, async (c) => {
    if (c.req.method !== "POST") {
      record(c, "invalid_request", 405);
      return c.json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const providedKey =
      typeof body === "object" && body !== null && "key" in body ? body.key : undefined;
    if (!setupKeyMatches(providedKey, setupKey)) {
      record(c, "invalid_key", 401);
      return c.json({ error: "invalid_key" }, 401);
    }

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      record(c, "invalid_request", 400);
      return c.json({ error: "invalid_email" }, 400);
    }
    if (!passwordSignInEnabled) {
      record(c, "password_signin_disabled", 409);
      return c.json({ error: "password_signin_disabled" }, 409);
    }

    const { email } = parsed.data;
    try {
      const result = await bootstrap(email);
      if (result.kind === "admin_exists" || result.kind === "email_taken") {
        record(c, result.kind, 409);
        return c.json({ error: result.kind }, 409);
      }
      record(c, "link_issued", 200);
      return c.json({ url: result.url, expiresAt: result.expiresAt.toISOString(), email });
    } catch (err) {
      console.error(
        "[setup] first-admin bootstrap failed:",
        err instanceof Error ? `${err.name}: ${err.message}` : "unknown error",
      );
      record(c, "error", 500);
      return c.json({ error: "internal_error" }, 500);
    }
  });
}
