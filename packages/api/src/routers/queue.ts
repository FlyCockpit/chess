import {
  checkBackupFreshnessQueue,
  chessReconcileQueue,
  chessRunQueue,
  notifyDataDeletionsQueue,
  QUEUE_NAMES,
  reapExpiredAuthTokensQueue,
  redisConnection,
} from "@cockpit-chess/queue";
import { z } from "zod";
import { adminOr404Procedure } from "../index";
import {
  backupFreshnessEnabled,
  misconfiguredBackupFreshness,
  readBackupFreshness,
  setupMissingBackupFreshness,
} from "../lib/backup-freshness";

const queuesByName = {
  [QUEUE_NAMES.chessRun]: chessRunQueue,
  [QUEUE_NAMES.chessReconcile]: chessReconcileQueue,
  [QUEUE_NAMES.reapExpiredAuthTokens]: reapExpiredAuthTokensQueue,
  [QUEUE_NAMES.checkBackupFreshness]: checkBackupFreshnessQueue,
  [QUEUE_NAMES.notifyDataDeletions]: notifyDataDeletionsQueue,
} as const;

const queueNameSchema = z.enum([
  QUEUE_NAMES.chessRun,
  QUEUE_NAMES.chessReconcile,
  QUEUE_NAMES.reapExpiredAuthTokens,
  QUEUE_NAMES.checkBackupFreshness,
  QUEUE_NAMES.notifyDataDeletions,
]);

export const queueRouter = {
  /**
   * Last backup-freshness verdict for the admin dashboard. `configured: false`
   * means logical backups are off (provider-only profile) and there is nothing
   * to show. A bucket that is set but unusable is NOT that case: it reports
   * `configured: true` with a `misconfigured` verdict, because a backup that
   * can never run has to be louder than one that is merely late, not quieter.
   * `status: null` with `configured: true` means the worker has not recorded a
   * verdict within its TTL — treat as unknown, not healthy.
   */
  backupStatus: adminOr404Procedure.handler(async () => {
    if (!backupFreshnessEnabled()) return { configured: false as const, status: null };
    const setupMissing = setupMissingBackupFreshness();
    if (setupMissing) return { configured: true as const, status: setupMissing };
    const misconfigured = misconfiguredBackupFreshness();
    if (misconfigured) return { configured: true as const, status: misconfigured };
    return { configured: true as const, status: await readBackupFreshness(redisConnection) };
  }),

  getJob: adminOr404Procedure
    .input(
      z.object({
        jobId: z.string(),
        queue: queueNameSchema.default(QUEUE_NAMES.chessRun),
      }),
    )
    .handler(async ({ input }) => {
      const queue = queuesByName[input.queue];
      const job = await queue.getJob(input.jobId);
      if (!job) return null;
      const state = await job.getState();
      return {
        id: job.id,
        data: job.data,
        state,
        returnValue: job.returnvalue,
        failedReason: job.failedReason,
      };
    }),

  listFailed: adminOr404Procedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(20),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const limit = input?.limit ?? 20;
      const entries = await Promise.all(
        Object.entries(queuesByName).map(async ([queueName, queue]) => {
          const jobs = await queue.getJobs(["failed"], 0, limit - 1, false);
          return Promise.all(
            jobs.map(async (job) => ({
              queue: queueName,
              id: job.id ?? null,
              name: job.name,
              failedReason: job.failedReason ?? null,
              attemptsMade: job.attemptsMade,
              timestamp: job.timestamp,
              finishedOn: job.finishedOn ?? null,
            })),
          );
        }),
      );
      const items = entries
        .flat()
        .sort((a, b) => (b.finishedOn ?? b.timestamp) - (a.finishedOn ?? a.timestamp))
        .slice(0, limit);
      return { items };
    }),
};
