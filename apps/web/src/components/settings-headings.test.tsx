import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Every settings page has one h1: the settings layout's "Settings" title. The
 * pages under it (profile, security, CLI, and any added later) title their
 * sections with card titles, never a second h1, a `PageHeader` (which renders
 * one) or a `role="heading"` stand-in. Route files cannot hold tests, so the
 * layout is rendered from here and the pages are read as source.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  // The original for the route file's code-split loader (`lazyRouteComponent`).
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  Outlet: () => <section data-outlet="" />,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/en-US/settings" }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const { Route: SettingsRoute } = await import("@/routes/$lang/_app/_auth/settings");

const SETTINGS_DIR = path.resolve(import.meta.dirname, "../routes/$lang/_app/_auth/settings");

describe("settings headings", () => {
  it("the layout renders exactly one h1, above the page", async () => {
    const { component: Layout } = (
      SettingsRoute as unknown as {
        options: { component: (() => ReactNode) & { preload?: () => Promise<void> } };
      }
    ).options;
    // Route components are code-split: load the real one before rendering it.
    await Layout.preload?.();
    const html = renderToStaticMarkup(<Layout />);
    expect(html.match(/<h1\b[^>]*>([^<]*)<\/h1>/g)).toEqual([
      expect.stringContaining(">title</h1>"),
    ]);
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("data-outlet"));
  });

  const pages = readdirSync(SETTINGS_DIR).filter((file) => file.endsWith(".tsx"));

  it.each(pages)("%s adds no level-1 heading of its own", (file) => {
    const source = readFileSync(path.join(SETTINGS_DIR, file), "utf8");
    expect(source).not.toMatch(/<h1\b/);
    expect(source).not.toMatch(/<PageHeader\b/);
    expect(source).not.toMatch(/role="heading"/);
  });

  it("finds the settings pages", () => {
    expect(pages).toEqual(expect.arrayContaining(["index.tsx", "security.tsx", "cli.tsx"]));
  });
});
