/**
 * Who this document's in-memory private state belongs to: the TanStack Query
 * cache, Zustand stores, module state and every in-flight request callback.
 * It is one identity for the whole life of the document, kept here at module
 * scope rather than in a component, so no layout unmount (a public page, a 404,
 * an error-state reset) can make it forget whose data is in memory.
 *
 * When a confirmed identity differs from it (sign-out in another tab, session
 * expiry or revocation, another account signing in), the document is replaced
 * with a full load: the one reset that drops all of that state at once, and
 * leaves no late mutation callback a cache to write into. On a page that holds
 * no account data (an allowlist, lib/account-free-pages.ts) the account state
 * is dropped in place instead, and the full load waits for the first
 * navigation to any other page, so the visitor's device-local work (the Lab's
 * imported archive) survives. Two places observe
 * the identity: every session route guard (`resolveRouteSession`), before
 * anything under it renders, and the hosted root's watcher
 * (`IdentityBoundary` → `useReloadOnIdentityChange`), for a change while a
 * page is open (public pages included, once it is mounted).
 * docs/auth-and-routing.md § Query cache follows identity.
 *
 * No runtime imports, so the router and the route guards use it without
 * loading Better Auth.
 */
import type { QueryClient } from "@tanstack/react-query";

/** A user id when signed in, `null` when confirmed anonymous, `undefined` while not known. */
export type SessionIdentity = string | null | undefined;

const documentIdentity = {
  /** The identity this document's private state belongs to. */
  baseline: undefined as SessionIdentity,
  /** A different identity was confirmed: this document is being replaced. */
  replaced: false,
  /** An explicit sign-out's own page load is under way. */
  leaving: false,
  /** A signed-in user's private state was in memory at some point. */
  heldPrivateState: false,
  /** The private UI was hidden and the cache dropped, ahead of the reload. */
  quarantined: false,
  /** Bumped when `baseline` changes or account state is discarded. */
  epoch: 0,
  /** `replaceDocument` already started the reload. */
  reloading: false,
  /**
   * Replaced while the page on screen held no account data: the account state
   * was dropped in place, and the full load waits for the next page that may
   * hold some (`replaceDocument`).
   */
  discarded: false,
};

const replaceListeners = new Set<() => void>();
const discardListeners = new Set<() => void>();

/**
 * Whether the page on screen, and the one being navigated to, hold no account
 * data. Registered by the router (`holdsNoAccountData`,
 * lib/account-free-pages.ts); until then every page counts as holding some.
 */
let accountFreePage: () => boolean = () => false;

/** The router registers the account-free-page check. */
export function setAccountFreePage(check: () => boolean): void {
  accountFreePage = check;
}

/**
 * True when a signed-in user's in-memory state must be dropped: the last known
 * identity was a user and the next known identity is a different user or
 * anonymous. Anonymous → signed in is not a leak (an anonymous cache only holds
 * public data), and `undefined` (pending, or a failed check) is never acted on,
 * so a flaky session check never reloads a signed-in user's page.
 */
export function shouldReloadForIdentity(
  lastKnown: SessionIdentity,
  next: SessionIdentity,
): boolean {
  return typeof lastKnown === "string" && next !== undefined && next !== lastKnown;
}

/**
 * Record a confirmed identity: a route guard's server answer or the watcher's
 * session. Returns true when this document's private state belongs to someone
 * else and the document must be replaced; once true, it stays true for the
 * rest of the document.
 */
export function observeDocumentIdentity(next: string | null): boolean {
  // Module state is process-wide on the server: never written there.
  if (typeof window === "undefined") return false;
  if (documentIdentity.replaced) return true;
  if (
    shouldReloadForIdentity(documentIdentity.baseline, next) ||
    (peerChangePending &&
      isAnonymousOnlyRoute() &&
      typeof next === "string" &&
      documentIdentity.baseline !== next)
  ) {
    documentIdentity.replaced = true;
    notifyIdentityListeners();
    return true;
  }
  if (documentIdentity.baseline !== next) {
    documentIdentity.baseline = next;
    documentIdentity.epoch++;
    notifyIdentityListeners();
  }
  if (typeof next === "string") documentIdentity.heldPrivateState = true;
  return false;
}

