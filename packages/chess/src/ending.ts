import { z } from "zod";
import {
  type AttemptEvent,
  archiveSchema,
  boardAt,
  type Chess,
  type MatchArchive,
  matchStats,
  plyLimit,
  type Rules,
  type Side,
  sideClockMs,
} from "./index";

/**
 * The one structured description of how a match ended (or that it has not). Every
 * surface renders from this: the web client through its locale keys (`ending.*`), the
 * PGN export and the CLI through `endingText`. Derived from the archive alone.
 */
export const drawKinds = [
  "stalemate",
  "threefold-repetition",
  "fifty-move-rule",
  "insufficient-material",
  /** A recorded draw whose position shows none of the above (not produced by the runner). */
  "other",
] as const;
export type DrawKind = (typeof drawKinds)[number];
export type PieceName = "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";
/** Why one rejected attempt was illegal, where that is cheap and certain to derive. */
export type IllegalWhy =
  | { code: "unparseable" }
  /** The reply was cut off at its output limit before it gave a move. */
  | { code: "truncated" }
  /**
   * The side's pawn on its own starting square already moved away earlier, so it was
   * that file's pawn. (A pawn that left any other square may have changed file.)
   */
  | { code: "pawn-moved"; file: string; square: string }
  /** Another of the side's pieces already left this square earlier in the game. */
  | { code: "piece-moved"; piece: PieceName; square: string }
  | { code: "empty"; square: string }
  | { code: "opponent-piece"; square: string }
  | { code: "cannot-move"; piece: PieceName; from: string; to: string }
  /** The pawn can make this move, but a promoting move must name the piece (a7a8q). */
  | { code: "promotion"; from: string };
export type IllegalAttempt = { move: string; why: IllegalWhy };
export type MatchEnding =
  | { kind: "playing" }
  | { kind: "checkmate"; winner: Side }
  | { kind: "draw"; draw: DrawKind }
  | { kind: "illegal-forfeit"; loser: Side; attempts: IllegalAttempt[] }
  | { kind: "timeout"; loser: Side; clockMs: number | null }
  | { kind: "move-timeout"; loser: Side; limitMs: number }
  | {
      kind: "token-budget";
      loser: Side;
      tokens: number;
      accounting: Rules["tokenAccounting"];
    }
  /**
   * Budget endings come from the check before each request (except shared-token
   * accounting, which also counts mid-reply): what was left could not pay for one more.
   * `spentMicros`: the provider-reported cost of the side's calls. `settled` is false
   * when some call never reported its cost, so the side spent at least that much.
   */
  | {
      kind: "cost-budget";
      loser: Side;
      budgetMicros: number;
      spentMicros: number;
      settled: boolean;
    }
  | { kind: "resignation"; loser: Side }
  | { kind: "ply-limit"; plies: number }
  | { kind: "cancelled" }
  | { kind: "interrupted" }
  /**
   * No side is named: a failure can come from either model's setup (the worker prices
   * both before play), not only from the side to move.
   */
  | { kind: "provider-error" }
  | { kind: "engine-error" }
  | { kind: "event-limit" }
  /** The paying OpenRouter key's limit or the account's credits ran out. Unscored. */
  | { kind: "account-limit" }
  /** The paying OpenRouter key was revoked, expired or disconnected. Unscored. */
  | { kind: "credential-revoked" };

const PIECES: Record<string, PieceName> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};
const UCI = /^([a-h][1-8])([a-h][1-8])[qrbn]?$/;

function drawKind(chess: Chess): DrawKind {
  if (chess.isStalemate()) return "stalemate";
  if (chess.isInsufficientMaterial()) return "insufficient-material";
  if (chess.isThreefoldRepetition()) return "threefold-repetition";
  if (chess.isDrawByFiftyMoves()) return "fifty-move-rule";
  return "other";
}

