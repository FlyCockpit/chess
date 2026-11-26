import {
  Chess,
  type Color,
  type MatchEvent,
  type PieceSymbol,
  type Square,
} from "@cockpit-chess/chess";
import type { TFunction } from "i18next";
import { turnAction } from "./legal-lookup";

/**
 * How the board moves between two adjacent events: a legal move slides (the rook too
 * when castling, a captured piece fades, a promotion swaps at the end), an illegal
 * attempt slides to the square it tried, shakes and slides back. Pure and
 * serializable: the DOM board plays it with CSS keyframes, the MP4 export draws it
 * frame by frame from `ghostPose`, so both show the same motion.
 */

/** A legal move's slide. */
export const MOVE_MS = 240;
/** An illegal attempt: out, shake, back. */
export const ILLEGAL_MS = 1080;
/** A reply that could not be read as a move: caption and a red flash, no slide. */
export const UNREADABLE_MS = 900;
/** A lookup shown while catching up with several new events. */
export const LOOKUP_HOLD_MS = 450;
/** Speed-up while more events wait (a new event arrived mid-animation). */
export const HURRY_FACTOR = 0.3;

type Piece = { type: PieceSymbol; color: Color };
/**
 * A piece drawn over the board during a motion. `slide` goes from → to, `illegal`
 * goes from → to → (shake) → from, `fade` disappears in place, `appear` fades in.
 */
export type Ghost = {
  piece: Piece;
  from: Square;
  to: Square;
  effect: "slide" | "illegal" | "fade" | "appear";
};
export type BoardMotion = {
  /** The event this motion leads into (the board then shows that event's position). */
  index: number;
  kind: "move" | "illegal" | "unreadable" | "hold";
  ms: number;
  ghosts: Ghost[];
  /** Squares whose real piece is hidden while the ghosts stand in for it. */
  hide: Square[];
};

/**
 * A rejected attempt, read from the position it was made in. `illegal` names the
 * squares it tried (`piece` is the side's piece on `from`, null when it has none
 * there); `unreadable` is a reply with no squares at all.
 */
export type IllegalMark =
  | {
      kind: "illegal";
      index: number;
      side: Color;
      from: Square;
      to: Square;
      piece: Piece | null;
      /** "Nf3-e5": the attempt in words a chess reader knows. */
      notation: string;
    }
  | { kind: "unreadable"; index: number; side: Color; raw: string };

type Labels =
  | TFunction<"chess">
  | ((key: string, params?: Record<string, string | number>) => string);

const UCI = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;
const LETTERS: Record<PieceSymbol, string> = { p: "", n: "N", b: "B", r: "R", q: "Q", k: "K" };

/** The rejected attempt at `index`, or undefined when the event is anything else. */
export function illegalMark(
  beforeFen: string,
  event: MatchEvent | undefined,
  index: number,
): IllegalMark | undefined {
  if (event?.type !== "attempt" || event.accepted) return undefined;
  const parts = UCI.exec(event.move.trim());
  if (!parts) return { kind: "unreadable", index, side: event.side, raw: event.move };
  const from = parts[1] as Square;
  const to = parts[2] as Square;
  let found: Piece | undefined;
  try {
    const at = new Chess(beforeFen).get(from);
    found = at ? { type: at.type, color: at.color } : undefined;
  } catch {
    found = undefined;
  }
  const piece = found && found.color === event.side ? found : null;
  const promotion = parts[3] ? `=${parts[3].toUpperCase()}` : "";
  return {
    kind: "illegal",
    index,
    side: event.side,
    from,
    to,
    piece,
    notation: `${piece ? LETTERS[piece.type] : ""}${from}-${to}${promotion}`,
  };
}

/**
 * The rejected attempt the board shows at `index`: the turn's latest action, when it
 * is one. It stays until the side's next action or the turn's end, so stepping onto it
 * (or a live game waiting for the retry) keeps it in view. `fenAt(i)` is the position
 * after event i; a rejected attempt leaves the position as it was.
 */
