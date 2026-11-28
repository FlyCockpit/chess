import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  state: { status: "authenticated", session: { user: { id: "original" } } },
  meta: { isRefetching: false, isDegraded: false, isOffline: false },
  identity: "original" as string | null | undefined,
  attempted: { current: false },
  mutate: vi.fn(),
  reset: vi.fn(),
  effect: undefined as (() => void) | undefined,
}));
vi.mock("react", () => ({
  useRef: () => fixture.attempted,
  useState: (initial: () => unknown) => [initial(), vi.fn()],
  useEffect: (effect: () => void) => {
    fixture.effect = effect;
  },
  useLayoutEffect: (effect: () => void) => effect(),
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({
    mutate: fixture.mutate,
    reset: fixture.reset,
    isPending: false,
    isSuccess: false,
    error: null,
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({}) }));
vi.mock("@/utils/orpc", () => ({
  orpc: { cliAccess: { runners: { claim: { mutationOptions: () => ({}) } } } },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: fixture.state, meta: fixture.meta }),
  readSessionIdentity: () => fixture.identity,
}));

import { useRunnerClaim } from "./use-runner-claim";

const token = "a".repeat(64);
beforeEach(() => {
  vi.clearAllMocks();
  fixture.state = { status: "authenticated", session: { user: { id: "original" } } };
  fixture.meta = { isRefetching: false, isDegraded: false, isOffline: false };
  fixture.identity = "original";
  fixture.attempted = { current: false };
});
it("does no write during render and automatically claims only after settled identity", () => {
  useRunnerClaim(`runner-claim=${token}`, "original");
  expect(fixture.mutate).not.toHaveBeenCalled();
  fixture.effect?.();
  fixture.effect?.();
  expect(fixture.mutate).toHaveBeenCalledExactlyOnceWith({ token });
});
it.each(["isRefetching", "isDegraded", "isOffline"] as const)(
  "waits while identity is %s",
  (key) => {
    fixture.meta[key] = true;
    useRunnerClaim(`runner-claim=${token}`, "original");
    fixture.effect?.();
    expect(fixture.mutate).not.toHaveBeenCalled();
  },
);
it("refuses an identity switch in the original tab, including retry", () => {
  const result = useRunnerClaim(`runner-claim=${token}`, "original");
  fixture.identity = "other";
  fixture.effect?.();
  result.retry();
  expect(fixture.mutate).not.toHaveBeenCalled();
});
it("does not auto-claim for a different or anonymous account", () => {
  fixture.state.session.user.id = "other";
  useRunnerClaim(`runner-claim=${token}`, "original");
  fixture.effect?.();
  expect(fixture.mutate).not.toHaveBeenCalled();
});
it("refuses an invalid fragment", () => {
  expect(useRunnerClaim("runner-claim=bad", "original").valid).toBe(false);
  fixture.effect?.();
  expect(fixture.mutate).not.toHaveBeenCalled();
});
