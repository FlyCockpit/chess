import { authClient } from "@/lib/auth-client";
import {
  type AuthSessionState,
  getAuthSessionState,
  rememberConfirmedAnonymous,
} from "@/lib/auth-session-state";
import { noteSignedInSession } from "@/lib/document-identity";

import { useNetworkStatus } from "./use-network-status";

/**
 * Whether Better Auth's session atom has settled anonymous in this document.
 * Module-level because the atom is: every caller reads the same session, so a
 * component that mounts during a refetch (a navigation from /login to /signup
 * while the tab regains focus) must not see a first load either. Only browser
 * snapshots write it; the server's are always the unresolved initial state.
 *
 * Not the document identity's baseline (lib/document-identity.ts): that one is
 * recorded only by the route guards and the identity watcher, which public
 * pages may not mount, and it says whose cached data the document holds, not
 * what the session atom last settled on.
 */
let confirmedAnonymous = false;

/** The sole application adapter for Better Auth's reactive session atom. */
export function useAuthSession(): AuthSessionState {
  const session = authClient.useSession();
  const isOnline = useNetworkStatus();
  // Idempotent: marks the document private for the back/forward cache before
  // anything renders this session (lib/document-identity.ts).
  if (session.data !== null) noteSignedInSession();

  const result = getAuthSessionState({
    data: session.data,
    isPending: session.isPending,
    isRefetching: session.isRefetching,
    error: session.error,
    isOnline,
    refetch: session.refetch,
    confirmedAnonymous,
  });
  // A fact about the shared atom, not about this render: idempotent, and the
  // same for every caller that reads this snapshot.
  if (typeof window !== "undefined") {
    confirmedAnonymous = rememberConfirmedAnonymous(confirmedAnonymous, result.state);
  }
  return result;
}

/** Forget the settled state, as a new document would. Tests only. */
export function resetAuthSessionMemoryForTests(): void {
  confirmedAnonymous = false;
}
