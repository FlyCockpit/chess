import { useEffect, useRef } from "react";

/** Reveal the active link by moving only its horizontal container. */
export function revealActiveTab(row: HTMLElement) {
  const active = row.querySelector<HTMLElement>('[aria-current="page"]');
  if (!active || row.scrollWidth <= row.clientWidth) return;
  const rowRect = row.getBoundingClientRect();
  const tabRect = active.getBoundingClientRect();
  const delta =
    tabRect.left < rowRect.left
      ? tabRect.left - rowRect.left
      : Math.max(0, tabRect.right - rowRect.right);
  if (delta) row.scrollLeft += delta;
}

export function useRevealActiveTab(pathname: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void pathname;
    if (ref.current) revealActiveTab(ref.current);
  }, [pathname]);
  return ref;
}
