import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While a cookie banner shows (only in an app with analytics), both shells
 * keep it off the page through `#main-content`, their scroller: its bottom
 * padding (index.css) adds `--consent-clearance` (from the `--consent-inset`
 * the banner publishes) minus `--frame-reserve`, what the frame already
 * reserves. The frames are never padded for the banner, so the shell chrome
 * (header, BottomNav) always spans the full viewport height. The app shell is
 * rendered, so a comment or a stray string cannot stand in for the real class;
 * the arena's frame and `#main-content` are plain CSS, read from index.css.
 * The geometry itself is checked in a browser (`pnpm check:layout`).
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

const css = readFileSync(resolve(import.meta.dirname, "../../index.css"), "utf8");
function cssRule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("\n}", start)).replace(/\s+/g, " ");
}

describe("the shell frames span the viewport; only <main> reserves the banner", () => {
  it("#main-content pads the banner's clearance beyond what its frame reserves, plus the keyboard", () => {
    expect(cssRule("#main-content")).toContain(
      "padding-bottom: calc( var(--keyboard-inset, 0px) + max(0px, var(--consent-clearance) - var(--frame-reserve, 0px)) );",
    );
  });

  it("arena shell: the frame reserves the home-indicator inset only", () => {
    expect(frameClasses(PublicShell)).toEqual(["cc-public-shell"]);
    const rule = cssRule(".cc-public-shell");
    expect(rule).toContain(
      "padding: var(--safe-area-top) var(--safe-area-right) var(--safe-area-bottom) var(--safe-area-left);",
    );
    expect(rule).toContain("--frame-reserve: var(--safe-area-bottom);");
    expect(rule).not.toContain("consent");
  });

  it("app shell, no keyboard: the frame reserves the BottomNav only, and tells <main> so", () => {
    const classes = frameClasses(AppShell);
    expect(classes).toContain("grid");
    expect(classes).toContain("pb-[calc(3.5rem_+_var(--safe-area-bottom))]");
    expect(classes).toContain("[--frame-reserve:calc(3.5rem_+_var(--safe-area-bottom))]");
    expect(classes).toContain("md:pb-0");
    expect(classes).toContain("md:[--frame-reserve:0px]");
    expect(classes.filter((c) => c.includes("consent"))).toEqual([]);
  });

  it("app shell, software keyboard up: no frame padding, so <main> pads the whole clearance", () => {
    keyboard.open = true;
    const classes = frameClasses(AppShell);
    expect(classes.filter((c) => /pb-|frame-reserve|consent/.test(c))).toEqual([]);
  });
});
