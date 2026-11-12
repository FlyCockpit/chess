import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  ref: { current: undefined as unknown },
  lastDeps: undefined as unknown[] | undefined,
  cleanup: undefined as (() => void) | undefined,
  state: { status: "pending" } as
    | { status: "pending" }
    | { status: "error" }
    | { status: "anonymous" }
    | { status: "authenticated"; session: { user: { id: string } } },
  reload: vi.fn(),
}));

// Run the hook without a DOM: one persistent ref, and an effect that fires
// whenever its deps change — the same contract React gives it.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: () => boundary.ref,
  useEffect: (effect: () => void, deps: unknown[]) => {
    const changed =
      boundary.lastDeps === undefined || deps.some((dep, i) => dep !== boundary.lastDeps?.[i]);
    boundary.lastDeps = deps;
    if (changed) effect();
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: boundary.state }),
}));
vi.mock("@/hooks/use-mount-effect", () => ({
  useMountEffect: (effect: () => () => void) => {
    boundary.cleanup ??= effect();
  },
}));

import {
  markExplicitSignOut,
  sessionIdentity,
  shouldReloadForIdentity,
  useReloadOnIdentityChange,
} from "./use-reload-on-identity-change";

const user = (id: string) => ({ status: "authenticated", session: { user: { id } } }) as const;

function useRenderWith(state: typeof boundary.state) {
  boundary.state = state;
  useReloadOnIdentityChange();
}

describe("sessionIdentity", () => {
  it("maps session states to identities", () => {
    expect(sessionIdentity(user("u1"))).toBe("u1");
    expect(sessionIdentity({ status: "anonymous" })).toBeNull();
    expect(sessionIdentity({ status: "pending" })).toBeUndefined();
    expect(sessionIdentity({ status: "error" })).toBeUndefined();
  });
});

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

describe("useReloadOnIdentityChange", () => {
  beforeEach(() => {
    boundary.ref.current = undefined;
    boundary.lastDeps = undefined;
    boundary.reload.mockReset();
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), { location: { reload: boundary.reload } }),
    );
  });
  afterEach(() => {
    boundary.cleanup?.();
    boundary.cleanup = undefined;
    markExplicitSignOut()();
    vi.unstubAllGlobals();
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

  it("leaves an explicit sign-out's own page load alone, until it is undone", () => {
    const undo = markExplicitSignOut();
    useRenderWith(user("u1"));
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).not.toHaveBeenCalled();
    undo();
    useRenderWith(user("u1"));
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads when the user signs out elsewhere or the account switches", () => {
    useRenderWith(user("u1"));
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).toHaveBeenCalledTimes(1);

    boundary.ref.current = undefined;
    boundary.lastDeps = undefined;
    useRenderWith(user("u1"));
    useRenderWith({ status: "pending" });
    useRenderWith(user("u2"));
    expect(boundary.reload).toHaveBeenCalledTimes(2);
  });

  it("resets explicit sign-out suppression only on a persisted pageshow", () => {
    useRenderWith(user("u1"));
    markExplicitSignOut();
    window.dispatchEvent(new Event("pageshow"));
    useRenderWith(user("u2"));
    expect(boundary.reload).not.toHaveBeenCalled();
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
    useRenderWith({ status: "pending" });
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).toHaveBeenCalledOnce();
  });

  it("removes the pageshow listener on unmount", () => {
    useRenderWith(user("u1"));
    boundary.cleanup?.();
    boundary.cleanup = undefined;
    markExplicitSignOut();
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).not.toHaveBeenCalled();
  });
});