/** Carry the document's owner, never a freshly switched session's owner. */
export function withExpectedIdentity(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  if (typeof window !== "undefined" && typeof documentIdentity.baseline === "string") {
    result.set("X-Expected-User", documentIdentity.baseline);
  }
  return result;
}

/** Called on render by an anonymous-only page (also covers hydration). Scoped to this URL. */
let anonymousOnlyPath: string | undefined;
let peerChangePending = false;
export function markAnonymousOnlyRoute(): void {
  // `location` is read optionally: server renders and some test windows have none.
  if (typeof window !== "undefined") anonymousOnlyPath = window.location?.pathname;
}

function isAnonymousOnlyRoute(): boolean {
  return anonymousOnlyPath !== undefined && anonymousOnlyPath === window.location?.pathname;
}

/**
 * Intercept before transport callbacks: a form must never receive this failure
 * (or a late response from the discarded document) and paint an inline error.
 * Like a replaced route guard, the old document's request never settles.
 */
export async function guardIdentityResponse(
  response: Response,
  /** Transport epoch captured before sending; only post-discard requests may resume. */
  startedAt?: number,
): Promise<Response> {
  if (response.status === 409) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (
      isIdentityChangedError({ status: 409, ...(body && typeof body === "object" ? body : {}) })
    ) {
      replaceDocument();
    }
  }
  if (
    documentIdentity.quarantined ||
    (isDocumentReplaced() && (!documentIdentity.discarded || startedAt !== documentIdentity.epoch))
  )
    return new Promise<never>(() => {});
  return response;
}

function isIdentityChangedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; code?: unknown; data?: { code?: unknown } };
  return e.status === 409 && (e.code === "IDENTITY_CHANGED" || e.data?.code === "IDENTITY_CHANGED");
}

/**
 * The session adapter (`useAuthSession`) saw a signed-in session: whatever
 * renders it (an account name on a page no guard covers, `verify-email`) is
 * private state for the back/forward cache, even before any guard or the
 * lazily loaded watcher recorded the identity.
 */
export function noteSignedInSession(): void {
  if (typeof window === "undefined") return;
  documentIdentity.heldPrivateState = true;
}

const identityListeners = new Set<() => void>();
let observationRequested = false;

/** An unguarded account control needs the root's lazy identity watcher. */
export function requestIdentityObservation(): void {
  if (typeof window === "undefined" || observationRequested) return;
  observationRequested = true;
  notifyIdentityListeners();
}

export function isIdentityObservationRequested(): boolean {
  return observationRequested;
}

function notifyIdentityListeners(): void {
  for (const listener of identityListeners) listener();
}

/**
 * Subscribe to the document's identity being recorded or replaced (for
 * `useSyncExternalStore`, see `documentAdmits`). Returns the unsubscribe.
 */
export function subscribeDocumentIdentity(listener: () => void): () => void {
  identityListeners.add(listener);
  return () => identityListeners.delete(listener);
}

/**
 * True when `identity` is the one this document's private state belongs to,
 * confirmed by a guard or the watcher, the watcher is connected (so a switch
 * from here on is noticed), and the document is not on its way out. Private UI outside a session guard (the public Studio tab) shows or
 * fetches the signed-in user's data only then: until the lazily loaded
 * watcher has recorded the identity, nothing would notice a switch, and the
 * cache could hold the previous account's answers.
 */
export function documentAdmits(identity: string): boolean {
  return (
    !documentIdentity.replaced &&
    !identityUnverified &&
    documentIdentity.baseline === identity &&
    sessionChecks.length > 0
  );
}

/**
 * Bumped whenever the recorded identity changes or account state is discarded.
 * A session guard reads it before its server probe: an answer that started before a newer
 * identity was recorded (a hover preload sent while signed out, answered
 * after this tab signed in) is out of date: `resolveRouteSession` probes again.
 */
