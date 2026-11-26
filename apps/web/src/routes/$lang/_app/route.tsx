import { cn } from "@cockpit-chess/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AdminSetupBanner } from "@/components/admin-setup-banner";
import BottomNav from "@/components/bottom-nav";
import Header from "@/components/header";
import PullToRefresh from "@/components/pull-to-refresh";
import { SetupKeyBanner } from "@/components/setup-key-banner";
import { useDocumentLang } from "@/hooks/use-document-lang";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { useUserLocaleSync } from "@/hooks/use-user-locale-sync";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";

export const Route = createFileRoute("/$lang/_app")({
  // App/auth/admin surfaces depend on browser-only auth, PWA, viewport, and
  // navigation side effects. Keep this branch client-rendered while public
  // pages remain SSR-capable under `/$lang/_public`.
  ssr: false,
  component: AppShellLayout,
});

function AppShellLayout() {
  // Service-worker registration (useAppUpdate) lives in __root so public
  // pages get it too — don't re-add it here.
  const { t } = useTranslation("nav");
  useDocumentLang();
  useUserLocaleSync();
  const mobileKeyboardOpen = useMobileKeyboard();
  const queryClient = useQueryClient();

  // Every signed-in page gets pull-to-refresh: mark all cached data stale and
  // refetch what is on screen. A page opts out with
  // `data-pull-to-refresh="off"` (see packages/api/src/lib/pagination.ts).
  const handleRefresh = useCallback(() => queryClient.invalidateQueries(), [queryClient]);

  return (
    <>
      <a
        href="#main-content"
        className="sr-only fixed top-2 left-2 z-50 rounded-md bg-background px-4 py-3 text-foreground shadow-md focus:not-sr-only focus:fixed focus-visible:outline-2 focus-visible:outline-ring"
      >
        {t("skipToContent")}
      </a>
      <div
        className={cn(
          "grid h-svh min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] md:grid-rows-[auto_1fr]",
          // The frame reserves the BottomNav (phones, no keyboard up) and
          // nothing else: the shell chrome always reaches the bottom of the
          // viewport. `--frame-reserve` tells #main-content (index.css) how
          // much of a cookie banner's clearance that already covers; <main>
          // pads the rest.
          !mobileKeyboardOpen &&
            "pb-[calc(3.5rem_+_var(--safe-area-bottom))] [--frame-reserve:calc(3.5rem_+_var(--safe-area-bottom))] md:pb-0 md:[--frame-reserve:0px]",
        )}
        style={{
          paddingTop: "var(--safe-area-top)",
          paddingLeft: "var(--safe-area-left)",
          paddingRight: "var(--safe-area-right)",
        }}
      >
        <div>
          <Header />
          <AdminSetupBanner />
          <SetupKeyBanner />
        </div>
        {/* No `scrollbar-gutter: stable`: the banners and sticky sub-navs
            inside the scroller are full-bleed. This shell has no footer:
            phones get the BottomNav, and Cookie preferences (with analytics) sits in Settings.
            See docs/design-system.md § Shell rules */}
        <main
          id="main-content"
          tabIndex={-1}
          data-scroll-restoration-id={MAIN_SCROLLER_ID}
          className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain"
        >
          <PullToRefresh onRefresh={handleRefresh}>
            <Outlet />
          </PullToRefresh>
        </main>
        <BottomNav hidden={mobileKeyboardOpen} />
      </div>
      {import.meta.env.DEV && (
        <>
          <TanStackRouterDevtools position="bottom-left" />
          <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
        </>
      )}
    </>
  );
}
