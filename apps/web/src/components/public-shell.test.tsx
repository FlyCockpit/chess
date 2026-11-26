import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The shell rules, see docs/design-system.md § Shell rules
 * They are rendered here, so a comment or a stray string cannot stand in for
 * the real markup. The geometry itself (footer bottom = scroller bottom,
 * full-bleed rules reach the viewport edge) is measured in a browser by
 * `pnpm check:layout`.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  // The original for the route files' code-split loader (`lazyRouteComponent`).
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  Outlet: () => <p>outlet</p>,
  redirect: () => undefined,
  useParams: () => ({ lang: "en-US" }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }));
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtools: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/admin-setup-banner", () => ({ AdminSetupBanner: () => null }));
vi.mock("@/components/bottom-nav", () => ({ default: () => null }));
vi.mock("@/components/header", () => ({ default: () => null }));
vi.mock("@/components/pull-to-refresh", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/setup-key-banner", () => ({ SetupKeyBanner: () => null }));
vi.mock("@/components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/consent/consent-preferences-button", () => ({
  ConsentPreferencesButton: () => <button type="button">preferences</button>,
}));
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => {} }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => {} }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));
vi.mock("@/i18n", () => ({ loadLocaleInto: async () => {} }));

const { PublicNotFoundPage, PublicShell } = await import("@/components/public-shell");
const { Route: AppRoute } = await import("@/routes/$lang/_app/route");
const { Route: PublicRoute } = await import("@/routes/$lang/_public/route");
const { Route: LangRoute } = await import("@/routes/$lang");

type LazyComponent = (() => ReactNode) & { preload?: () => Promise<void> };
const component = (route: unknown) =>
  (route as { options: { component: LazyComponent } }).options.component;
// Route components are code-split: load the real ones before rendering them.
await component(AppRoute).preload?.();
await component(PublicRoute).preload?.();

function render(route: unknown): string {
  const Component = component(route);
  return renderToStaticMarkup(<Component />);
}

function mainTag(html: string): string {
  const tags = html.match(/<main\b[^>]*>/g) ?? [];
  expect(tags, "exactly one <main> per shell").toHaveLength(1);
  return tags[0] ?? "";
}

// The scroller holds one column, at least as tall as the scroller: the page
// (growing) and then the footer, last.
const COLUMN =
  /<main\b[^>]*><div class="flex min-h-full min-w-0 flex-col"><div class="flex min-w-0 flex-1 flex-col">([\s\S]*)<\/div><footer\b[^>]*>[\s\S]*?<\/footer><\/div><\/main>/;

describe("public shell", () => {
  it("puts the footer after the page in a min-h-full column inside the one scroller", () => {
    const html = renderToStaticMarkup(
      <PublicShell>
        <p>page</p>
      </PublicShell>,
    );
    const match = html.match(COLUMN);
    expect(match, html).not.toBeNull();
    expect(match?.[1]).toBe("<p>page</p>");
    expect(html.match(/<footer\b/g)).toHaveLength(1);
    // check:layout finds the shell's footer by this marker, not by the first <footer> in <main>.
    expect(html).toMatch(/<footer\b[^>]*\bdata-public-footer=/);
  });

  it("the _public layout renders its routes through the shell", () => {
    expect(render(PublicRoute).match(COLUMN)?.[1]).toBe("<p>outlet</p>");
  });

  it("the 404 for an unknown URL renders inside the public shell", async () => {
    // `$lang`'s notFoundComponent is code-split too: the loaded one is PublicNotFoundPage.
    const NotFound = (LangRoute as unknown as { options: { notFoundComponent: LazyComponent } })
      .options.notFoundComponent;
    await NotFound.preload?.();
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toBe(renderToStaticMarkup(<PublicNotFoundPage />));
    expect(html).toContain('<header class="cc-header">');
    expect(html.match(COLUMN)?.[1]).toContain("pageNotFound.title");
  });

  it("the public footer carries Cookie preferences, so every public page offers it", () => {
    const footer = render(PublicRoute).match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1];
    expect(footer).toContain("preferences");
  });

  it("the header's rule is on the full-width header, the 1440px row inside it", () => {
    // index.css: `.cc-header` carries the border, `.cc-header-row` the max-width.
    expect(render(PublicRoute)).toMatch(/<header class="cc-header"><div class="cc-header-row">/);
  });
});

describe("full-bleed rules inside the scroller", () => {
  it.each([
    ["public", PublicRoute],
    ["app", AppRoute],
  ])("the %s shell's scroller reserves no scrollbar gutter", (_name, route) => {
    const tag = mainTag(render(route));
    expect(tag).toContain('id="main-content"');
    expect(tag).toContain("overflow-y-auto");
    expect(tag).not.toContain("scrollbar-gutter");
  });

  it("the app shell has no footer (BottomNav on phones, Cookie preferences in Settings)", () => {
    expect(render(AppRoute)).not.toContain("<footer");
  });
});