export function documentIdentityEpoch(): number {
  return documentIdentity.epoch;
}

/** A different identity was confirmed and this document is on its way out. */
export function isDocumentReplaced(): boolean {
  return documentIdentity.replaced;
}

/** The document is hidden and sealed pending a full load; no transport may resume. */
export function isDocumentQuarantined(): boolean {
  return documentIdentity.quarantined;
}

/**
 * Run when the document is replaced, before the reload starts: the router
 * drops its QueryClient's data here. Returns the unsubscribe.
 */
export function onDocumentReplaced(listener: () => void): () => void {
  replaceListeners.add(listener);
  return () => replaceListeners.delete(listener);
}

/**
 * Run when the document is replaced on a page that holds no account data,
 * instead of the reload: the router drops its QueryClient's account data here
 * (`discardAccountQueries`). Returns the unsubscribe.
 */
export function onAccountStateDiscarded(listener: () => void): () => void {
  discardListeners.add(listener);
  return () => discardListeners.delete(listener);
}

/**
 * Drop the previous identity's query data from a page that holds no account
 * data, without a reload: every mutation, and every query no mounted
 * component uses (Studio's lists, settings: whatever earlier pages cached),
 * is removed; what is on screen is public (the allowlist's guarantee) and is
 * refreshed, the header's session hint included. A late callback that writes
 * the old identity's data back can only write into a cache no account-free
 * page reads, and the first navigation to any other page replaces the
 * document before that page renders.
 */
export function discardAccountQueries(queryClient: QueryClient): void {
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({ predicate: (query) => query.getObserversCount() === 0 });
  void queryClient.invalidateQueries();
}

/**
 * Drop a replaced document's query data and keep it empty until the reload
 * commits: every query and mutation is removed, and any query a late callback
 * (an A-era mutation's `onSuccess` → `setQueryData`) or a still-mounted
 * observer creates afterwards is removed again as soon as it is added.
 */
export function sealQueryClient(queryClient: QueryClient): void {
  const queries = queryClient.getQueryCache();
  queryClient.getMutationCache().clear();
  queries.clear();
  queries.subscribe((event) => {
    if (event.type === "added") queries.remove(event.query);
  });
}

function hidePage(): void {
  // `display: none` on the root, important: no descendant can opt back in
  // (`visibility: hidden` can be undone by any element that sets itself
  // `visible`). CSSOM, not a style attribute: allowed under the strict
  // style-src CSP.
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty("display", "none", "important");
  }
}

/**
 * Take the previous identity's state out of reach synchronously, ahead of an
 * asynchronous page load (the old page stays up until the new one commits,
 * which can take a while on a slow connection): the page is hidden and the
 * query cache sealed (`onDocumentReplaced`), so nothing of it stays on screen
 * and a late callback can only write into a hidden, discarded document.
 */
function quarantineDocument(): void {
  if (documentIdentity.quarantined) return;
  documentIdentity.quarantined = true;
  hidePage();
  for (const listener of replaceListeners) listener();
}

/**
 * Replace the document with a fresh load of the same URL, where the route
 * guards send the new identity wherever it belongs. Quarantined first. An
 * explicit sign-out already owns the document's navigation (`leaveDocument`
 * to the sign-in page), so it is left to finish; `markExplicitSignOut`'s undo
 * reloads here instead if that sign-out fails.
 *
 * On a page that holds no account data (`setAccountFreePage`), the account
 * state is dropped in place instead (`onAccountStateDiscarded`) and the page
 * stays as it is. The router calls this again before every navigation of a
 * replaced document (`replaceDocumentBeforeNavigation`), and the first one
 * to a page that may hold account data gets the full load of that page.
 */
