import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { holdsNoAccountData } from "./account-free-pages";
import {
  observeDocumentIdentity,
  onAccountStateDiscarded,
  replaceDocument,
  replaceDocumentBeforeNavigation,
  resetDocumentIdentityForTests,
  setAccountFreePage,
} from "./document-identity";

/**
 * A document kept on an account-free page after an identity change (the Lab
 * with an imported archive, after A signed out in another tab) is reloaded at
 * the first navigation to a page that may hold account data. That reload must
 * load the destination: the router's real browser history writes the new URL
 * a microtask after `onBeforeNavigate`, and a reload before that reloaded the
 * Lab (losing the archive) instead of opening Studio.
 */

/** A browser window with just what `createBrowserHistory` and the reload use. */
function fakeWindow(start: string) {
  const url = new URL(start, "https://chess.test");
  const reloadedAt: string[] = [];
  let state: unknown = null;
  const write = (next: unknown, href?: string) => {
    state = next;
    // `replaceState(state, "")` keeps the URL, as in a browser.
    if (!href) return;
    const target = new URL(href, url);
    url.pathname = target.pathname;
    url.search = target.search;
    url.hash = target.hash;
  };
  const win = {
    location: {
      get pathname() {
        return url.pathname;
      },
      get search() {
        return url.search;
      },
      get hash() {
        return url.hash;
      },
      get href() {
        return url.href;
      },
      reload: () => reloadedAt.push(`${url.pathname}${url.search}`),
      assign: vi.fn(),
    },
    history: {
      get state() {
        return state;
      },
      length: 1,
      pushState: (next: unknown, _title: string, href?: string) => write(next, href),
      replaceState: (next: unknown, _title: string, href?: string) => write(next, href),
      back: vi.fn(),
      forward: vi.fn(),
      go: vi.fn(),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    scrollTo: vi.fn(),
  };
  return { win, reloadedAt };
}

function homeRouter(win: ReturnType<typeof fakeWindow>["win"]) {
  const rootRoute = createRootRoute();
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "$lang",
    validateSearch: (search: Record<string, unknown>) => ({
      tab: typeof search.tab === "string" ? search.tab : undefined,
    }),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home]),
    history: createBrowserHistory({ window: win as unknown as Window }),
  });
  // As router.tsx wires it.
  setAccountFreePage(
    () =>
      holdsNoAccountData(router.latestLocation) &&
      holdsNoAccountData(router.state.resolvedLocation ?? router.latestLocation),
  );
  router.subscribe("onBeforeNavigate", () => replaceDocumentBeforeNavigation(router.history));
  return router;
}

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
  Object.assign(root.style, { display: "", priority: "" });
  vi.stubGlobal("document", { documentElement: root });
  // The client router registers itself on `self`.
  vi.stubGlobal("self", {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a replaced document kept on an account-free page", () => {
  async function labAfterSignOutElsewhere() {
    const { win, reloadedAt } = fakeWindow("/en-US?tab=lab");
    vi.stubGlobal("window", win);
    const router = homeRouter(win);
    await router.load();
    const discarded = vi.fn();
    onAccountStateDiscarded(discarded);
    // A's document, then A signs out in another tab while the Lab is open.
    observeDocumentIdentity("a");
    expect(observeDocumentIdentity(null)).toBe(true);
    replaceDocument();
    // Kept in place: the archive survives.
    expect(discarded).toHaveBeenCalledTimes(1);
    expect(reloadedAt).toEqual([]);
    return { router, reloadedAt };
  }

  it("reloads into Studio on the first click, not back onto the Lab", async () => {
    const { router, reloadedAt } = await labAfterSignOutElsewhere();

    void router.navigate({ to: "/$lang", params: { lang: "en-US" }, search: { tab: "studio" } });

    expect(reloadedAt).toEqual(["/en-US?tab=studio"]);
    expect(hidden()).toBe(true);
  });

  it("keeps the archive on a navigation to another account-free tab", async () => {
    const { router, reloadedAt } = await labAfterSignOutElsewhere();

    await router.navigate({ to: "/$lang", params: { lang: "en-US" }, search: { tab: "arena" } });

    expect(reloadedAt).toEqual([]);
    expect(hidden()).toBe(false);
    expect(router.state.location.search).toEqual({ tab: "arena" });
  });

  it("does nothing on a document that was never replaced", async () => {
    const { win, reloadedAt } = fakeWindow("/en-US?tab=lab");
    vi.stubGlobal("window", win);
    const router = homeRouter(win);
    await router.load();
    observeDocumentIdentity("a");

    await router.navigate({ to: "/$lang", params: { lang: "en-US" }, search: { tab: "studio" } });

    expect(reloadedAt).toEqual([]);
    expect(win.location.search).toBe("?tab=studio");
  });
});
