import { Chess, createMatch, type MatchArchive, submitMove } from "@cockpit-chess/chess";
import { describe, expect, it } from "vitest";
import { LOOKUP_HOLD_MS } from "./board-motion";
import {
  afterMotion,
  gameSource,
  isHurried,
  MAX_QUEUE,
  type PlaybackSource,
  type PlaybackState,
  retarget,
} from "./use-board-playback";

/**
 * A turn as a live game records it: a lookup, an illegal attempt, bookkeeping, then
 * the move; then Black's reply.
 */
function game(): MatchArchive {
  const match = createMatch(
    {
      title: "Playback",
      white: { name: "W", model: "w", protocol: "random" },
      black: { name: "B", model: "b", protocol: "random" },
      rules: { maxAttempts: 10, legalMoves: "tool" },
    },
    "hosted",
  );
  const chess = new Chess();
  match.events.push({
    type: "tool",
    seq: 0,
    at: new Date(0).toISOString(),
    side: "w",
    ply: 0,
    name: "legal_moves",
    input: JSON.stringify({ square: "g1" }),
    output: "f3 h3",
  });
  submitMove(match, chess, "g1e5"); // 1: illegal
  match.events.push({
    type: "timing",
    seq: 2,
    at: new Date(0).toISOString(),
    side: "w",
    ply: 0,
    elapsedMs: 5,
  }); // 2
  submitMove(match, chess, "g1f3"); // 3
  submitMove(match, chess, "e7e5"); // 4
  return match;
}

const match = game();
const source: PlaybackSource = {
  ...gameSource(match),
  holds: (index) => match.events[index]?.type === "tool",
};
/** Still at `shown`, having seen `count` events. */
const still = (shown: number, count = match.events.length): PlaybackState => ({
  shown,
  target: shown,
  motion: null,
  count,
  queue: false,
});
const end = (state: PlaybackState) =>
  afterMotion(state, state.motion as NonNullable<PlaybackState["motion"]>, source);

