import { z } from "zod";

/**
 * Job schemas — define the shape of each job's payload here.
 * Both producers and workers import from this file so the contract is shared.
 */

/**
 * Backup freshness check — lists the backup bucket, records the age of the
 * newest dump in Redis, and alerts admins when it exceeds BACKUP_MAX_AGE_HOURS.
 * Cron-only.
 */
export const checkBackupFreshnessJobSchema = z.object({
  reason: z.enum(["cron"]),
});

export type CheckBackupFreshnessJobData = z.infer<typeof checkBackupFreshnessJobSchema>;

/**
 * Delete short-lived credential rows past their `expiresAt` — Session,
 * Verification (`packages/api/src/lib/auth-token-retention.ts`).
 *
 * Nothing else prunes those tables: expiry was only ever enforced by rejecting
 * the credential at read time, so expired rows accumulated forever.
 * This bounded Postgres delete is scheduled unconditionally.
 *
 * Cron-only; `attempts: 1` like the other sweeps, because the next daily
 * firing is the retry and the delete is idempotent by construction.
 */
export const reapExpiredAuthTokensJobSchema = z.object({
  reason: z.enum(["cron"]),
});

export type ReapExpiredAuthTokensJobData = z.infer<typeof reapExpiredAuthTokensJobSchema>;

/**
 * Queue names — use these constants instead of string literals.
 */
export const chessRunJobSchema = z.object({
  matchId: z.string().min(1).max(64),
});
export type ChessRunJobData = z.infer<typeof chessRunJobSchema>;

/**
 * Chess reconcile sweep — errors hosted matches whose worker stopped
 * heartbeating, and queued matches whose BullMQ job is missing or terminal.
 * Lives on its own queue: the chess-run consumer has concurrency 1, so a sweep
 * sharing it could never run while a match (the thing it watches) was running.
 */
export const chessReconcileJobSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("cron") }),
  /**
   * A finished game's missing spectator evaluations (enqueued by a replay read,
   * deduplicated per match by `chessSpectatorJobId`). It shares this queue because
   * the chess-run consumer must never wait behind it.
   */
  z.object({
    reason: z.literal("spectator"),
    matchId: z.string().min(1).max(64),
    /** The first missing ply when the chunk was requested (also in its job id). */
    fromPly: z.number().int().nonnegative(),
  }),
]);
export type ChessReconcileJobData = z.infer<typeof chessReconcileJobSchema>;

/**
 * A spectator-evaluation backfill chunk: one per match and first missing ply, so
 * concurrent readers of the same gap share one job, and a chunk that leaves positions
 * behind hands them to a new job (the next first missing ply) instead of its own,
 * still-active id.
 */
export const chessSpectatorJobId = (matchId: string, fromPly: number) =>
  `chess-spectator-${matchId}-${fromPly}`;
/**
 * Backfill chunks are prioritized BullMQ jobs; the reconcile sweep's scheduled jobs are
 * not, and BullMQ hands out unprioritized waiting jobs first. So a sweep waits for at
 * most the one chunk in progress, however many backfills are queued.
 */
export const CHESS_SPECTATOR_JOB_PRIORITY = 10;

/** Stable BullMQ Job Scheduler ID for the chess reconcile sweep. */
export const CHESS_RECONCILE_JOB_SCHEDULER_ID = "chess-reconcile";

/** Every minute: a dead run is noticed ~1 minute after its 5-minute heartbeat window. */
export const CHESS_RECONCILE_EVERY_MS = 60_000;

export const QUEUE_NAMES = {
  chessRun: "chess-run",
  chessReconcile: "chess-reconcile",
  reapExpiredAuthTokens: "reap-expired-auth-tokens",
  checkBackupFreshness: "check-backup-freshness",
  notifyDataDeletions: "notify-data-deletions",
} as const;

/** Stable BullMQ Job Scheduler ID for the expired-auth-token sweep. */
export const REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID = "reap-expired-auth-tokens";

/**
 * Once a day at 04:17 UTC. Daily is the right cadence for rows whose only cost
 * is existing: an expired credential is dead the moment it ages out, and sweeping more
 * often would re-scan the same indexed range for nothing.
 */
export const REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN = "17 4 * * *";

/** Stable BullMQ Job Scheduler ID for the backup freshness check. */
export const CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID = "check-backup-freshness";

/**
 * Every 6 hours at :20. Nightly dumps land at 03:00 and BACKUP_MAX_AGE_HOURS
 * defaults to 36, so a missed run is noticed within a quarter-day of crossing
 * the threshold; more often would only re-list the bucket for the same answer.
 */
export const CHECK_BACKUP_FRESHNESS_CRON_PATTERN = "20 */6 * * *";

/** Recent migration deletions are emailed to opted-in admins; the next run retries failures. */
export const notifyDataDeletionsJobSchema = z.object({ reason: z.enum(["cron"]) });
export type NotifyDataDeletionsJobData = z.infer<typeof notifyDataDeletionsJobSchema>;
export const NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID = "notify-data-deletions";
export const NOTIFY_DATA_DELETIONS_CRON_PATTERN = "*/15 * * * *";
