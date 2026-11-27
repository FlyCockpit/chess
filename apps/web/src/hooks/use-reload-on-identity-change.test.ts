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
    meta: {},
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
  skipErrorToastForIdentity,
} from "@/lib/document-identity";

import {
  connectSessionRetry,
  observeSessionRetry,
  recordSessionRetryAfter,
  resetSessionRetryForTests,
} from "@/lib/session-retry";
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
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

class FakeChannel {
  static open: FakeChannel[] = [];
  posted = 0;
  messages: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeChannel.open.push(this);
  }
  postMessage(message: unknown) {
    this.posted++;
    this.messages.push(message);
  }
  close() {
    FakeChannel.open = FakeChannel.open.filter((c) => c !== this);
  }
}

beforeEach(() => {
  resetDocumentIdentityForTests();
  resetSessionRetryForTests();
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
  it("presentation continuity alone never announces an identity", async () => {
    boundary.checked = undefined; // no successful settled atom answer
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    expect(channel?.messages).not.toContainEqual({ kind: "identity", id: "a" });
    boundary.checked = "a";
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    expect(channel?.messages.at(-1)).toEqual({ kind: "identity", id: "a" });
  });
  it("never broadcasts retained A on verify-email after a newer B announcement", async () => {
    useRenderWith({ status: "anonymous" });
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    let finish!: () => void;
    boundary.refetch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    Object.assign(window.location, { pathname: "/en-US/verify-email" });
    // Presentation continuity still exposes old A before this mount's check.
    useRenderWith(user("a"));
    await settle();
    expect(channel?.messages).not.toContainEqual({ kind: "identity", id: "a" });
    expect(isDocumentIdentityUnverified()).toBe(true);
    boundary.checked = "b";
    finish();
    await settle();
    expect(channel?.messages.at(-1)).toEqual({ kind: "identity", id: "b" });
    expect(boundary.reload).not.toHaveBeenCalled();
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it.each(["a", "b"])(
    "discards a 404 probe predating a peer switch; fresh %s coalesces once",
    async (fresh) => {
      vi.useFakeTimers();
      boundary.checked = "a";
      useRenderWith(user("a"));
      const [channel] = FakeChannel.open;
      let finishOld!: () => void;
      let finishFresh!: () => void;
      boundary.refetch
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishOld = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishFresh = resolve;
            }),
        );
      skipErrorToastForIdentity({ status: 404 }, "query");
      await settle();
      expect(boundary.refetch).toHaveBeenCalledTimes(1);
      const announce = () => {
        channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
        channel?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
      };
      announce();
      expect(isDocumentIdentityUnverified()).toBe(true);
      finishOld(); // A's old-cookie answer must not verify this document.
      await settle();
      useRenderWith(user("a"));
      expect(isDocumentIdentityUnverified()).toBe(true);
      expect(boundary.reload).not.toHaveBeenCalled();
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
      announce(); // hints received during the fresh probe join it
      await settle();
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
      boundary.checked = fresh;
      finishFresh();
      await settle();
      expect(boundary.reload).toHaveBeenCalledTimes(fresh === "b" ? 1 : 0);
      expect(isDocumentIdentityUnverified()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
    },
  );

  it("never adopts a focus probe superseded by a peer invalidation", async () => {
    vi.useFakeTimers();
    useRenderWith({ status: "anonymous" });
    const [channel] = FakeChannel.open;
    let finish!: () => void;
    let finishFresh!: () => void;
    boundary.refetch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    boundary.refetch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFresh = resolve;
        }),
    );
    fire("focus");
    await settle();
    channel?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    boundary.checked = "a";
    finish();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(channel?.messages).not.toContainEqual({ kind: "identity", id: "a" });
    boundary.checked = "b";
    finishFresh();
    await settle();
    expect(boundary.reload).not.toHaveBeenCalled();
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(channel?.messages.at(-1)).toEqual({ kind: "identity", id: "b" });
  });

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

  it("two mounted watchers share one probe and the survivor settles it", async () => {
    let answer!: () => void;
    boundary.refetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    useRenderWith(user("a"), "root");
    useRenderWith(user("a"), "shell");
    FakeChannel.open[0]?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    unmount("shell");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    boundary.checked = "b";
    answer();
    await settle();
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("a peer's change checked while connected, with no fresh answer, leaves the account masked until a retry", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    // Another tab signs in as B; this tab's check fails (503, A retained).
    boundary.checked = undefined;
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
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
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("an unmount cancels every follow-up: no refetch after it", async () => {
    vi.useFakeTimers();
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
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

  it("a peer check overtaken by a newer watcher shares its answer", async () => {
    let answer!: () => void;
    boundary.refetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    useRenderWith(user("a"), "root");
    FakeChannel.open[0]?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    await settle();
    useRenderWith(user("a"), "shell");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    boundary.checked = "a";
    answer();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(boundary.reload).not.toHaveBeenCalled();
  });
  it("two mounted watchers (the `_app` shell's and the root's) share one connection order", async () => {
    const first = vi.fn();
    const second = vi.fn();
    resetDocumentIdentityForTests(() => channel);
    const disconnectFirst = connectIdentityPeers(first);
    const disconnectSecond = connectIdentityPeers(second);
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(second).toHaveBeenCalledTimes(1);
    // The newer one unmounts first: the older one still answers.
    disconnectSecond();
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(first).toHaveBeenCalledTimes(1);
    disconnectFirst();
    channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("A → B directly: replaces the document", async () => {
    useRenderWith(user("a"));
    useRenderWith({ status: "pending" });
    useRenderWith(user("b"));
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("remembers whose data is cached across a watcher remount", async () => {
    useRenderWith(user("a"));
    unmount();
    // Another account signed in while it was not mounted.
    useRenderWith(user("b"));
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("leaves an explicit sign-out's own page load alone, until it is undone", async () => {
    useRenderWith(user("u1"));
    const undo = markExplicitSignOut();
    useRenderWith({ status: "error" });
    useRenderWith(user("u1"));
    expect(boundary.reload).not.toHaveBeenCalled();
    undo();
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("tells the other tabs about a sign-in, and checks the session on theirs", async () => {
    boundary.checked = null;
    useRenderWith({ status: "anonymous" });
    const [channel] = FakeChannel.open;
    expect(channel?.posted).toBe(1);
    boundary.checked = "a";
    useRenderWith(user("a"));
    expect(channel?.posted).toBe(2);
    boundary.checked = "a";
    useRenderWith(user("a"));
    expect(channel?.posted).toBe(2);
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    // The channel is the document's, not the watcher's: it stays open.
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(FakeChannel.open).toHaveLength(1);
  });

  it("after a peer's announcement with no watcher connected, re-checks on mount and stays neutral until then", async () => {
    // A on an `_app` page, then a public page: the shell unmounts.
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    // Another tab announces; nobody here can check it yet.
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(isDocumentIdentityUnverified()).toBe(true);
    // A watcher connects again (no guard confirmed anyone). The mount check
    // refetches; the atom says B.
    boundary.checked = "b";
    useRenderWith({ status: "pending" });
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    await settle();
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("a fresh check that confirms the same account lifts the neutral chrome", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
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
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
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
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("a failed mount check is retried on focus, visibility or reconnect, never left neutral", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
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
    expect(boundary.refetch).toHaveBeenCalledTimes(4);
  });

  it("a retried check that answers another account replaces the document", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
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
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
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
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    // Back in the shell: check 1 starts; the shell unmounts before it
    // answers; another tab announces a newer change.
    useRenderWith({ status: "pending" });
    await settle();
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    // The shell remounts: the newer generation queues behind check 1.
    useRenderWith({ status: "pending" });
    await settle();
    expect(answers).toHaveLength(1);
    // Check 1 answers A: it belongs to an unmounted watcher and predates the
    // newer change, so it settles nothing.
    boundary.checked = "a";
    answers[0]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(answers).toHaveLength(2);
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
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
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

  it.each(["focus", "visibilitychange", "online", "identity"])(
    "%s during Retry-After cannot bypass cooldown with the watcher mounted",
    async (event) => {
      vi.useFakeTimers();
      // The real useAuthSession adapter connects the same refetch to the
      // coordinator. Keep that connection while this watcher is mounted.
      const disconnect = connectSessionRetry(boundary.refetch);
      boundary.refetch.mockImplementationOnce(() => {
        recordSessionRetryAfter(
          new Response(null, { status: 429, headers: { "Retry-After": "10" } }),
        );
        observeSessionRetry({ status: 429 }, false);
      });
      useRenderWith(user("a"));
      try {
        const [channel] = FakeChannel.open;
        channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
        await settle();
        expect(boundary.refetch).toHaveBeenCalledTimes(1);
        expect(isDocumentIdentityUnverified()).toBe(true);
        if (event === "identity") {
          channel?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
        } else fire(event);
        await settle();
        expect(boundary.reload).not.toHaveBeenCalled();
        expect(boundary.refetch).toHaveBeenCalledTimes(1);
        expect(isDocumentIdentityUnverified()).toBe(true);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(boundary.refetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(boundary.refetch).toHaveBeenCalledTimes(2);
      } finally {
        disconnect();
      }
    },
  );
});
