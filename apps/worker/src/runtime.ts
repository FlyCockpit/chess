import type {
  CheckBackupFreshnessJobData,
  ChessReconcileJobData,
  ChessRunJobData,
  NotifyDataDeletionsJobData,
  ReapExpiredAuthTokensJobData,
} from "@cockpit-chess/queue";
import {
  CHECK_BACKUP_FRESHNESS_CRON_PATTERN,
  CHESS_RECONCILE_EVERY_MS,
  CHESS_RECONCILE_JOB_SCHEDULER_ID,
  checkBackupFreshnessQueue,
  chessReconcileQueue,
  createRedisConnection,
  NOTIFY_DATA_DELETIONS_CRON_PATTERN,
  NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID,
  notifyDataDeletionsQueue,
  QUEUE_NAMES,
  REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN,
  REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
  reapExpiredAuthTokensQueue,
} from "@cockpit-chess/queue";
import { createConsumerHeartbeat } from "@cockpit-chess/queue/consumer-health";
import { type Processor, Worker, type WorkerOptions } from "bullmq";
import { syncBackupFreshnessScheduler } from "./backup-freshness-scheduler.js";
import { handleCheckBackupFreshnessJob } from "./handlers/check-backup-freshness.js";
import { handleChessReconcileJob, handleChessRunJob } from "./handlers/chess-run.js";
import { handleNotifyDataDeletionsJob } from "./handlers/notify-data-deletions.js";
import { handleReapExpiredAuthTokensJob } from "./handlers/reap-expired-auth-tokens.js";
import {
  closeOperationalAlertConnection,
  sendOperationalFailureAlert,
} from "./operational-alerts.js";
import { withTimeout } from "./runtime-lifecycle.js";

// One lifecycle per process.
// The host owns signals, fatal exit, and the shared Prisma/producer connections.
let claimed = false;
export type WorkerRuntime = {
  isReady(): boolean;
  stop(): Promise<void>;
};
export class WorkerDrainError extends Error {}

