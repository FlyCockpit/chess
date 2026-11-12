import { setTimeout as delay } from "node:timers/promises";

import { chessStatsColumns } from "@cockpit-chess/api/lib/chess-stats";
import { boardAt, finishMatch, type MatchArchive, validateArchive } from "@cockpit-chess/chess";
import {
  finishAbortedMatch,
  MATCH_INTERRUPTED,
  type ProviderCredentials,
  runMatch,
} from "@cockpit-chess/chess/runner";
import prisma from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/shared";
import {
  type ChessReconcileJobData,
  type ChessRunJobData,
  chessReconcileJobSchema,
  chessRunJobSchema,
  chessRunQueue,
  isLiveJobState,
  type Job,
} from "@cockpit-chess/queue";

const STALE_HEARTBEAT_MS = 300000;
const RECONCILE_BATCH = 50;
const TERMINAL_WRITE_ATTEMPTS = 3;
// Per worker process: advance past live queued jobs, then wrap to revisit them.
let queuedReconcileCursor: { id: string; heartbeatAt: Date } | undefined;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Error hosted matches that can no longer finish.
 *
 * Running rows: the claim holder refreshes `heartbeatAt` every 2s, so five
 * silent minutes means the worker died. Queued rows only carry the create-time
 * heartbeat, so age alone proves nothing (a match can wait behind a long one on
 * the concurrency-1 chess-run queue); they are errored only when their
 * deterministic BullMQ job is missing or terminal.
 *
 * Only the row status flips: get/inspect normalize a running archive snapshot
 * under an error row status, so the archive is not loaded or rewritten here.
 * Every write is a compare-and-set on (status, heartbeatAt), so a claim or
 * heartbeat that lands mid-sweep wins.
 */
export async function handleChessReconcileJob(job: Pick<Job<ChessReconcileJobData>, "data">) {
  chessReconcileJobSchema.parse(job.data);
  const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS);
  const select = { id: true, status: true, heartbeatAt: true } as const;
  const orderBy = [{ heartbeatAt: "asc" }, { id: "asc" }] as const;
  // Separate bounded scans: queued rows with live jobs are legitimately old and
  // must not crowd dead running rows out of the batch.
  const [running, queued] = await Promise.all([
    prisma.chessMatch.findMany({
      where: { status: "running", heartbeatAt: { lt: cutoff } },
      select,
      orderBy: [...orderBy],
      take: RECONCILE_BATCH,
    }),
    prisma.chessMatch.findMany({
      where: {
        status: "queued",
        heartbeatAt: { lt: cutoff },
        ...(queuedReconcileCursor
          ? {
              OR: [
                { heartbeatAt: { gt: queuedReconcileCursor.heartbeatAt } },
                {
                  heartbeatAt: queuedReconcileCursor.heartbeatAt,
                  id: { gt: queuedReconcileCursor.id },
                },
              ],
            }
          : {}),
      },
      select,
      orderBy: [...orderBy],
      take: RECONCILE_BATCH,
    }),
  ]);
  // Advance even if a row's Redis lookup or CAS fails. A short/empty page wraps
  // the next invocation; no invocation reads more than one page per status.
  const lastQueued = queued.at(-1);
  queuedReconcileCursor =
    queued.length === RECONCILE_BATCH && lastQueued?.heartbeatAt
      ? { id: lastQueued.id, heartbeatAt: lastQueued.heartbeatAt }
      : undefined;
  let errored = 0;
  for (const row of [...running, ...queued]) {
    try {
      if (row.status === "queued") {
        const queuedJob = await chessRunQueue.getJob(`chess-${row.id}`);
        const state = queuedJob ? await queuedJob.getState() : "missing";
        if (isLiveJobState(state)) continue;
      }
      const result = await prisma.chessMatch.updateMany({
        where: { id: row.id, status: row.status, heartbeatAt: row.heartbeatAt },
        data: { status: "error", runToken: null },
      });
      errored += result.count;
    } catch (error) {
      console.error("[chess-reconcile] Failed to reconcile match", {
        matchId: row.id,
        error: message(error),
      });
    }
  }
  return { scanned: running.length + queued.length, errored };
}

/** The row's status/runToken no longer match this run: it was stopped or reconciled. */
class MatchOwnershipEndedError extends Error {
  constructor() {
    super("Match ownership ended");
    this.name = "MatchOwnershipEndedError";
  }
}

