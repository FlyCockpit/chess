import { type ComponentType, createElement, lazy, Suspense, useReducer, useState } from "react";

import { useMountEffect } from "@/hooks/use-mount-effect";

type WatcherModule = { default: ComponentType };

const importWatcher = (): Promise<WatcherModule> => import("@/components/identity-boundary");

/**
 * Calls `retry` when the tab is back in front or back online. Returns the
 * unsubscribe.
 */
export function whenBackInFront(retry: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState !== "hidden") retry();
  };
  window.addEventListener("focus", retry);
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("focus", retry);
    window.removeEventListener("online", retry);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

function RetryWhenBack({ retry }: { retry: () => void }) {
  useMountEffect(() => whenBackInFront(retry));
  return null;
}

/**
 * The watcher's chunk, or, when it fails to load (offline, a deploy replaced
 * it), a stand-in that renders nothing and asks for another attempt when the
 * tab is back: the failure never reaches the root's error boundary, which
 * would unmount the page (and the Lab's device-local work with it).
 */
export function loadWatcherOrRetry(
  load: () => Promise<WatcherModule>,
  retry: () => void,
): Promise<WatcherModule> {
  return load().catch(() => ({ default: () => createElement(RetryWhenBack, { retry }) }));
}

function Attempt({ retry }: { retry: () => void }) {
  // One lazy component per attempt: React.lazy keeps its first result.
  const [Watcher] = useState(() => lazy(() => loadWatcherOrRetry(importWatcher, retry)));
  // Suspense inside the attempt: it commits (with the fallback) and keeps
  // its lazy component while the chunk loads.
  return (
    <Suspense fallback={null}>
      <Watcher />
    </Suspense>
  );
}

/**
 * The hosted root's lazily loaded identity watcher (`IdentityBoundary`),
 * contained: until it has loaded, an unverified identity keeps the chrome
 * neutral, and a failed load is retried when the tab is back in front or
 * online. See docs/auth-and-routing.md § Query cache follows identity
 */
export function IdentityBoundaryLoader() {
  const [attempt, retry] = useReducer((n: number) => n + 1, 0);
  return <Attempt key={attempt} retry={retry} />;
}
