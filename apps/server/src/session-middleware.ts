import { auth, type Session } from "@cockpit-chess/auth";
import { isUserBanned } from "@cockpit-chess/auth/ban";
import type { Context, Next } from "hono";

// Resolves the Better-Auth session once per request and stashes it on the
// Hono context. Downstream consumers (rate limiter, oRPC createContext)
// read `c.get("session")` instead of each making
// their own database hit.
//
// Failure mode: a Better-Auth blip becomes "no session" rather than a 500
// for the entire request. The downstream `requireAuth` gates will still
// return 401 if a real session was needed.
//
// SECURITY: `Authorization` is stripped before resolving, so the routes this
// middleware guards (/rpc/*) authenticate by cookie ONLY.
//
// Defense in depth. The companion CLI's credentials (device-flow session
// tokens, API keys) are bearer tokens, and a Better-Auth plugin that accepts
// one typically mocks a session for the credential's owner inside
// `getSession` — while no oRPC procedure here checks a credential's scope.
// Stripping the header keeps that from silently turning these cookie surfaces
// into token surfaces. The one bearer surface, /api/cli/*, resolves and labels
// its own credential (cli-session.ts); never relax this to "make the CLI work".
export async function sessionMiddleware(c: Context, next: Next) {
  let session: Session | null = null;
  try {
    const cookieOnly = new Headers(c.req.raw.headers);
    cookieOnly.delete("authorization");
    session = (await auth.api.getSession({ headers: cookieOnly })) as Session | null;
    // getSession does not re-check bans. A session minted concurrently with
    // archival can survive session deletion; never expose it to consumers.
    if (session?.user && isUserBanned(session.user)) session = null;
  } catch (err) {
    console.warn("[session-middleware] getSession failed, treating as anonymous:", err);
    session = null;
  }
  c.set("session", session ?? null);
  await next();
}
