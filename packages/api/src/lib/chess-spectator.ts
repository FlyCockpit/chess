import type { MatchArchive } from "@cockpit-chess/chess";
import {
  missingSpectatorPlies,
  type SpectatorEvaluations,
  storedSpectatorEvaluations,
} from "@cockpit-chess/chess/spectator";
import type { Prisma } from "@cockpit-chess/db";
import {
  CHESS_SPECTATOR_JOB_PRIORITY,
  type ChessSpectatorAccess,
  chessSpectatorJobId,
} from "@cockpit-chess/queue";
import { publishRegisteredChessJob } from "@cockpit-chess/queue/chess-job-registry";
import { withChessJobPublication } from "./chess-jobs";

/** Matches this process asked to backfill recently: a replay poll must not re-enqueue each time. */
const requested = new Map<string, number>();
/** Short enough that a replay's polling re-asks within a minute if a job failed. */
const REQUEST_TTL_MS = 60_000;
const REQUEST_MEMO_LIMIT = 1000;

function requestBackfill(matchId: string, fromPly: number, access: ChessSpectatorAccess) {
  const key = chessSpectatorJobId(matchId, fromPly, access);
  const now = Date.now();
  const last = requested.get(key);
  if (last !== undefined && now - last < REQUEST_TTL_MS) return;
  if (requested.size >= REQUEST_MEMO_LIMIT) requested.clear();
  requested.set(key, now);
  // One job per gap (job id = match + first missing ply): a retained completed or
  // failed job is made runnable again. A read never waits for or fails on the queue.
  void Promise.resolve()
    .then(async () => {
      // A queued microtask may outlive the public get/owner inspection which requested it.
      await withChessJobPublication(matchId, access, (assertFresh) =>
        publishRegisteredChessJob(
          matchId,
          "spectator",
          "chess-spectator",
          { reason: "spectator", matchId, fromPly, access },
          key,
          assertFresh,
          { priority: CHESS_SPECTATOR_JOB_PRIORITY },
        ),
      );
    })
    .catch(() => requested.delete(key));
}

/**
 * The spectator evaluations a replay shows (see packages/chess/src/spectator.ts), read
 * leniently. A game that is no longer running but still lacks positions gets one
 * background backfill; a running game's own run evaluates as it plays.
 */
export function spectatorEvaluationsFor(
  row: {
    id: string;
    status: string;
    source: string;
    archive: MatchArchive;
    spectatorEvaluations: Prisma.JsonValue;
  },
  access: ChessSpectatorAccess,
): SpectatorEvaluations | null {
  const evaluations = storedSpectatorEvaluations.parse(row.spectatorEvaluations);
  if (
    row.source !== "hosted" ||
    row.archive.source !== "hosted" ||
    row.status === "queued" ||
    (row.status === "running" &&
      !(row.archive.source === "hosted" && row.archive.turn.type === "human"))
  )
    return evaluations;
  let missing: number[] = [];
  try {
    missing = missingSpectatorPlies(row.archive, evaluations);
  } catch {
    // An archive that no longer replays has no positions to evaluate.
  }
  if (missing[0] !== undefined) requestBackfill(row.id, missing[0], access);
  return evaluations;
}
