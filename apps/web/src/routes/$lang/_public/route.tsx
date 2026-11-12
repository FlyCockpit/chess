import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
export const Route = createFileRoute("/$lang/_public")({ component: PublicLayout });
function PublicLayout() {
  useMobileKeyboard();
  const { lang } = Route.useParams();
  const { t } = useTranslation(["chess", "nav"]);
  return (
    <div className="cc-public-shell">
      <a
        href="#main-content"
        className="sr-only fixed top-2 left-2 z-[100] rounded-md bg-background px-4 py-3 text-foreground shadow-md focus:not-sr-only focus-visible:outline-2 focus-visible:outline-ring"
      >
        {t("nav:skipToContent")}
      </a>
      <header className="cc-header">
        <Link to="/$lang" params={{ lang }} search={{ tab: "arena" }} className="cc-brand">
          <img
            src="/pwa-192x192.png"
            alt=""
            width={36}
            height={36}
            decoding="async"
            className="size-9 shrink-0"
          />
          {t("chess:brand")}
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
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <Link to="/$lang" params={{ lang }} search={{ tab: "studio" }} className="cc-signin">
            {t("chess:nav.studio")}
          </Link>
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        data-scroll-restoration-id={MAIN_SCROLLER_ID}
        className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain [scrollbar-gutter:stable]"
      >
        <Outlet />
      </main>
    </div>
  );
}