describe("retarget", () => {
  it("animates one step forward and one step back", () => {
    const next = retarget(still(2), 3, false, source);
    expect(next).toMatchObject({ shown: 3, target: 3, motion: { kind: "move", index: 3 } });
    expect(next.motion?.ghosts[0]).toMatchObject({ from: "g1", to: "f3", effect: "slide" });
    const back = retarget(still(3), 2, false, source);
    expect(back).toMatchObject({ shown: 2, motion: { kind: "move" } });
    expect(back.motion?.ghosts[0]).toMatchObject({ from: "f3", to: "g1" });
    // Stepping onto the illegal attempt plays it.
    expect(retarget(still(0), 1, false, source).motion).toMatchObject({ kind: "illegal" });
    // Stepping back off it, or onto bookkeeping, just shows the position.
    expect(retarget(still(2), 1, false, source)).toEqual(still(1));
    expect(retarget(still(1), 2, false, source)).toEqual(still(2));
  });

  it("snaps on a jump, the viewer's jump to the latest event included", () => {
    expect(retarget(still(-1), 4, false, source)).toEqual(still(4));
    expect(retarget(still(4), -1, false, source)).toEqual(still(-1));
    expect(retarget(still(4), 1, false, source)).toEqual(still(1));
    // Following the latest event, but no new event arrived: a jump, not a catch-up.
    expect(retarget(still(-1), 4, true, source)).toEqual(still(4));
  });

  it("replaces a running step with the next single step", () => {
    const running = retarget(still(2), 3, false, source);
    expect(retarget(running, 4, false, source)).toMatchObject({
      shown: 4,
      motion: { index: 4, kind: "move" },
    });
  });

  it("plays new events in order: lookup, attempt, move, even in the poll that ends a game", () => {
    // Events 0-4 arrive together while following (count was 0).
    let state = retarget(still(-1, 0), 4, true, source);
    const kinds: string[] = [];
    const shown: number[] = [];
    while (state.motion) {
      kinds.push(state.motion.kind);
      shown.push(state.shown);
      state = end(state);
    }
    expect(kinds).toEqual(["hold", "illegal", "move", "move"]);
    expect(shown).toEqual([0, 1, 3, 4]);
    expect(state).toEqual(still(4));
  });

  it("lets a running motion finish when new events arrive, then continues", () => {
    const running = retarget(still(0, 1), 1, true, source);
    expect(running).toMatchObject({ motion: { kind: "illegal" }, queue: true });
    const queued = retarget(running, 3, true, source);
    expect(queued).toEqual({ ...running, target: 3 });
    expect(end(queued)).toMatchObject({ shown: 3, motion: { kind: "move" } });
    // A single step the viewer took, then new events: they queue behind it.
    const step = retarget(still(0, 5), 1, true, source);
    expect(step.queue).toBe(false);
    const grown = { ...step, count: 2 };
    expect(retarget(grown, 3, true, source)).toMatchObject({ shown: 1, target: 3, queue: true });
  });

  it("holds a lookup only while more events wait", () => {
    expect(retarget(still(-1, 0), 0, true, source)).toEqual(still(0));
    expect(retarget(still(-1, 0), 1, true, source).motion).toMatchObject({
      kind: "hold",
      ms: LOOKUP_HOLD_MS,
    });
  });

  it("hurries only while another event that shows something waits", () => {
    // The lookup, the attempt and the move arrive together: the lookup's hold and the
    // attempt hurry (more to show after them); the move is last of what shows.
    let state = retarget(still(-1, 0), 3, true, source);
    const hurried: boolean[] = [];
    while (state.motion) {
      hurried.push(isHurried(state, source));
      state = end(state);
    }
    expect(hurried).toEqual([true, true, false]);
    // An attempt that arrives with bookkeeping only (the timing after it): full length.
    const attempt = retarget(still(0, 1), 2, true, source);
    expect(attempt).toMatchObject({ shown: 1, target: 2, motion: { kind: "illegal" } });
    expect(isHurried(attempt, source)).toBe(false);
    expect(end(attempt)).toEqual(still(2));
    // A move followed by bookkeeping in the same poll is not hurried either.
    const booked = game();
    booked.events.push({
      type: "timing",
      seq: booked.events.length,
      at: new Date(0).toISOString(),
      side: "w",
      ply: 2,
      elapsedMs: 5,
    });
    const bookedSource = gameSource(booked);
    const move = retarget(still(3, 4), 5, true, bookedSource);
    expect(move).toMatchObject({ shown: 4, motion: { kind: "move" } });
    expect(isHurried(move, bookedSource)).toBe(false);
    // A new move arriving mid-motion hurries the running one.
    const running = retarget(still(2, 3), 3, true, source);
    const queued = retarget(running, 4, true, source);
    expect(isHurried(queued, source)).toBe(true);
    // A single step the viewer takes never hurries.
    expect(isHurried(retarget(still(2), 3, false, source), source)).toBe(false);
  });

  it("snaps a scrubber drag, even one event at a time, but still plays arrivals", () => {
    expect(retarget(still(2), 3, false, source, true)).toEqual(still(3));
    expect(retarget(still(3), 2, false, source, true)).toEqual(still(2));
    expect(retarget(still(0), 1, false, source, true)).toEqual(still(1));
    // Dragged to the end (following again) with no new events: snaps too.
    expect(retarget(still(3), 4, true, source, true)).toEqual(still(4));
    // A drag that replaces a running step ends it.
    const running = retarget(still(2), 3, false, source);
    expect(retarget(running, 4, false, source, true)).toEqual(still(4));
    // Events that arrive while following after a drag still play in order.
    expect(retarget(still(2, 3), 3, true, source, true)).toMatchObject({
      shown: 3,
      motion: { kind: "move" },
    });
  });

  it("snaps when too many events arrive at once", () => {
    const long = { ...source, fenAt: () => new Chess().fen() };
    expect(retarget(still(0, 1), MAX_QUEUE + 1, true, long)).toEqual(still(MAX_QUEUE + 1));
  });

  it("ignores the end of a motion that was already replaced", () => {
    const first = retarget(still(2), 3, false, source);
    const second = retarget(first, 4, false, source);
    expect(afterMotion(second, first.motion as NonNullable<typeof first.motion>, source)).toBe(
      second,
    );
    expect(end(second)).toEqual(still(4));
  });

  it("snaps past a position that does not replay", () => {
    const broken: PlaybackSource = {
      events: match.events,
      fenAt: (index) => {
        if (index >= 2) throw new Error("replay failed");
        return source.fenAt(index);
      },
    };
    expect(retarget(still(2), 3, false, broken)).toEqual(still(3));
  });

  it("holds a playable board's lookups when it shows them", () => {
    const shown = gameSource(match, { lookups: true });
    let state = retarget(still(-1, 0), 4, true, shown);
    expect(state.motion).toMatchObject({ kind: "hold", index: 0 });
    state = afterMotion(state, state.motion as NonNullable<typeof state.motion>, shown);
    expect(state.motion).toMatchObject({ kind: "illegal", index: 1 });
    // Without lookups on the board there is nothing to hold for.
    expect(retarget(still(-1, 0), 4, true, gameSource(match)).motion).toMatchObject({
      kind: "illegal",
    });
  });
});
