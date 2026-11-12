import { type MatchArchive, matchStats } from "@cockpit-chess/chess";
import type { Prisma } from "@cockpit-chess/db";

/**
 * Typed leaderboard columns derived from a finished archive.
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
    whiteCostMicros: white.costMicros === null ? null : BigInt(white.costMicros),
    blackCostMicros: black.costMicros === null ? null : BigInt(black.costMicros),
    moveFormat: match.config.rules.moveFormat,
  } satisfies Prisma.ChessMatchUncheckedUpdateManyInput;
}
