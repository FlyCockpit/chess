import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The app name is the first thing in both header rows (the app shell's
 * `Header` and the arena's `.cc-header`) to give way, so a long name or a
 * narrow screen cannot push the controls past the trailing line. Rendered to
 * static markup (no layout, no media queries), so the rule is pinned through
 * its classes; the real widths are checked in a browser.
 */

const authState = vi.hoisted(() => ({ status: "anonymous" as string }));

vi.mock("@cockpit-chess/env/web", () => ({
  env: { VITE_APP_NAME: "Northwind Regional Logistics" },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  // The original for the route file's code-split loader (`lazyRouteComponent`).
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Outlet: () => null,
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
  Link: ({
    className,
    title,
    children,
  }: {
    className?: string;
    title?: string;
    children?: ReactNode;
  }) => (
    <a className={className} title={title}>
      {children}
    </a>
  ),
  useParams: () => ({ lang: "en-US" }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: authState.status } }),
}));
vi.mock("./main-nav", () => ({ MainNav: () => null }));
vi.mock("./language-switcher", () => ({ LanguageSwitcher: () => <i data-control="language" /> }));
vi.mock("@/components/language-switcher", () => ({
  LanguageSwitcher: () => <i data-control="language" />,
}));
vi.mock("./mode-toggle", () => ({ ModeToggle: () => <i data-control="mode" /> }));
vi.mock("./user-menu", () => ({ default: () => <i data-control="user-menu" /> }));

const { default: Header } = await import("./header");
const { Route: PublicRoute } = await import("@/routes/$lang/_public/route");

const PublicLayout = (
  PublicRoute as unknown as {
    options: { component: (() => ReactNode) & { preload?: () => Promise<void> } };
  }
).options.component;
// Route components are code-split: load the real one before rendering it.
await PublicLayout.preload?.();

function renderPublic() {
  return renderToStaticMarkup(<PublicLayout />);
}

// The class list of the div that holds the header controls.
function controlsGroupClasses() {
  const html = renderToStaticMarkup(<Header />);
  const match = html.match(/<div class="([^"]*)"><i data-control="language"/);
  if (!match?.[1]) throw new Error("controls group not found");
  return match[1].split(" ");
}

describe("Header controls group", () => {
  beforeEach(() => {
    authState.status = "anonymous";
  });

  it("stays on one line and lets the account trigger shrink when signed in", () => {
    authState.status = "authenticated";
    const classes = controlsGroupClasses();
    expect(classes).toEqual(expect.arrayContaining(["ml-auto", "flex", "min-w-0"]));
    expect(classes).not.toContain("flex-wrap");
    expect(classes).not.toContain("shrink-0");
  });

  it.each(["anonymous", "pending", "error"])(
    "wraps when %s, since Sign Up and Sign In cannot shrink",
    (status) => {
      authState.status = status;
      expect(controlsGroupClasses()).toEqual(
        expect.arrayContaining(["ml-auto", "max-w-full", "flex-wrap", "justify-end"]),
      );
    },
  );
});

describe("app header: the app name gives way first", () => {
  it.each(["anonymous", "pending", "error", "authenticated"])("while %s", (status) => {
    authState.status = status;
    const html = renderToStaticMarkup(<Header />);
    const [, classes = "", title = "", inner = ""] =
      html.match(/<a class="([^"]*)" title="([^"]*)">(.*?)<\/a>/) ?? [];
    const brand = classes.split(" ");
    // A zero basis: it only grows into what the controls leave, up to its own
    // width, never below 88px (icon, gap and about "Co…"). No shrink factor
    // (any factor leaks a fraction of a pixel to the controls) and no
    // breakpoint variant of these.
    expect(brand).toEqual(
      expect.arrayContaining(["basis-0", "grow", "max-w-fit", "min-w-22", "inline-flex"]),
    );
    expect(brand.filter((c) => /shrink|:(basis|grow|max-w|min-w)/.test(c))).toEqual([]);
    // The ellipsis needs a block box: `truncate` on the inline-flex link only
    // clips. The caps sit on the span, so a long name leaves the MainNav room.
    expect(brand).not.toContain("truncate");
    const span = inner.match(/<span class="([^"]*)">([^<]*)<\/span>$/);
    expect(span?.[1]?.split(" ").sort()).toEqual(
      ["lg:max-w-80", "max-w-40", "min-w-0", "sm:max-w-56", "truncate"].sort(),
    );
    expect(span?.[2]).toBe("Northwind Regional Logistics");
    expect(title).toBe("Northwind Regional Logistics");
  });
});

describe("arena header: the brand gives way first", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../index.css"), "utf8");
  const rule = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`);
    return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
  };

  it("renders the brand name in its own span, with the full name as the title", () => {
    const html = renderPublic();
    expect(html).toMatch(
      /<a class="cc-brand" title="chess:brand"><img [^>]*\/><span class="cc-brand-name">chess:brand<\/span><\/a>/,
    );
  });

  it("gives the brand a zero basis with a floor, and the name an ellipsis", () => {
    const brand = rule(".cc-brand");
    expect(brand).toContain("flex: 1 1 0;");
    expect(brand).toContain("max-width: fit-content;");
    expect(brand).toContain("min-width: 88px;");
    expect(brand).not.toMatch(/flex-shrink/);
    const name = rule(".cc-brand-name");
    expect(name).toContain("min-width: 0;");
    expect(name).toContain("overflow: hidden;");
    expect(name).toContain("text-overflow: ellipsis;");
  });

  it("keeps the controls whole and on the trailing line", () => {
    const html = renderPublic();
    const match = html.match(/<div class="([^"]*)"><i data-control="language"/);
    expect(match?.[1]?.split(" ")).toEqual(expect.arrayContaining(["ml-auto", "shrink-0"]));
  });
});
