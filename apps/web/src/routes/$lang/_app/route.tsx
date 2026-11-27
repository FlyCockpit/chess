import { cn } from "@cockpit-chess/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { type ReactNode, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AdminSetupBanner } from "@/components/admin-setup-banner";
import BottomNav from "@/components/bottom-nav";
import Header from "@/components/header";
import { OfflineBand } from "@/components/offline-band";
import PullToRefresh from "@/components/pull-to-refresh";
import { RouteContentSkeleton } from "@/components/route-content-skeleton";
import { SetupKeyBanner } from "@/components/setup-key-banner";
import { useDocumentLang } from "@/hooks/use-document-lang";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { useMountEffect } from "@/hooks/use-mount-effect";
import { useReloadOnIdentityChange } from "@/hooks/use-reload-on-identity-change";
import { useSessionHintSync } from "@/hooks/use-session-hint-sync";
import { useUserLocaleSync } from "@/hooks/use-user-locale-sync";
import { markAppShellHydrated } from "@/lib/app-shell-hydration";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { SessionUnconfirmed } from "@/lib/session-unconfirmed";

/** The frame's last element: the first paint waits until it is parsed. */
const APP_SHELL_END_ID = "app-shell-end";

export const Route = createFileRoute("/$lang/_app")({
  // App/auth/admin surfaces depend on browser-only auth, PWA, viewport, and
  // navigation side effects. Keep this branch client-rendered while public
  // pages remain SSR-capable under `/$lang/_public`.
  ssr: false,
  // What a hard refresh paints first. With `ssr: false` the server renders
  // this route's pending component in place of the layout, and the client
  // shows it again until the layout can mount (hydration, the auth check).
  // So it is the real shell (header, bottom nav) around a skeleton of the
  // page's content area only: no frame without the nav, and no layout jump
  // when the page arrives; `pnpm check:shell-loading` measures it.
  // See docs/design-system.md § Route pending states
  pendingComponent: AppShellPending,
  // A browser may paint a document it has only partly parsed (the HTML
  // arrives in pieces on a slow network): a header without the scroller or
  // the bottom nav. Hold the first paint until the whole frame is parsed
  // (`#app-shell-end`, the frame's last element). Browsers without
  // `rel="expect"` ignore it.
  head: () => ({
    links: [{ rel: "expect", href: `#${APP_SHELL_END_ID}`, blocking: "render" }],
  }),
  component: AppShellLayout,
});

function AppShellLayout() {
  // Service-worker registration (useAppUpdate) lives in __root so public
  // pages get it too — don't re-add it here.
  useDocumentLang();
  useUserLocaleSync();
  useSessionHintSync();
  const queryClient = useQueryClient();

  // Every signed-in page gets pull-to-refresh: mark all cached data stale and
  // refetch what is on screen. A page opts out with
  // `data-pull-to-refresh="off"` (see packages/api/src/lib/pagination.ts).
  const handleRefresh = useCallback(() => queryClient.invalidateQueries(), [queryClient]);

  return (
    <>
      <AppShellFrame>
        <PullToRefresh onRefresh={handleRefresh}>
          <Outlet />
        </PullToRefresh>
      </AppShellFrame>
      {import.meta.env.DEV && (
        <>
          <TanStackRouterDevtools position="bottom-left" />
          <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
        </>
      )}
    </>
  );
}

/** The shell around the loading page: same frame, content skeleton only. */
function AppShellPending() {
  // It paints before any session guard has admitted anyone: the chrome shows
  // no account until one has (lib/session-unconfirmed.ts). The frame's
  // identity watcher reads the session unmasked.
  return (
    <SessionUnconfirmed>
      <AppShellFrame>
        <RouteContentSkeleton />
      </AppShellFrame>
    </SessionUnconfirmed>
  );
}

/**
 * The app frame, shared by the layout and its pending state so the two are
 * the same boxes: the header and the bottom nav never move when the page
 * replaces its skeleton.
 */
function AppShellFrame({ children }: { children: ReactNode }) {
  // In the frame itself (the pending shell and the loaded one), not only
  // through the root's lazily loaded IdentityBoundary: the shell shows the
  // account and a guarded page renders private data at once, so the identity
  // watcher is connected by then, never waiting on a chunk. See
  // docs/auth-and-routing.md § Query cache follows identity
  useReloadOnIdentityChange();
  const { t } = useTranslation("nav");
  const mobileKeyboardOpen = useMobileKeyboard();
  // The first effect of a hydrated (or client-rendered) frame: from here on a
  // route guard may change the URL (lib/app-shell-hydration.ts).
  useMountEffect(markAppShellHydrated);
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
        // APP_SHELL_ATTRIBUTE: what a guard looks for to know a server-rendered
        // shell may still be hydrating.
        data-app-shell=""
      >
        <div>
          <Header />
          <AdminSetupBanner />
          <SetupKeyBanner />
          {/* In the top row, above the scroller: it never covers the page,
              the BottomNav or the cookie banner. */}
          <OfflineBand />
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
          {children}
        </main>
        <BottomNav hidden={mobileKeyboardOpen} />
        <span id={APP_SHELL_END_ID} hidden />
      </div>
    </>
  );
}