export function replaceDocument(): void {
  if (typeof window === "undefined") return;
  documentIdentity.replaced = true;
  notifyIdentityListeners();
  if (!documentIdentity.leaving && !documentIdentity.quarantined && accountFreePage()) {
    if (documentIdentity.discarded) return;
    documentIdentity.discarded = true;
    documentIdentity.epoch++;
    for (const listener of discardListeners) listener();
    return;
  }
  quarantineDocument();
  if (documentIdentity.leaving || documentIdentity.reloading) return;
  // Once: every watcher and guard that sees the change ends up here.
  documentIdentity.reloading = true;
  // full-reload:audited — An identity change discards all prior user cache and mounted client state.
  window.location.reload();
}

/**
 * The router's hook before every navigation (`onBeforeNavigate`): a replaced
 * document is replaced again there (`replaceDocument`), so the first
 * navigation of a document kept on an account-free page to a page that may
 * hold account data (Lab → Studio) reloads into that page. The router has
 * the destination by then but its browser history writes the URL a microtask
 * later, so a reload at that point would load the page being left (and drop
 * its device-local work for nothing): the pending URL is written first.
 */
export function replaceDocumentBeforeNavigation(history: { flush(): void }): void {
  if (!documentIdentity.replaced) return;
  history.flush();
  replaceDocument();
}

/**
 * An explicit sign-out's page load, once the sign-out succeeded: quarantine
 * the document, then load `href` (the sign-in page) as a new document with an
 * empty cache.
 */
export function leaveDocument(href: string): void {
  if (typeof window === "undefined") return;
  documentIdentity.replaced = true;
  quarantineDocument();
  // full-reload:audited — Sign-out discards the previous identity's cache and client state.
  window.location.assign(href);
}

type RouteIdentityResolution =
  | { status: "resolved"; session: { user: { id: string } } | null }
  | { status: "error" };

/**
 * A session guard's check, after its server probe and before anything under
 * it loads or renders. A different identity than this document's replaces the
 * document, and the guard never settles, so no page renders the previous
 * identity's cached data even for a frame. A failed probe decides nothing.
 */
export async function admitRouteIdentity(
  resolution: RouteIdentityResolution,
  startedAt: number = documentIdentity.epoch,
  /** `identityVerificationGeneration()` taken before the probe started. */
  since: number = verificationGeneration,
): Promise<void> {
  if (resolution.status !== "resolved" || since !== verificationGeneration) return;
  // A newer identity was recorded while this probe was in flight.
  if (startedAt !== documentIdentity.epoch) return;
  const identity = resolution.session?.user.id ?? null;
  if (!observeDocumentIdentity(identity)) {
    // The server just confirmed this document's own identity.
    confirmDocumentIdentityFresh(since);
    announceDocumentIdentity(identity);
    return;
  }
  replaceDocument();
  await new Promise<never>(() => {});
}

/**
 * Call right before an explicit sign-out that ends in `leaveDocument`,
 * so the watcher doesn't race it with a reload of the signed-out page (an
 * extra load, and a `redirectTo` back to the old user's page). Returns the
 * undo for a sign-out that failed (still signed in here). If the identity
 * changed meanwhile anyway (another tab signed out first), the undo replaces
 * the document at once: nothing else would.
 */
export function markExplicitSignOut(): () => void {
  documentIdentity.leaving = true;
  return () => {
    documentIdentity.leaving = false;
    if (documentIdentity.replaced) replaceDocument();
  };
}

let restoreWatched = false;

/**
 * Installed once per document by the router. A page restored from the
 * back/forward cache is the old document, private state included, frozen
 * without any check since (Back after signing out, after another account
 * signed in, or after the session expired or was revoked meanwhile, would show
 * the previous account's page). So a document that ever held a signed-in
 * user's state is hidden as it enters the cache (the restored frame is blank,
 * never the old page), and on restore it is quarantined and reloaded for the
 * route guards to decide again. An anonymous one is cached and restored as it
 * is.
 */
