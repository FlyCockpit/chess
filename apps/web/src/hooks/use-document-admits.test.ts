import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  subscribe: undefined as ((listener: () => void) => () => void) | undefined,
}));

// Run the hook without a DOM: read the client snapshot, as React does after
// hydration, and keep the subscription it registers.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useLayoutEffect: (effect: () => void) => effect(),
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, get: () => boolean) => {
    store.subscribe = subscribe;
    return get();
  },
}));

import {
  connectIdentityPeers,
  isIdentityObservationRequested,
  observeDocumentIdentity,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";

import { useDocumentAdmits } from "./use-document-admits";

beforeEach(() => {
  resetDocumentIdentityForTests(() => undefined);
  vi.stubGlobal("window", { location: { reload: vi.fn() } });
  vi.stubGlobal("document", { documentElement: { style: { setProperty: () => {} } } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useDocumentAdmits", () => {
  it("requests the lazy observer as soon as an unguarded control sees an account", () => {
    expect(useDocumentAdmits(undefined)).toBe(false);
    expect(isIdentityObservationRequested()).toBe(false);
    expect(useDocumentAdmits("a")).toBe(false);
    expect(isIdentityObservationRequested()).toBe(true);
  });
  it("follows the recorded identity and tells its subscriber when it changes", () => {
    expect(useDocumentAdmits(undefined)).toBe(false);
    expect(useDocumentAdmits("a")).toBe(false);
    const listener = vi.fn();
    store.subscribe?.(listener);
    observeDocumentIdentity("a");
    expect(listener).toHaveBeenCalledTimes(1);
    // Recorded, but nothing watches for a switch yet.
    expect(useDocumentAdmits("a")).toBe(false);
    connectIdentityPeers(vi.fn());
    expect(listener).toHaveBeenCalledTimes(2);
    expect(useDocumentAdmits("a")).toBe(true);
    expect(useDocumentAdmits("b")).toBe(false);
  });
});
