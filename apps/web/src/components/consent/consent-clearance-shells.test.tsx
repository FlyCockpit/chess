import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the cookie banner shows, both shells end `<main>` where the banner
 * starts: their frame pads its bottom by `--consent-clearance` (index.css,
 * from the `--consent-inset` the banner publishes). The app shell is rendered,
 * so a comment or a stray string cannot stand in for the real class; the
 * arena's frame is plain CSS (`.cc-public-shell`), so its rule is read from
 * index.css and the rendered frame must carry that class. The geometry itself
 * is checked in a browser.
 */
const keyboard = vi.hoisted(() => ({ open: false }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  // The original for the route files' code-split loader (`lazyRouteComponent`).
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
  useParams: () => ({ lang: "en-US" }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  Outlet: () => null,
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }));
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtools: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/admin-setup-banner", () => ({ AdminSetupBanner: () => null }));
vi.mock("@/components/bottom-nav", () => ({ default: () => null }));
vi.mock("@/components/header", () => ({ default: () => null }));
vi.mock("@/components/setup-key-banner", () => ({ SetupKeyBanner: () => null }));
vi.mock("@/components/pull-to-refresh", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => {} }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => {} }));
vi.mock("@/components/consent/consent-preferences-button", () => ({
  ConsentPreferencesButton: () => null,
}));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => keyboard.open }));

const { Route: AppRoute } = await import("@/routes/$lang/_app/route");
const { Route: PublicRoute } = await import("@/routes/$lang/_public/route");

type LazyComponent = (() => ReactNode) & { preload?: () => Promise<void> };
const component = (route: unknown) =>
  (route as { options: { component: LazyComponent } }).options.component;
const AppShell = component(AppRoute);
const PublicShell = component(PublicRoute);
// Route components are code-split: load the real ones before rendering them.
await AppShell.preload?.();
await PublicShell.preload?.();

/** The frame: the shell's first `<div>`, the grid that holds header, main and nav. */
function frameClasses(Shell: LazyComponent): string[] {
  const match = renderToStaticMarkup(<Shell />).match(/<div class="([^"]*)"/);
  return (match?.[1] ?? "").split(" ");
}

beforeEach(() => {
  keyboard.open = false;
});

describe("the shells reserve the cookie banner's height", () => {
  it("arena shell: the larger of the home-indicator inset and the banner's clearance", () => {
    expect(frameClasses(PublicShell)).toEqual(["cc-public-shell"]);
    const css = readFileSync(resolve(import.meta.dirname, "../../index.css"), "utf8");
    const start = css.indexOf("\n.cc-public-shell {");
    const rule = css.slice(start, css.indexOf("\n}", start)).replace(/\s+/g, " ");
    expect(rule).toContain(
      "padding: var(--safe-area-top) var(--safe-area-right) max(var(--safe-area-bottom), var(--consent-clearance)) var(--safe-area-left);",
    );
  });

  it("app shell, no keyboard: the larger of the BottomNav's and the banner's; from md: the banner's", () => {
    const classes = frameClasses(AppShell);
    expect(classes).toContain("grid");
    expect(classes).toContain(
      "pb-[max(calc(3.5rem_+_var(--safe-area-bottom)),var(--consent-clearance))]",
    );
    expect(classes).toContain("md:pb-(--consent-clearance)");
    expect(classes).not.toContain("md:pb-0");
  });

  it("app shell, software keyboard up: the banner's part the keyboard does not cover", () => {
    keyboard.open = true;
    const classes = frameClasses(AppShell);
    expect(classes).toContain("pb-(--consent-clearance)");
    expect(classes.filter((c) => c.includes("3.5rem"))).toEqual([]);
  });
});
