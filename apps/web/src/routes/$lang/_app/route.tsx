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
        className="sr-only fixed top-2 left-2 z-[100] rounded-md bg-background px-4 py-3 text-foreground shadow-md focus:not-sr-only focus-visible:outline-2 focus-visible:outline-ring"
      >
        {t("skipToContent")}
      </a>
      <div
        className={cn(
          "grid h-svh min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] md:grid-rows-[auto_1fr] md:pb-(--consent-clearance)",
          // The bottom reserve: the cookie banner's clearance (index.css; 0
          // without a banner) and, on phones with no keyboard up, at least the
          // BottomNav's. The banner reaches down over the BottomNav, so it is
          // the larger while it shows.
          mobileKeyboardOpen
            ? "pb-(--consent-clearance)"
            : "pb-[max(calc(3.5rem_+_var(--safe-area-bottom)),var(--consent-clearance))]",
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
        <main
          id="main-content"
          tabIndex={-1}
          data-scroll-restoration-id={MAIN_SCROLLER_ID}
          className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain [scrollbar-gutter:stable]"
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
