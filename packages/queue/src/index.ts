import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";
import { QUEUE_NAMES } from "./jobs.js";

export { FlowProducer, Job, Queue, QueueEvents, Worker } from "bullmq";
export { createRedisConnection, redisConnection } from "./connection.js";
export { ensureRunnableJob, isLiveJobState } from "./ensure-job.js";
export {
  CHECK_BACKUP_FRESHNESS_CRON_PATTERN,
  CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID,
  CHESS_RECONCILE_EVERY_MS,
  CHESS_RECONCILE_JOB_SCHEDULER_ID,
  type CheckBackupFreshnessJobData,
  type ChessReconcileJobData,
  type ChessRunJobData,
  checkBackupFreshnessJobSchema,
  chessReconcileJobSchema,
  chessRunJobSchema,
  NOTIFY_DATA_DELETIONS_CRON_PATTERN,
  NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID,
  type NotifyDataDeletionsJobData,
  notifyDataDeletionsJobSchema,
  QUEUE_NAMES,
  REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN,
  REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
  type ReapExpiredAuthTokensJobData,
  reapExpiredAuthTokensJobSchema,
} from "./jobs.js";

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400, count: 5000 },
};

/** Hosted chess match runs (one attempt; the reconcile sweep handles failures). */
export const chessRunQueue = new Queue(QUEUE_NAMES.chessRun, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

/**
 * Chess reconcile sweep. Cron-only; `attempts: 1` like the other sweeps — the
 * next firing (a minute later) is the retry.
 */
export const chessReconcileQueue = new Queue(QUEUE_NAMES.chessReconcile, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

/**
 * Deletes expired short-lived credentials (sessions, verifications, device
 * codes, API keys). Cron-only and unconditional: a bounded Postgres delete
 * every install owes its users.
 * `attempts: 1` — the next daily firing is the retry.
 */
export const reapExpiredAuthTokensQueue = new Queue(QUEUE_NAMES.reapExpiredAuthTokens, {
  connection: redisConnection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

/**
 * Backup freshness check. `attempts: 1` like the other sweeps: a listing error
 * is itself a verdict the handler records and alerts on, and the next firing
 * (6 hours later) is the retry.
 */
export const checkBackupFreshnessQueue = new Queue(QUEUE_NAMES.checkBackupFreshness, {
  connection: redisConnection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

/** One scheduled notice sweep, with the next 15-minute firing acting as its retry. */
export const notifyDataDeletionsQueue = new Queue(QUEUE_NAMES.notifyDataDeletions, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});
