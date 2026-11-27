import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  chessStatsColumns,
  chessUsageColumns,
  INTERRUPTED_ENDING,
} from "@cockpit-chess/api/lib/chess-stats";
import {
  loadOwnerOpenRouterKey,
  markOpenRouterKeyInvalid,
} from "@cockpit-chess/api/lib/provider-key";
import { isAdminRole } from "@cockpit-chess/auth/roles";
import {
  boardAt,
  catalogOutputLimits,
  finishMatch,
  type MatchArchive,
  validateArchive,
} from "@cockpit-chess/chess";
import {
  CREDENTIAL_REVOKED,
  finishAbortedMatch,
  MATCH_INTERRUPTED,
  type ProviderCredentials,
  runMatch,
} from "@cockpit-chess/chess/runner";
import { storedSpectatorEvaluations } from "@cockpit-chess/chess/spectator";
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
import { leaseOwnerKeyRun } from "../chess-key-revocations";
import { registerHeartbeat } from "./chess-heartbeat";
import {
  backfillSpectatorEvaluations,
  matchSpectatorFeed,
  settleSpectatorFeed,
} from "./chess-spectator";

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
 * heartbeat, so age alone proves nothing: a match can wait behind
 * CHESS_RUN_CONCURRENCY others on the chess-run queue. They are errored only when
 * their deterministic BullMQ job is missing or terminal.
 *
 * Only the row status flips: get/inspect normalize a running archive snapshot
 * under an error row status, so the archive is not loaded or rewritten here.
 * Every write is a compare-and-set on (status, heartbeatAt), so a claim or
 * heartbeat that lands mid-sweep wins.
 */