export function rejectedAt(
  events: readonly MatchEvent[],
  fenAt: (index: number) => string,
  index: number,
): IllegalMark | undefined {
  const action = turnAction(events, index);
  if (action === undefined) return undefined;
  const event = events[action];
  if (event?.type !== "attempt" || event.accepted) return undefined;
  return illegalMark(fenAt(action), event, action);
}

/** A rejected attempt on the board: its outlined squares and the caption over the board. */
export type BoardIllegal = { index: number; squares: Square[]; caption: string };

export function boardIllegal(t: Labels, mark: IllegalMark): BoardIllegal {
  return { index: mark.index, squares: markSquares(mark), caption: illegalCaption(t, mark) };
}

/** Squares to outline for a mark: both for a slide, the from-square alone without a piece. */
export function markSquares(mark: IllegalMark | undefined): Square[] {
  if (mark?.kind !== "illegal") return [];
  return mark.piece ? [mark.from, mark.to] : [mark.from];
}

/** Untrusted model text for a caption: one line, no controls or bidi overrides, short. */
function shortRaw(raw: string, max = 40): string {
  const clean = raw
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}

/** "Black tried Nf3-e5: not a legal move", for the board, the video and the PNG alike. */
export function illegalCaption(t: Labels, mark: IllegalMark): string {
  const translate = t as (key: string, params?: Record<string, string | number>) => string;
  const side = translate(`colors.${mark.side}`);
  if (mark.kind === "unreadable") {
    const raw = shortRaw(mark.raw);
    return raw
      ? translate("motion.unreadable", { side, raw })
      : translate("motion.unreadableEmpty", { side });
  }
  return mark.piece
    ? translate("motion.illegal", { side, move: mark.notation })
    : translate("motion.noPiece", { side, move: mark.notation, square: mark.from });
}

/** "+12 more illegal attempts". */
export function moreAttemptsCaption(t: Labels, count: number): string {
  return (t as (key: string, params?: Record<string, string | number>) => string)("motion.more", {
    count,
  });
}

function rookSquares(flags: string, color: Color): [Square, Square] | null {
  const rank = color === "w" ? "1" : "8";
  if (flags.includes("k")) return [`h${rank}` as Square, `f${rank}` as Square];
  if (flags.includes("q")) return [`a${rank}` as Square, `d${rank}` as Square];
  return null;
}

/**
 * A legal move between `beforeFen` and the position after it. `back` plays it in
 * reverse (stepping back in a replay): the board then shows the before-position.
 */
export function moveMotion(
  beforeFen: string,
  uci: string,
  index: number,
  direction: "forward" | "back" = "forward",
): BoardMotion | null {
  const parts = UCI.exec(uci);
  if (!parts) return null;
  let move: ReturnType<Chess["move"]>;
  try {
    move = new Chess(beforeFen).move({
      from: parts[1] as Square,
      to: parts[2] as Square,
      ...(parts[3] ? { promotion: parts[3] } : {}),
    });
  } catch {
    return null;
  }
  const mover: Piece = { type: move.piece, color: move.color };
  const promoted: Piece = { type: move.promotion ?? move.piece, color: move.color };
  const rook = rookSquares(move.flags, move.color);
  const capturedAt = move.captured
    ? ((move.flags.includes("e") ? `${move.to[0]}${move.from[1]}` : move.to) as Square)
    : null;
  const captured: Piece | null = move.captured
    ? { type: move.captured, color: move.color === "w" ? "b" : "w" }
    : null;
  const ghosts: Ghost[] = [];
  const hide: Square[] = [];
  if (direction === "forward") {
    if (captured && capturedAt)
      ghosts.push({ piece: captured, from: capturedAt, to: capturedAt, effect: "fade" });
    ghosts.push({ piece: mover, from: move.from, to: move.to, effect: "slide" });
    hide.push(move.to);
    if (rook) {
      ghosts.push({
        piece: { type: "r", color: move.color },
        from: rook[0],
        to: rook[1],
        effect: "slide",
      });
      hide.push(rook[1]);
    }
  } else {
    ghosts.push({ piece: promoted, from: move.to, to: move.from, effect: "slide" });
    hide.push(move.from);
    if (rook) {
      ghosts.push({
        piece: { type: "r", color: move.color },
        from: rook[1],
        to: rook[0],
        effect: "slide",
      });
      hide.push(rook[0]);
    }
    if (captured && capturedAt) {
      ghosts.unshift({ piece: captured, from: capturedAt, to: capturedAt, effect: "appear" });
      hide.push(capturedAt);
    }
  }
  return { index, kind: "move", ms: MOVE_MS, ghosts, hide };
}