export function watchDocumentRestore(): void {
  if (typeof window === "undefined" || restoreWatched) return;
  restoreWatched = true;
  const holdsPrivateState = () => documentIdentity.heldPrivateState || documentIdentity.replaced;
  window.addEventListener("pagehide", (event) => {
    if (event.persisted && holdsPrivateState()) hidePage();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !holdsPrivateState()) return;
    documentIdentity.leaving = false;
    quarantineDocument();
    // full-reload:audited — A restored copy may hold a previous identity's private state.
    window.location.reload();
  });
}

/** An API answer that says this request had no valid session (oRPC or Better Auth). */
function isSessionRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; status?: unknown };
  return e.code === "UNAUTHORIZED" || e.status === 401;
}

/** A 404 answer: also what a hidden admin procedure answers a request whose session is gone. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; status?: unknown };
  return e.code === "NOT_FOUND" || e.status === 404;
}

/** This document believes a user is signed in (a guard or the watcher recorded one). */
const believesSignedIn = (): boolean => typeof documentIdentity.baseline === "string";

/**
 * The global error toasts' identity filter. A query rejected for having no
 * session queues one session check instead of a toast (so a session lost
 * elsewhere ends in a document replacement, not one toast per mounted query);
 * a mutation still toasts, since an action must never fail silently. Nothing
 * toasts once the document is being replaced. True: skip the toast.
 *
 * Hidden admin procedures (`adminOr404Procedure`) answer a lost session with
 * 404, by design, never 401: so while this document believes a user is signed
 * in, a 404 checks the session too (it toasts, or not, as before). A still
 * valid session changes nothing.
 */
export function skipErrorToastForIdentity(error: unknown, kind: "query" | "mutation"): boolean {
  if (isIdentityChangedError(error)) replaceDocument();
  if (documentIdentity.replaced) return true;
  if (isNotFound(error)) {
    if (believesSignedIn()) reportSessionRejected();
    return false;
  }
  if (!isSessionRejection(error)) return false;
  reportSessionRejected();
  return kind === "query";
}

/**
 * Better Auth answered one of this tab's requests with an error status (the
 * auth client's `onError`). A 401 on an account action (Settings' profile
 * save, `updateUser`, on a session lost elsewhere) checks the session like an
 * oRPC 401. Only while this document believes a user is signed in: a wrong
 * password on the sign-in page is a 401 too, and says nothing about a session.
 */
export function reportAuthErrorStatus(status: number): void {
  if (status === 401 && believesSignedIn()) reportSessionRejected();
}

/**
 * Another tab announced an identity change (or a request was refused for
 * having no session) while no watcher could check it: Better Auth's atom may
 * still hold the previous account. Until a fresh check (a guard's server
 * probe, or a refetch a watcher starts when it connects: the `_app` shell's,
 * or the root's lazily loaded one, which `useIdentityBoundaryEnabled` loads
 * for exactly this) confirms this document's identity, `useAuthSession()`
 * reports `pending`, so no chrome shows that stale account, even on a page a
 * guard didn't admit (a guard error, an unguarded page, a public page).
 */
let identityUnverified = false;
/** Bumped by every invalidation, so an answer that predates one can't settle it. */
let verificationGeneration = 0;
const verificationListeners = new Set<() => void>();

function setIdentityUnverified(next: boolean): void {
  // Module state is process-wide on the server: never written there.
  if (typeof window === "undefined" || identityUnverified === next) return;
  identityUnverified = next;
  for (const listener of verificationListeners) listener();
  // `documentAdmits` depends on it too.
  notifyIdentityListeners();
}

/**
 * Leave the identity unverified (the chrome shows no account) until a fresh
 * check settles it. Also for the watcher, when its check of a peer's change
 * or a 401 got no fresh answer (a failed fetch that may still retain the
 * previous account).
 */
export function markDocumentIdentityUnverified(): void {
  if (typeof window === "undefined") return;
  verificationGeneration++;
  setIdentityUnverified(true);
}

/** Taken before a check starts; pass it to `confirmDocumentIdentityFresh`. */
export function identityVerificationGeneration(): number {
  return verificationGeneration;
}

