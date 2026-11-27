import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  /**
   * Each mounted watcher (by name): last deps of each layout effect, by call
   * order within one render, and their cleanups.
   */
  instances: {} as Record<
    string,
    { deps: (unknown[] | undefined)[]; cleanups: ((() => void) | undefined)[] }
  >,
  /** The watcher being rendered. */
  instance: "main",
  call: 0,
  state: { status: "pending" } as
    | { status: "pending" }
    | { status: "error" }
    | { status: "anonymous" }
    | { status: "authenticated"; session: { user: { id: string } } },
  refetch: vi.fn(),
  reload: vi.fn(),
  /** What the atom holds right after a refetch (`readSessionIdentity`). */
  checked: undefined as string | null | undefined,
  inFlight: false,
}));

// Run the hook without a DOM: layout effects that fire, in order, whenever
// their deps change (cleaning up the previous run first), as React does.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useLayoutEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const mounted = boundary.instances[boundary.instance] ?? { deps: [], cleanups: [] };
    boundary.instances[boundary.instance] = mounted;
    const i = boundary.call++;
    const last = mounted.deps[i];
    if (last !== undefined && deps.every((dep, j) => dep === last[j])) return;
    mounted.deps[i] = deps;
    mounted.cleanups[i]?.();
    mounted.cleanups[i] = effect() ?? undefined;
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: (options?: { unmasked?: boolean }) => ({
    // The watcher must read the raw session: a masked read here would see
    // only `pending`, and every identity test below would fail.
    state: options?.unmasked === true ? boundary.state : { status: "pending" },
    actions: { refetch: boundary.refetch },
  }),
  readSessionIdentity: () => boundary.checked,
  isSessionFetchInFlight: () => boundary.inFlight,
}));

import {
  admitRouteIdentity,
  connectIdentityPeers,
  isDocumentIdentityUnverified,
  isDocumentReplaced,
  markExplicitSignOut,
  resetDocumentIdentityForTests,
  setAccountFreePage,
} from "@/lib/document-identity";

import { sessionIdentity, useReloadOnIdentityChange } from "./use-reload-on-identity-change";

const channel = {
  postMessage: () => {},
  onmessage: null as ((event: MessageEvent) => void) | null,
};

const user = (id: string) => ({ status: "authenticated", session: { user: { id } } }) as const;

/** Render watcher `instance` (they share the session atom's state). */
function useRenderWith(state: typeof boundary.state, instance = "main") {
  boundary.state = state;
  boundary.instance = instance;
  boundary.call = 0;
  useReloadOnIdentityChange();
}

/** Watcher `instance` unmounts (its effects clean up); a render mounts it again. */
function unmount(instance = "main") {
  for (const cleanup of boundary.instances[instance]?.cleanups ?? []) cleanup?.();
  delete boundary.instances[instance];
}

/** window/document listeners by event type. */
const events = new Map<string, Set<() => void>>();
function listen(type: string, fn: () => void) {
  if (!events.has(type)) events.set(type, new Set());
  events.get(type)?.add(fn);
}
function fire(type: string) {
  for (const fn of events.get(type) ?? []) fn();
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

class FakeChannel {
  static open: FakeChannel[] = [];
  posted = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeChannel.open.push(this);
  }
  postMessage() {
    this.posted++;
  }
  close() {
    FakeChannel.open = FakeChannel.open.filter((c) => c !== this);
  }
}

beforeEach(() => {
  resetDocumentIdentityForTests();
  boundary.instances = {};
  boundary.reload.mockReset();
  boundary.refetch.mockReset();
  boundary.checked = undefined;
  boundary.inFlight = false;
  FakeChannel.open = [];
  events.clear();
  vi.stubGlobal("window", {
    location: { reload: boundary.reload },
    addEventListener: (type: string, fn: () => void) => listen(type, fn),
    removeEventListener: (type: string, fn: () => void) => events.get(type)?.delete(fn),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    documentElement: { style: { setProperty: () => {} } },
    addEventListener: (type: string, fn: () => void) => listen(type, fn),
    removeEventListener: (type: string, fn: () => void) => events.get(type)?.delete(fn),
  });
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});
afterEach(() => {
  for (const instance of Object.keys(boundary.instances)) unmount(instance);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sessionIdentity", () => {
  it("maps session states to identities", () => {
    expect(sessionIdentity(user("u1"))).toBe("u1");
    expect(sessionIdentity({ status: "anonymous" })).toBeNull();
    expect(sessionIdentity({ status: "pending" })).toBeUndefined();
    expect(sessionIdentity({ status: "error" })).toBeUndefined();
  });
});

