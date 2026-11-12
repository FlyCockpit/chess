import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  matches: [] as { routeId: string }[],
  search: {} as { tab?: string },
  started: undefined as boolean | undefined,
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({
    select,
  }: {
    select: (state: {
      matches: { routeId: string }[];
      location: { search: { tab?: string } };
    }) => boolean;
  }) => select({ matches: fixture.matches, location: { search: fixture.search } }),
}));
vi.mock("react", () => ({
  useState: (initial: boolean) => {
    fixture.started ??= initial;
    return [
      fixture.started,
      (value: boolean) => {
        fixture.started = value;
      },
    ];
  },
  useEffect: (effect: () => void) => effect(),
}));

import { useIdentityBoundaryEnabled } from "./use-identity-boundary-enabled";

beforeEach(() => {
  fixture.started = undefined;
  fixture.matches = [];
  fixture.search = {};
});
describe("hosted identity boundary lifecycle", () => {
  it.each(["arena", "lab", "leaderboard"])("keeps fresh public %s session-free", (tab) => {
    fixture.search = { tab };
    expect(useIdentityBoundaryEnabled()).toBe(false);
  });
  it("starts for lazy public Studio and remains mounted after leaving it", () => {
    fixture.search = { tab: "studio" };
    expect(useIdentityBoundaryEnabled()).toBe(true);
    fixture.search = { tab: "arena" };
    expect(useIdentityBoundaryEnabled()).toBe(true);
  });
  it("keeps the same watcher across app/public layout boundaries", () => {
    fixture.matches = [{ routeId: "/$lang/_app/_auth/settings/" }];
    expect(useIdentityBoundaryEnabled()).toBe(true);
    fixture.matches = [{ routeId: "/$lang/_public/" }];
    expect(useIdentityBoundaryEnabled()).toBe(true);
    fixture.search = { tab: "studio" };
    expect(useIdentityBoundaryEnabled()).toBe(true);
  });
});
