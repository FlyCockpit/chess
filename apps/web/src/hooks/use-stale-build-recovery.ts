import { useRouter } from "@tanstack/react-router";

import { useMountEffect } from "@/hooks/use-mount-effect";
import {
  listenForRouteImportFailure,
  recoverFromStaleChunk,
  type StaleBuildRecoveryEnv,
  USER_INPUT_WINDOW_MS,
} from "@/lib/stale-build-recovery";

function openSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function suppressRouterReload(error: unknown): void {
  if (
    !error ||
    typeof error !== "object" ||
    !("message" in error) ||
    typeof error.message !== "string"
  )
    return;
  const message = error.message;
  // TanStack's lazyRouteComponent otherwise reloads from render independently of
  // our activation/ownership/cooldown policy. Mark its documented per-error slot
  // before the Vite rejection reaches it; the original error still reaches ErrorState.
  // This key mirrors the installed lazyRouteComponent implementation, not our cooldown.
  if (
    ![
      "Failed to fetch dynamically imported module",
      "error loading dynamically imported module",
      "Importing a module script failed",
    ].some((prefix) => message.startsWith(prefix))
  )
    return;
  try {
    openSessionStorage()?.setItem(`tanstack_router_reload:${message}`, "1");
  } catch {
    /* Unavailable storage must never initiate recovery. */
  }
}

/** Recover only an import proven to belong to the activated pending route, never a lazy menu. */
export function useStaleBuildRecovery() {
  const router = useRouter();
  useMountEffect(() => {
    let recovering = false;
    let lastInputAt = Number.NEGATIVE_INFINITY;
    let activatedNavigationHref: string | undefined;
    let failedImports: { error: unknown; pending: StaleBuildRecoveryEnv["router"] }[] = [];
    const recoverOwnedImport = (navigationErrors: readonly unknown[]) => {
      if (recovering || router.latestLocation.publicHref !== activatedNavigationHref) return;
      for (const failure of failedImports) {
        if (
          recoverFromStaleChunk({
            router: failure.pending,
            storage: openSessionStorage(),
            now: Date.now(),
            activatedNavigationHref,
            failedImport: failure.error,
            navigationErrors,
            assign: (href) => window.location.assign(href),
          })
        ) {
          recovering = true;
          break;
        }
      }
    };
    const unsubscribeImportFailure = listenForRouteImportFailure(router, (error, routeId) => {
      if (router.state.matches.some((match) => match.routeId === routeId))
        recoverOwnedImport([error]);
    });
    const unsubscribeNavigation = router.subscribe("onBeforeNavigate", ({ toLocation }) => {
      activatedNavigationHref =
        Date.now() - lastInputAt < USER_INPUT_WINDOW_MS ? toLocation.publicHref : undefined;
      lastInputAt = Number.NEGATIVE_INFINITY;
      failedImports = [];
    });
    // Vite emits before the import rejection reaches its owner. Leave that rejection intact,
    // then compare the exact error against this navigation's failed route matches at commit.
    // A global preload failure during someone else's navigation is insufficient evidence.
    const unsubscribeLoad = router.subscribe("onLoad", ({ toLocation }) => {
      if (recovering || toLocation.publicHref !== activatedNavigationHref) return;
      const navigationErrors = router.state.matches
        .filter((match) => match.status === "error")
        .map((match) => match.error);
      recoverOwnedImport(navigationErrors);
    });
    const unsubscribeRendered = router.subscribe("onRendered", () => {
      activatedNavigationHref = undefined;
      failedImports = [];
    });
    const onPointerDown = () => {
      lastInputAt = Date.now();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") lastInputAt = Date.now();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        recovering = false;
        activatedNavigationHref = undefined;
        lastInputAt = Number.NEGATIVE_INFINITY;
        failedImports = [];
      }
    };
    const onPreloadError = (event: Event) => {
      if ("payload" in event) suppressRouterReload(event.payload);
      if (recovering) {
        event.preventDefault();
        return;
      }
      if (
        !activatedNavigationHref ||
        !router.state.isLoading ||
        router.latestLocation.publicHref !== activatedNavigationHref
      )
        return;
      if (!("payload" in event) || event.payload === undefined) return;
      failedImports.push({
        error: event.payload,
        pending: {
          latestLocation: router.latestLocation,
          state: { isLoading: true, resolvedLocation: router.state.resolvedLocation },
        },
      });
    };
    window.addEventListener("vite:preloadError", onPreloadError);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      unsubscribeImportFailure();
      unsubscribeNavigation();
      unsubscribeLoad();
      unsubscribeRendered();
      window.removeEventListener("vite:preloadError", onPreloadError);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pageshow", onPageShow);
    };
  });
}
