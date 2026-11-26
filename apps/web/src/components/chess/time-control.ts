import { CLOCK_MAX_MS, CLOCK_MIN_MS, type RulesV2 } from "@cockpit-chess/chess";
import type { TFunction } from "i18next";
import { durationLabel } from "./ending-label";

/**
 * The create flows' time control: Untimed, or a whole-game clock per side (presets
 * are shortcuts that fill the minutes), optionally uneven. Minutes and seconds stay
 * strings while typed; `clockFromTimeControl` turns a valid value into `rules.clock`.
 */
export type SideTime = { minutes: string; seconds: string };
export type TimeControlValue = {
  timed: boolean;
  /** Off: Black's clock mirrors White's. */
  uneven: boolean;
  white: SideTime;
  black: SideTime;
};
export const TIME_PRESETS_MINUTES = [5, 10, 30] as const;
export const DEFAULT_TIME_CONTROL: TimeControlValue = {
  timed: false,
  uneven: false,
  white: { minutes: "10", seconds: "0" },
  black: { minutes: "10", seconds: "0" },
};
/** The per-move safety limit's bounds (rules.turnTimeoutMs) and its default, in seconds. */
export const MOVE_LIMIT_SECONDS = { min: 1, max: 300, fallback: 60 } as const;

const WHOLE = /^\d{1,3}$/;
function sideMs(side: SideTime): number | null {
  const minutes = side.minutes.trim() || "0";
  const seconds = side.seconds.trim() || "0";
  if (!WHOLE.test(minutes) || !WHOLE.test(seconds) || Number(seconds) > 59) return null;
  return (Number(minutes) * 60 + Number(seconds)) * 1000;
}
const effectiveBlack = (value: TimeControlValue) => (value.uneven ? value.black : value.white);

/** `rules.clock` for a valid value; null when untimed. Throws on an invalid value. */
export function clockFromTimeControl(value: TimeControlValue): RulesV2["clock"] {
  if (!value.timed) return null;
  const w = sideMs(value.white);
  const b = sideMs(effectiveBlack(value));
  if (w === null || b === null) throw new Error("Invalid time control");
  return { w, b };
}

/** Which side's time is out of bounds, with the message the field shows. */
export function timeControlErrors(
  t: TFunction<"chess">,
  value: TimeControlValue,
): Partial<Record<"white" | "black", string>> {
  if (!value.timed) return {};
  const errors: Partial<Record<"white" | "black", string>> = {};
  const bounds = {
    min: durationLabel(t, CLOCK_MIN_MS),
    max: durationLabel(t, CLOCK_MAX_MS),
  };
  for (const side of value.uneven ? (["white", "black"] as const) : (["white"] as const)) {
    const ms = sideMs(value[side]);
    if (ms === null) errors[side] = t("time.errors.format");
    else if (ms < CLOCK_MIN_MS || ms > CLOCK_MAX_MS) errors[side] = t("time.errors.range", bounds);
  }
  return errors;
}

/** The preset a value matches ("untimed", a preset's minutes, or "custom"). */
export function selectedPreset(value: TimeControlValue): "untimed" | "custom" | number {
  if (!value.timed) return "untimed";
  const w = sideMs(value.white);
  if (value.uneven && sideMs(value.black) !== w) return "custom";
  const preset = TIME_PRESETS_MINUTES.find((minutes) => w === minutes * 60_000);
  return preset ?? "custom";
}
export function applyPreset(value: TimeControlValue, preset: "untimed" | number): TimeControlValue {
  if (preset === "untimed") return { ...value, timed: false };
  const side = { minutes: String(preset), seconds: "0" };
  return { timed: true, uneven: false, white: side, black: side };
}

/** The per-move limit's automatic value: one minute, never longer than the shorter clock. */
export function autoMoveLimitMs(clock: RulesV2["clock"]) {
  const fallback = MOVE_LIMIT_SECONDS.fallback * 1000;
  return clock ? Math.min(fallback, clock.w, clock.b) : fallback;
}
/** The per-move limit for a typed value ("" = automatic), or null when it is invalid. */
export function moveLimitMs(raw: string, clock: RulesV2["clock"]): number | null {
  const text = raw.trim();
  if (!text) return autoMoveLimitMs(clock);
  if (!WHOLE.test(text)) return null;
  const ms = Number(text) * 1000;
  if (ms < MOVE_LIMIT_SECONDS.min * 1000 || ms > MOVE_LIMIT_SECONDS.max * 1000) return null;
  if (clock && ms > Math.min(clock.w, clock.b)) return null;
  return ms;
}

/** "Untimed", "10 min each" or "White 15 min · Black 5 min" for a form value. */
export function timeControlSummary(t: TFunction<"chess">, value: TimeControlValue) {
  if (!value.timed) return t("timeControl.untimed");
  const w = sideMs(value.white);
  const b = sideMs(effectiveBlack(value));
  if (w === null || b === null) return t("time.custom");
  if (w === b) return t("timeControl.each", { time: durationLabel(t, w) });
  return t("timeControl.uneven", { white: durationLabel(t, w), black: durationLabel(t, b) });
}
