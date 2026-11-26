import { type Color, type MatchArchive, sideClockMs } from "@cockpit-chess/chess";

/**
 * Per-side game clocks for the replay. The archive charges each turn's time to the side
 * as a `timing` event when the turn ends, so a clock at an event is the side's
 * allowance minus the time charged up to it; a live clock also counts down the turn in
 * progress, from the moment the previous event was recorded.
 */
export function clockAt(match: MatchArchive, side: Color, index: number): number | null {
  const clock = sideClockMs(match.config.rules, side);
  if (clock === null) return null;
  let used = 0;
  for (const [at, event] of match.events.entries()) {
    if (at > index) break;
    if (event.type === "timing" && event.side === side) used += event.elapsedMs;
  }
  return Math.max(0, clock - used);
}

/**
 * The clock of the side to move in a running game, counting down its current turn.
 * A model's turn is charged per attempt (a `timing` event when it ends), so the live
 * countdown runs only while one of its attempts is under way: from that side's first
 * reservation after the last charged time. Before that (a queued match, or the runner's
 * own work between attempts: persisting, evaluating) the clock shows its charged value.
 * A human's turn (local lab) runs from the last recorded event, or from the game's
 * creation on the opening move.
 */
export function liveClock(match: MatchArchive, side: Color, turn: Color, now: number) {
  const left = clockAt(match, side, match.events.length - 1);
  if (left === null || match.status !== "running" || side !== turn) return left;
  const human = (side === "w" ? match.config.white : match.config.black).protocol === "human";
  const charged = match.events.findLastIndex((event) => event.type === "timing");
  const start = human
    ? (match.events.at(-1)?.at ?? match.createdAt)
    : match.events
        .slice(charged + 1)
        .find((event) => event.type === "reservation" && event.side === side)?.at;
  if (!start) return left;
  const since = Date.parse(start);
  return Number.isFinite(since) ? Math.max(0, left - Math.max(0, now - since)) : left;
}

/** "10:00", "1:05:00"; tenths under ten seconds ("0:07.3"), as chess clocks show. */
export function formatClock(ms: number) {
  const tenths = Math.floor(ms / 100);
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`;
  if (ms < 10_000) return `0:${rest}.${tenths % 10}`;
  return `${minutes}:${rest}`;
}