/** Why `attempt` was illegal, from its own `before` position and the moves played earlier. */
export function illegalWhy(match: MatchArchive, attempt: AttemptEvent, board: Chess): IllegalWhy {
  if (attempt.reason === "truncated") return { code: "truncated" };
  const parsed = UCI.exec(attempt.move);
  if (!parsed || attempt.reason === "unparseable") return { code: "unparseable" };
  const from = parsed[1] as string;
  const to = parsed[2] as string;
  const piece = board.get(from as Parameters<Chess["get"]>[0]);
  if (piece && piece.color !== attempt.side) return { code: "opponent-piece", square: from };
  if (piece) {
    const promotes = board
      .moves({ square: from as Parameters<Chess["get"]>[0], verbose: true })
      .some((move) => move.to === to && move.promotion);
    if (promotes) return { code: "promotion", from };
    return { code: "cannot-move", piece: PIECES[piece.type] ?? "pawn", from, to };
  }
  // The square is empty: say why when this side's own piece moved off it earlier.
  const left = match.events
    .filter(
      (event): event is AttemptEvent =>
        event.type === "attempt" &&
        event.accepted &&
        event.side === attempt.side &&
        event.seq < attempt.seq,
    )
    .findLast((event) => event.move.slice(0, 2) === from);
  if (left?.san) {
    const letter = left.san[0] ?? "";
    if (/[a-h]/.test(letter))
      return from[1] === (attempt.side === "w" ? "2" : "7")
        ? { code: "pawn-moved", file: from[0] as string, square: from }
        : { code: "piece-moved", piece: "pawn", square: from };
    if (letter === "O") return { code: "piece-moved", piece: "king", square: from };
    const name = PIECES[letter.toLowerCase()];
    if (name) return { code: "piece-moved", piece: name, square: from };
  }
  return { code: "empty", square: from };
}

/** A side's reported spend, and whether every call's cost was reported. */
function spentOf(match: MatchArchive, side: Side) {
  const stats = matchStats(match, side);
  return { spentMicros: stats.reportedCostMicros, settled: stats.costMicros !== null };
}

/** How the match ended, with the details its plain-words description needs. */
export function matchEnding(match: MatchArchive): MatchEnding {
  const rules = match.config.rules;
  const board = boardAt(match);
  const toMove = board.turn();
  switch (match.termination) {
    case "playing":
      return { kind: "playing" };
    case "checkmate":
      return { kind: "checkmate", winner: toMove === "w" ? "b" : "w" };
    case "draw":
      return { kind: "draw", draw: drawKind(board) };
    case "illegal-forfeit": {
      const ply = match.events.filter((event) => event.type === "attempt" && event.accepted).length;
      const attempts = match.events
        .filter(
          (event): event is AttemptEvent =>
            event.type === "attempt" && !event.accepted && event.ply === ply,
        )
        .map((attempt) => ({ move: attempt.move, why: illegalWhy(match, attempt, board) }));
      return { kind: "illegal-forfeit", loser: toMove, attempts };
    }
    case "timeout":
      // cockpit-v1 recorded "timeout" for its per-move limit too, so which limit ran
      // out is unknown there: no clock is named.
      return {
        kind: "timeout",
        loser: toMove,
        clockMs: rules.version === "cockpit-v1" ? null : sideClockMs(rules, toMove),
      };
    case "move-timeout":
      return { kind: "move-timeout", loser: toMove, limitMs: rules.turnTimeoutMs };
    case "token-budget":
      return {
        kind: "token-budget",
        loser: toMove,
        tokens: rules.tokenBudget,
        accounting: rules.tokenAccounting,
      };
    case "cost-budget":
      return {
        kind: "cost-budget",
        loser: toMove,
        budgetMicros: rules.costBudgetMicros,
        ...spentOf(match, toMove),
      };
    case "resignation":
      return { kind: "resignation", loser: toMove };
    case "ply-limit":
      return { kind: "ply-limit", plies: plyLimit(rules) ?? 0 };
    case "provider-error":
    case "cancelled":
    case "interrupted":
    case "engine-error":
    case "event-limit":
    case "account-limit":
    case "credential-revoked":
      return { kind: match.termination };
  }
}

/**
 * The short ending a match card shows, stored on the row (`ChessMatch.ending`) so lists
 * need no archive. `side` is the side to move at the end: the mated, forfeiting,
 * resigning or failing side. Rows backfilled from older archives may lack `side`,
 * `draw` or `illegal`; renderers fall back to the plain kind.
 */
export const endingSummarySchema = z
  .object({
    kind: archiveSchema.shape.termination,
    side: z.enum(["w", "b"]).optional(),
    draw: z.enum(drawKinds).optional(),
    /** Rejected attempts in an illegal-move forfeit. */
    illegal: z.number().int().nonnegative().optional(),
    /** Of those, replies cut off before they gave a move (absent when none). */
    truncated: z.number().int().positive().optional(),
  })
  .strict();
