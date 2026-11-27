import { MutationCache, QueryCache, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  admitRouteIdentity,
  announceDocumentIdentity,
  announceSessionChange,
  confirmDocumentIdentityFresh,
  connectIdentityPeers,
  discardAccountQueries,
  documentAdmits,
  documentIdentityEpoch,
  identityVerificationGeneration,
  isCurrentSessionCheck,
  isDocumentIdentityUnverified,
  isDocumentReplaced,
  leaveDocument,
  markAnonymousOnlyRoute,
  markExplicitSignOut,
  noteSignedInSession,
  observeDocumentIdentity,
  onAccountStateDiscarded,
  onDocumentReplaced,
  onPeerSessionChange,
  replaceDocument,
  reportAuthErrorStatus,
  reportSessionRejected,
  resetDocumentIdentityForTests,
  sealQueryClient,
  setAccountFreePage,
  shouldReloadForIdentity,
  skipErrorToastForIdentity,
  subscribeDocumentIdentity,
  subscribeIdentityVerification,
  watchDocumentRestore,
  withExpectedIdentity,
} from "./document-identity";

const reload = vi.fn();
let pageshow: ((event: { persisted: boolean }) => void) | undefined;
let pagehide: ((event: { persisted: boolean }) => void) | undefined;
const assign = vi.fn();
/** The root element's inline style, as `hidePage` writes it. */
const root = {
  style: {
    display: "",
    priority: "",
    setProperty(name: string, value: string, priority: string) {
      if (name === "display") Object.assign(this, { display: value, priority });
    },
  },
};
const hidden = () => root.style.display === "none" && root.style.priority === "important";