export async function startWorkerRuntime(options: {
  embedded: boolean;
  onFatal(error: unknown): void;
  signal?: AbortSignal;
}): Promise<WorkerRuntime> {
  if (claimed) throw new Error("Worker runtime already started; restart the process to re-enter.");
  claimed = true;
  const { embedded } = options;
  const connection = createRedisConnection();
  const heartbeatConnection = createRedisConnection({
    maxRetriesPerRequest: 1,
    commandTimeout: 3000,
  });
  const workers: Array<
    Pick<Worker, "name" | "close" | "run" | "isRunning" | "isPaused" | "waitUntilReady">
  > = [];
  const requiredQueues = Object.values(QUEUE_NAMES);
  let stopping = false;
  let ready = false;
  let failed = false;
  let stopPromise: Promise<void> | undefined;
  const heartbeat = createConsumerHeartbeat(
    heartbeatConnection,
    embedded ? "embedded" : "external",
    requiredQueues,
    () =>
      ready &&
      !stopping &&
      !failed &&
      connection.status === "ready" &&
      workers.length === requiredQueues.length &&
      requiredQueues.every((name) => workers.some((worker) => worker.name === name)) &&
      workers.every((worker) => worker.isRunning() && !worker.isPaused()),
  );
  function createWorker<T>(name: string, processor: Processor<T>, options: WorkerOptions) {
    const worker = new Worker<T>(name, processor, { ...options, autorun: false });
    workers.push(worker);
    worker.on("error", (error) =>
      console.error("[worker] Consumer connection error:", error.message),
    );
    return worker;
  }
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopping = true;
    ready = false;
    stopPromise = (async () => {
      // Closing consumers must begin even if a pending heartbeat cannot finish.
      // stop() closes BullMQ admission synchronously before awaiting active jobs.
      const workerDrains = Promise.allSettled(workers.map((worker) => worker.close()));
      const heartbeatFailure = await heartbeat.stop().then(
        () => false,
        () => true,
      );
      const results = await workerDrains;
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("One or more job consumers did not close cleanly.");
      }
      connection.disconnect();
      heartbeatConnection.disconnect();
      closeOperationalAlertConnection();
      if (heartbeatFailure) throw new Error("Consumer heartbeat did not close cleanly.");
    })();
    // Do not disconnect shared clients or pretend timed-out handlers stopped.
    // The host must exit on this rejection; its watchdog owns the hard deadline.
    stopPromise = withTimeout(
      stopPromise,
      15_000,
      "Worker drain timed out; process must exit.",
    ).catch((error: unknown) => {
      throw new WorkerDrainError(error instanceof Error ? error.message : "Worker drain failed.", {
        cause: error,
      });
    });
    return stopPromise;
  }
  options.signal?.addEventListener(
    "abort",
    () => {
      void stop().catch(() => {});
    },
    { once: true },
  );
  const requireRunning = () => {
    if (stopping || options.signal?.aborted) throw new Error("Worker startup cancelled.");
  };

  try {
    requireRunning();
    for (let attempt = 0; ; attempt++) {
      try {
        requireRunning();
        await withTimeout(connection.ping(), 5000, "Redis startup ping timed out");
        break;
      } catch (error) {
        requireRunning();
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    requireRunning();

    const chessWorker = createWorker<ChessRunJobData>(
      QUEUE_NAMES.chessRun,
      (job) => handleChessRunJob(job, options.signal),
      { connection, concurrency: 1 },
    );
    chessWorker.on("failed", (job, error) => {
      console.error(`[chess-run] Job ${job?.id} failed:`, error.message);
      void reportJobFailure("chess-run", job, error);
    });

    // Chess reconcile sweep — its own queue so it runs while a match holds the
    // concurrency-1 chess-run consumer. Concurrency 1: overlapping sweeps would
    // scan the same rows, and the compare-and-set makes the second a no-op.
    const chessReconcileWorker = createWorker<ChessReconcileJobData>(
      QUEUE_NAMES.chessReconcile,
      handleChessReconcileJob,
      { connection, concurrency: 1 },
    );

    chessReconcileWorker.on("failed", (job, err) => {
      console.error(`[chess-reconcile] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("chess-reconcile", job, err);
    });

    // Expired short-lived credentials (sessions, verifications) — another
    // bounded Postgres delete, no storage involved.
    // Concurrency 1: two overlapping sweeps would select the same id pages and
    // race the delete loops for no gain.
    const reapExpiredAuthTokensWorker = createWorker<ReapExpiredAuthTokensJobData>(
      QUEUE_NAMES.reapExpiredAuthTokens,
      handleReapExpiredAuthTokensJob,
      { connection, concurrency: 1 },
    );

    reapExpiredAuthTokensWorker.on("completed", (job) => {
      console.log(`[reap-expired-auth-tokens] Job ${job.id} completed`);
    });

    reapExpiredAuthTokensWorker.on("failed", (job, err) => {
      console.error(`[reap-expired-auth-tokens] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("reap-expired-auth-tokens", job, err);
    });

    // Backup freshness: one listing of the backup bucket per run, so concurrency 1.
    // The worker is always constructed (a job enqueued from the admin UI must not
    // sit forever), but the schedule is registered only when monitoring is on.
    const checkBackupFreshnessWorker = createWorker<CheckBackupFreshnessJobData>(
      QUEUE_NAMES.checkBackupFreshness,
      handleCheckBackupFreshnessJob,
      { connection, concurrency: 1 },
    );

    checkBackupFreshnessWorker.on("completed", (job) => {
      console.log(`[check-backup-freshness] Job ${job.id} completed`);
    });

    checkBackupFreshnessWorker.on("failed", (job, err) => {
      console.error(`[check-backup-freshness] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("check-backup-freshness", job, err);
    });

    const notifyDataDeletionsWorker = createWorker<NotifyDataDeletionsJobData>(
      QUEUE_NAMES.notifyDataDeletions,
      handleNotifyDataDeletionsJob,
      { connection, concurrency: 1 },
    );
    notifyDataDeletionsWorker.on("failed", (job, err) => {
      console.error(`[notify-data-deletions] Job ${job?.id} failed:`, err.message);
      void reportJobFailure("notify-data-deletions", job, err);
    });

    // Register the scheduled sweeps. Stable BullMQ Job Scheduler IDs make these
    // upserts idempotent across restarts and multiple worker replicas.
    requireRunning();
    await chessReconcileQueue.upsertJobScheduler(
      CHESS_RECONCILE_JOB_SCHEDULER_ID,
      { every: CHESS_RECONCILE_EVERY_MS },
      { name: "chess-reconcile", data: { reason: "cron" } },
    );
    requireRunning();
    // Expired-auth-token pruning is registered unconditionally:
    // reading `expiresAt` back is the only thing that ever happened to
    // an expired session or verification — the
    // rows piled up forever. The sweep needs nothing but Postgres.
    try {
      requireRunning();
      await reapExpiredAuthTokensQueue.upsertJobScheduler(
        REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
        { pattern: REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN },
        { name: "reap-expired-auth-tokens", data: { reason: "cron" } },
      );
      console.log(
        `[reap-expired-auth-tokens] Registered job scheduler (${REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN}).`,
      );
    } catch (err) {
      console.error("[reap-expired-auth-tokens] Failed to register job scheduler:", err);
      throw err;
    }

    // Backup freshness is gated on the BACKUP_* config and uses its own
    // bucket and credentials. BACKUP_ENABLED=false opts out of monitoring
    // without controlling migration snapshots or the daily backup writer.
    try {
      requireRunning();
      const action = await syncBackupFreshnessScheduler(checkBackupFreshnessQueue);
      if (action === "upserted") {
        console.log(
          `[check-backup-freshness] Registered job scheduler (${CHECK_BACKUP_FRESHNESS_CRON_PATTERN}).`,
        );
      } else {
        console.log(
          "[check-backup-freshness] Backup monitoring is disabled (BACKUP_ENABLED=false); removed job scheduler.",
        );
      }
    } catch (err) {
      console.error("[check-backup-freshness] Failed to sync job scheduler:", err);
      throw err;
    }

    requireRunning();
    await notifyDataDeletionsQueue.upsertJobScheduler(
      NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID,
      { pattern: NOTIFY_DATA_DELETIONS_CRON_PATTERN },
      { name: "notify-data-deletions", data: { reason: "cron" } },
    );
    requireRunning();
    await withTimeout(
      Promise.all(workers.map((worker) => worker.waitUntilReady())),
      10_000,
      "Job consumer startup timed out",
    );
    requireRunning();
    ready = true;
    for (const worker of workers) {
      void worker.run().catch((error: unknown) => {
        failed = true;
        void sendOperationalFailureAlert({
          queue: "worker",
          jobId: "consumer-failure",
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
        options.onFatal(error);
      });
    }
    await heartbeat.start();
    requireRunning();
    console.log(
      embedded ? "[worker] Embedded consumers started." : "[worker] External consumers started.",
    );
    return { isReady: () => heartbeat.isReady(), stop };
  } catch (error) {
    // Propagate an unclean drain to the host. A rejected startup alone does not
    // prove that active jobs released their shared Prisma/producer dependencies.
    await stop();
    throw error;
  }
}

type FailedJob = {
  id?: string | number;
  attemptsMade: number;
  finishedOn?: number;
  opts: { attempts?: number };
};

// BullMQ emits `failed` on every attempt, not only the last one. Act (alert,
// mark FAILED) only once the job has exhausted its retries so a queue with
// `attempts > 1` doesn't fire one alert per retry. A missing job handle (rare:
// lock lost) is treated as terminal so the failure is still surfaced.
function isTerminalFailure(job: FailedJob | undefined, err?: Error): boolean {
  if (!job) return true;
  if (err?.name === "UnrecoverableError") return true;
  if (job.finishedOn !== undefined) return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

async function reportJobFailure(
  queue: string,
  job: FailedJob | undefined,
  err: Error,
): Promise<void> {
  if (!isTerminalFailure(job, err)) return;
  try {
    await sendOperationalFailureAlert({ queue, jobId: job?.id, message: err.message });
  } catch (alertErr) {
    console.error(
      `[${queue}] Failed to send operational alert:`,
      alertErr instanceof Error ? alertErr.message : alertErr,
    );
  }
}
