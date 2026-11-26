import { cn } from "@cockpit-chess/ui/lib/utils";
import { Wifi, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PAGE_COLUMN_CLASS } from "@/components/page-shell";
import { useConnectivityNotice } from "@/hooks/use-connectivity-notice";

/**
 * The app-wide offline band. Both shells (the arena's public shell and the
 * signed-in app shell) render it in their top row, above `<main>`, so it takes
 * its own space in the flow: it never covers the page, the BottomNav or the
 * cookie banner, and it is not a second scroller. See
 * docs/design-system.md § Offline and network failures
 *
 * The live region is always mounted (empty while online), so assistive tech
 * announces "You're offline" once when it appears and "Back online" once on
 * reconnect. The fade is `motion-safe:` only.
 */
export function OfflineBand({
  columnClassName = PAGE_COLUMN_CLASS,
}: {
  /** The column its text sits in: the shell's widest page column (the arena passes `cc-app`). */
  columnClassName?: string;
}) {
  const notice = useConnectivityNotice();
  const { t } = useTranslation("common");
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-offline-band="">
      {notice && (
        // The band spans the window; its text sits in the widest page column.
        // See docs/design-system.md § Viewport scale
        <p className="border-b bg-muted py-1.5 text-sm text-foreground motion-safe:animate-in motion-safe:fade-in-0">
          <span className={cn(columnClassName, "flex min-w-0 items-center gap-2")}>
            {notice === "offline" ? (
              <WifiOff aria-hidden="true" className="size-4 shrink-0 text-state-warning" />
            ) : (
              <Wifi aria-hidden="true" className="size-4 shrink-0 text-state-success" />
            )}
            <span className="min-w-0">
              {notice === "offline" ? t("offline.band") : t("offline.backOnline")}
            </span>
          </span>
        </p>
      )}
    </div>
  );
}