/** The motion of a rejected attempt: out-shake-back with its piece, else a still caption. */
export function illegalMotion(mark: IllegalMark): BoardMotion {
  if (mark.kind === "unreadable")
    return { index: mark.index, kind: "unreadable", ms: UNREADABLE_MS, ghosts: [], hide: [] };
  return {
    index: mark.index,
    kind: "illegal",
    ms: ILLEGAL_MS,
    ghosts: mark.piece
      ? [{ piece: mark.piece, from: mark.from, to: mark.to, effect: "illegal" }]
      : [],
    hide: mark.piece ? [mark.from] : [],
  };
}

/**
 * The motion into event `index` from the position before it (`beforeFen`), or null
 * when that event does not move anything on the board.
 */
export function stepMotion(
  beforeFen: string,
  event: MatchEvent | undefined,
  index: number,
): BoardMotion | null {
  if (event?.type !== "attempt") return null;
  if (event.accepted) return moveMotion(beforeFen, event.move, index);
  const mark = illegalMark(beforeFen, event, index);
  return mark ? illegalMotion(mark) : null;
}

/**
 * Where an illegal ghost stands over time, as a share of the way to its target
 * (0 = from, 1 = to) plus a sideways shake in squares. The CSS keyframes
 * `cc-illegal` in index.css follow the same breakpoints.
 */
export const ILLEGAL_PHASES = { out: 0.22, shakeStart: 0.3, shakeEnd: 0.62, back: 0.76 } as const;
const SHAKE_SQUARES = 0.09;
const SHAKES = 4;

/** CSS `ease-in-out`, closely enough for a few frames: a symmetric cubic. */
function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * A ghost's pose at `progress` (0–1 of its motion): its offset from `from` in squares
 * (file and rank steps, from White's side) and its opacity.
 */
export function ghostPose(
  ghost: Ghost,
  progress: number,
): { dx: number; dy: number; alpha: number } {
  const p = Math.min(1, Math.max(0, progress));
  const fx = ghost.to.charCodeAt(0) - ghost.from.charCodeAt(0);
  // Board y grows downwards from rank 8 (White's side up), so a higher rank is a smaller y.
  const fy = Number(ghost.from[1]) - Number(ghost.to[1]);
  if (ghost.effect === "fade") return { dx: 0, dy: 0, alpha: 1 - easeInOut(p) };
  if (ghost.effect === "appear") return { dx: 0, dy: 0, alpha: easeInOut(p) };
  if (ghost.effect === "slide") {
    const k = easeInOut(p);
    return { dx: fx * k || 0, dy: fy * k || 0, alpha: 1 };
  }
  const { out, shakeStart, shakeEnd, back } = ILLEGAL_PHASES;
  let k: number;
  if (p <= out) k = easeInOut(p / out);
  else if (p < back) k = 1;
  else k = 1 - easeInOut((p - back) / (1 - back));
  let shake = 0;
  if (p > shakeStart && p < shakeEnd) {
    const s = (p - shakeStart) / (shakeEnd - shakeStart);
    shake = Math.sin(s * Math.PI * 2 * SHAKES) * SHAKE_SQUARES;
  }
  return { dx: fx * k + shake || 0, dy: fy * k || 0, alpha: 1 };
}