export async function handleChessReconcileJob(
  job: Pick<Job<ChessReconcileJobData>, "data">,
  signal?: AbortSignal,
) {
  const data = chessReconcileJobSchema.parse(job.data);
  if (data.reason === "spectator")
    return backfillSpectatorEvaluations(data.matchId, data.fromPly, signal);
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
        data: {
          status: "error",
          runToken: null,
          ending: INTERRUPTED_ENDING,
          terminalCause: row.status === "running" ? "worker-lost" : "queue-lost",
        },
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

/**
 * A hosted match that may not run as stored. Ends it unscored with `termination`
 * before any inference. Its message is fixed text, never provider or key data.
 */
class RunRefusedError extends Error {
  constructor(
    message: string,
    readonly termination: "credential-revoked" | "interrupted" | "provider-error",
  ) {
    super(message);
    this.name = "RunRefusedError";
  }
}

/** Same hash for the same snapshot: the last write is remembered without keeping its bytes. */
const snapshotDigest = (serialized: string) =>
  `${serialized.length}:${createHash("sha256").update(serialized).digest("base64")}`;

/** OpenRouter app attribution on hosted calls (users see "Cockpit Chess" in their activity). */
function attributionHeaders(): Record<string, string> {
  return {
    "X-OpenRouter-Title": "Cockpit Chess",
    ...(env.PUBLIC_APP_URL ? { "HTTP-Referer": env.PUBLIC_APP_URL } : {}),
  };
}

/**
 * The key that pays for a hosted match's players.
 *
 * - "operator": the server's OPENROUTER_API_KEY (admin matches only; `chess.create`
 *   never lets anyone else pick it).
 * - "owner-openrouter": the match owner's connected key, looked up by the row's
 *   `ownerId` (never by anything in the job) and opened with that owner's id as
 *   associated data. Never falls back to the operator key: no usable key ends the
 *   match "credential-revoked".
 *
 * If the operator turned user matches off (CHESS_USER_MATCHES_ENABLED=false) while a
 * non-admin's match was still queued, it ends "interrupted" without inference: the
 * server stopped it, not the user's key. Admins may keep using their own key while the
 * flag is off (they may connect one regardless), so their matches still run. A server
 * without CHESS_PROVIDER_KEY_SECRET cannot open any key; that is the operator's
 * configuration too, so it also ends "interrupted".
 */
async function playerKey(row: {
  ownerId: string;
  credentialSource: string;
  Owner: { role: string | null };
}): Promise<{ apiKey: string; ownerKey?: { userId: string; keyHash: string } }> {
  if (!env.CHESS_HOSTED_ENABLED)
    throw new RunRefusedError("Hosted chess inference is disabled", "interrupted");
  if (row.credentialSource === "operator") {
    // Re-check queued authority: demotion between create and claim must not spend
    // the operator's funds. Own-key matches never reach this branch.
    if (!isAdminRole(row.Owner.role ?? undefined))
      throw new RunRefusedError("Operator billing requires an admin owner", "interrupted");
    if (!env.OPENROUTER_API_KEY)
      throw new RunRefusedError("Hosted chess inference is disabled", "interrupted");
    return { apiKey: env.OPENROUTER_API_KEY };
  }
  if (row.credentialSource !== "owner-openrouter")
    throw new RunRefusedError("Unknown credential source", "interrupted");
  if (!env.CHESS_USER_MATCHES_ENABLED && !isAdminRole(row.Owner.role ?? undefined))
    throw new RunRefusedError("User matches are disabled", "interrupted");
  if (!env.CHESS_PROVIDER_KEY_SECRET)
    throw new RunRefusedError("Provider key secret is not configured", "interrupted");
  const loaded = await loadOwnerOpenRouterKey(row.ownerId);
  if (!loaded) throw new RunRefusedError("No usable OpenRouter connection", "credential-revoked");
  return { apiKey: loaded.apiKey, ownerKey: { userId: row.ownerId, keyHash: loaded.keyHash } };
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
    where: { id: matchId, status: "queued", source: "hosted" },
    data: { status: "running", runToken, heartbeatAt: new Date() },
  });
  if (claimed.count !== 1) return;
  const row = await prisma.chessMatch.findUnique({
    where: { id: matchId },
    select: {
      archive: true,
      source: true,
      spectatorEvaluations: true,
      ownerId: true,
      credentialSource: true,
      Owner: { select: { role: true } },
    },
  });
  if (!row) return;
  let match: MatchArchive;
  try {
    match = validateArchive(row.archive);
    if (row.source !== "hosted" || match.source !== "hosted")
      throw new Error("Only hosted archives may run in the hosted worker");
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
      data: {
        status: "error",
        runToken: null,
        ending: INTERRUPTED_ENDING,
        terminalCause: "archive-invalid",
      },
    });
    return;
  }
  const controller = new AbortController();
  // All aborts at the hosted worker boundary are infrastructure interruptions.
  // Operator stops already own the terminal DB row and clear this run's claim.
  const abort = () => controller.abort(MATCH_INTERRUPTED);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let ownershipEnded = false;
  let terminalPersisted = false;
  const revoke = () => controller.abort(CREDENTIAL_REVOKED);
  const heartbeat: Omit<Parameters<typeof registerHeartbeat>[0], "ownerKey"> & {
    ownerKey?: { userId: string; keyHash: string };
  } = {
    matchId,
    runToken,
    onLost: () => {
      // A terminal write ends the claim itself; only a foreign end aborts the run.
      if (terminalPersisted) return;
      ownershipEnded = true;
      abort();
    },
    onRevoked: revoke,
    onFailing: abort,
  };
  const leaveHeartbeat = registerHeartbeat(heartbeat);
  // Spectator evaluation of each committed position, in the background on its own
  // engine lane: it never delays a move, and a failure never touches the game.
  const spectatorStop = new AbortController();
  const spectators = matchSpectatorFeed(
    matchId,
    storedSpectatorEvaluations.parse(row.spectatorEvaluations),
    signal ? AbortSignal.any([signal, spectatorStop.signal]) : spectatorStop.signal,
  );
  let terminalWriteAttempts = 0;
  // Digest of the last snapshot this run wrote (not the snapshot itself: an archive
  // may be 2 MB, and hundreds of matches run at once). An unchanged running snapshot
  // is not rewritten — the shared heartbeat keeps `heartbeatAt` (and the ownership
  // check) fresh, so skipping costs nothing but a redundant multi-KB write.
  let lastWritten: string | undefined;
  async function persist(archive: MatchArchive) {
    if (ownershipEnded) throw new MatchOwnershipEndedError();
    if (terminalPersisted) return;
    const digest = snapshotDigest(JSON.stringify(archive));
    if (archive.status === "running" && digest === lastWritten) return;
    if (archive.status !== "running") terminalWriteAttempts += 1;
    const result = await prisma.chessMatch
      .updateMany({
        where: { id: matchId, status: "running", runToken },
        data: {
          archive,
          ...chessUsageColumns(archive),
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
    lastWritten = digest;
    if (archive.status !== "running") terminalPersisted = true;
    // Only the new moves are replayed here; the analysis runs in the background.
    spectators.update(archive);
  }
  let ownerKey: { userId: string; keyHash: string } | undefined;
  let keyLease: Awaited<ReturnType<typeof leaseOwnerKeyRun>> | undefined;
  // The run's own key, so a message that echoes it (a provider or SDK error) is
  // redacted before it reaches a log line.
  let runKey: string | undefined;
  const logged = (error: unknown) => {
    const text = message(error);
    return runKey ? text.replaceAll(runKey, "[redacted]") : text;
  };
  try {
    const credentials: Partial<Record<"w" | "b", ProviderCredentials>> = {};
    const requiresModel = [match.config.white, match.config.black].some(
      (player) => player.protocol !== "random",
    );
    // An own-key match passes the same gates whether or not a model plays: the user
    // matches switch, a usable connection, and the heartbeat's disconnect check (a
    // random-only match spends no inference but still holds a slot and the engine).
    const ownKeyMatch = row.credentialSource === "owner-openrouter";
    // An own-key run holds a key-use lease before it even loads the key, so a
    // Disconnect waits for it (chess-key-revocations.ts). No lease, no key.
    if (ownKeyMatch) {
      try {
        keyLease = await leaseOwnerKeyRun({
          matchId,
          userId: row.ownerId,
          revoke,
          fence: abort,
        });
      } catch {
        throw new RunRefusedError("Key-use lease unavailable", "interrupted");
      }
    }
    let key: Awaited<ReturnType<typeof playerKey>> | undefined;
    try {
      key = requiresModel || ownKeyMatch ? await playerKey(row) : undefined;
    } finally {
      // A Disconnect of this key aborts the run here (the signal is checked below and
      // by every provider request), before anything is sent with it.
      await keyLease?.loaded(key?.ownerKey?.keyHash ?? null);
    }
    if (key) {
      runKey = key.apiKey;
      if (key.ownerKey) {
        ownerKey = key.ownerKey;
        heartbeat.ownerKey = key.ownerKey;
      }
    }
    if (requiresModel && key) {
      const response = await fetch(`${env.OPENROUTER_ORIGIN}/api/v1/models`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw new Error("Model catalog unavailable");
      const catalog = (await response.json()) as {
        data?: Array<{
          id: string;
          supported_parameters?: string[];
          pricing?: { prompt?: string; completion?: string };
          context_length?: unknown;
          top_provider?: unknown;
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
          // In memory for this run only: never in the job, the archive, a log or an error.
          apiKey: key.apiKey,
          baseUrl: `${env.OPENROUTER_ORIGIN}/api/v1`,
          headers: attributionHeaders(),
          // The key-use lease, checked synchronously before every provider request.
          beforeDispatch: () => {
            controller.signal.throwIfAborted();
            leaveHeartbeat.assertUsable();
            keyLease?.assertUsable();
            controller.signal.throwIfAborted();
          },
          anthropicAuth: "bearer",
          inputMicrosPerMillion: Math.ceil(inputPrice * 1e12),
          outputMicrosPerMillion: Math.ceil(outputPrice * 1e12),
          // Each request may use the model's own maximum output (within its budgets).
          ...catalogOutputLimits(item),
        };
      }
    }
    // The claim token protects writes and cancellation. Reservations persist before dispatch.
    await runMatch(match, {
      credentials,
      signal: controller.signal,
      onUpdate: persist,
      conversationMaxBytes: env.CHESS_CONVERSATION_MAX_BYTES,
    });
    if (match.status === "running") finishMatch(match, "*", "provider-error", "error");
    if (!terminalPersisted) await persist(match);
  } catch (error) {
    // Message only: never log credentials, prompts, or the error object itself.
    if (!ownershipEnded) {
      console.error("[chess-run] Match run ended with an error", {
        matchId,
        error: logged(error),
      });
    }
    if (!ownershipEnded && match.status === "running") {
      if (controller.signal.aborted) finishAbortedMatch(match, controller.signal);
      else
        finishMatch(
          match,
          "*",
          error instanceof RunRefusedError ? error.termination : "provider-error",
          "error",
        );
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
            error: logged(persistError),
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
    keyLease?.finish();
    leaveHeartbeat();
    signal?.removeEventListener("abort", abort);
    // OpenRouter refused the owner's key (401), or the connection changed under the
    // run: ask the owner to reconnect. A compare-and-set on the key's hash, so a key
    // connected meanwhile is never touched.
    if (ownerKey && match.termination === "credential-revoked")
      await markOpenRouterKeyInvalid(ownerKey.userId, ownerKey.keyHash).catch(() => undefined);
  }
  // The result is already written. Give the last positions a short, bounded wait
  // (they were evaluated while the game was played); anything left goes to a backfill.
  await settleSpectatorFeed(matchId, spectators, spectatorStop);
  return { result: match.result, termination: match.termination, fen: boardAt(match).fen() };
}
