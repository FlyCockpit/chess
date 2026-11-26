import { type QueryClient, queryOptions } from "@tanstack/react-query";

import { getSessionCookieHint } from "@/server/auth-session";

/**
 * The public pages' "is this visitor probably signed in?" hint, as one shared
 * query: the `_public` layout seeds it in `beforeLoad` (so a cookie-bearing SSR
 * render already has the answer, and the router's SSR query integration ships
 * it to the client), and the public header (also under the 404, which no
 * `_public` route wraps) reads it with `useQuery` to show the account link
 * instead of nothing.
 *
 * It is `getSessionCookieHint` (server/auth-session.ts): cookie presence only,
 * a chrome hint, never an access check. No Better-Auth client code is
 * involved, so public modules can import this file. A failure reads as
 * "signed out": the hint is a convenience and the anonymous chrome is always a
 * correct fallback.
 */
export const SESSION_HINT_QUERY_KEY = ["session-cookie-hint"] as const;

export function sessionHintQueryOptions() {
  return queryOptions({
    queryKey: SESSION_HINT_QUERY_KEY,
    queryFn: async () => {
      try {
        return await getSessionCookieHint();
      } catch {
        return false;
      }
    },
    // A minute: long enough that the layout seed and the header share one
    // answer, short enough that a sign-in in another tab shows up on the next
    // public navigation. This tab's own session checks update it at once
    // (`setSessionHint`).
    staleTime: 60_000,
    retry: false,
    // Run even while the browser reports offline: an "online" query would
    // pause, and the `_public` layout's `beforeLoad` would wait on it until
    // the connection came back. Offline, the server function fails at once
    // and the hint reads as signed out, like any other failure.
    networkMode: "always",
    meta: { skipGlobalErrorToast: true },
  });
}

/**
 * The hint for the `_public` layout's seed: the cached answer while it is
 * fresh (so repeat navigations share one request), otherwise a new one,
 * awaited. A stale answer is never used, so signing in in another tab is seen
 * by the next public navigation once the minute is up. Never throws.
 */
export function ensureSessionHint(queryClient: QueryClient): Promise<boolean> {
  return queryClient.fetchQuery(sessionHintQueryOptions());
}

/**
 * Record what the app's own session check just learned, so a later public
 * page agrees with it without asking: `true` once a session is confirmed
 * (the `_auth` gate, a finished sign-in, the app shell's session state),
 * `false` when it is confirmed there is none. Sign-out reloads the page, which
 * drops the cache.
 */
export function setSessionHint(queryClient: QueryClient, signedIn: boolean): void {
  queryClient.setQueryData(SESSION_HINT_QUERY_KEY, signedIn);
}
