import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  router: {
    routesById: {
      leaf: { options: { component: { preload: undefined as (() => void) | undefined } } },
    },
  },
  report: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => fixture.router,
  useMatch: () => ({ routeId: "leaf" }),
}));
vi.mock("react", () => ({ useLayoutEffect: (effect: () => void) => effect() }));
vi.mock("@/lib/stale-build-recovery", () => ({ reportRouteImportFailure: fixture.report }));

import { useRouteImportFailure } from "./use-route-import-failure";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  fixture.report.mockClear();
  fixture.router.routesById.leaf.options.component.preload = undefined;
});
it("does not attribute a lazy-child failure to an already loaded route", () => {
  useRouteImportFailure(new Error("menu import"));
  expect(fixture.report).not.toHaveBeenCalled();
});
it("reports the failed route import before its error screen is acknowledged", () => {
  fixture.router.routesById.leaf.options.component.preload = () => {};
  const error = new Error("route import");
  useRouteImportFailure(error);
  expect(fixture.report).toHaveBeenCalledWith(fixture.router, error, "leaf");
});
it("leaves a failed route import alone while offline (a reload would land on the browser's offline page)", () => {
  vi.stubGlobal("navigator", { onLine: false });
  fixture.router.routesById.leaf.options.component.preload = () => {};
  useRouteImportFailure(new TypeError("Failed to fetch dynamically imported module: /a.js"));
  expect(fixture.report).not.toHaveBeenCalled();
});