export type EndingSummary = z.infer<typeof endingSummarySchema>;
export function endingSummary(ending: MatchEnding): EndingSummary {
  switch (ending.kind) {
    case "checkmate":
      return { kind: ending.kind, side: ending.winner === "w" ? "b" : "w" };
    case "draw":
      return { kind: ending.kind, draw: ending.draw };
    case "illegal-forfeit": {
      const truncated = ending.attempts.filter((attempt) => attempt.why.code === "truncated");
      return {
        kind: ending.kind,
        side: ending.loser,
        illegal: ending.attempts.length,
        ...(truncated.length ? { truncated: truncated.length } : {}),
      };
    }
    case "timeout":
    case "move-timeout":
    case "token-budget":
    case "cost-budget":
    case "resignation":
      return { kind: ending.kind, side: ending.loser };
    default:
      return { kind: ending.kind };
  }
}

const colour = (side: Side) => (side === "w" ? "White" : "Black");
/** "$1.00", "$0.05", "$0.0012", "$0.00": cents when whole, else up to four decimals. */
export function formatUsd(micros: number) {
  if (micros === 0) return "$0.00";
  const dollars = micros / 1_000_000;
  return `$${dollars >= 0.01 && Number.isInteger(micros / 10_000) ? dollars.toFixed(2) : dollars.toFixed(4).replace(/\.?0+$/, "")}`;
}
/** "10 min", "1 min 30 s", "45 s". */
export function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return `${rest} s`;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}
/** A move as untrusted display text: bounded, single-line. */
export function displayMove(move: string) {
  const line = move.replace(/[\p{Cc}\s]+/gu, " ").trim();
  return line.length > 16 ? `${line.slice(0, 15)}…` : line;
}
/**
 * A forfeit's attempts for its detail: the ones with a move token to show, and how many
 * replies gave none (the runner archived a placeholder, never shown as a move). Cut-off
 * replies are left out: the headline already counts them.
 */
export function forfeitAttempts(attempts: IllegalAttempt[]) {
  const placeholder = (attempt: IllegalAttempt) =>
    attempt.why.code === "truncated" ||
    (attempt.why.code === "unparseable" && /^\[[a-z]+\]$/.test(attempt.move));
  return {
    listed: attempts.filter((attempt) => !placeholder(attempt)),
    unreadable: attempts.filter(
      (attempt) => attempt.why.code === "unparseable" && placeholder(attempt),
    ).length,
  };
}
export function illegalWhyText(why: IllegalWhy) {
  switch (why.code) {
    case "unparseable":
      return "not a move in UCI notation";
    case "truncated":
      return "ran out of space before giving a move";
    case "pawn-moved":
      return `its ${why.file}-pawn had already moved`;
    case "piece-moved":
      return `its ${why.piece} had already left ${why.square}`;
    case "empty":
      return `there is no piece on ${why.square}`;
    case "opponent-piece":
      return `${why.square} holds an opposing piece`;
    case "cannot-move":
      return `its ${why.piece} on ${why.from} cannot legally move to ${why.to}`;
    case "promotion":
      return `its pawn on ${why.from} must name a promotion piece (q, r, b or n)`;
  }
}
const DRAW_TEXT: Record<Exclude<DrawKind, "other">, string> = {
  stalemate: "stalemate",
  "threefold-repetition": "threefold repetition",
  "fifty-move-rule": "fifty-move rule",
  "insufficient-material": "insufficient material",
};
/**
 * The ending's headline: what a match card and the PNG show. Needs only the short
 * summary, so stored rows render it without the archive; fields a backfilled row lacks
 * degrade to a plainer sentence. The web client renders the same mapping through its
 * locale keys (`chess:ending.*`), and its tests compare the two for every ending.
 */
