import { buttonVariants } from "@cockpit-chess/ui/components/button";
import { revealFocusedItem } from "@cockpit-chess/ui/components/selector-row";
import { edgeAttributes, useScrollEdges } from "@cockpit-chess/ui/hooks/use-scroll-edges";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { User } from "lucide-react";
import { type ReactNode, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ModeToggle } from "@/components/mode-toggle";
import { NotFoundPage } from "@/components/not-found-page";
import { OfflineBand } from "@/components/offline-band";
import { PublicFooter } from "@/components/public-footer";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { usePeerSessionChange } from "@/hooks/use-peer-session-change";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { SESSION_HINT_QUERY_KEY, sessionHintQueryOptions } from "@/lib/session-hint";

/**
 * The arena's public shell: header, the one page scroller and the footer. The
 * `_public` layout renders its routes through it, and so does the 404 (`$lang`'s
 * `notFoundComponent`), so an unknown URL keeps the header's language and theme
 * controls, the footer and the scroller. See
 * docs/design-system.md § Shell rules
 */
export function PublicShell({ children }: { children: ReactNode }) {
  useMobileKeyboard();
  const { t } = useTranslation("nav");
  return (
    // `.cc-public-shell` (index.css) is the frame: pinned to the viewport, the
    // header row over <main>, the bottom padded by the home-indicator inset
    // only. A cookie banner's reserve is <main>'s (`#main-content`, index.css).
    <div className="cc-public-shell">
      <a
        href="#main-content"
        className="sr-only fixed top-2 left-2 z-50 rounded-md bg-background px-4 py-3 text-foreground shadow-md focus:not-sr-only focus:fixed focus-visible:outline-2 focus-visible:outline-ring"
      >
        {t("skipToContent")}
      </a>
      {/* The top row: header, then the offline band, which takes its own
          space above the scroller instead of covering the page. */}
      <div className="min-w-0">
        <PublicHeader />
        <OfflineBand columnClassName="cc-app" />
      </div>
      {/* No `scrollbar-gutter: stable`: a reserved gutter stops the footer's
          and every other full-bleed rule inside the scroller short of the
          viewport edge with classic scrollbars. */}
      <main
        id="main-content"
        tabIndex={-1}
        data-scroll-restoration-id={MAIN_SCROLLER_ID}
        className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain"
      >
        {/* At least as tall as the scroller: the page grows into the space,
            so the footer ends at the scroller's bottom on a short page and
            follows the content on a long one. */}
        <div className="flex min-h-full min-w-0 flex-col">
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          <PublicFooter />
        </div>
      </main>
    </div>
  );
}

function PublicHeader() {
  // `strict: false`: the 404 renders this header under `$lang` as well as the
  // `_public` routes. An unsupported value never gets this far (`$lang`
  // redirects it), but fall back rather than build a broken link.
  const langParam = useParams({ strict: false, select: (p) => p.lang });
  const lang = isSupportedLocale(langParam) ? langParam : DEFAULT_LOCALE;
  const { t } = useTranslation(["chess", "nav"]);
  // Signed in (the session-cookie hint, lib/session-hint.ts): an account link
  // to the app shell, where Settings, Admin and Sign Out live. The `_public`
  // layout seeds the hint, so it is in the SSR HTML; the 404 (no `_public`
  // route) asks on the client. A presence hint, never an access check: the
  // link's `_auth` gate does the real one. Signed out there is no Sign In
  // here: Studio's own page offers it to administrators.
  const { data: signedIn = false } = useQuery({
    ...sessionHintQueryOptions(),
    // A sign-in or sign-out in another tab shows here as soon as this tab is
    // back in front, not once the minute is up.
    refetchOnWindowFocus: "always",
  });
  // ...and at once when the other tab announces it.
  const queryClient = useQueryClient();
  usePeerSessionChange(
    useCallback(
      () => void queryClient.invalidateQueries({ queryKey: SESSION_HINT_QUERY_KEY }),
      [queryClient],
    ),
  );
  const navRef = useRef<HTMLElement>(null);
  const navEdges = useScrollEdges(navRef);
  return (
    // The rule is the full-bleed header's border; the row inside keeps the
    // 1440px maximum (`.cc-header-row`), so the line reaches both viewport
    // edges at any width.
    <header className="cc-header">
      <div className="cc-header-row">
        {/* The first thing in the row to give way, down to its icon (`.cc-brand`
            in index.css, the same rule as the app header's AppNameLink). */}
        <Link
          to="/$lang"
          params={{ lang }}
          search={{ tab: "arena" }}
          className="cc-brand"
          title={t("chess:brand")}
        >
          <img
            src="/pwa-192x192.png"
            alt=""
            width={36}
            height={36}
            decoding="async"
            className="size-9 shrink-0"
          />
          <span className="cc-brand-name">{t("chess:brand")}</span>
        </Link>
        {/* When the tabs scroll sideways (651–700px in es-MX, for one), the edge
            with more tabs past it fades, as in every SelectorRow, and a tab
            reached by keyboard scrolls clear of the fade. */}
        <nav
          ref={navRef}
          className="cc-nav scroll-fade-x scroll-px-6"
          aria-label={t("nav:mainNav.ariaLabel")}
          {...edgeAttributes(navEdges)}
          onFocus={revealFocusedItem}
        >
          {(["arena", "leaderboard", "lab", "methodology"] as const).map((tab) => (
            <Link
              key={tab}
              to="/$lang"
              params={{ lang }}
              search={{ tab }}
              activeOptions={{ includeSearch: true }}
            >
              <span className="cc-nav-label">{t(`chess:nav.${tab}`)}</span>
            </Link>
          ))}
        </nav>
        {/* Never pushed past the row's trailing edge, at any width and in any
            locale (signed in, the account link is the only way to Settings,
            Admin and Sign out). The tabs give way instead (`.cc-nav` scrolls
            sideways once its labels have wrapped), so the row needs only the
            brand's 88px floor, the gaps and this group. Worst case, signed
            in, es-MX: language icon-only below `xl` 66 (with "Español
            (México)" about 190), theme 44, "Estudio" about 93, account 44,
            three 8px gaps: 271px below 1280 (395 from 1280), against 288px at
            320 (on its own line under the brand), 603 at 651 and 1200 at
            1280. `max-w-full flex-wrap` is the backstop: a longer future
            label wraps inside the group instead of overflowing it. Pinned in
            public-shell.test.tsx, measured by `pnpm check:layout`. */}
        <div
          data-header-controls=""
          className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2"
        >
          <LanguageSwitcher labelHiddenBelow="xl" />
          <ModeToggle />
          <Link to="/$lang" params={{ lang }} search={{ tab: "studio" }} className="cc-signin">
            {t("chess:nav.studio")}
          </Link>
          {signedIn && (
            <Link
              to="/$lang/settings"
              params={{ lang }}
              aria-label={t("nav:userMenu.account")}
              title={t("nav:userMenu.account")}
              data-account-link=""
              className={buttonVariants({ variant: "outline", size: "icon-touch" })}
            >
              <User className="size-4" aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * The 404 for an unknown URL, which matches no layout: `$lang`'s
 * `notFoundComponent`, so it renders in `$lang`'s outlet with nothing around
 * it. Wrapped in the public shell, it keeps the header (language, theme,
 * Studio, and the account link when signed in), the footer and the scroller
 * like every other page.
 */
export function PublicNotFoundPage() {
  return (
    <PublicShell>
      <NotFoundPage />
    </PublicShell>
  );
}