/** No retries of inference after a crash: interrupted runs retain their replay and stay unrated. */
export async function handleChessRunJob(
  job: Pick<Job<ChessRunJobData>, "data">,
  signal?: AbortSignal,
) {
  const data = chessRunJobSchema.parse(job.data);
  const matchId = data.matchId;
  const runToken = crypto.randomUUID();
  const claimed = await prisma.chessMatch.updateMany({
    where: { id: matchId, status: "queued" },
    data: { status: "running", runToken, heartbeatAt: new Date() },
  });
  if (claimed.count !== 1) return;
  const row = await prisma.chessMatch.findUnique({
    where: { id: matchId },
    select: { archive: true },
  });
  if (!row) return;
  let match: MatchArchive;
  try {
    match = validateArchive(row.archive);
  } catch (error) {
    // Release the claim now instead of leaving the row `running` until the
    // stale-heartbeat reconcile. Status only: like reconcile, the unparseable
    // archive is left as-is (get/inspect normalize it under an error status).
    console.error("[chess-run] Stored archive failed validation", {
      matchId,
      error: message(error),
    });
    await prisma.chessMatch.updateMany({
      where: { id: matchId, status: "running", runToken },
      data: { status: "error", runToken: null },
    });
    return;
  }
  const controller = new AbortController();
  // All aborts at the hosted worker boundary are infrastructure interruptions.
  // Operator stops already own the terminal DB row and clear this run's claim.
  const abort = () => controller.abort(MATCH_INTERRUPTED);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let polling = false;
  let heartbeatErrors = 0;
  let ownershipEnded = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void prisma.chessMatch
      .updateMany({
        where: { id: matchId, status: "running", runToken },
        data: { heartbeatAt: new Date() },
      })
      .then((result) => {
        heartbeatErrors = 0;
        if (result.count !== 1) {
          ownershipEnded = true;
          abort();
        }
      })
      .catch(() => {
        heartbeatErrors += 1;
        if (heartbeatErrors >= 3) abort();
      })
      .finally(() => {
        polling = false;
      });
  }, 2000);
  let terminalPersisted = false;
  let terminalWriteAttempts = 0;
  // Last snapshot this run wrote. An unchanged running snapshot is not
  // rewritten — the heartbeat timer keeps `heartbeatAt` (and the ownership
  // check) fresh, so skipping costs nothing but a redundant multi-KB write.
  let lastWritten: string | undefined;
  async function persist(archive: MatchArchive) {
    if (ownershipEnded) throw new MatchOwnershipEndedError();
    if (terminalPersisted) return;
    const serialized = JSON.stringify(archive);
    if (archive.status === "running" && serialized === lastWritten) return;
    if (archive.status !== "running") terminalWriteAttempts += 1;
    const result = await prisma.chessMatch
      .updateMany({
        where: { id: matchId, status: "running", runToken },
        data: {
          archive,
          heartbeatAt: new Date(),
          ...(archive.status !== "running"
            ? { status: archive.status, runToken: null, ...chessStatsColumns(archive) }
            : {}),
        },
      })
      .catch((error: unknown) => {
        // Snapshot failures belong to our infrastructure, not the model provider.
        abort();
        throw error;
      });
    if (result.count !== 1) {
      ownershipEnded = true;
      abort();
      throw new MatchOwnershipEndedError();
    }
    lastWritten = serialized;
    if (archive.status !== "running") terminalPersisted = true;
  }
  try {
    const credentials: Partial<Record<"w" | "b", ProviderCredentials>> = {};
    const requiresModel = [match.config.white, match.config.black].some(
      (player) => player.protocol !== "random",
    );
    if (requiresModel) {
      if (!env.CHESS_HOSTED_ENABLED || !env.OPENROUTER_API_KEY)
        throw new Error("Hosted chess inference is disabled");
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw new Error("Model catalog unavailable");
      const catalog = (await response.json()) as {
        data?: Array<{
          id: string;
          supported_parameters?: string[];
          pricing?: { prompt?: string; completion?: string };
        }>;
      };
      for (const side of ["w", "b"] as const) {
        const player = side === "w" ? match.config.white : match.config.black;
        if (player.protocol === "random") continue;
        const item = catalog.data?.find((entry) => entry.id === player.model);
        const inputPrice = Number(item?.pricing?.prompt);
        const outputPrice = Number(item?.pricing?.completion);
        if (
          !item ||
          !Number.isFinite(inputPrice) ||
          !Number.isFinite(outputPrice) ||
          inputPrice < 0 ||
          outputPrice < 0
        )
          throw new Error("Model pricing unavailable");
        credentials[side] = {
          apiKey: env.OPENROUTER_API_KEY,
          baseUrl: "https://openrouter.ai/api/v1",
          anthropicAuth: "bearer",
          inputMicrosPerMillion: Math.ceil(inputPrice * 1e12),
          outputMicrosPerMillion: Math.ceil(outputPrice * 1e12),
        };
      }
    }
    // The claim token protects writes and cancellation. Reservations persist before dispatch.
    await runMatch(match, { credentials, signal: controller.signal, onUpdate: persist });
    if (match.status === "running") finishMatch(match, "*", "provider-error", "error");
    if (!terminalPersisted) await persist(match);
  } catch (error) {
    // Message only: never log credentials, prompts, or the error object itself.
    if (!ownershipEnded) {
      console.error("[chess-run] Match run ended with an error", {
        matchId,
        error: message(error),
      });
    }
    if (!ownershipEnded && match.status === "running") {
      if (controller.signal.aborted) finishAbortedMatch(match, controller.signal);
      else finishMatch(match, "*", "provider-error", "error");
    }
    // A finished game's result survives a failed write. Retry only persistence,
    // with the same claim; exhausted writes are left for stale-run reconciliation.
    while (
      !ownershipEnded &&
      !terminalPersisted &&
      terminalWriteAttempts < TERMINAL_WRITE_ATTEMPTS
    ) {
      if (terminalWriteAttempts > 0) await delay(50 * terminalWriteAttempts);
      try {
        await persist(match);
      } catch (persistError) {
        if (!ownershipEnded)
          console.error("[chess-run] Terminal snapshot write failed", {
            matchId,
            error: message(persistError),
          });
      }
    }
    if (ownershipEnded) {
      // The operator stop or reconcile owns the terminal row. Return no stale
      // in-memory outcome, which could disagree with the result already persisted.
      console.info("[chess-run] Match claim ended (stopped or reassigned); run aborted", {
        matchId,
      });
    }
    if (!terminalPersisted) return;
  } finally {
    clearInterval(timer);
    signal?.removeEventListener("abort", abort);
  }
  return { result: match.result, termination: match.termination, fen: boardAt(match).fen() };
}
