import { applyUci, Chess, type MatchArchive, type MatchEvent } from "@cockpit-chess/chess";
import { useCallback, useState } from "react";
import {
  type BoardMotion,
  HURRY_FACTOR,
  LOOKUP_HOLD_MS,
  moveMotion,
  stepMotion,
} from "./board-motion";
import { describeLookup } from "./legal-lookup";

/**
 * What the board shows while it catches up with the event the page wants (`target`):
 * the event it shows now (`shown`) and the motion that leads into it. Single steps
 * animate (next, previous, autoplay); jumps snap; following a live game plays every
 * new event in order (lookups, illegal attempts, the move), faster while more wait.
 * No effects and no timers: the board reports the end of each motion
 * (`onMotionEnd`, from the motion's CSS animation), and the next step is derived.
 */
export type PlaybackSource = {
  events: readonly MatchEvent[];
  /** The position after event `index` (-1: the initial position). Throws past a replay failure. */
  fenAt: (index: number) => string;
  /** Whether event `index` shows something worth a pause when catching up (a lookup). */
  holds?: (index: number) => boolean;
};

export type PlaybackState = {
  shown: number;
  target: number;
  motion: BoardMotion | null;
  /** How many events the source had at the last target change. */
  count: number;
  /** Catching up with new events: each motion's end starts the next step. */
  queue: boolean;
};

/** More than this many new events at once (a tab back from the background): snap. */
export const MAX_QUEUE = 24;

function safeFen(source: PlaybackSource, index: number): string | null {
  try {
    return source.fenAt(index);
  } catch {
    return null;
  }
}

/** The next stop after `from` on the way to `target`: the first event that moves something. */
function forward(
  source: PlaybackSource,
  from: number,
  target: number,
  queue: boolean,
): PlaybackState {
  const count = source.events.length;
  for (let index = from + 1; index <= target; index++) {
    const before = safeFen(source, index - 1);
    if (before === null) break;
    const motion = stepMotion(before, source.events[index], index);
    if (motion) return { shown: index, target, motion, count, queue };
    if (queue && index < target && source.holds?.(index))
      return {
        shown: index,
        target,
        motion: { index, kind: "hold", ms: LOOKUP_HOLD_MS, ghosts: [], hide: [] },
        count,
        queue,
      };
    if (!queue) break;
  }
  return still(target, count);
}

function still(target: number, count: number): PlaybackState {
  return { shown: target, target, motion: null, count, queue: false };
}

function back(source: PlaybackSource, from: number, target: number): PlaybackState {
  const event = source.events[from];
  const before = safeFen(source, from - 1);
  const motion =
    event?.type === "attempt" && event.accepted && before !== null
      ? moveMotion(before, event.move, from - 1, "back")
      : null;
  return { ...still(target, source.events.length), motion };
}

/**
 * The playback after the page asks for `target` (exported for tests). `follow`: the
 * page follows the game's latest event, so events that arrive (the source grew) are
 * played in order, even the poll that ends the game. A jump the viewer makes (to the
 * end included) never queues: it snaps.
 */
export function retarget(
  state: PlaybackState,
  target: number,
  follow: boolean,
  source: PlaybackSource,
): PlaybackState {
  const { shown } = state;
  const count = source.events.length;
  const arrived = follow && count > state.count;
  const ahead = target - shown;
  // New events mid-animation wait for the current one (which hurries).
  if (state.motion && follow && (state.queue || arrived) && ahead > 0 && ahead <= MAX_QUEUE)
    return { ...state, target, count, queue: true };
  if (ahead === 0) return { ...state, target, count };
  if (arrived && ahead > 0 && ahead <= MAX_QUEUE) return forward(source, shown, target, true);
  if (ahead === 1) return forward(source, shown, target, false);
  if (ahead === -1) return back(source, shown, target);
  return still(target, count);
}

/** The playback once `ended` has played: the next queued step, or still. */
export function afterMotion(
  now: PlaybackState,
  ended: BoardMotion,
  source: PlaybackSource,
): PlaybackState {
  if (now.motion !== ended) return now;
  if (now.target > now.shown && now.queue) return forward(source, now.shown, now.target, true);
  return still(now.target, now.count);
}

export function useBoardPlayback(target: number, follow: boolean, source: PlaybackSource) {
  const [state, setState] = useState<PlaybackState>(() => still(target, source.events.length));
  let current = state;
  // Derived during render (React's "adjust state when a prop changes"): never animates
  // the first render, and a target change starts at most one step.
  if (state.target !== target || state.count !== source.events.length) {
    current = retarget(state, target, follow, source);
    setState(current);
  }
  const onMotionEnd = useCallback(
    (ended: BoardMotion) => setState((now) => afterMotion(now, ended, source)),
    [source],
  );
  /** Ends every motion now and shows the target (a click on the playable board). */
  const finish = useCallback(
    () => setState((now) => (now.motion ? still(now.target, now.count) : now)),
    [],
  );
  const hurried = !!current.motion && current.target > current.shown;
  return {
    shown: current.shown,
    motion: current.motion,
    /** The motion's length now: shorter while more events wait. */
    ms: current.motion ? Math.round(current.motion.ms * (hurried ? HURRY_FACTOR : 1)) : 0,
    hurried,
    onMotionEnd,
    finish,
  };
}

/**
 * A playable board's source: the position after each event, replayed from accepted
 * attempts only (like the replay view); a move that does not replay keeps the last
 * good position.
 */
export function gameSource(
  match: MatchArchive,
  { lookups = false }: { lookups?: boolean } = {},
): PlaybackSource {
  const fens = eventPositions(match);
  const fenAt = (index: number) => fens[index] ?? fens.initial;
  return {
    events: match.events,
    fenAt,
    // A lookup of one of the mover's pieces pauses the catch-up, so its dots show.
    holds: lookups
      ? (index) => {
          const event = match.events[index];
          if (event?.type !== "tool") return false;
          const lookup = describeLookup(new Chess(fenAt(index)), event);
          return !!lookup?.square && !!lookup.piece;
        }
      : undefined,
  };
}

function eventPositions(match: MatchArchive): string[] & { initial: string } {
  const chess = new Chess(match.config.initialFen);
  const fens = Object.assign([] as string[], { initial: chess.fen() });
  let failed = false;
  for (const event of match.events) {
    if (!failed && event.type === "attempt" && event.accepted) {
      try {
        applyUci(chess, event.move);
      } catch {
        failed = true;
      }
    }
    fens.push(chess.fen());
  }
  return fens;
}
