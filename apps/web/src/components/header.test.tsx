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

const authState = vi.hoisted(() => ({
  status: "anonymous" as string,
  /** The public pages' session-cookie hint (lib/session-hint.ts). */
  hint: false,
}));

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
  // Only a named link (an icon-only control) also carries its target, so the
  // brand and nav links render exactly as before.
  Link: ({
    to,
    className,
    title,
    "aria-label": ariaLabel,
    children,
  }: {
    to?: string;
    className?: string;
    title?: string;
    "aria-label"?: string;
    children?: ReactNode;
  }) => (
    <a
      className={className}
      title={title}
      aria-label={ariaLabel}
      data-to={ariaLabel ? to : undefined}
    >
      {children}
    </a>
  ),
  useParams: () => ({ lang: "en-US" }),
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: (options?: { queryKey?: readonly unknown[] }) => ({
    data: options?.queryKey?.[0] === "session-cookie-hint" ? authState.hint : undefined,
  }),
}));
vi.mock("@/server/auth-session", () => ({ getSessionCookieHint: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/consent/consent-preferences-button", () => ({
  ConsentPreferencesButton: () => null,
}));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: authState.status } }),
}));
vi.mock("./main-nav", () => ({ MainNav: () => null }));
vi.mock("./language-switcher", () => ({ LanguageSwitcher: () => <i data-control="language" /> }));
vi.mock("@/components/language-switcher", () => ({
  LanguageSwitcher: ({ labelHiddenBelow }: { labelHiddenBelow?: string }) => (
    <i data-control="language" data-label-hidden-below={labelHiddenBelow} />
  ),
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

const css = readFileSync(resolve(import.meta.dirname, "../index.css"), "utf8");
const rule = (selector: string) => {
  const start = css.indexOf(`\n${selector} {`);
  return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
};

describe("arena header: the brand gives way first", () => {
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
    const match = html.match(
      /<div data-header-controls="" class="([^"]*)"><i data-control="language"/,
    );
    // `max-w-full flex-wrap`: a group wider than the row wraps inside itself
    // instead of running past the trailing edge (check:layout measures it).
    expect(match?.[1]?.split(" ")).toEqual(
      expect.arrayContaining(["ml-auto", "shrink-0", "max-w-full", "flex-wrap", "justify-end"]),
    );
  });
});

/**
 * The translated tabs, not the controls, give way once the brand is at its
 * floor: otherwise es-MX's tabs pushed the signed-in account link (the only
 * way to Settings, Admin and Sign out) off a 651–1279px screen. The widths are
 * in public-shell.tsx's PublicHeader and the home-nav handoff; `pnpm
 * check:layout` measures them in a browser.
 */
describe("arena header: the tabs give way before the controls", () => {
  it("the tab strip shrinks after the brand and then scrolls sideways", () => {
    const nav = rule(".cc-nav");
    // An `auto` basis: the brand (zero basis) reaches its floor first.
    expect(nav).toContain("flex: 1 1 auto;");
    expect(nav).toContain("min-width: 0;");
    expect(nav).toContain("overflow-x: auto;");
    // A tab's focus ring is drawn inside the strip, which would clip it outside.
    expect(css).toMatch(
      /\.cc-public-shell :is\([^)]*\.cc-nav\b[^)]*\) :focus-visible \{\s*outline-offset: -2px;/,
    );
  });

  it("a tab never shrinks below its longest word, so labels cannot overlap (Codex round 3)", () => {
    // An explicit min-width on the link replaces its automatic minimum (the
    // min-content width), and the strip squeezed every tab to 44px.
    expect(rule(".cc-nav a")).not.toMatch(/min-width:/);
    // The 44px hit-box floor sits on the label, so the link's automatic
    // minimum is max(44px, its longest word).
    expect(rule(".cc-nav-label")).toContain("min-width: 44px;");
    const html = renderPublic();
    for (const tab of ["arena", "leaderboard", "lab", "methodology"])
      expect(html).toContain(`<span class="cc-nav-label">chess:nav.${tab}</span>`);
  });

  it("the language trigger is icon-only below xl in the arena header", () => {
    expect(renderPublic()).toContain('<i data-control="language" data-label-hidden-below="xl">');
  });
});

describe("arena header: the session hint", () => {
  beforeEach(() => {
    authState.hint = false;
  });

  it("signed in: an account link to the app shell, never Sign In", () => {
    authState.hint = true;
    const html = renderPublic();
    expect(html).toContain('aria-label="nav:userMenu.account" data-to="/$lang/settings"');
    expect(html).not.toContain("userMenu.signIn");
    // Studio stays: it is part of the arena, for everyone.
    expect(html).toContain("chess:nav.studio");
  });

  it("signed out (or unseeded, as on the 404): no account link and no Sign In", () => {
    const html = renderPublic();
    expect(html).not.toContain("nav:userMenu.account");
    expect(html).not.toContain("userMenu.signIn");
    expect(html).toContain("chess:nav.studio");
  });
});