beforeEach(() => {
  resetDocumentIdentityForTests(() => undefined);
  reload.mockReset();
  assign.mockReset();
  Object.assign(root.style, { display: "", priority: "" });
  pageshow = undefined;
  pagehide = undefined;
  vi.stubGlobal("window", {
    location: { reload, assign },
    addEventListener: (type: string, listener: (event: { persisted: boolean }) => void) => {
      if (type === "pageshow") pageshow = listener;
      if (type === "pagehide") pagehide = listener;
    },
  });
  vi.stubGlobal("document", { documentElement: root });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const resolved = (id: string | null) =>
  ({ status: "resolved", session: id === null ? null : { user: { id } } }) as const;

/** Whether a promise settled within a few macrotasks. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return settled;
}

const unauthorized = () =>
  Object.assign(new Error("no session"), { code: "UNAUTHORIZED", status: 401 });

describe("shouldReloadForIdentity", () => {
  it("only reloads when a signed-in user goes away", () => {
    expect(shouldReloadForIdentity(undefined, "u1")).toBe(false);
    expect(shouldReloadForIdentity("u1", undefined)).toBe(false);
    expect(shouldReloadForIdentity("u1", "u1")).toBe(false);
    expect(shouldReloadForIdentity(null, null)).toBe(false);
    // Anonymous → signed in carries only public data; no reload.
    expect(shouldReloadForIdentity(null, "u1")).toBe(false);
    expect(shouldReloadForIdentity("u1", null)).toBe(true);
    expect(shouldReloadForIdentity("u1", "u2")).toBe(true);
  });
});

describe("observeDocumentIdentity", () => {
  it("A → sign-out → B replaces the document at the sign-out, and stays replaced", () => {
    expect(observeDocumentIdentity("a")).toBe(false);
    expect(observeDocumentIdentity("a")).toBe(false);
    expect(observeDocumentIdentity(null)).toBe(true);
    expect(isDocumentReplaced()).toBe(true);
    // The account that signs in next still finds a document on its way out.
    expect(observeDocumentIdentity("b")).toBe(true);
  });

  it("A → B directly replaces the document", () => {
    expect(observeDocumentIdentity("a")).toBe(false);
    expect(observeDocumentIdentity("b")).toBe(true);
  });

  it("signing in on an anonymous document keeps it, then guards the new account", () => {
    expect(observeDocumentIdentity(null)).toBe(false);
    expect(observeDocumentIdentity("a")).toBe(false);
    expect(observeDocumentIdentity("b")).toBe(true);
  });

  it("is never written during SSR (module state is process-wide there)", () => {
    vi.unstubAllGlobals();
    expect(observeDocumentIdentity("a")).toBe(false);
    expect(observeDocumentIdentity("b")).toBe(false);
  });
});

describe("admitRouteIdentity (session guards)", () => {
  it("admits the document's own identity and a failed probe", async () => {
    expect(await settles(admitRouteIdentity(resolved("a")))).toBe(true);
    expect(await settles(admitRouteIdentity({ status: "error" }))).toBe(true);
    expect(await settles(admitRouteIdentity(resolved("a")))).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("catches a switch made while no `_app` page (and so no watcher) was open", async () => {
    // An `_app` page as A, then a public page: the shell (and its watcher)
    // unmounts. Another account signs in meanwhile. Back into the app, the
    // guard sees B before anything renders: the document reloads and the
    // guard never settles, so no page under it shows A's cache.
    expect(await settles(admitRouteIdentity(resolved("a")))).toBe(true);
    expect(await settles(admitRouteIdentity(resolved("b")))).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("catches a sign-out elsewhere on the next anonymous-only page (login)", async () => {
    await admitRouteIdentity(resolved("a"));
    expect(await settles(admitRouteIdentity(resolved(null)))).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("documentAdmits (private UI outside a guard)", () => {
  it("admits an account only once it is recorded and watched, never on a replaced document", () => {
    const changed = vi.fn();
    subscribeDocumentIdentity(changed);
    expect(documentAdmits("a")).toBe(false);
    observeDocumentIdentity(null);
    expect(changed).toHaveBeenCalledTimes(1);
    // A guard recorded A, but the lazily loaded watcher is not connected
    // yet: nothing would notice a switch, so nothing is admitted.
    observeDocumentIdentity("a");
    expect(changed).toHaveBeenCalledTimes(2);
    expect(documentAdmits("a")).toBe(false);
    const disconnect = connectIdentityPeers(vi.fn());
    expect(changed).toHaveBeenCalledTimes(3);
    expect(documentAdmits("a")).toBe(true);
    // The same identity again changes nothing.
    observeDocumentIdentity("a");
    expect(changed).toHaveBeenCalledTimes(3);
    expect(documentAdmits("b")).toBe(false);
    disconnect();
    expect(documentAdmits("a")).toBe(false);
    connectIdentityPeers(vi.fn());
    observeDocumentIdentity("b");
    expect(documentAdmits("a")).toBe(false);
    expect(documentAdmits("b")).toBe(false);
  });

  it("marks a document that rendered a signed-in session as private for the back/forward cache", () => {
    watchDocumentRestore();
    // No guard or watcher recorded anything yet (a fresh verify-email page).
    noteSignedInSession();
    pagehide?.({ persisted: true });
    expect(hidden()).toBe(true);
    pageshow?.({ persisted: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("out-of-date guard probes", () => {
  it("a probe sent before this tab signed in decides nothing once it answers", async () => {
    // A hover preload of the sign-up page probes while signed out; this tab
    // signs in as A before the answer arrives.
    connectIdentityPeers(vi.fn());
    observeDocumentIdentity(null);
    const startedAt = documentIdentityEpoch();
    observeDocumentIdentity("a");
    expect(await settles(admitRouteIdentity(resolved(null), startedAt))).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(isDocumentReplaced()).toBe(false);
    expect(documentAdmits("a")).toBe(true);
    // A probe sent after it still catches a real sign-out.
    expect(await settles(admitRouteIdentity(resolved(null), documentIdentityEpoch()))).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("explicit sign-out", () => {
  it("a failed sign-out after the identity changed anyway replaces the document", () => {
    observeDocumentIdentity("a");
    const undo = markExplicitSignOut();
    // Another tab's sign-out lands first; this tab's own request then fails.
    expect(observeDocumentIdentity(null)).toBe(true);
    replaceDocument();
    expect(reload).not.toHaveBeenCalled();
    undo();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a successful sign-out quarantines the document before loading the sign-in page", () => {
    const seal = vi.fn();
    onDocumentReplaced(seal);
    observeDocumentIdentity("a");
    markExplicitSignOut();
    // The signed-out session is seen first: hidden and sealed, no reload.
    expect(observeDocumentIdentity(null)).toBe(true);
    replaceDocument();
    expect(hidden()).toBe(true);
    expect(seal).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    leaveDocument("/en-US/login");
    expect(assign).toHaveBeenCalledWith("/en-US/login");
    expect(seal).toHaveBeenCalledTimes(1);
  });

  it("leaveDocument quarantines even before the session change is seen", () => {
    const seal = vi.fn();
    onDocumentReplaced(seal);
    observeDocumentIdentity("a");
    markExplicitSignOut();
    leaveDocument("/en-US/login");
    expect(hidden()).toBe(true);
    expect(seal).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("hides a signed-in page as it enters the back/forward cache, and reloads it on restore", () => {
    const seal = vi.fn();
    onDocumentReplaced(seal);
    watchDocumentRestore();
    observeDocumentIdentity("a");
    // A normal unload (not cached) leaves the page alone.
    pagehide?.({ persisted: false });
    expect(hidden()).toBe(false);
    pagehide?.({ persisted: true });
    expect(hidden()).toBe(true);
    // Another account signs in meanwhile; Back restores this frozen copy.
    pageshow?.({ persisted: true });
    expect(seal).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("restores an anonymous page from the back/forward cache as it is", () => {
    watchDocumentRestore();
    observeDocumentIdentity(null);
    pagehide?.({ persisted: true });
    pageshow?.({ persisted: true });
    expect(hidden()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads any restored copy that held a signed-in user's state", () => {
    watchDocumentRestore();
    pageshow?.({ persisted: true });
    expect(reload).not.toHaveBeenCalled();
    observeDocumentIdentity(null);
    pageshow?.({ persisted: true });
    expect(reload).not.toHaveBeenCalled();
    // Signed in, then frozen in the back/forward cache with no identity
    // change seen: the session may have expired or been revoked meanwhile.
    observeDocumentIdentity("a");
    pageshow?.({ persisted: false });
    expect(reload).not.toHaveBeenCalled();
    pageshow?.({ persisted: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads a restored copy after a sign-out or an identity change", () => {
    watchDocumentRestore();
    observeDocumentIdentity("a");
    markExplicitSignOut();
    observeDocumentIdentity("b");
    pageshow?.({ persisted: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("global error toasts", () => {
  function appClient(toast: (kind: string) => void) {
    return new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      queryCache: new QueryCache({
        onError: (error) => {
          if (skipErrorToastForIdentity(error, "query")) return;
          toast("query");
        },
      }),
      mutationCache: new MutationCache({
        onError: (error) => {
          if (skipErrorToastForIdentity(error, "mutation")) return;
          toast("mutation");
        },
      }),
    });
  }

  it("401s arriving apart while a session check runs share it", async () => {
    let finish!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    connectIdentityPeers(check);
    reportSessionRejected();
    await new Promise((r) => setTimeout(r, 0));
    reportSessionRejected();
    await new Promise((r) => setTimeout(r, 0));
    reportSessionRejected();
    expect(check).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    reportSessionRejected();
    await new Promise((r) => setTimeout(r, 0));
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("a session lost elsewhere: no 401 toast storm, one session check", async () => {
    const toast = vi.fn();
    const check = vi.fn();
    connectIdentityPeers(check);
    const client = appClient(toast);
    await Promise.allSettled(
      ["kbs", "documents", "members", "tokens", "settings"].map((key) =>
        client.fetchQuery({ queryKey: [key], queryFn: () => Promise.reject(unauthorized()) }),
      ),
    );
    await Promise.resolve();
    expect(toast).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("still toasts a failed action, and any other query error", async () => {
    const toast = vi.fn();
    connectIdentityPeers(vi.fn());
    const client = appClient(toast);
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(unauthorized()) })
      .execute(undefined)
      .catch(() => {});
    await client
      .fetchQuery({ queryKey: ["x"], queryFn: () => Promise.reject(new Error("boom")) })
      .catch(() => {});
    expect(toast.mock.calls).toEqual([["mutation"], ["query"]]);
  });

  it("a mutation whose response arrives after the switch cannot write A's data back", async () => {
    const toast = vi.fn();
    const client = appClient(toast);
    onDocumentReplaced(() => sealQueryClient(client));
    observeDocumentIdentity("a");
    client.setQueryData(["documents"], ["A's private document"]);
    let respond!: (value: { name: string }) => void;
    let fail!: (error: Error) => void;
    const save = client.getMutationCache().build(client, {
      mutationFn: () =>
        new Promise<{ name: string }>((resolve) => {
          respond = resolve;
        }),
      onSuccess: (data: { name: string }) => client.setQueryData(["settings"], data),
    });
    const late = save.execute(undefined);
    const exported = client
      .getMutationCache()
      .build(client, {
        mutationFn: () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      })
      .execute(undefined)
      .catch(() => {});

    // mutationFn starts after a microtask.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Account B is confirmed while both requests are in flight. Before the
    // (asynchronous) reload starts, the page is hidden and the cache emptied;
    // A's late write is dropped as soon as it lands, and a late failure
    // doesn't toast.
    expect(observeDocumentIdentity("b")).toBe(true);
    replaceDocument();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(hidden()).toBe(true);
    expect(client.getQueryData(["documents"])).toBeUndefined();
    respond({ name: "A's settings" });
    fail(new Error("late"));
    await late;
    await exported;
    await new Promise((r) => setTimeout(r, 0));
    expect(client.getQueryData(["settings"])).toBeUndefined();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(isDocumentReplaced()).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("pages that hold no account data", () => {
  it("drop the account state in place, and reload at the first navigation to any other page", async () => {
    const client = new QueryClient();
    let accountFree = true;
    setAccountFreePage(() => accountFree);
    onDocumentReplaced(() => sealQueryClient(client));
    onAccountStateDiscarded(() => discardAccountQueries(client));
    observeDocumentIdentity("a");
    // Studio's list, cached before the visitor opened the Lab tab.
    client.setQueryData(["studio"], ["A's draft"]);
    // The header's session hint, on screen.
    const hint = vi.fn(async () => true);
    const unsubscribe = new QueryObserver(client, { queryKey: ["hint"], queryFn: hint }).subscribe(
      () => {},
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(hint).toHaveBeenCalledTimes(1);

    // A signs out in another tab while the Lab is open.
    expect(observeDocumentIdentity(null)).toBe(true);
    replaceDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(hidden()).toBe(false);
    expect(client.getQueryData(["studio"])).toBeUndefined();
    // What is on screen (public) stays, and is asked again.
    expect(client.getQueryCache().find({ queryKey: ["hint"] })).toBeDefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(hint).toHaveBeenCalledTimes(2);
    // Private UI outside a guard never admits anyone on this document.
    expect(documentAdmits("a")).toBe(false);
    // Another account later: still in place, nothing dropped twice.
    replaceDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(hint).toHaveBeenCalledTimes(2);

    // The visitor opens Studio (or any page that may hold account data).
    accountFree = false;
    replaceDocument();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(hidden()).toBe(true);
    unsubscribe();
  });

  it("an explicit sign-out still owns its navigation", () => {
    setAccountFreePage(() => true);
    observeDocumentIdentity("a");
    markExplicitSignOut();
    expect(observeDocumentIdentity(null)).toBe(true);
    replaceDocument();
    expect(hidden()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("session checks for answers that are not 401", () => {
  const notFound = () => Object.assign(new Error("Not found"), { code: "NOT_FOUND", status: 404 });

  it("a hidden admin procedure's 404 checks the session while signed in, and still toasts", async () => {
    const check = vi.fn();
    connectIdentityPeers(check);
    // Anonymous: a missing public game is only a 404.
    observeDocumentIdentity(null);
    expect(skipErrorToastForIdentity(notFound(), "query")).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(check).not.toHaveBeenCalled();
    observeDocumentIdentity("a");
    expect(skipErrorToastForIdentity(notFound(), "query")).toBe(false);
    expect(skipErrorToastForIdentity(notFound(), "mutation")).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("a Better Auth 401 checks the session only while signed in", async () => {
    const check = vi.fn();
    connectIdentityPeers(check);
    // A wrong password on the sign-in page.
    observeDocumentIdentity(null);
    reportAuthErrorStatus(401);
    await new Promise((r) => setTimeout(r, 0));
    expect(check).not.toHaveBeenCalled();
    // Settings' profile save after a sign-out elsewhere.
    observeDocumentIdentity("a");
    reportAuthErrorStatus(400);
    reportAuthErrorStatus(401);
    await new Promise((r) => setTimeout(r, 0));
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("other tabs", () => {
  function fakeChannel() {
    return {
      postMessage: vi.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null,
    };
  }

  it("announces each newly confirmed identity once, and checks the session on a peer's", async () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    const check = vi.fn();
    const disconnect = connectIdentityPeers(check);
    announceDocumentIdentity(null);
    announceDocumentIdentity("a");
    announceDocumentIdentity("a");
    expect(channel.postMessage).toHaveBeenCalledTimes(2);
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(check).toHaveBeenCalledTimes(1);
    // Without a watcher, a peer's announcement or a 401 checks nothing yet,
    // but is not lost: the identity is left unverified, for the next watcher
    // to check when it connects (useReloadOnIdentityChange).
    disconnect();
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    reportSessionRejected();
    expect(check).toHaveBeenCalledTimes(1);
    expect(isDocumentIdentityUnverified()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("a peer's announcement or a 401 with no watcher connected leaves the identity unverified", async () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    const changed = vi.fn();
    subscribeIdentityVerification(changed);
    observeDocumentIdentity("a");
    announceDocumentIdentity("a");
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    // A guard's server answer for the same account confirms it.
    await admitRouteIdentity(resolved("a"));
    expect(isDocumentIdentityUnverified()).toBe(false);
    reportSessionRejected();
    expect(isDocumentIdentityUnverified()).toBe(true);
  });

  it("an unverified identity admits no private UI until it is confirmed", async () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    const disconnect = connectIdentityPeers(vi.fn());
    await admitRouteIdentity(resolved("a"));
    expect(documentAdmits("a")).toBe(true);
    disconnect();
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    const admits = vi.fn();
    subscribeDocumentIdentity(admits);
    connectIdentityPeers(vi.fn());
    expect(documentAdmits("a")).toBe(false);
    confirmDocumentIdentityFresh(identityVerificationGeneration());
    expect(admits).toHaveBeenCalled();
    expect(documentAdmits("a")).toBe(true);
  });

  it("an unverified identity is checked by the newest watcher only, and handed over when it disconnects", () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    announceDocumentIdentity(null);
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(isDocumentIdentityUnverified()).toBe(true);
    // The root's watcher connects (checks at once), then the shell's (now
    // the one that checks).
    const root = vi.fn();
    const shell = vi.fn();
    connectIdentityPeers(root);
    expect(root).toHaveBeenCalledTimes(1);
    const disconnectShell = connectIdentityPeers(shell);
    expect(shell).toHaveBeenCalledTimes(1);
    expect(isCurrentSessionCheck(shell)).toBe(true);
    expect(isCurrentSessionCheck(root)).toBe(false);
    // The shell unmounts with its check unanswered: the root checks again.
    disconnectShell();
    expect(root).toHaveBeenCalledTimes(2);
    expect(isCurrentSessionCheck(root)).toBe(true);
  });

  it("a peer's announcement with a watcher connected still outdates earlier answers", () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    const check = vi.fn();
    connectIdentityPeers(check);
    const before = identityVerificationGeneration();
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(check).toHaveBeenCalledTimes(1);
    expect(identityVerificationGeneration()).not.toBe(before);
    // Mask the old account until the shared server check answers.
    expect(isDocumentIdentityUnverified()).toBe(true);
  });

  it("an answer that predates a newer invalidation settles nothing", async () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    observeDocumentIdentity("a");
    announceDocumentIdentity("a");
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    // A guard's probe starts, then another tab announces again mid-probe.
    const since = identityVerificationGeneration();
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await admitRouteIdentity(resolved("a"), documentIdentityEpoch(), since);
    expect(isDocumentIdentityUnverified()).toBe(true);
    confirmDocumentIdentityFresh(since);
    expect(isDocumentIdentityUnverified()).toBe(true);
    confirmDocumentIdentityFresh(identityVerificationGeneration());
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("an identity announced across a remount of the watcher is not announced twice", () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    connectIdentityPeers(vi.fn())();
    announceDocumentIdentity("a");
    connectIdentityPeers(vi.fn());
    announceDocumentIdentity("a");
    expect(channel.postMessage).toHaveBeenCalledTimes(1);
  });

  it("tells listeners about a peer's session change, after queueing the watcher's check", () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    const order: string[] = [];
    connectIdentityPeers(() => order.push("check"));
    const unsubscribe = onPeerSessionChange(() => order.push("listener"));
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(order).toEqual(["check", "listener"]);
    unsubscribe();
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(order).toEqual(["check", "listener"]); // duplicate hint joins the pending check
  });

  it("a session change made here is announced before the flow navigates", () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    // Every time: a sign-in, then a 2FA verification, each is news to peers.
    announceSessionChange();
    announceSessionChange();
    expect(channel.postMessage).toHaveBeenCalledTimes(2);
  });

  it("a guard announces a sign-in whose page never mounts the `_app` shell", async () => {
    // Window 2 signs in as B and lands on a hidden admin page: the guard
    // confirms B and renders a public 404, so no watcher ever runs there.
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    expect(await settles(admitRouteIdentity(resolved("b")))).toBe(true);
    expect(channel.postMessage).toHaveBeenCalledTimes(1);
    // A replaced document announces nothing: it is on its way out.
    expect(await settles(admitRouteIdentity(resolved("c")))).toBe(false);
    expect(channel.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("expected document identity", () => {
  it("uses the baseline even after an unrelated cookie change, preserving other headers", () => {
    expect(withExpectedIdentity().has("X-Expected-User")).toBe(false);
    observeDocumentIdentity(null);
    expect(withExpectedIdentity().has("X-Expected-User")).toBe(false);
    observeDocumentIdentity("a");
    const headers = withExpectedIdentity({ "x-csrf-token": "token" });
    expect(headers.get("X-Expected-User")).toBe("a");
    expect(headers.get("x-csrf-token")).toBe("token");
  });
  it("recognizes a server-confirmed identity conflict in the global toast filters", () => {
    observeDocumentIdentity("a");
    expect(skipErrorToastForIdentity({ status: 409, code: "IDENTITY_CHANGED" }, "mutation")).toBe(
      true,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("confirmed peer messages", () => {
  function channel() {
    const peer = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
    };
    resetDocumentIdentityForTests(() => peer);
    return { receive: (data: unknown) => peer.onmessage?.({ data } as MessageEvent) };
  }
  it.each(["b", null])("a different peer identity (%s) waits for a server check", async (id) => {
    const peer = channel();
    observeDocumentIdentity("a");
    let finish!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    connectIdentityPeers(check);
    peer.receive({ kind: "identity", id });
    expect(reload).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
    expect(isDocumentIdentityUnverified()).toBe(true);
    // Only the check's server answer can decide to replace the document.
    if (observeDocumentIdentity(id)) replaceDocument();
    finish();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("same identity is ignored and does not certify an unverified cookie", () => {
    const peer = channel();
    observeDocumentIdentity("a");
    reportSessionRejected();
    const check = vi.fn();
    connectIdentityPeers(check);
    check.mockClear(); // connecting checks the already-unverified identity
    peer.receive({ kind: "identity", id: "a" });
    expect(check).not.toHaveBeenCalled();
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
  it("a matching peer identity leaves local sign-in navigation on /login alone", () => {
    const peer = channel();
    window.location.pathname = "/en-US/login";
    markAnonymousOnlyRoute();
    observeDocumentIdentity(null);
    // Local sign-in confirms A before the router finishes leaving /login.
    observeDocumentIdentity("a");
    reportSessionRejected();
    const check = vi.fn();
    connectIdentityPeers(check);
    const since = identityVerificationGeneration();
    check.mockClear();
    peer.receive({ kind: "identity", id: "a" });
    expect(reload).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(identityVerificationGeneration()).toBe(since);
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(withExpectedIdentity().get("X-Expected-User")).toBe("a");
  });
  it("one switch shares one check across hints and conflicting identities", async () => {
    const peer = channel();
    observeDocumentIdentity("a");
    let finish!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    connectIdentityPeers(check);
    peer.receive({ kind: "session-changed" });
    peer.receive({ kind: "session-changed" });
    expect(check).toHaveBeenCalledTimes(1);
    const since = identityVerificationGeneration();
    peer.receive({ kind: "identity", id: "b" });
    expect(reload).not.toHaveBeenCalled();
    expect(identityVerificationGeneration()).toBe(since);
    expect(check).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
  });
  it("a delayed hint confirming the local sign-in keeps its pending /login navigation", async () => {
    const peer = channel();
    window.location.pathname = "/en-US/login";
    markAnonymousOnlyRoute();
    observeDocumentIdentity(null);
    observeDocumentIdentity("b");
    const check = vi.fn(async () => {
      const since = identityVerificationGeneration();
      await Promise.resolve();
      if (observeDocumentIdentity("b")) replaceDocument();
      else confirmDocumentIdentityFresh(since);
    });
    connectIdentityPeers(check);
    peer.receive({ kind: "session-changed" });
    expect(isDocumentIdentityUnverified()).toBe(true);
    await check.mock.results[0]?.value;
    expect(check).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(isDocumentReplaced()).toBe(false);
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(withExpectedIdentity().get("X-Expected-User")).toBe("b");
  });
  it.each(["login", "signup", "forgot-password", "reset-password"])(
    "peer sign-in checks before replacing the anonymous-only %s page",
    (route) => {
      const peer = channel();
      window.location.pathname = `/en-US/${route}`;
      markAnonymousOnlyRoute();
      observeDocumentIdentity(null);
      const check = vi.fn();
      connectIdentityPeers(check);
      peer.receive({ kind: "identity", id: "b" });
      expect(reload).not.toHaveBeenCalled();
      expect(check).toHaveBeenCalledTimes(1);
      expect(isDocumentIdentityUnverified()).toBe(true);
      if (observeDocumentIdentity("b")) replaceDocument();
      expect(reload).toHaveBeenCalledTimes(1);
    },
  );
  it("a sign-in found by a hinted check replaces an anonymous-only form", async () => {
    const peer = channel();
    window.location.pathname = "/en-US/login";
    markAnonymousOnlyRoute();
    observeDocumentIdentity(null);
    connectIdentityPeers(() => {
      if (observeDocumentIdentity("b")) replaceDocument();
    });
    peer.receive({ kind: "session-changed" });
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("the anonymous-only marker does not affect a later public page", () => {
    const peer = channel();
    window.location.pathname = "/en-US/login";
    markAnonymousOnlyRoute();
    observeDocumentIdentity(null);
    window.location.pathname = "/en-US/about";
    const check = vi.fn();
    connectIdentityPeers(check);
    peer.receive({ kind: "identity", id: "b" });
    expect(reload).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
  });
});