/**
 * A fresh check confirmed this document's identity: the chrome may show it
 * again, unless the identity was invalidated again after that check started
 * (`since`, from `identityVerificationGeneration()`): its answer may predate
 * the newer change.
 */
export function confirmDocumentIdentityFresh(since: number): void {
  if (since !== verificationGeneration) return;
  peerChangePending = false;
  setIdentityUnverified(false);
}

export function isDocumentIdentityUnverified(): boolean {
  return identityUnverified;
}

export function subscribeIdentityVerification(listener: () => void): () => void {
  verificationListeners.add(listener);
  return () => verificationListeners.delete(listener);
}

/**
 * The connected watchers' session checks, newest last (the `_app` shell's and
 * the root's may both be mounted for a moment); the newest one runs.
 */
const sessionChecks: { check: () => unknown }[] = [];
const currentSessionCheck = (): (() => unknown) | undefined => sessionChecks.at(-1)?.check;
let sessionCheckPending = false;

/**
 * A request was rejected for having no session: ask Better Auth to check the
 * session once (however many queries failed together), so a session lost
 * elsewhere replaces the document instead of leaving one error toast per
 * query. With no watcher connected yet (the root's loads lazily), the
 * identity is marked unverified instead: the chrome shows no account, and the
 * next watcher to connect checks it.
 */
export function reportSessionRejected(): void {
  const check = currentSessionCheck();
  if (!check) {
    markDocumentIdentityUnverified();
    return;
  }
  if (sessionCheckPending) return;
  // One check at a time, until it settles: 401s that arrive in separate
  // network tasks while it runs share it.
  sessionCheckPending = true;
  void Promise.resolve(check())
    .catch(() => {})
    .finally(() => {
      sessionCheckPending = false;
    });
}

/** The channel the open tabs use to tell each other the signed-in identity changed. */
const IDENTITY_CHANNEL = "app-session-identity";

type IdentityChannel = Pick<BroadcastChannel, "postMessage"> & {
  onmessage: ((event: MessageEvent) => void) | null;
};

const openBroadcastChannel = (): IdentityChannel | undefined =>
  typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(IDENTITY_CHANNEL);

let openChannel = openBroadcastChannel;
let peers: IdentityChannel | undefined;
let peersOpened = false;
let announced: SessionIdentity;

/**
 * The document's one channel to the other open tabs, opened on first use and
 * kept for the document's life, so an announcement never depends on which
 * layout is mounted. Better Auth tells the other tabs about a sign-out, but not
 * about a sign-in: a tab where an identity is confirmed announces it here, and
 * peers share one session check for a conflicting identity or a change hint.
 * Unversioned peer confirmations may have crossed newer local confirmations.
 */
function peerChannel(): IdentityChannel | undefined {
  if (typeof window === "undefined") return undefined;
  if (!peersOpened) {
    peersOpened = true;
    peers = openChannel();
    if (peers) {
      peers.onmessage = (event) => {
        if (isDocumentReplaced()) return;
        const message = event.data;
        if (
          message?.kind === "identity" &&
          (message.id === null || typeof message.id === "string")
        ) {
          // Same id costs nothing and cannot certify this tab's cookie.
          if (documentIdentity.baseline === message.id) return;
          // A peer's unversioned confirmation may predate our own. Let the
          // coalesced server check decide whether this document must reload.
        } else if (message?.kind !== "session-changed") return;
        // The first hint invalidates even a watcher-owned check started by
        // an earlier 404/401. Its completion queues a fresh probe. Further
        // hints for this switch share that probe and its retry cooldown.
        if (!peerChangePending || !currentSessionCheck()) {
          markDocumentIdentityUnverified();
        }
        peerChangePending = true;
        reportSessionRejected();
        for (const listener of peerSessionListeners) listener();
      };
    }
  }
  return peers;
}

const peerSessionListeners = new Set<() => void>();

/**
 * Run whenever another tab announces a session change (a sign-in, a sign-out,
 * another account), after the watcher's own check is queued: the public
 * header refreshes its session hint, the sign-in page re-runs its guard.
 * Opens the peer channel. Returns the unsubscribe.
 */
