import { useMatch, useRouter } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { isBrowserOffline } from "@/lib/network-failure";
import { reportRouteImportFailure } from "@/lib/stale-build-recovery";

/** Report only a failed route import, before the router acknowledges the error screen's render. */
export function useRouteImportFailure(error: unknown): void {
  const router = useRouter();
  const match = useMatch({ strict: false });
  const routeId = match?.routeId;
  useLayoutEffect(() => {
    if (!routeId) return;
    // TanStack clears .preload after a successful route import. If it is absent,
    // the route loaded: a failed lazy child/menu is not owned by this route import.
    if (!router.routesById[routeId]?.options.component?.preload) return;
    // Offline, the chunk is missing because the network is, not because a
    // deploy replaced it: a reload would only land on the browser's offline
    // page. ErrorState shows the offline state and retries on reconnect.
    if (isBrowserOffline()) return;
    reportRouteImportFailure(router, error, routeId);
  }, [router, routeId, error]);
}
