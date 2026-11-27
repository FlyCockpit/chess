import { useLayoutEffect } from "react";

import {
  isSessionFetchInFlight,
  readSessionIdentity,
  useAuthSession,
} from "@/hooks/use-auth-session";
import type { AuthSessionState } from "@/lib/auth-session-state";
import {
  announceDocumentIdentity,
  confirmDocumentIdentityFresh,
  connectIdentityPeers,
  identityVerificationGeneration,
  isCurrentSessionCheck,
  isDocumentIdentityUnverified,
  markDocumentIdentityUnverified,
  observeDocumentIdentity,
  recheckDocumentIdentity,
  replaceDocument,
  type SessionIdentity,
} from "@/lib/document-identity";

/**
 * `undefined` (session pending or errored) is never acted on: a flaky session
 * check must not reload a signed-in user's page.
 */
export function sessionIdentity(
  state: AuthSessionState<{ user: { id: string } }>["state"],
): SessionIdentity {
  if (state.status === "authenticated") return state.session.user.id;
  if (state.status === "anonymous") return null;
  return undefined;
}

/**
 * The watcher's session checks while it is connected: for a peer tab's
 * announcement, a 401, and an unverified identity (another tab announced a
 * change, or a request got a 401, while no watcher was connected: the chrome
 * shows no account until a check settles it; so does a check of a peer's
 * change or a 401 made while connected that got no fresh answer). Only the
 * newest connected watcher checks (`isCurrentSessionCheck`;
 * `connectIdentityPeers` runs the first check, and hands over to the next
 * watcher when this one disconnects), so two mounted watchers never cancel
 * each other's fetches. Only a check
 * started here can settle that state: Better Auth's refetch cancels any fetch
 * already in flight, so the answer it settles with was asked for after
 * `since`, never inherited from before a newer invalidation. A failed check
 * is retried when the tab regains focus, visibility or the network; one
 * superseded by another fetch still running is followed up (at most 3 times,
 * 250 ms apart). `stop()` drops every pending completion, timer and listener.
 */
function startIdentityChecks(refetch: () => unknown): { stop: () => void } {
  let connected = true;
  let followUp: ReturnType<typeof setTimeout> | undefined;
  /** Checks of this watcher still waiting for their answer. */
  let outstanding = 0;
  const current = () => connected && isCurrentSessionCheck(sessionCheck);
  const check = (superseded = 0): Promise<void> => {
    if (!current()) return Promise.resolve();
    const since = identityVerificationGeneration();
    outstanding++;
    // A rejected refetch is an answer-less check, like a failed one: the atom
    // says what is known.
    return Promise.resolve(refetch())
      .catch(() => {})
      .then(() => {
        outstanding--;
        if (!connected) return;
        const checked = readSessionIdentity();
        if (!isCurrentSessionCheck(sessionCheck)) {
          // A newer watcher took over while this one was asking. A change
          // this check was the only one to look at, answered with nothing
          // fresh, is unverified now, and the newer watcher checks it.
          if (checked === undefined && !isDocumentIdentityUnverified()) {
            markDocumentIdentityUnverified();
            recheckDocumentIdentity();
          }
          return;
        }
        if (!isDocumentIdentityUnverified()) {
          // A peer's change or a 401, checked while connected: a fresh answer
          // reaches the identity effect below. None at all (a failed fetch,
          // which may retain the previous account) leaves the identity
          // unverified, so the chrome and Studio show no account until a
          // retry settles it.
          if (checked !== undefined) return;
          markDocumentIdentityUnverified();
        }
        if (checked === undefined) {
          if (isSessionFetchInFlight() && superseded < 3) {
            clearTimeout(followUp);
            followUp = setTimeout(() => void check(superseded + 1), 250);
          }
          return;
        }
        // A different account replaces the document: a reload, or on an
        // account-free page (the Lab) the account state dropped in place,
        // where the chrome may then show the account just confirmed.
        if (observeDocumentIdentity(checked)) replaceDocument();
        confirmDocumentIdentityFresh(since);
      });
  };
  const sessionCheck = () => check();
  const retry = () => {
    if (isDocumentIdentityUnverified() && document.visibilityState !== "hidden") void check();
  };
  const disconnectPeers = connectIdentityPeers(sessionCheck);
  window.addEventListener("focus", retry);
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", retry);
  return {
    stop: () => {
      // A check still waiting for its answer is dropped with this watcher:
      // until another one answers, nobody has checked that change, so the
      // identity is unverified (masked), and the next watcher takes over.
      const dropped = outstanding > 0 && !isDocumentIdentityUnverified();
      connected = false;
      clearTimeout(followUp);
      window.removeEventListener("focus", retry);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
      disconnectPeers();
      if (dropped) {
        markDocumentIdentityUnverified();
        recheckDocumentIdentity();
      }
    },
  };
}

/**
 * Replaces the document when the signed-in user goes away while a page is
 * open (sign-out in another tab, session expiry or revocation, another account
 * signing in). The identity the document belongs to lives in
 * `lib/document-identity.ts`, not here, so it survives this watcher
 * remounting; the route guards check the same baseline before anything
 * renders. Mounted eagerly by the `_app` shell's frame (pending and loaded),
 * and by the hosted root (`components/identity-boundary.tsx`), lazily when an
 * account-aware page first needs it (`useIdentityBoundaryEnabled`: any `_app`
 * page, the public Studio tab, or an unverified identity), and kept mounted
 * across public navigation from then on.
 *
 * It also connects the other open tabs: an identity this tab confirms (a
 * sign-in included, which Better Auth does not broadcast) makes them check
 * their session, and a request rejected for having no session
 * (`reportSessionRejected`) checks it here.
 */
export function useReloadOnIdentityChange(): void {
  // Raw, never masked: the identity effect below must see the session even
  // while the chrome is held neutral.
  const authSession = useAuthSession({ unmasked: true });
  const identity = sessionIdentity(authSession.state);
  const { refetch } = authSession.actions;

  // Connected first (effects run in order), so the first identity below is
  // already announced to the other tabs.
  useLayoutEffect(() => {
    const watcher = startIdentityChecks(refetch);
    return () => watcher.stop();
  }, [refetch]);

  // Layout effect: replace the document before the browser paints a frame
  // that pairs the new identity's chrome with the old identity's cached data.
  useLayoutEffect(() => {
    if (identity === undefined) return;
    if (observeDocumentIdentity(identity)) {
      replaceDocument();
      return;
    }
    announceDocumentIdentity(identity);
  }, [identity]);
}