export function onPeerSessionChange(listener: () => void): () => void {
  peerSessionListeners.add(listener);
  peerChannel();
  return () => peerSessionListeners.delete(listener);
}

function runSessionCheck(check: () => unknown): void {
  try {
    void Promise.resolve(check()).catch(() => {});
  } catch {
    // A check that throws decides nothing; the next event checks again.
  }
}

/**
 * Run the current watcher's session check now, if one is connected: after a
 * watcher marked the identity unverified for a check it can no longer finish
 * itself (it is unmounting, or a newer watcher took over meanwhile).
 */
export function recheckDocumentIdentity(): void {
  const check = currentSessionCheck();
  if (check) runSessionCheck(check);
}

/**
 * Whether `checkSession` is the connected watcher whose checks run now (the
 * newest). Only it checks an unverified identity, so two mounted watchers
 * never cancel each other's session fetches.
 */
export function isCurrentSessionCheck(checkSession: () => unknown): boolean {
  return currentSessionCheck() === checkSession;
}

/**
 * Connect a watcher's session check: run for a peer tab's announcement and
 * for a 401 (`reportSessionRejected`), and at once while the identity is
 * unverified (whatever arrived before any watcher was connected). The newest
 * connected watcher runs the checks; when it disconnects while the identity
 * is still unverified, the one below takes over and checks again, so a check
 * dropped with its watcher is never the last one. Returns the disconnect.
 */
export function connectIdentityPeers(checkSession: () => unknown): () => void {
  const connection = { check: checkSession };
  sessionChecks.push(connection);
  peerChannel();
  notifyIdentityListeners();
  if (identityUnverified) runSessionCheck(checkSession);
  return () => {
    const index = sessionChecks.indexOf(connection);
    if (index === -1) return;
    const wasCurrent = index === sessionChecks.length - 1;
    sessionChecks.splice(index, 1);
    notifyIdentityListeners();
    const next = currentSessionCheck();
    if (wasCurrent && next && identityUnverified) runSessionCheck(next);
  };
}

/**
 * Tell the other tabs about a confirmed identity this document has not
 * announced yet. Called by the watcher and by every session guard
 * (`admitRouteIdentity`), so a sign-in whose destination page never mounts the
 * watcher (a hidden admin 404 on a fresh document) is still announced.
 */
export function announceDocumentIdentity(identity: string | null): void {
  if (identity === announced) return;
  const channel = peerChannel();
  if (!channel) return;
  announced = identity;
  channel.postMessage({ kind: "identity", id: identity });
}

/**
 * Tell the other tabs this document's session just changed (a sign-in, a
 * 2FA verification, a sign-up), before the flow navigates anywhere: the auth
 * client calls it on Better Auth's session signal, so the announcement
 * doesn't depend on the destination page running a guard or the watcher.
 */
export function announceSessionChange(): void {
  peerChannel()?.postMessage({ kind: "session-changed" });
}

/** Tests only: a fresh document, with `open` as its peer-channel factory. */
export function resetDocumentIdentityForTests(
  open: () => IdentityChannel | undefined = openBroadcastChannel,
): void {
  Object.assign(documentIdentity, {
    baseline: undefined,
    replaced: false,
    leaving: false,
    heldPrivateState: false,
    quarantined: false,
    epoch: 0,
    reloading: false,
    discarded: false,
  });
  replaceListeners.clear();
  discardListeners.clear();
  peerSessionListeners.clear();
  accountFreePage = () => false;
  identityListeners.clear();
  observationRequested = false;
  sessionChecks.length = 0;
  sessionCheckPending = false;
  identityUnverified = false;
  verificationGeneration = 0;
  verificationListeners.clear();
  openChannel = open;
  peers = undefined;
  peersOpened = false;
  announced = undefined;
  restoreWatched = false;
  anonymousOnlyPath = undefined;
  peerChangePending = false;
}
