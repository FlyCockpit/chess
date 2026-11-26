import {
  type Chess,
  type Color,
  legalMoves,
  type MatchEvent,
  type PieceSymbol,
  type Square,
} from "@cockpit-chess/chess";

/** One square a looked-up piece can reach; `capture` includes en passant. */
export type LookupTarget = { square: Square; capture: boolean };

/**
 * What a `legal_moves` tool call asked, read from the position it was made in
 * (the same `legalMoves` the tool answers with), never from its recorded text.
 * `square: null` is a lookup of every legal move.
 */
export type LegalLookup =
  | { square: null; count: number }
  | {
      square: Square;
      /** The side to move's piece on the square; null when it holds none of theirs. */
      piece: { type: PieceSymbol; color: Color } | null;
      /** One entry per target square (a promotion counts once). */
      targets: LookupTarget[];
      /** Every legal move in SAN, promotions included. */
      san: string[];
    };

/** The looked-up square of a `legal_moves` input, `null` for all moves, undefined if unreadable. */
function requestedSquare(input: string): Square | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const square = (parsed as { square?: unknown }).square;
  if (square === undefined) return null;
  return typeof square === "string" && /^[a-h][1-8]$/.test(square) ? (square as Square) : undefined;
}

/** Targets of the piece on `square`, computed with the tool's own `legalMoves`. */
export function lookupTargets(
  chess: Chess,
  square: string,
  moves = legalMoves(chess, square),
): LookupTarget[] {
  const targets = new Map<string, LookupTarget>();
  const piece = chess.get(square as Square);
  for (const move of moves) {
    const to = move.slice(2, 4) as Square;
    if (targets.has(to)) continue;
    // A pawn that changes file captures, even onto the empty en passant square.
    const capture = !!chess.get(to) || (piece?.type === "p" && move[0] !== move[2]);
    targets.set(to, { square: to, capture });
  }
  return [...targets.values()];
}

/**
 * Descriptions by position and input. A live game rebuilds its replay index on every
 * update; this keeps each earlier lookup's work (and object identity) from repeating.
 * The limit is above the most lookups one archive can hold (MAX_ARCHIVE_BYTES over
 * the smallest serialized tool event; the test checks it), so a single game never
 * evicts its own entries.
 */
const cache = new Map<string, LegalLookup | undefined>();
export const LOOKUP_CACHE_LIMIT = 16_384;

/** The lookup a tool event describes in `chess` (its position), or undefined if it is none. */
export function describeLookup(chess: Chess, event: MatchEvent): LegalLookup | undefined {
  if (event.type !== "tool" || event.name !== "legal_moves") return undefined;
  const key = `${chess.fen()}\n${event.input}`;
  if (cache.has(key)) return cache.get(key);
  const lookup = computeLookup(chess, event.input);
  if (cache.size >= LOOKUP_CACHE_LIMIT) cache.clear();
  cache.set(key, lookup);
  return lookup;
}

function computeLookup(chess: Chess, input: string): LegalLookup | undefined {
  const square = requestedSquare(input);
  if (square === undefined) return undefined;
  if (square === null) return { square: null, count: legalMoves(chess).length };
  const found = chess.get(square);
  const piece = found && found.color === chess.turn() ? found : null;
  if (!piece) return { square, piece: null, targets: [], san: [] };
  const san = new Map(
    chess
      .moves({ square, verbose: true })
      .map((move) => [`${move.from}${move.to}${move.promotion ?? ""}`, move.san]),
  );
  const moves = legalMoves(chess, square);
  return {
    square,
    piece: { type: piece.type, color: piece.color },
    targets: lookupTargets(chess, square, moves),
    san: moves.map((move) => san.get(move) ?? move),
  };
}

/** Events that happen around a model's inference without being its next action. */
const PASSIVE = new Set<MatchEvent["type"]>(["timing", "reservation", "usage", "shared-usage"]);

/** `index` is the lookup event the overlay comes from. */
export type LookupOverlay = { index: number; from: Square; targets: LookupTarget[] };

/**
 * The latest action of the turn at `index` (a tool call or a move attempt), skipping
 * the bookkeeping recorded around inference; undefined before the turn's first action.
 */
export function turnAction(events: readonly MatchEvent[], index: number): number | undefined {
  const at = events[index];
  if (!at) return undefined;
  for (let i = index; i >= 0; i--) {
    const event = events[i];
    if (!event || event.ply !== at.ply || event.side !== at.side) return undefined;
    if (!PASSIVE.has(event.type)) return i;
  }
  return undefined;
}

/** One overlay object per (cached) lookup and event, so memoized boards skip re-renders. */
const overlays = new WeakMap<LegalLookup, Map<number, LookupOverlay>>();

function toOverlay(index: number, lookup: LegalLookup | undefined): LookupOverlay | undefined {
  if (!lookup?.square || !lookup.piece) return undefined;
  let byIndex = overlays.get(lookup);
  if (!byIndex) {
    byIndex = new Map();
    overlays.set(lookup, byIndex);
  }
  let overlay = byIndex.get(index);
  if (!overlay) {
    overlay = { index, from: lookup.square, targets: lookup.targets };
    byIndex.set(index, overlay);
  }
  return overlay;
}

/**
 * The board overlay at `index`: the turn's latest action, if it is a lookup of one of
 * the mover's pieces. It lasts until the model's next tool call or move attempt, or
 * the turn's end; bookkeeping events in between keep it.
 */
export function overlayAt(
  events: readonly MatchEvent[],
  lookups: ReadonlyMap<number, LegalLookup>,
  index: number,
): LookupOverlay | undefined {
  const action = turnAction(events, index);
  return action === undefined ? undefined : toOverlay(action, lookups.get(action));
}

/** The overlay for a live board: `chess` is the position after the last event. */
export function latestOverlay(
  events: readonly MatchEvent[],
  chess: Chess,
): LookupOverlay | undefined {
  const action = turnAction(events, events.length - 1);
  const event = action === undefined ? undefined : events[action];
  return action !== undefined && event
    ? toOverlay(action, describeLookup(chess, event))
    : undefined;
}
