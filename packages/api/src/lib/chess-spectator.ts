import type { MatchArchive } from "@cockpit-chess/chess";
import {
  missingSpectatorPlies,
  type SpectatorEvaluations,
  storedSpectatorEvaluations,
} from "@cockpit-chess/chess/spectator";
import type { Prisma } from "@cockpit-chess/db";
import {
  CHESS_SPECTATOR_JOB_PRIORITY,
  chessReconcileQueue,
  chessSpectatorJobId,
  ensureRunnableJob,
} from "@cockpit-chess/queue";

/** Matches this process asked to backfill recently: a replay poll must not re-enqueue each time. */
const requested = new Map<string, number>();
/** Short enough that a replay's polling re-asks within a minute if a job failed. */
const REQUEST_TTL_MS = 60_000;
const REQUEST_MEMO_LIMIT = 1000;

function requestBackfill(matchId: string, fromPly: number) {
  const now = Date.now();
  const last = requested.get(matchId);
  if (last !== undefined && now - last < REQUEST_TTL_MS) return;
  if (requested.size >= REQUEST_MEMO_LIMIT) requested.clear();
  requested.set(matchId, now);
  // One job per gap (job id = match + first missing ply): a retained completed or
  // failed job is made runnable again. A read never waits for or fails on the queue.
  void Promise.resolve()
    .then(() =>
      ensureRunnableJob(
        chessReconcileQueue,
        "chess-spectator",
        { reason: "spectator", matchId, fromPly },
        chessSpectatorJobId(matchId, fromPly),
        { priority: CHESS_SPECTATOR_JOB_PRIORITY },
      ),
    )
    .catch(() => requested.delete(matchId));
}

/**
 * The spectator evaluations a replay shows (see packages/chess/src/spectator.ts), read
 * leniently. A game that is no longer running but still lacks positions gets one
 * background backfill; a running game's own run evaluates as it plays.
 */
export function spectatorEvaluationsFor(row: {
  id: string;
  status: string;
  archive: MatchArchive;
  spectatorEvaluations: Prisma.JsonValue;
}): SpectatorEvaluations | null {
  const evaluations = storedSpectatorEvaluations.parse(row.spectatorEvaluations);
  if (row.status === "queued" || row.status === "running") return evaluations;
  let missing: number[] = [];
  try {
    missing = missingSpectatorPlies(row.archive, evaluations);
  } catch {
    // An archive that no longer replays has no positions to evaluate.
  }
  if (missing[0] !== undefined) requestBackfill(row.id, missing[0]);
  return evaluations;
}
