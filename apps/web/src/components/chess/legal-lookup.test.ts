import { Chess, legalMoves, MAX_ARCHIVE_BYTES, type MatchEvent } from "@cockpit-chess/chess";
import { describe, expect, it } from "vitest";
import {
  describeLookup,
  type LegalLookup,
  LOOKUP_CACHE_LIMIT,
  latestOverlay,
  lookupTargets,
  overlayAt,
} from "./legal-lookup";

/** A `legal_moves` event exactly as the runner records it (input and output). */

type ToolEvent = Extract<MatchEvent, { type: "tool" }>;
function lookupEvent(chess: Chess, square: string | undefined, seq = 0): ToolEvent {
  return {
    type: "tool",
    name: "legal_moves",
    seq,
    at: "2026-11-26T00:00:00.000Z",
    side: chess.turn(),
    ply: 0,
    input: JSON.stringify({ square }),
    output: legalMoves(chess, square).join(" "),
  };
}
/** The recorded output's target squares, the cross-check for the computed ones. */
const recordedSquares = (event: MatchEvent) =>
  event.type === "tool"
    ? [
        ...new Set(
          event.output
            .split(" ")
            .filter(Boolean)
            .map((move) => move.slice(2, 4)),
        ),
      ].sort()
    : [];

function lookupOf(fen: string, square: string) {
  const chess = new Chess(fen);
  const event = lookupEvent(chess, square);
  const lookup = describeLookup(chess, event);
  if (lookup?.square)
    expect(lookup.targets.map((t) => t.square).sort()).toEqual(recordedSquares(event));
  return lookup;
}

describe("lookup targets", () => {
  it("lists a piece's quiet moves as dots, in SAN", () => {
    expect(lookupOf(new Chess().fen(), "g1")).toEqual({
      square: "g1",
      piece: { type: "n", color: "w" },
      targets: [
        { square: "f3", capture: false },
        { square: "h3", capture: false },
      ],
      san: ["Nf3", "Nh3"],
    });
  });
  it("marks captures", () => {
    const lookup = lookupOf("4k3/8/8/3p4/8/4N3/8/4K3 w - - 0 1", "e3");
    expect(lookup?.square && lookup.targets.find((t) => t.square === "d5")).toEqual({
      square: "d5",
      capture: true,
    });
    expect(lookup?.square && lookup.san).toContain("Nxd5");
  });
  it("counts en passant as a capture onto the empty square", () => {
    const fen = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";
    expect(lookupTargets(new Chess(fen), "e5")).toEqual([
      { square: "e6", capture: false },
      { square: "d6", capture: true },
    ]);
  });
  it("includes castling squares", () => {
    const lookup = lookupOf("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1");
    expect(lookup?.square && lookup.targets.map((t) => t.square)).toEqual(
      expect.arrayContaining(["g1", "c1"]),
    );
    expect(lookup?.square && lookup.san).toEqual(expect.arrayContaining(["O-O", "O-O-O"]));
  });
  it("counts a promotion once per square but lists every promotion move", () => {
    const lookup = lookupOf("1r6/P7/8/8/8/8/8/k6K w - - 0 1", "a7");
    expect(lookup?.square && lookup.targets).toEqual([
      { square: "a8", capture: false },
      { square: "b8", capture: true },
    ]);
    expect(lookup?.square && lookup.san).toHaveLength(8);
    expect(lookup?.square && lookup.san).toContain("axb8=Q");
  });
  it("gives a pinned piece no targets", () => {
    expect(lookupOf("4k3/4r3/8/8/8/8/4N3/4K3 w - - 0 1", "e2")).toEqual({
      square: "e2",
      piece: { type: "n", color: "w" },
      targets: [],
      san: [],
    });
  });
  it("has nothing for an invalid square, an empty square or an opponent's piece", () => {
    const chess = new Chess();
    expect(lookupTargets(chess, "z9")).toEqual([]);
    expect(describeLookup(chess, { ...lookupEvent(chess, "e2"), input: '{"square":"z9"}' })).toBe(
      undefined,
    );
    expect(describeLookup(chess, { ...lookupEvent(chess, "e2"), input: "not json" })).toBe(
      undefined,
    );
    expect(lookupOf(chess.fen(), "e4")).toEqual({
      square: "e4",
      piece: null,
      targets: [],
      san: [],
    });
    expect(lookupOf(chess.fen(), "e7")).toEqual({
      square: "e7",
      piece: null,
      targets: [],
      san: [],
    });
  });
  it("reads a lookup of every move as a count, with no square to paint", () => {
    const chess = new Chess();
    expect(describeLookup(chess, lookupEvent(chess, undefined))).toEqual({
      square: null,
      count: 20,
    });
    // The same lookup in the same position is described once (and keeps its identity).
    const event = lookupEvent(chess, "g1");
    expect(describeLookup(new Chess(), event)).toBe(describeLookup(chess, event));
    // No archive holds more lookups than the cache keeps: even the smallest lookup
    // event takes more bytes than this in the archive's (indented) file form.
    const smallest = JSON.stringify({ ...event, seq: 0, input: "{}", output: "" }, null, 2);
    expect(LOOKUP_CACHE_LIMIT).toBeGreaterThan(MAX_ARCHIVE_BYTES / smallest.length);
    // Other tools are not lookups.
    expect(describeLookup(chess, { ...lookupEvent(chess, "g1"), name: "board" })).toBe(undefined);
  });
});

