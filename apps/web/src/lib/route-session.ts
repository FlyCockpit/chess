import { appShellHydrated } from "@/lib/app-shell-hydration";
import {
  admitRouteIdentity,
  documentIdentityEpoch,
  identityVerificationGeneration,
} from "@/lib/document-identity";
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
 * in), or before another tab announced a change no watcher here checked
 * (`identityVerificationGeneration`), is out of date: the probe runs again,
 * and only its answer is used. It also waits for the server-rendered app
 * shell to hydrate, so a guard's redirect never lands mid-hydration. Every
 * session guard uses this, never
 * `getRouteSession()` alone.
 */
export async function resolveRouteSession(): Promise<RouteSessionResolution> {
  // Nothing a guard decides (redirect, not-found, error) may reach the router
  // while the server-rendered app shell is still hydrating
  // (lib/app-shell-hydration.ts). The wait runs alongside the first probe, and
  // a failed probe (a transport error) also waits before it reaches the
  // router. Taken once: a re-probe below runs after the shell hydrated.
  const shellHydrated = appShellHydrated();
  for (;;) {
    const startedAt = documentIdentityEpoch();
    // Taken before the probe too: an identity change announced while it runs
    // is newer than its answer, so the answer can't lift the unverified mask.
    const since = identityVerificationGeneration();
    const [probe] = await Promise.allSettled([getRouteSession(), shellHydrated]);
    if (probe.status === "rejected") throw probe.reason;
    const resolution = probe.value;
    // Out of date: probe again rather than act on (or hand the route) an
    // answer older than the identity recorded meanwhile, or than another
    // tab's change announced meanwhile (it may predate the switch). Terminates:
    // the recorded identity changes at most twice (unknown → anonymous → a
    // user) before any further change replaces the document instead, and a
    // probe goes stale only for an announcement made while it ran.
    if (startedAt !== documentIdentityEpoch() || since !== identityVerificationGeneration()) {
      continue;
    }
    await admitRouteIdentity(resolution, startedAt, since);
    return resolution;
  }
}
