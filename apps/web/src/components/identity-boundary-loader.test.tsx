import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWatcherOrRetry, whenBackInFront } from "./identity-boundary-loader";

/** window/document listeners by event type. */
const events = new Map<string, Set<() => void>>();
const target = {
  addEventListener: (type: string, fn: () => void) => {
    if (!events.has(type)) events.set(type, new Set());
    events.get(type)?.add(fn);
  },
  removeEventListener: (type: string, fn: () => void) => events.get(type)?.delete(fn),
};
const fire = (type: string) => {
  for (const fn of events.get(type) ?? []) fn();
};
const doc = { ...target, visibilityState: "visible" as DocumentVisibilityState };

beforeEach(() => {
  events.clear();
  doc.visibilityState = "visible";
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", doc);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const Watcher = () => null;

describe("IdentityBoundaryLoader", () => {
  it("passes the watcher's chunk through when it loads", async () => {
    const loaded = await loadWatcherOrRetry(async () => ({ default: Watcher }), vi.fn());
    expect(loaded.default).toBe(Watcher);
  });

  it("a failed chunk load never rejects (so it never reaches the root's error page)", async () => {
    const retry = vi.fn();
    const loaded = loadWatcherOrRetry(() => Promise.reject(new Error("offline")), retry);
    await expect(loaded).resolves.toHaveProperty("default");
    // The stand-in renders nothing in place of the watcher.
    const { default: StandIn } = await loaded;
    expect(renderToStaticMarkup(<StandIn />)).toBe("");
  });

  it("asks for another attempt when the tab is back in front or online", () => {
    const retry = vi.fn();
    const stop = whenBackInFront(retry);
    doc.visibilityState = "hidden";
    fire("visibilitychange");
    expect(retry).not.toHaveBeenCalled();
    doc.visibilityState = "visible";
    fire("visibilitychange");
    fire("focus");
    fire("online");
    expect(retry).toHaveBeenCalledTimes(3);
    stop();
    fire("focus");
    expect(retry).toHaveBeenCalledTimes(3);
  });
});