describe("overlay lifetime", () => {
  /** One white turn, then Black's: each lookup is followed by what can come next. */
  function turn() {
    const chess = new Chess();
    const base = { at: "2026-11-26T00:00:00.000Z", side: "w" as const, ply: 0 };
    const events: MatchEvent[] = [
      { ...base, seq: 0, type: "reservation", dispatch: 0, tokens: 10, costMicros: 0 },
      lookupEvent(chess, "g1", 1),
      {
        ...base,
        seq: 2,
        type: "usage",
        dispatch: 0,
        inputTokens: 1,
        outputTokens: 1,
        costMicros: 0,
      },
      { ...base, seq: 3, type: "timing", elapsedMs: 5 },
      { ...base, seq: 4, type: "tool", name: "board", input: "{}", output: "" },
      lookupEvent(chess, "b1", 5),
      { ...base, seq: 6, ...attempt("b1b4", false) },
      lookupEvent(chess, "g1", 7),
      lookupEvent(chess, undefined, 8),
      lookupEvent(chess, "e7", 9),
      lookupEvent(chess, "g1", 10),
      { ...base, seq: 11, ...attempt("g1f3", true) },
      {
        ...base,
        seq: 12,
        side: "b",
        ply: 1,
        type: "reservation",
        dispatch: 1,
        tokens: 10,
        costMicros: 0,
      },
    ];
    const lookups = new Map<number, LegalLookup>();
    for (const [index, event] of events.entries()) {
      const lookup = describeLookup(chess, event);
      if (lookup) lookups.set(index, lookup);
    }
    return { events, lookups };
  }
  function attempt(move: string, accepted: boolean) {
    return {
      type: "attempt" as const,
      move,
      accepted,
      before: "",
      fen: "",
      san: accepted ? "Nf3" : null,
      reason: accepted ? null : ("illegal" as const),
      comment: "",
    };
  }
  it("shows a lookup from the call until the next tool call, attempt or the turn's end", () => {
    const { events, lookups } = turn();
    const from = events.map((_, index) => overlayAt(events, lookups, index)?.from ?? null);
    expect(from).toEqual([
      null, // before any lookup
      "g1", // the lookup
      "g1", // usage and timing keep it
      "g1",
      null, // another tool call ends it
      "b1",
      null, // an illegal attempt shows as itself
      "g1",
      null, // all moves: nothing to paint
      null, // the opponent's piece: nothing to paint
      "g1",
      null, // the move
      null, // the next turn
    ]);
    expect(overlayAt(events, lookups, 1)?.targets.map((t) => t.square)).toEqual(["f3", "h3"]);
    expect(overlayAt(events, lookups, 99)).toBe(undefined);
    // The same overlay object on every call (and live), so a memoized board skips
    // re-rendering on clock ticks.
    expect(overlayAt(events, lookups, 2)).toBe(overlayAt(events, lookups, 1));
    expect(latestOverlay(events.slice(0, 4), new Chess())).toBe(overlayAt(events, lookups, 3));
    // A live board (the position after the last event) shows the same, up to the move.
    const start = new Chess();
    for (let index = 0; index < 11; index++)
      expect(latestOverlay(events.slice(0, index + 1), start)).toEqual(
        overlayAt(events, lookups, index),
      );
    expect(latestOverlay([], start)).toBe(undefined);
  });
});
