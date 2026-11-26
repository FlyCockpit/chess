import { archiveSchema, type EngineEvaluation } from "@cockpit-chess/chess";
import { spectatorFeed } from "@cockpit-chess/chess/runner";
import {
  missingSpectatorPlies,
  type SpectatorEvaluations,
  storedSpectatorEvaluations,
} from "@cockpit-chess/chess/spectator";
import prisma from "@cockpit-chess/db";
import {
  CHESS_SPECTATOR_JOB_PRIORITY,
  chessReconcileQueue,
  chessSpectatorJobId,
  ensureRunnableJob,
} from "@cockpit-chess/queue";

/**
 * Spectator evaluation of hosted games (see packages/chess/src/spectator.ts): stored in
 * `chess_match.spectatorEvaluations`, never in the archive, so the players never see
 * it and it never counts against the archive limit.
 */

/** How long a finished run waits for its last positions before handing them to a backfill. */
const SPECTATOR_DRAIN_MS = 15_000;
/**
 * One backfill job's time budget. Backfills share the reconcile queue's single consumer,
 * so each runs in bounded chunks and the minute's cron sweep waits at most this long.
 */
const SPECTATOR_CHUNK_MS = 20_000;
/** How long past its deadline a chunk waits for a write already in flight. */
const SPECTATOR_WRITE_GRACE_MS = 5_000;

/**
 * Merges one ply's evaluation into the row in one statement (`||` on the JSONB object),
 * so a run's feed and a backfill writing the same row never drop each other's keys.
 * A stored value that is not an object is replaced rather than concatenated into an
 * array. Only that column changes: the archive, status and claim are untouched. The
 * write waits at most 2 s for the row lock and runs at most 5 s, so a stalled database
 * cannot hold a backfill chunk (or a run's drain) past its own deadline for long.
 */
async function recordSpectatorEvaluation(
  matchId: string,
  ply: number,
  evaluation: EngineEvaluation,
) {
  const patch = JSON.stringify({ [String(ply)]: evaluation });
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL lock_timeout = '2s'`,
    prisma.$executeRaw`SET LOCAL statement_timeout = '5s'`,
    prisma.$executeRaw`UPDATE "chess_match" SET "spectatorEvaluations" = (CASE WHEN jsonb_typeof("spectatorEvaluations") = 'object' THEN "spectatorEvaluations" ELSE '{}'::jsonb END) || ${patch}::jsonb WHERE "id" = ${matchId}`,
  ]);
}

/** A run's feed: evaluates each committed position in the background (spectator engine lane). */
export function matchSpectatorFeed(
  matchId: string,
  known: SpectatorEvaluations | null,
  signal?: AbortSignal,
) {
  return spectatorFeed({
    known,
    signal,
    record: (ply, evaluation) => recordSpectatorEvaluation(matchId, ply, evaluation),
  });
}

/** Queues a backfill chunk starting at `fromPly` (a retained finished job runs again). */
function requestSpectatorBackfill(matchId: string, fromPly: number) {
  return ensureRunnableJob(
    chessReconcileQueue,
    "chess-spectator",
    { reason: "spectator", matchId, fromPly },
    chessSpectatorJobId(matchId, fromPly),
    { priority: CHESS_SPECTATOR_JOB_PRIORITY },
  );
}

/**
 * Waits up to `ms` for a feed's queue to empty. If positions are left (or the feed
 * failed), stops it and hands the gap to a backfill job, so a finished run never holds
 * the concurrency-1 chess-run consumer for long.
 */
export async function settleSpectatorFeed(
  matchId: string,
  feed: ReturnType<typeof matchSpectatorFeed>,
  stop: AbortController,
  ms = SPECTATOR_DRAIN_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  const late = await Promise.race([feed.drain().then(() => false), timedOut]);
  clearTimeout(timer);
  if (!late && !feed.failed && feed.remaining === 0) return { handedOff: false };
  stop.abort();
  // Best effort: a queue outage only delays the gap until a replay asks for it.
  await Promise.resolve()
    .then(() => requestSpectatorBackfill(matchId, 0))
    .catch(() => undefined);
  return { handedOff: true };
}

/**
 * Backfill for a game that is no longer running (an older game, or one whose run could
 * not evaluate every position): evaluates the positions it still lacks, for at most
 * `SPECTATOR_CHUNK_MS`, then hands what is left to the next chunk. Enqueued when a
 * replay finds gaps (`chess.get` / `chess.inspect`); a running game is its run's job.
 * An engine or write failure fails the job, so a later read can run it again.
 */
export async function backfillSpectatorEvaluations(
  matchId: string,
  fromPly: number,
  signal?: AbortSignal,
  ms = SPECTATOR_CHUNK_MS,
) {
  const row = await prisma.chessMatch.findUnique({
    where: { id: matchId },
    select: { status: true, archive: true, spectatorEvaluations: true },
  });
  if (!row || row.status === "queued" || row.status === "running") return { evaluated: false };
  const archive = archiveSchema.safeParse(row.archive);
  if (!archive.success) return { evaluated: false };
  const known = storedSpectatorEvaluations.parse(row.spectatorEvaluations);
  const chunk = new AbortController();
  const timer = setTimeout(() => chunk.abort(), ms);
  const feed = matchSpectatorFeed(
    matchId,
    known,
    signal ? AbortSignal.any([signal, chunk.signal]) : chunk.signal,
  );
  feed.update(archive.data);
  // The deadline stops new analysis; a write that hangs past it (and its grace) must not
  // hold the reconcile queue's single consumer either: the job fails and is retried.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    feed.drain().then(() => true),
    new Promise<false>((resolve) => {
      deadline = setTimeout(() => resolve(false), ms + SPECTATOR_WRITE_GRACE_MS);
    }),
  ]);
  clearTimeout(deadline);
  clearTimeout(timer);
  if (!drained) {
    chunk.abort();
    throw new Error("Spectator backfill timed out on a write");
  }
  if (feed.failed && !chunk.signal.aborted && !signal?.aborted)
    throw new Error("Spectator evaluation failed");
  if ((chunk.signal.aborted || feed.remaining > 0) && !signal?.aborted) {
    // Out of time (the position in flight may be lost too): the next chunk starts at
    // the first position still missing in the database.
    const current = storedSpectatorEvaluations.parse(
      (
        await prisma.chessMatch.findUnique({
          where: { id: matchId },
          select: { spectatorEvaluations: true },
        })
      )?.spectatorEvaluations ?? null,
    );
    const next = missingSpectatorPlies(archive.data, current)[0];
    if (next === undefined) return { evaluated: true };
    // No progress from this chunk's own start would ask for this very (active) job:
    // fail instead, so it is retried (ensureRunnableJob re-runs a failed job).
    if (next <= fromPly) throw new Error("Spectator backfill made no progress");
    await requestSpectatorBackfill(matchId, next);
    return { evaluated: false, continued: next };
  }
  return { evaluated: !feed.failed };
}
