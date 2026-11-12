import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  changeLanguage: vi.fn(),
  setItem: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: fixture.navigate }) }));
vi.mock("@tanstack/react-query", () => ({ useMutation: () => ({ mutate: fixture.mutate }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en-US", changeLanguage: fixture.changeLanguage },
    t: (key: string) => key,
  }),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: "anonymous" }, meta: {} }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: { auth: { updateLocale: { mutationOptions: () => ({}) } } },
}));

import LanguageSwitcherSelect from "./language-switcher-select";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("replaces the locale while retaining query, fragment and reading position", () => {
  vi.stubGlobal("window", {
    location: { pathname: "/en-US" },
    localStorage: { setItem: fixture.setItem },
  });
  const select = LanguageSwitcherSelect();
  select.props.onValueChange("es-MX");
  const options = fixture.navigate.mock.calls[0]?.[0];
  expect(options).toMatchObject({ to: ".", replace: true, hash: true, resetScroll: false });
  expect(options.params({ lang: "en-US" })).toEqual({ lang: "es-MX" });
  const search = { tab: "arena", game: "published" };
  expect(options.search(search)).toBe(search);
  expect(fixture.setItem).toHaveBeenCalledWith("locale", "es-MX");
});
