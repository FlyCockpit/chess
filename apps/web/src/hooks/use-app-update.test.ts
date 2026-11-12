import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  register: vi.fn(),
}));
vi.mock("virtual:pwa-register", () => ({ registerSW: fixture.register }));
vi.mock("@/hooks/use-mount-effect", () => ({
  useMountEffect: (effect: () => () => void) => {
    fixture.cleanup = effect();
  },
}));

import { useAppUpdate } from "./use-app-update";

afterEach(() => {
  fixture.cleanup?.();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("silent service worker registration", () => {
  it("defers registration and suppresses activation reloads, including other tabs", () => {
    let idle: (() => void) | undefined;
    const cancel = vi.fn();
    const reload = vi.fn();
    vi.stubGlobal("window", {
      requestIdleCallback: (callback: () => void) => {
        idle = callback;
        return 7;
      },
      cancelIdleCallback: cancel,
      location: { reload },
    });
    useAppUpdate();
    expect(fixture.register).not.toHaveBeenCalled();
    idle?.();
    const options = fixture.register.mock.calls[0]?.[0];
    expect(options.immediate).toBe(true);
    options.onNeedReload();
    options.onNeedReload();
    expect(reload).not.toHaveBeenCalled();
    fixture.cleanup?.();
    fixture.cleanup = undefined;
    expect(cancel).toHaveBeenCalledWith(7);
  });
  it("cancels the fallback timer when unmounted", () => {
    const setTimeout = vi.fn(() => 8);
    const clearTimeout = vi.fn();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    useAppUpdate();
    fixture.cleanup?.();
    fixture.cleanup = undefined;
    expect(clearTimeout).toHaveBeenCalledWith(8);
    expect(fixture.register).not.toHaveBeenCalled();
  });
});
