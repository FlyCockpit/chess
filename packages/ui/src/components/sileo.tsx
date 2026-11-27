import { useSyncExternalStore } from "react";
import { Toaster as SileoToaster, sileo } from "sileo";
import "sileo/styles.css";

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToasterProps {
  position?: ToastPosition;
}

// Tailwind `md`. Below it the page is one column and the toast sits centred
// above the thumb. From it on, forms and their submit buttons sit in centred
// columns, so a bottom-centre toast (an expanded error stays up for seconds,
// longer while hovered) lands on the action that raised it; the bottom-right
// corner is outside every centred column.
const WIDE_QUERY = "(min-width: 768px)";

/** The default corner for a viewport. Exported for the tests. */
export function defaultToastPosition(wide: boolean): ToastPosition {
  return wide ? "bottom-right" : "bottom-center";
}

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia?.(WIDE_QUERY);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}
const readWide = () => window.matchMedia?.(WIDE_QUERY).matches === true;
const readWideOnServer = () => false;

// No `theme`: sileo's themes invert the page (a light pill on a dark app).
// The toast takes the app's popover tokens from globals.css instead, so it
// follows `.dark` like every other surface, with no JS theme state.
// sileo stamps each toast with the corner current when it is raised, so a
// resize across the breakpoint moves only the toasts raised after it.
const Toaster = ({ position, ...props }: ToasterProps) => {
  const wide = useSyncExternalStore(subscribeWide, readWide, readWideOnServer);
  return <SileoToaster position={position ?? defaultToastPosition(wide)} {...props} />;
};

type ToastOptions = {
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
};

// sileo keys toasts by `id` and defaults every one to "sileo-default", so a
// second toast replaces (morphs into) the first: two messages merge into one
// blob and the first is lost. Each toast gets its own id, so they stack.
let toastCount = 0;
const nextToastId = () => `toast-${++toastCount}`;

// The pill is one line inside sileo's fixed 350px SVG (`--sileo-width`).
// globals.css caps the title row and ends a longer title with an ellipsis, so
// a title that does not fit also goes in the description, which sileo expands
// under the pill. Whether it fits depends on the glyphs and the root font size
// (a larger browser font setting grows the title but not the pill), not on a
// character count, so measure it at the title's font. Where nothing can be
// measured (SSR, tests without canvas) a length rule stands in.
const SILEO_WIDTH_PX = 350;
const PILL_MAX_CHARS = 40;

/** Room for the title: the pill minus sileo's 10px padding, the 24px badge,
 *  the header's 0.5rem padding on each side and the 0.5rem gap (all at `rootPx`). */
export function pillTitleBudget(rootPx: number): number {
  return SILEO_WIDTH_PX - 10 - 24 - rootPx * 1.5;
}

type TitleMeasure = (message: string) => { width: number; budget: number } | null;

let measureContext: CanvasRenderingContext2D | null | undefined;
const measureTitle: TitleMeasure = (message) => {
  if (typeof document === "undefined") return null;
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement("canvas").getContext("2d");
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return null;
  const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  // sileo's title: 0.825rem, weight 500.
  measureContext.font = `500 ${0.825 * rootPx}px ${family}`;
  return { width: measureContext.measureText(message).width, budget: pillTitleBudget(rootPx) };
};

/** True when the message would be cut off in the pill. A 5% margin covers
 *  sub-pixel and font-loading differences. Exported for the tests. */
export function titleOverflowsPill(message: string, measure: TitleMeasure = measureTitle): boolean {
  const measured = measure(message);
  if (!measured) return message.length > PILL_MAX_CHARS;
  return measured.width > measured.budget * 0.95;
}

function createToastMethod(method: "success" | "error" | "info" | "warning" | "show") {
  return (message: string, options?: ToastOptions): string => {
    // sileo 0.1.6 reads `options.id` at runtime, but its type omits it.
    return sileo[method]({
      id: nextToastId(),
      title: message,
      ...(titleOverflowsPill(message)
        ? { description: message, autopilot: { expand: 0, collapse: 0 } }
        : {}),
      ...(options?.duration != null ? { duration: options.duration } : {}),
      ...(options?.action
        ? {
            autopilot: { expand: 0, collapse: 0 },
            button: { title: options.action.label, onClick: options.action.onClick },
          }
        : {}),
    } as Parameters<typeof sileo.show>[0]);
  };
}

const toast = {
  /** Neutral, polite notice — no success/error severity styling. */
  message: createToastMethod("show"),
  success: createToastMethod("success"),
  error: createToastMethod("error"),
  info: createToastMethod("info"),
  warning: createToastMethod("warning"),
  dismiss: sileo.dismiss,
  clear: sileo.clear,
};

export { Toaster, toast };
