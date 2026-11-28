import type { MatchArchive, TurnState } from "@cockpit-chess/chess";
import { chessRunQueue, ensureRunnableJob } from "@cockpit-chess/queue";
import { DbNull } from "../../../db/prisma/generated/internal/prismaNamespace";
import { chessTurnColumns } from "./chess-turn";

/** One recoverable wake per durable event tail, shared by API and worker repair. */
export function chessRunJobId(matchId: string, archive: MatchArchive): string {
  return archive.events.length === 0
    ? `chess-${matchId}`
    : `chess-${matchId}-turn-${archive.events.length}`;
}

/** Absent pending input is SQL NULL, never a JSON null value. */
export function chessTurnData(turn: TurnState) {
  const columns = chessTurnColumns(turn);
  return { ...columns, pendingMove: columns.pendingMove ?? DbNull };
}

/** Call only after commit: a lost queue hint leaves durable queued work for repair. */
export async function wakeHostedMatch(matchId: string, archive: MatchArchive): Promise<void> {
  const jobId = chessRunJobId(matchId, archive);
  try {
    await ensureRunnableJob(chessRunQueue, "chess-run", { matchId }, jobId);
  } catch {
    console.error("[chess] Hosted wake unavailable", { matchId, jobId });
  }
}
