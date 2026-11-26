import { Card, CardContent, CardHeader } from "@cockpit-chess/ui/components/card";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { cn } from "@cockpit-chess/ui/lib/utils";
import { useMatch, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { SkeletonList } from "@/components/skeleton-list";
import {
  type PendingFrame,
  type PendingLayout,
  type PendingShape,
  type PendingWidth,
  resolvePendingLayout,
} from "@/lib/pending-layout";

// The `PageShell` widths (components/page-shell.tsx), so the skeleton's
// columns line up with the page that replaces it.
const WIDTH_CLASS: Record<PendingWidth, string> = {
  narrow: "max-w-4xl",
  default: "max-w-5xl",
  wide: "max-w-7xl",
};

/**
 * The content-area skeleton for the route that is loading, shaped by its
 * `staticData` (lib/pending-layout.ts). It never draws app chrome: the app
 * shell renders around it (`_app`'s pending component, and every pending
 * boundary below it, sit inside the shell's `<main>`), so the header, the nav
 * and the bottom nav are the real ones from the first frame.
 *
 * It is the router's `defaultPendingComponent`, `_app`'s pending content and
 * the forced-2FA gate's loading state.
 */
export function RouteContentSkeleton() {
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  // The matches of the location being loaded (a pending route is already in
  // `matches`, with status "pending"), leaf last.
  const matches = useRouterState({ select: (state) => state.matches });
  return <ContentSkeleton layout={resolvePendingLayout(matches, routeId)} />;
}

/** The skeleton markup for a resolved layout. */
function ContentSkeleton({ layout }: { layout: PendingLayout }) {
  let body: ReactNode = <ShapeSkeleton shape={layout.shape} />;
  // Innermost frame first: a settings form inside the settings frame inside
  // nothing else.
  for (const frame of [...layout.frames].reverse()) {
    body = (
      <FrameSkeleton frame={frame} width={layout.width}>
        {body}
      </FrameSkeleton>
    );
  }
  const framed = layout.frames.length > 0;
  return (
    <div
      data-route-skeleton={layout.shape}
      aria-busy="true"
      className={cn(
        !framed && ["container mx-auto space-y-6 px-4 py-8", WIDTH_CLASS[layout.width]],
      )}
    >
      {body}
    </div>
  );
}

function FrameSkeleton({
  frame,
  width,
  children,
}: {
  frame: PendingFrame;
  width: PendingWidth;
  children: ReactNode;
}) {
  if (frame === "admin") {
    // The admin layout: a sticky, full-bleed sub-nav of four 44px links, then
    // the page in its own `PageShell`.
    return (
      <>
        <div className="border-b">
          <div className="container mx-auto flex max-w-7xl gap-1 overflow-hidden px-4 py-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-11 w-24 shrink-0 rounded-md" />
            ))}
          </div>
        </div>
        <div className={cn("container mx-auto space-y-6 px-4 py-8", WIDTH_CLASS[width])}>
          {children}
        </div>
      </>
    );
  }
  // The settings layout (its own max-w-4xl container): title, then a side nav
  // (a row on phones) and the section's content.
  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      <Skeleton className="mb-6 h-8 w-32" />
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <div className="flex gap-1 md:w-48 md:shrink-0 md:flex-col">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-11 w-24 shrink-0 rounded-md md:h-9 md:w-full" />
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-6">{children}</div>
      </div>
    </div>
  );
}

function HeaderSkeleton({ action }: { action?: boolean }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-5 w-64 max-w-full" />
      </div>
      {action ? <Skeleton className="h-11 w-32" /> : null}
    </div>
  );
}

function ShapeSkeleton({ shape }: { shape: PendingShape }) {
  switch (shape) {
    case "list":
      return (
        <>
          <HeaderSkeleton action />
          <Card>
            <CardHeader className="space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent className="p-0">
              <SkeletonList count={4} />
            </CardContent>
          </Card>
        </>
      );
    case "detail":
      return (
        <>
          <HeaderSkeleton action />
          <Skeleton className="h-48 w-full rounded-lg" />
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </>
      );
    case "form":
      return (
        <>
          <HeaderSkeleton />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-11 w-full md:h-8" />
              </div>
            ))}
          </div>
          <Skeleton className="h-11 w-32" />
        </>
      );
    case "dashboard":
      return (
        <>
          <HeaderSkeleton />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Skeleton className="h-32 w-full rounded-lg" />
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
        </>
      );
  }
}
