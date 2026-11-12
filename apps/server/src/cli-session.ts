import type { CredentialKind } from "@cockpit-chess/api/context";
import { auth, type Session } from "@cockpit-chess/auth";
import { isUserBanned } from "@cockpit-chess/auth/ban";
import { API_KEY_PREFIX, DEVICE_FLOW_SESSION_ORIGIN } from "@cockpit-chess/config/cli";
import prisma, { type Prisma } from "@cockpit-chess/db";
import type { Context, Next } from "hono";

// Credential resolution for the companion-CLI surface (/api/cli/*) — the ONE
// place in this app where `Authorization: Bearer …` authenticates anyone.
// Every cookie surface strips that header (session-middleware.ts,
// admin-session-gate.ts, the /api/auth/* handler); this middleware is the
// "bearer surface that resolves and scope-checks its own credential" those
// comments refer to.
//
// The inverse holds here: cookies are IGNORED. Only the Authorization header
// is read, so a browser's ambient session can never ride along on a
// cross-site request to this surface (no CSRF exposure), and the CSRF plugin
// the cookie surface uses is not needed.
//
// Two credentials, distinguished by API_KEY_PREFIX and labelled on the oRPC
// context so procedures (and `requireAdmin`) can tell them apart:
//   - "session-token": a device-flow session (`cockpit-chess login`) — a Better-Auth
//     session row, looked up by token, whose `origin` is "device-flow". A
//     browser sign-in session is refused even with a valid token,
//     so a token lifted from a cookie never works here. (Not via the `bearer`
//     plugin; see packages/auth/src/index.ts for why it is not installed.)
//   - "api-key": verified with `auth.api.verifyApiKey` (hash lookup, expiry,
//     enabled), then mapped to its owner. Never a mock session from a header:
//     the plugin's `enableSessionForAPIKeys` stays off.
//
// Banned users get no session from either path. A ban deletes session rows,
// but API keys outlive it, so this check is what actually stops a banned
// user's keys.

/** The session-user columns, selected explicitly for the API-key path. */
const sessionUserSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  email: true,
  emailVerified: true,
  image: true,
  role: true,
  locale: true,
  banned: true,
  banReason: true,
  banExpires: true,
  twoFactorEnabled: true,
  operationalAlerts: true,
} satisfies Prisma.UserSelect;

export type CliCredential = { session: Session; credential: CredentialKind };

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function resolveApiKey(key: string): Promise<Session | null> {
  const result = await auth.api.verifyApiKey({ body: { key } });
  if (!result.valid || !result.key) return null;
  const user = await prisma.user.findUnique({
    where: { id: result.key.referenceId },
    select: sessionUserSelect,
  });
  if (!user) return null;
  const now = new Date();
  return {
    user,
    // Not a session row: there is nothing to revoke or refresh. `id` is the
    // key id so logs and rate-limit keys stay attributable to one key.
    session: {
      id: result.key.id,
      token: "",
      userId: user.id,
      createdAt: now,
      updatedAt: now,
      expiresAt: result.key.expiresAt ?? now,
      ipAddress: null,
      userAgent: null,
      impersonatedBy: null,
      origin: null,
    },
  };
}

async function resolveSessionToken(token: string): Promise<Session | null> {
  const row = await prisma.session.findUnique({
    where: { token },
    select: {
      id: true,
      token: true,
      userId: true,
      createdAt: true,
      updatedAt: true,
      expiresAt: true,
      ipAddress: true,
      userAgent: true,
      impersonatedBy: true,
      origin: true,
      user: { select: sessionUserSelect },
    },
  });
  if (!row || row.origin !== DEVICE_FLOW_SESSION_ORIGIN) return null;
  // No sliding refresh on this path: a CLI session lasts the configured
  // session lifetime (30 days) from `cockpit-chess login`, then the user logs in again.
  if (row.expiresAt.getTime() <= Date.now()) return null;
  const { user, ...session } = row;
  return { user, session };
}

/** Resolve a CLI credential from an Authorization header value. */
export async function resolveCliCredential(
  authorization: string | undefined,
): Promise<CliCredential | null> {
  const token = bearerToken(authorization);
  if (!token) return null;
  const credential: CredentialKind = token.startsWith(API_KEY_PREFIX) ? "api-key" : "session-token";
  let session: Session | null = null;
  try {
    session =
      credential === "api-key" ? await resolveApiKey(token) : await resolveSessionToken(token);
  } catch (err) {
    // Same failure mode as sessionMiddleware: a lookup blip is "anonymous",
    // and the procedure's own gate answers 401.
    console.warn("[cli-session] credential lookup failed, treating as anonymous:", err);
    return null;
  }
  if (!session?.user || isUserBanned(session.user)) return null;
  return { session, credential };
}

/**
 * Stash the CLI credential on the Hono context. `createContext` reads both
 * keys, and the rate limiter keys on `session.user.id`.
 */
export async function cliSessionMiddleware(c: Context, next: Next) {
  const resolved = await resolveCliCredential(c.req.header("authorization"));
  c.set("session", resolved?.session ?? null);
  c.set("credential", resolved?.credential);
  await next();
}
