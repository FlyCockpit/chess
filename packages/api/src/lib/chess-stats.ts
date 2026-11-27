import { type MatchArchive, matchStats } from "@cockpit-chess/chess";
import { type EndingSummary, endingSummary, matchEnding } from "@cockpit-chess/chess/ending";
import type { Prisma } from "@cockpit-chess/db";

/**
 * Typed leaderboard columns, and the match card's short ending, derived from a finished
 * archive.
 *
 * The single derivation point for `ChessMatch.result` / `white*` / `black*`:
 * the worker's terminal persist and `chess.importGame` both write exactly this,
 * so the public leaderboard aggregates columns instead of parsing archives.
 * Returns null while the match is still running — stats are written once, on
 * the terminal write. Cost is usage-based (`matchStats().costMicros`) and stays
 * null when any usage is unpriced or a reservation was never settled.
 */
export function chessStatsColumns(match: MatchArchive) {
  if (match.status === "running") return null;
  const white = matchStats(match, "w");
  const black = matchStats(match, "b");
  return {
    result: match.result,
    whiteModel: match.config.white.model,
    whiteProtocol: match.config.white.protocol,
    blackModel: match.config.black.model,
    blackProtocol: match.config.black.protocol,
    whiteIllegal: white.illegalAttempts,
    blackIllegal: black.illegalAttempts,
    whiteTruncated: white.truncatedAttempts,
    blackTruncated: black.truncatedAttempts,
    whiteCostMicros: white.costMicros === null ? null : BigInt(white.costMicros),
    blackCostMicros: black.costMicros === null ? null : BigInt(black.costMicros),
    moveFormat: match.config.rules.moveFormat,
    ending: endingSummary(matchEnding(match)),
  } satisfies Prisma.ChessMatchUncheckedUpdateManyInput;
}

/**
 * The card endings of the status-only writes, which leave the archive snapshot as it
 * was: an operator stop reads as cancelled, an error over a running snapshot as
 * interrupted (the same normalization `chess.get` / `chess.inspect` apply).
 */
export const STOPPED_ENDING = { kind: "cancelled" } satisfies EndingSummary;
export const INTERRUPTED_ENDING = { kind: "interrupted" } satisfies EndingSummary;
export const CREDENTIAL_REVOKED_ENDING = { kind: "credential-revoked" } satisfies EndingSummary;
