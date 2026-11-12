import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ navigate: vi.fn(), mutate: vi.fn() }));
vi.mock("react", () => ({
  useEffect: (effect: () => void) => effect(),
  useRef: () => ({ current: null }),
}));
vi.mock("@tanstack/react-query", () => ({ useMutation: () => ({ mutate: fixture.mutate }) }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: fixture.navigate }),
  useParams: () => ({ lang: "en-US" }),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: { status: "authenticated", session: { user: { locale: "es-MX" } } },
    meta: { isDegraded: false },
  }),
}));
vi.mock("@/i18n", () => ({ default: { changeLanguage: vi.fn() } }));
vi.mock("@/utils/orpc", () => ({
  orpc: { auth: { updateLocale: { mutationOptions: () => ({}) } } },
}));

import { useUserLocaleSync } from "./use-user-locale-sync";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("preserves search, fragment and scroll when applying the account locale", () => {
  vi.stubGlobal("window", { localStorage: { getItem: () => null } });
  useUserLocaleSync();
  const options = fixture.navigate.mock.calls[0]?.[0];
  expect(options).toMatchObject({ hash: true, resetScroll: false, replace: true });
  expect(options.params({ lang: "en-US" })).toEqual({ lang: "es-MX" });
  const search = { tab: "arena", game: "published" };
  expect(options.search(search)).toBe(search);
});
