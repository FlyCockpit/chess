import type { Context, Next } from "hono";

import {
  requireImpersonatorIsVerifiedAdmin,
  requireVerifiedAdminSession,
} from "./admin-session-gate";

const STOP_IMPERSONATING_PATH = "/api/auth/admin/stop-impersonating";

// Better-Auth's admin plugin exposes a parallel management API under
// `/api/auth/admin/*`. Its built-in route checks validate the role, but they
// do not know this app also requires verified email and any globally forced
// second factor. Gate the whole plugin surface before `auth.handler`.
//
// One exact exception: `POST /api/auth/admin/stop-impersonating`. During an
// impersonation the cookie session is the target user's, so the strict gate
// would refuse the request that ends it. That one route is checked against the
// impersonating admin instead (`requireImpersonatorIsVerifiedAdmin`). Every
// other method and path — including near-misses like a trailing slash — stays
// on the strict gate.
export async function betterAuthAdminGate(c: Context, next: Next) {
  const isStopImpersonating = c.req.method === "POST" && c.req.path === STOP_IMPERSONATING_PATH;
  const result = isStopImpersonating
    ? await requireImpersonatorIsVerifiedAdmin(c.req.raw.headers)
    : await requireVerifiedAdminSession(c.req.raw.headers);
  if (!result.ok) {
    return c.json(
      { error: result.error, error_description: result.errorDescription },
      result.status,
    );
  }
  // The web UI uses oRPC for these writes. Keeping a parallel plugin path
  // would bypass the shared transaction, last-admin guard, and role audit.
  const path = c.req.path.replace(/\/+$/, "");
  let procedure: string | undefined;
  if (path === "/api/auth/admin/set-role") procedure = "users.setRole";
  if (path === "/api/auth/admin/ban-user") procedure = "users.archive";
  if (path === "/api/auth/admin/remove-user") procedure = "users.remove";
  if (path === "/api/auth/admin/update-user") {
    // Inspect a clone so supported profile updates still reach Better Auth
    // with their body intact. Invalid JSON remains Better Auth's concern.
    const body: unknown = await c.req.raw
      .clone()
      .json()
      .catch(() => null);
    if (body && typeof body === "object" && "data" in body) {
      const data = body.data;
      if (data && typeof data === "object") {
        if ("role" in data) procedure = "users.setRole";
        else if ("banned" in data || "banExpires" in data) procedure = "users.archive";
        else if ("emailVerified" in data) procedure = "users";
      }
    }
  }
  if (procedure) {
    return c.json(
      {
        error: "USE_ORPC_USER_MANAGEMENT",
        error_description: `Use the oRPC ${procedure} procedure for user access changes.`,
      },
      403,
    );
  }
  await next();
}
