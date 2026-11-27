import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  changeLanguage: vi.fn(),
  setItem: vi.fn(),
  mutate: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
  signedIn: false,
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
  useAuthSession: () => ({
    state: fixture.signedIn
      ? { status: "authenticated", session: { user: { id: "a", locale: "en-US" } } }
      : { status: "anonymous" },
    meta: {},
  }),
}));
vi.mock("@cockpit-chess/env/web", () => ({ env: { VITE_SERVER_URL: "https://app.test" } }));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useLayoutEffect: (effect: () => void) => effect(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

import {
  connectIdentityPeers,
  markDocumentIdentityUnverified,
  observeDocumentIdentity,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";
import { orpc } from "@/utils/orpc";
import LanguageSwitcherSelect from "./language-switcher-select";

beforeEach(() => {
  resetDocumentIdentityForTests(() => undefined);
  vi.stubGlobal("fetch", fixture.fetch);
  fixture.fetch.mockReset().mockResolvedValue(Response.json({ json: { official: true } }));
  fixture.signedIn = false;
});
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

it("a fresh public locale control waits for admission, then carries A across a silent cookie switch", async () => {
  vi.stubGlobal("window", {
    location: { pathname: "/en-US" },
    localStorage: { setItem: fixture.setItem },
  });
  fixture.signedIn = true;
  // Start with no guard, watcher or baseline: opening the control loaded A.
  LanguageSwitcherSelect().props.onValueChange("es-MX");
  expect(fixture.mutate).not.toHaveBeenCalled();
  expect(fixture.navigate).toHaveBeenCalledTimes(1);
  // The activated watcher records A. The shared cookie silently becomes B;
  // the control still presents A and must send A as its expected owner.
  connectIdentityPeers(vi.fn());
  observeDocumentIdentity("a");
  expect(fixture.fetch).not.toHaveBeenCalled();
  let request: Promise<unknown> | undefined;
  fixture.mutate.mockImplementation((input: { locale: "es-MX" }) => {
    request = orpc.auth.updateLocale.call(input);
  });
  const select = LanguageSwitcherSelect();
  select.props.onValueChange("es-MX");
  await request;
  const [input, init] = fixture.fetch.mock.calls[0] ?? [];
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  expect(headers.get("X-Expected-User")).toBe("a");
  markDocumentIdentityUnverified();
  select.props.onValueChange("es-MX");
  expect(fixture.mutate).toHaveBeenCalledTimes(1);
});