export function endingHeadline(summary: EndingSummary): string {
  const side = summary.side ? colour(summary.side) : null;
  switch (summary.kind) {
    case "playing":
      return "In progress";
    case "checkmate":
      return summary.side
        ? `Checkmate: ${colour(summary.side === "w" ? "b" : "w")} wins`
        : "Checkmate";
    case "draw":
      return summary.draw && summary.draw !== "other" ? `Draw: ${DRAW_TEXT[summary.draw]}` : "Draw";
    case "illegal-forfeit":
      if (!side) return "Forfeit after illegal moves";
      if (summary.illegal === undefined) return `${side} forfeited: illegal moves`;
      if (summary.truncated !== undefined && summary.truncated === summary.illegal)
        return `${side} forfeited: ${summary.truncated} ${summary.truncated === 1 ? "reply" : "replies"} ran out of space`;
      if (summary.truncated !== undefined)
        return `${side} forfeited: ${summary.illegal} rejected moves (${summary.truncated} ran out of space)`;
      return `${side} forfeited: ${summary.illegal} illegal ${summary.illegal === 1 ? "move" : "moves"}`;
    case "timeout":
      return side ? `${side} ran out of time` : "Out of time";
    case "move-timeout":
      return side ? `${side} ran out of time for one move` : "Out of time for one move";
    case "token-budget":
      return side ? `${side} ran out of tokens` : "Out of tokens";
    case "cost-budget":
      return side ? `${side} ran out of budget` : "Out of budget";
    case "resignation":
      return side ? `${side} resigned` : "Resignation";
    case "ply-limit":
      return "Draw: move limit reached";
    case "cancelled":
      return "Stopped by the operator";
    case "interrupted":
      return "Interrupted by the server";
    case "provider-error":
      return "A model provider failed";
    case "engine-error":
      return "The chess engine failed";
    case "event-limit":
      return "The game record reached its size limit";
    case "account-limit":
      return "The OpenRouter key's limit or credits ran out";
    case "credential-revoked":
      return "The OpenRouter key was revoked or disconnected";
  }
}
/**
 * Why a budget ending can come before the budget is spent: each request reserves its
 * worst case up front, and the game ends once what is left cannot pay for one. Only
 * shared (cl100k_base) token accounting can also end mid-reply, on the count itself.
 */
const NO_ROOM_TEXT = "not enough left for another request";
/**
 * The ending's detail, shown in brackets after the headline in the game view and the
 * PGN: the illegal moves and why, the limit that ran out, or that the game is unscored.
 */
export function endingDetail(ending: MatchEnding): string | null {
  switch (ending.kind) {
    case "illegal-forfeit": {
      const { listed, unreadable } = forfeitAttempts(ending.attempts);
      const whys = listed.map((attempt) => illegalWhyText(attempt.why));
      const moves = listed.map((attempt) => displayMove(attempt.move));
      const parts: string[] = [];
      if (whys.length && whys.every((why) => why === whys[0]))
        parts.push(`${moves.join(", ")}; ${whys[0]}`);
      else parts.push(...moves.map((move, index) => `${move}: ${whys[index]}`));
      if (unreadable)
        parts.push(`${unreadable} ${unreadable === 1 ? "reply" : "replies"} couldn't be read`);
      return parts.length ? parts.join("; ") : null;
    }
    case "timeout":
      return ending.clockMs === null ? null : `${formatDuration(ending.clockMs)} clock`;
    case "move-timeout":
      return `${formatDuration(ending.limitMs)} per-move limit`;
    case "token-budget": {
      const limit = `${ending.tokens.toLocaleString("en-US")} token budget`;
      return ending.accounting === "provider" ? `${limit}; ${NO_ROOM_TEXT}` : limit;
    }
    case "cost-budget":
      return `spent ${ending.settled ? "" : "at least "}${formatUsd(ending.spentMicros)} of ${formatUsd(ending.budgetMicros)}; ${NO_ROOM_TEXT}`;
    case "ply-limit":
      return `${ending.plies} plies`;
    case "cancelled":
    case "interrupted":
    case "provider-error":
    case "engine-error":
    case "event-limit":
    case "account-limit":
    case "credential-revoked":
      return "unscored";
    default:
      return null;
  }
}
/** Headline plus detail, in plain English: the PGN's closing comment and the CLI. */
export function endingText(ending: MatchEnding): string {
  const detail = endingDetail(ending);
  const headline = endingHeadline(endingSummary(ending));
  return detail ? `${headline} (${detail})` : headline;
}

/** "10 min each", "White 15 min · Black 5 min", or "Untimed". */
export function timeControlText(rules: Rules) {
  const white = sideClockMs(rules, "w");
  const black = sideClockMs(rules, "b");
  if (white === null || black === null) return "Untimed";
  if (white === black) return `${formatDuration(white)} each`;
  return `White ${formatDuration(white)} · Black ${formatDuration(black)}`;
}
