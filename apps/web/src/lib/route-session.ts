import { admitRouteIdentity, documentIdentityEpoch } from "@/lib/document-identity";
import type { RouteSessionResolution } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

/**
 * The session guards' probe: `getRouteSession()`, then the document's
 * identity check (`lib/document-identity.ts`). When the server answers with a
 * different identity than the one this document's cached data belongs to (a
 * switch made while no `_app` page was open, or in another tab), the document
 * is replaced and this never settles, so nothing under the guard renders the
 * previous identity's data. An answer to a probe that started before a
 * newer identity was recorded (a hover preload sent before this tab signed
 * in) is out of date: the probe runs again, and only its answer is used. Every session guard
 * uses this, never `getRouteSession()` alone.
 */
export async function resolveRouteSession(): Promise<RouteSessionResolution> {
  for (;;) {
    const startedAt = documentIdentityEpoch();
    const resolution = await getRouteSession();
    // Out of date: probe again rather than act on (or hand the route) an
    // answer older than the identity recorded meanwhile. Terminates: the
    // recorded identity changes at most twice (unknown → anonymous → a user)
    // before any further change replaces the document instead.
    if (startedAt !== documentIdentityEpoch()) continue;
    await admitRouteIdentity(resolution, startedAt);
    return resolution;
  }
}
