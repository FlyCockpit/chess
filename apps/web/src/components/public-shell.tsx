import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ModeToggle } from "@/components/mode-toggle";
import { NotFoundPage } from "@/components/not-found-page";
import { PublicFooter } from "@/components/public-footer";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";

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
    // header row over <main>, the bottom padded by the cookie banner's clearance.
    <div className="cc-public-shell">
      <a
        href="#main-content"
        className="sr-only fixed top-2 left-2 z-50 rounded-md bg-background px-4 py-3 text-foreground shadow-md focus:not-sr-only focus-visible:outline-2 focus-visible:outline-ring"
      >
        {t("skipToContent")}
      </a>
      <PublicHeader />
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
        <nav className="cc-nav" aria-label={t("nav:mainNav.ariaLabel")}>
          {(["arena", "leaderboard", "lab", "methodology"] as const).map((tab) => (
            <Link
              key={tab}
              to="/$lang"
              params={{ lang }}
              search={{ tab }}
              activeOptions={{ includeSearch: true }}
            >
              {t(`chess:nav.${tab}`)}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <LanguageSwitcher />
          <ModeToggle />
          <Link to="/$lang" params={{ lang }} search={{ tab: "studio" }} className="cc-signin">
            {t("chess:nav.studio")}
          </Link>
        </div>
      </div>
    </header>
  );
}

/**
 * The 404 for an unknown URL, which matches no layout: `$lang`'s
 * `notFoundComponent`, so it renders in `$lang`'s outlet with nothing around
 * it. Wrapped in the public shell, it keeps the header (language, theme,
 * Studio), the footer and the scroller like every other page.
 */
export function PublicNotFoundPage() {
  return (
    <PublicShell>
      <NotFoundPage />
    </PublicShell>
  );
}