describe("useReloadOnIdentityChange", () => {
  it("does not reload on the first known identity or on sign-in", () => {
    useRenderWith({ status: "pending" });
    useRenderWith({ status: "anonymous" });
    useRenderWith(user("u1"));
    expect(boundary.reload).not.toHaveBeenCalled();
  });

  it("does not reload when a pending or error blip resolves to the same user", () => {
    useRenderWith(user("u1"));
    useRenderWith({ status: "error" });
    useRenderWith({ status: "pending" });
    useRenderWith(user("u1"));
    expect(boundary.reload).not.toHaveBeenCalled();
  });

  it("A → sign-out elsewhere → B: replaces the document at the sign-out", () => {
    useRenderWith(user("a"));
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).toHaveBeenCalledTimes(1);
    // Still on its way out: the reload already started is not requested again.
    useRenderWith(user("b"));
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("two mounted watchers (the `_app` shell's and the root's) share one connection order", () => {
    const first = vi.fn();
    const second = vi.fn();
    resetDocumentIdentityForTests(() => channel);
    const disconnectFirst = connectIdentityPeers(first);
    const disconnectSecond = connectIdentityPeers(second);
    channel.onmessage?.({} as MessageEvent);
    expect(second).toHaveBeenCalledTimes(1);
    // The newer one unmounts first: the older one still answers.
    disconnectSecond();
    channel.onmessage?.({} as MessageEvent);
    expect(first).toHaveBeenCalledTimes(1);
    disconnectFirst();
    channel.onmessage?.({} as MessageEvent);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("A → B directly: replaces the document", () => {
    useRenderWith(user("a"));
    useRenderWith({ status: "pending" });
    useRenderWith(user("b"));
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("remembers whose data is cached across a watcher remount", () => {
    useRenderWith(user("a"));
    unmount();
    // Another account signed in while it was not mounted.
    useRenderWith(user("b"));
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("leaves an explicit sign-out's own page load alone, until it is undone", () => {
    useRenderWith(user("u1"));
    const undo = markExplicitSignOut();
    useRenderWith({ status: "error" });
    useRenderWith(user("u1"));
    expect(boundary.reload).not.toHaveBeenCalled();
    undo();
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("tells the other tabs about a sign-in, and checks the session on theirs", () => {
    useRenderWith({ status: "anonymous" });
    const [channel] = FakeChannel.open;
    expect(channel?.posted).toBe(1);
    useRenderWith(user("a"));
    expect(channel?.posted).toBe(2);
    useRenderWith(user("a"));
    expect(channel?.posted).toBe(2);
    channel?.onmessage?.({} as MessageEvent);
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    // The channel is the document's, not the watcher's: it stays open.
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(FakeChannel.open).toHaveLength(1);
  });

  it("after a peer's announcement with no watcher connected, re-checks on mount and stays neutral until then", async () => {
    // A on an `_app` page, then a public page: the shell unmounts.
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    // Another tab announces; nobody here can check it yet.
    channel?.onmessage?.({} as MessageEvent);
    expect(isDocumentIdentityUnverified()).toBe(true);
    // A watcher connects again (no guard confirmed anyone). The mount check
    // refetches; the atom says B.
    boundary.checked = "b";
    useRenderWith({ status: "pending" });
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    await settle();
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("a fresh check that confirms the same account lifts the neutral chrome", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    boundary.checked = "a";
    useRenderWith({ status: "pending" });
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(boundary.reload).not.toHaveBeenCalled();
  });

  it("a failed check keeps it neutral; a guard's confirmation lifts it", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    boundary.checked = undefined;
    useRenderWith({ status: "pending" });
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    await admitRouteIdentity({ status: "resolved", session: { user: { id: "a" } } });
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("a 401 with no watcher connected is checked by the next one to connect", async () => {
    useRenderWith(user("a"));
    unmount();
    // A query on a public page is refused: no watcher to check it.
    const { reportSessionRejected } = await import("@/lib/document-identity");
    reportSessionRejected();
    expect(boundary.refetch).not.toHaveBeenCalled();
    boundary.checked = null;
    useRenderWith({ status: "pending" });
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("a failed mount check is retried on focus, visibility or reconnect, never left neutral", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    // Back in the shell: the mount check gets no fresh answer (offline, 503).
    boundary.checked = undefined;
    useRenderWith(user("a"));
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    // Back online: a new check of its own, still nothing.
    fire("online");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(2);
    expect(isDocumentIdentityUnverified()).toBe(true);
    // The tab regains focus; this check's answer is A: the chrome comes back.
    boundary.checked = "a";
    fire("focus");
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(boundary.reload).not.toHaveBeenCalled();
    // Settled: further focus events check nothing more.
    fire("visibilitychange");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(3);
  });

  it("a retried check that answers another account replaces the document", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    useRenderWith(user("a"));
    await settle();
    boundary.checked = "b";
    fire("visibilitychange");
    await settle();
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("on a page that holds no account data, another account is dropped in place and the chrome shows it", async () => {
    setAccountFreePage(() => true);
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    boundary.checked = "b";
    useRenderWith({ status: "pending" });
    await settle();
    // No reload (the Lab's local work survives), the document is replaced,
    // and the confirmed account is no longer masked.
    expect(boundary.reload).not.toHaveBeenCalled();
    expect(isDocumentReplaced()).toBe(true);
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("a fetch in flight across an unmount and a newer invalidation can't settle it, even after a remount", async () => {
    const answers: (() => void)[] = [];
    boundary.refetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    // Back in the shell: check 1 starts; the shell unmounts before it
    // answers; another tab announces a newer change.
    useRenderWith({ status: "pending" });
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    // The shell remounts while check 1 is still in flight: check 2 starts.
    useRenderWith({ status: "pending" });
    expect(answers).toHaveLength(2);
    // Check 1 answers A: it belongs to an unmounted watcher and predates the
    // newer change, so it settles nothing.
    boundary.checked = "a";
    answers[0]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    // Check 2, asked after the change, answers A: now it is settled.
    answers[1]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("a check superseded by an automatic refresh checks again once that settles", async () => {
    vi.useFakeTimers();
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    // The mount check is cancelled by Better Auth's own cross-tab refresh,
    // which is still running when the check's promise resolves.
    boundary.checked = undefined;
    boundary.inFlight = true;
    useRenderWith(user("a"));
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    // That refresh settles with the same account; the follow-up check
    // (a new one of the watcher's own) confirms it with no other event.
    boundary.inFlight = false;
    boundary.checked = "a";
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(2);
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("two mounted watchers never cancel each other's checks; the survivor settles it", async () => {
    vi.useFakeTimers();
    const answers: (() => void)[] = [];
    boundary.refetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    useRenderWith(user("a"), "root");
    const [channel] = FakeChannel.open;
    unmount("root");
    channel?.onmessage?.({} as MessageEvent);
    expect(isDocumentIdentityUnverified()).toBe(true);
    // The root's watcher mounts and checks (1); the shell's mounts and, now
    // the newest, checks (2), which cancels 1 in Better Auth.
    useRenderWith(user("a"), "root");
    useRenderWith(user("a"), "shell");
    expect(answers).toHaveLength(2);
    // 1 resolves as cancelled while 2 is still fetching: the root is not the
    // one checking, so it schedules no follow-up that would cancel 2.
    boundary.checked = undefined;
    boundary.inFlight = true;
    answers[0]?.();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    // A focus retries only in the shell's watcher.
    fire("focus");
    await settle();
    expect(answers).toHaveLength(3);
    // The shell unmounts with its checks unanswered: the root takes over (4).
    unmount("shell");
    expect(answers).toHaveLength(4);
    answers[1]?.();
    answers[2]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    // The root's own check answers A: settled, no reload.
    boundary.inFlight = false;
    boundary.checked = "a";
    answers[3]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(boundary.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(answers).toHaveLength(4);
  });

  it("a peer's change checked while connected, with no fresh answer, leaves the account masked until a retry", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    // Another tab signs in as B; this tab's check fails (503, A retained).
    boundary.checked = undefined;
    channel?.onmessage?.({} as MessageEvent);
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    // The tab regains focus: the retry answers B, the document is replaced.
    boundary.checked = "b";
    fire("focus");
    await settle();
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("a peer's change checked while connected, answered fresh, masks nothing", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    boundary.checked = "a";
    channel?.onmessage?.({} as MessageEvent);
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("an unmount cancels every follow-up: no refetch after it", async () => {
    vi.useFakeTimers();
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    boundary.checked = undefined;
    boundary.inFlight = true;
    useRenderWith(user("a"));
    // Two superseded checks in a row (mount, then focus), each scheduling a
    // follow-up.
    await settle();
    fire("focus");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(2);
    unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(boundary.refetch).toHaveBeenCalledTimes(2);
  });

  it("a peer's change whose check is dropped with its watcher is unverified and checked by the next one", async () => {
    const answers: (() => void)[] = [];
    boundary.refetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    // Both watchers mounted on verify-email: the shell is the newest.
    useRenderWith(user("a"), "root");
    useRenderWith(user("a"), "shell");
    const [channel] = FakeChannel.open;
    // Another tab signs in as B: the shell checks (not unverified yet).
    channel?.onmessage?.({} as MessageEvent);
    expect(answers).toHaveLength(1);
    expect(isDocumentIdentityUnverified()).toBe(false);
    // Back to public Studio before it answers: the shell unmounts.
    unmount("shell");
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(answers).toHaveLength(2);
    // The dropped answer settles nothing; the root's own answer (B) replaces.
    boundary.checked = "b";
    answers[0]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    answers[1]?.();
    await settle();
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("a peer's check overtaken by a newer watcher, answered with nothing fresh, is handed to it", async () => {
    const answers: (() => void)[] = [];
    boundary.refetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    useRenderWith(user("a"), "root");
    const [channel] = FakeChannel.open;
    channel?.onmessage?.({} as MessageEvent);
    // The shell mounts while the root's check is out, then it fails (503).
    useRenderWith(user("a"), "shell");
    boundary.checked = undefined;
    answers[0]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(answers).toHaveLength(2);
    boundary.checked = "a";
    answers[1]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
  });
});
