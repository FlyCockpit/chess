/**
 * Below which breakpoint the trigger shows only its icon and chevron (the
 * locale name stays for screen readers). Static class names, so Tailwind sees
 * them. `sm` by default (the app header); the arena header passes `xl`, where
 * its translated tabs, the brand and the controls only fit with the name from
 * 1280px up (the width budget is in public-shell.tsx's PublicHeader).
 */
export const LABEL_HIDDEN_BELOW = {
  sm: "max-sm:sr-only",
  xl: "max-xl:sr-only",
} as const;
export type LabelHiddenBelow = keyof typeof LABEL_HIDDEN_BELOW;
