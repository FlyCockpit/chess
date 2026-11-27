import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  isDocumentIdentityUnverified,
  isIdentityObservationRequested,
  subscribeDocumentIdentity,
  subscribeIdentityVerification,
} from "@/lib/document-identity";

/**
 * Start session observation only on account-aware pages, then retain it across
 * public navigation. Unguarded account controls request observation through
 * `useDocumentAdmits` before they can write. Also once the document's identity
 * is unverified (another tab announced a change, or a request got a 401, while no watcher was
 * connected): until a watcher checks it, `useAuthSession()` reports `pending`
 * everywhere, so a public page that shows the session (the leaderboard's
 * admin toggle) would otherwise wait for a watcher that never loads.
 */
export function useIdentityBoundaryEnabled(): boolean {
  const accountAware = useRouterState({
    select: (state) =>
      state.matches.some((match) => match.routeId.startsWith("/$lang/_app")) ||
      ("tab" in state.location.search && state.location.search.tab === "studio"),
  });
  const unverified = useSyncExternalStore(
    subscribeIdentityVerification,
    isDocumentIdentityUnverified,
    () => false,
  );
  const requested = useSyncExternalStore(
    subscribeDocumentIdentity,
    isIdentityObservationRequested,
    () => false,
  );
  const needed = accountAware || unverified || requested;
  const [started, setStarted] = useState(needed);
  useEffect(() => {
    if (needed) setStarted(true);
  }, [needed]);
  return started || needed;
}
