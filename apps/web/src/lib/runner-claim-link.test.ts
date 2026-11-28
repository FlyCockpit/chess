import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isRunnerClaimPath,
  runnerClaimAfterSignIn,
  runnerClaimLoginTarget,
  runnerClaimToken,
} from "./runner-claim-link";

const token = "a".repeat(64);
const pathname = "/en-US/runner/claim";
const fragment = `runner-claim=${token}`;
const identityFenceCases: {
  baseline: string | null;
  path: string;
  raw?: string;
  keep?: boolean;
}[] = [
  { baseline: "A", path: "/en-US/Runner/Claim" },
  { baseline: null, path: "/en-US/Runner/Claim" },
  { baseline: "A", path: "/en-US/login?redirectTo=%2Fen-US%2Frunner%2Fclaim" },
  { baseline: null, path: "/en-US/login?redirectTo=%2Fen-US%2Frunner%2Fclaim" },
  { baseline: "A", path: "/%65n-US/Login/?redirectTo=%2Fen-US%2Frunner%2Fclaim" },
  { baseline: "A", path: "/en-US/login?redirectTo=%22%2Fen-US%2Frunner%2Fclaim%22" },
  { baseline: null, path: "/en-US/login?redirectTo=%22%2Fen-US%2Frunner%2Fclaim%22" },
  { baseline: "A", path: "/xx/login?redirectTo=%2Fen-US%2Frunner%2Fclaim" },
  { baseline: "A", path: "/en-US/settings" },
  { baseline: "A", path: "/en-US/login", raw: "ordinary-heading", keep: true },
];
afterEach(() => vi.unstubAllGlobals());

describe("claim sign-in continuation", () => {
  it.each(identityFenceCases)(
    "fences document replacement at module load before any route guard: $baseline $path",
    async ({ baseline, path, raw = `%72unner-claim=${token}`, keep = false }) => {
      vi.resetModules();
      let current = new URL(`https://chess.test${path}#${raw}`);
      const reloaded: string[] = [];
      const state = { __TSR_key: "entry" };
      vi.stubGlobal("window", {
        location: {
          get href() {
            return current.href;
          },
          get hash() {
            return current.hash;
          },
          reload: () => reloaded.push(current.href),
        },
        history: { state },
      });
      vi.stubGlobal("document", { documentElement: { style: { setProperty() {} } } });
      vi.stubGlobal("History", {
        prototype: {
          replaceState: (_state: unknown, _title: string, href: string) => {
            current = new URL(href, current);
          },
        },
      });
      const identity = await import("./document-identity");
      const claims = await import("./runner-claim-link");
      identity.observeDocumentIdentity(baseline);
      identity.replaceDocument();
      expect(reloaded).toHaveLength(1);
      expect(new URL(reloaded[0] ?? "").hash).toBe(baseline && !keep ? "" : `#${raw}`);
      claims.resetRunnerClaimContinuationForTests();
    },
  );
  it.each([
    `%72unner-claim=${token}`,
    `runner%2Dclaim=${token}`,
    `runner-claim=%61${token.slice(1)}`,
  ])("uses the actual router's one hash decode for %s", (raw) => {
    const root = createRootRoute();
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: [`${pathname}#${raw}`] }),
    });
    expect(runnerClaimToken(router.latestLocation.hash)).toBe(token);
  });
  it.each([
    `%72unner-claim%3D${token}`,
    `%23runner-claim=${token}`,
    `runner-claim=%2561${token.slice(1)}`,
  ])("keeps reserved or double-encoded router fragments invalid: %s", (raw) => {
    const root = createRootRoute();
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: [`${pathname}#${raw}`] }),
    });
    expect(runnerClaimToken(router.latestLocation.hash)).toBeNull();
  });
  it.each(["/en-US/Runner/Claim", "/en-US/runner/claim/", "/%65n-US/runner/claim"])(
    "recognizes the router's accepted claim path %s",
    (path) => {
      const root = createRootRoute();
      const locale = createRoute({ getParentRoute: () => root, path: "$lang" });
      const claim = createRoute({ getParentRoute: () => locale, path: "runner/claim" });
      const router = createRouter({
        routeTree: root.addChildren([locale.addChildren([claim])]),
        history: createMemoryHistory({ initialEntries: [path] }),
      });
      expect(router.matchRoutes(path, {}).at(-1)?.routeId).toBe("/$lang/runner/claim");
      expect(isRunnerClaimPath(path, "en-US")).toBe(true);
      expect(
        runnerClaimLoginTarget(
          { pathname: path, href: `${path}#${fragment}`, hash: fragment },
          "en-US",
        ),
      ).toEqual({ redirectTo: pathname, hash: fragment });
    },
  );
  it("preserves the fragment outside the login query", () => {
    const target = runnerClaimLoginTarget(
      { pathname, href: `${pathname}#${fragment}`, hash: fragment },
      "en-US",
    );
    const login = new URL("https://chess.test/en-US/login");
    login.searchParams.set("redirectTo", target.redirectTo);
    login.hash = target.hash ?? "";
    expect(login.search).not.toContain(token);
    expect(login.hash).toBe(`#${fragment}`);
    expect(runnerClaimAfterSignIn(target.redirectTo, "en-US", login.hash)).toBe(
      `${pathname}#${fragment}`,
    );
  });
  it("never copies the token onto a different or external destination", () => {
    expect(runnerClaimAfterSignIn("https://evil.test/", "en-US", fragment)).toBe("/en-US");
    expect(runnerClaimAfterSignIn("/en-US/settings", "en-US", fragment)).toBe("/en-US/settings");
    expect(runnerClaimAfterSignIn("/es-MX/runner/claim", "en-US", fragment)).toBe("/en-US");
  });
  it("drops malformed fragments and search strings when leaving the claim page", () => {
    expect(runnerClaimToken(`runner-claim=${token}&extra=1`)).toBeNull();
    expect(runnerClaimToken(`runner-claim=${token.toUpperCase()}`)).toBeNull();
    expect(runnerClaimToken("runner-claim=short")).toBeNull();
    expect(
      runnerClaimLoginTarget(
        { pathname, href: `${pathname}?anything=private#bad`, hash: "bad" },
        "en-US",
      ),
    ).toEqual({ redirectTo: pathname });
  });
  it("preserves existing non-claim authentication destinations", () => {
    expect(
      runnerClaimLoginTarget(
        { pathname: "/en-US/settings", href: "/en-US/settings?tab=x#heading", hash: "heading" },
        "en-US",
      ),
    ).toEqual({ redirectTo: "/en-US/settings?tab=x#heading" });
  });
});
