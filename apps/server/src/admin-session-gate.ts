import { checkAdminAuthority } from "@cockpit-chess/api";
import { auth, type Session } from "@cockpit-chess/auth";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { parseSigned } from "hono/utils/cookie";

type AdminGateFailure = { ok: false; status: 401 | 403; error: string; errorDescription: string };
type AdminSessionGateResult = { ok: true; session: Session } | AdminGateFailure;

const UNAUTHENTICATED: AdminGateFailure = {
  ok: false,
  status: 401,
  error: "unauthorized",
  errorDescription: "Authentication required",
};

// Same actor projection as the template, with chess's pending-deletion fence.
const impersonatorSelect = {
  id: true,
  role: true,
  emailVerified: true,
  banned: true,
  banExpires: true,
  deletionRequestedAt: true,
  twoFactorEnabled: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

// These are cookie-authenticated admin UI surfaces. Strip Authorization before
// any plugin can resolve a bearer as its owner and confer management authority.
async function getCookieSession(headers: Headers): Promise<Session | null> {
  try {
    const cookieOnly = new Headers(headers);
    cookieOnly.delete("authorization");
    return (await auth.api.getSession({ headers: cookieOnly })) as Session | null;
  } catch {
    return null;
  }
}

// Map failures only: checkAdminAuthority remains the single admin rule shared
// with requireAdmin / requireAdminOr404, including forced 2FA and deletion.
async function checkVerifiedAdminUser(
  user: Pick<Session["user"], keyof typeof impersonatorSelect>,
): Promise<{ ok: true } | AdminGateFailure> {
  const authority = await checkAdminAuthority({ user });
  if (!authority.ok) {
    return {
      ok: false,
      status: authority.reason === "unauthenticated" ? 401 : 403,
      error: authority.reason === "unauthenticated" ? "unauthorized" : "access_denied",
      errorDescription:
        authority.reason === "unauthenticated"
          ? "Authentication required"
          : authority.reason === "two-factor"
            ? "Two-factor authentication setup is required"
            : "Verified admin access required",
    };
  }
  return { ok: true };
}

export async function requireVerifiedAdminSession(
  headers: Headers,
): Promise<AdminSessionGateResult> {
  const session = await getCookieSession(headers);
  if (!session?.user) return UNAUTHENTICATED;
  const check = await checkVerifiedAdminUser(session.user);
  if (!check.ok) return check;
  return { ok: true, session };
}

/**
 * The exact stop-impersonating POST checks the original actor, never the target's
 * role or lifecycle. Better Auth still validates the original request's CSRF,
 * signed cookies and impersonation binding, and restores the existing session.
 */
export async function requireImpersonatorIsVerifiedAdmin(
  headers: Headers,
): Promise<AdminSessionGateResult> {
  const session = await getCookieSession(headers);
  if (!session?.session.impersonatedBy) return UNAUTHENTICATED;
  try {
    const context = await auth.$context;
    const savedName = context.createAuthCookie("admin_session").name;
    const rawCookies = headers.get("cookie") ?? "";
    const savedEntries = rawCookies
      .split(";")
      .filter((entry) => entry.slice(0, entry.indexOf("=")).trim() === savedName);
    // Better Call and Hono differ on malformed quotes. Only accept the single
    // unquoted cookie Better Auth emits, so both parsers must select the same
    // signed value even when another path/domain cookie has the same name.
    if (savedEntries.length !== 1 || savedEntries[0]?.includes('"')) return UNAUTHENTICATED;
    const cookies = await parseSigned(rawCookies, context.secret);
    const saved = cookies[savedName];
    if (!saved) return UNAUTHENTICATED;
    const [token] = saved.split(":");
    if (!token) return UNAUTHENTICATED;
    // The template loads the actor fresh by impersonatedBy. Also bind that
    // actor to the signed saved token's live browser session: the pinned stop
    // handler does not independently reject an expired or derived saved row.
    const original = await prisma.session.findFirst({
      where: {
        token,
        userId: session.session.impersonatedBy,
        impersonatedBy: null,
        origin: "sign-in",
        expiresAt: { gt: new Date() },
      },
      select: { user: { select: impersonatorSelect } },
    });
    if (!original) return UNAUTHENTICATED;
    const check = await checkVerifiedAdminUser(original.user);
    if (!check.ok) return check;
    return { ok: true, session };
  } catch {
    return UNAUTHENTICATED;
  }
}
