import { deleteAccountVerifications } from "@cockpit-chess/auth/account-deletion-verifications";
import { lockCliCredentials } from "@cockpit-chess/auth/device-redemption-lock";
import { withLockSlot } from "@cockpit-chess/auth/lock-slots";
import { passwordWriteLockKey } from "@cockpit-chess/auth/password-write-lock";
import { lockSetPasswordLinks } from "@cockpit-chess/auth/set-password-link-lock";
import prisma, { Prisma } from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/shared";
import { redisConnection } from "@cockpit-chess/queue";
import { runnerDeletionLeasesBlocking } from "@cockpit-chess/queue/account-deletion";
import { purgeChessJobs } from "@cockpit-chess/queue/chess-job-registry";
import {
  chessKeyLeasesBlocking,
  forgetChessKeyRevocations,
} from "@cockpit-chess/queue/chess-key-revocation";
import { z } from "zod";
import { appendAccountDeletionSuppression } from "../../../../scripts/backup/account-deletion-suppression.mjs";
import { anonymizePublishedReplayBatch } from "./chess-anonymization";
import { CHESS_CREATE_LOCK } from "./chess-locks";
import { getCachedModelCatalog } from "./chess-models";
import { chessTurnColumns } from "./chess-turn";

const BATCH = 50;
// Longer than publication deadlines and every self-fencing transport/key lease.
// Also bounds short-lived proof writers already admitted before the tombstone.
const QUIET_MS = 180_000;
const progressSchema = z
  .object({
    phase: z.enum(["stopping", "matches", "verifications", "finalizing"]),
    afterId: z.string().min(1).max(200).nullable(),
  })
  .strict();

/** One current cursor format inside D2a's existing pending/cleaning lifecycle. */
function deletionProgress(user: { deletionState: string; deletionCursor: string | null }) {
  if (user.deletionState === "pending" && user.deletionCursor === null)
    return { phase: "pending", afterId: null } as const;
  if (user.deletionState !== "cleaning" || user.deletionCursor === null)
    throw new Error("Unsupported deletion phase");
  return progressSchema.parse(JSON.parse(user.deletionCursor));
}

type DeletingUser = {
  id: string;
  email: string;
  deletionRequestedAt: Date;
};
type CleanupEffects = {
  record(user: DeletingUser): Promise<void>;
  keyUseStopped(userId: string): Promise<boolean>;
  runnerUseStopped(machineIds: string[]): Promise<boolean>;
  purgeJobs(matchId: string): Promise<boolean>;
  retireKeyState(userId: string): Promise<void>;
};
const effects: CleanupEffects = {
  record: (user) =>
    appendAccountDeletionSuppression({
      directory: env.ACCOUNT_DELETION_REGISTER_DIR,
      userId: user.id,
      requestedAt: user.deletionRequestedAt,
    }),
  keyUseStopped: async (id) => !(await chessKeyLeasesBlocking(redisConnection, id, [], null)),
  runnerUseStopped: async (ids) => !(await runnerDeletionLeasesBlocking(redisConnection, ids)),
  purgeJobs: purgeChessJobs,
  retireKeyState: (id) => forgetChessKeyRevocations(redisConnection, id),
};

/**
 * One bounded crash-safe phase. Missing authority is a completed retry, never an
 * invitation to recreate it. External effects precede database progress; failures
 * roll progress back and retain the permanent access fence. No keys enter jobs.
 */
export async function cleanupAccountDeletion(
  userId: string,
  resources: CleanupEffects = effects,
): Promise<{ complete: boolean; phase: string }> {
  // Cleanup never starts external requests, including for runner-only owners.
  // A cold cache reduces retained labels to the existing neutral whitelist fallback.
  const safeModels = new Set(getCachedModelCatalog()?.models.map((model) => model.id) ?? []);
  return withLockSlot(() =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', '25000ms', true)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${passwordWriteLockKey(userId)}))`;
        await lockCliCredentials(userId, tx);
        await lockSetPasswordLinks(userId, tx);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${CHESS_CREATE_LOCK}))::text AS locked`;
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            deletionRequestedAt: true,
            deletionState: true,
            deletionCursor: true,
          },
        });
        if (!user) return { complete: true, phase: "complete" };
        if (!user.deletionRequestedAt) return { complete: false, phase: "active" };
        const progress = deletionProgress(user);
        // Fsync outside the DB snapshot, while a writer connection prevents a
        // guarded restore from racing the register's final read.
        await resources.record({ ...user, deletionRequestedAt: user.deletionRequestedAt });
        await tx.user.update({
          where: { id: userId },
          data: { deletionAttempts: { increment: 1 } },
          select: { id: true },
        });
        const advance = async (phase: string, cursor: string | null = null) => {
          await tx.user.update({
            where: { id: userId },
            data: {
              deletionState: phase === "pending" ? "pending" : "cleaning",
              deletionCursor:
                phase === "pending" ? null : JSON.stringify({ phase, afterId: cursor }),
            },
            select: { id: true },
          });
          return { complete: false, phase };
        };

        if (progress.phase === "pending") {
          // Recover a crash after D2a committed its independent authority fence.
          const active = await tx.chessMatch.findMany({
            where: { ownerId: userId, status: { in: ["queued", "running"] } },
            select: { id: true, source: true },
            orderBy: { id: "asc" },
            take: BATCH,
          });
          for (const row of active) {
            await tx.chessMatch.updateMany({
              where: { id: row.id, ownerId: userId, status: { in: ["queued", "running"] } },
              data: {
                status: "stopped",
                runToken: null,
                terminalCause: "owner-delete",
                ...chessTurnColumns({ type: "idle" }),
                pendingMove: Prisma.DbNull,
                ending: { kind: "cancelled" },
                ...(row.source === "runner"
                  ? {
                      runnerState: "stopped",
                      runnerGeneration: null,
                      runnerResumeDeadline: null,
                      runnerRevision: { increment: 1 },
                    }
                  : {}),
              },
            });
            await tx.runnerCommand.updateMany({
              where: { matchId: row.id, ackedAt: null, cancelledAt: null },
              data: { cancelledAt: new Date() },
            });
          }
          return advance(active.length === BATCH ? "pending" : "stopping");
        }

        if (progress.phase === "stopping") {
          if (Date.now() - user.deletionRequestedAt.getTime() < QUIET_MS)
            return { complete: false, phase: "stopping" };
          if (!(await resources.keyUseStopped(userId)))
            return { complete: false, phase: "stopping" };
          const machines = await tx.runnerMachine.findMany({
            where: { userId, ...(progress.afterId ? { id: { gt: progress.afterId } } : {}) },
            select: { id: true },
            orderBy: { id: "asc" },
            take: BATCH,
          });
          if (!(await resources.runnerUseStopped(machines.map((machine) => machine.id))))
            return { complete: false, phase: "stopping" };
          return machines.length === BATCH
            ? advance("stopping", machines.at(-1)?.id ?? null)
            : advance("matches");
        }

        if (progress.phase === "matches") {
          // Registry purging precedes both deletion and ownership detachment.
          const rows = await tx.chessMatch.findMany({
            where: { ownerId: userId },
            select: { id: true, published: true },
            orderBy: { id: "asc" },
            take: BATCH,
          });
          for (const row of rows) {
            if (!(await resources.purgeJobs(row.id))) return { complete: false, phase: "matches" };
            if (!row.published) {
              await tx.chessMatch.deleteMany({
                where: { id: row.id, ownerId: userId, published: false },
              });
            } else {
              // Durable offers duplicate original titles/names, including ACKed
              // offers. Clear all control/event data before detaching provenance.
              await tx.runnerCommand.deleteMany({ where: { matchId: row.id } });
              await tx.runnerEvent.deleteMany({ where: { matchId: row.id } });
            }
          }
          // The helper itself is keyset-bounded and clears ownership atomically
          // with its whitelist projection. Hidden published replays stay hidden.
          if (rows.some((row) => row.published))
            await anonymizePublishedReplayBatch(
              tx,
              userId,
              undefined,
              safeModels,
              rows.filter((row) => row.published).map((row) => row.id),
            );
          return advance(rows.length === BATCH ? "matches" : "verifications");
        }

        if (progress.phase === "verifications") {
          // Machines still exist here, including their pre-delete IDs.
          const deleted = await deleteAccountVerifications(tx, user);
          return advance(deleted === 100 ? "verifications" : "finalizing");
        }

        // A defensive inventory closes future FK/non-FK omissions and phase
        // redelivery. Do not let User's SetNull leave an unscrubbed archive.
        if (await tx.chessMatch.count({ where: { ownerId: userId } })) return advance("matches");
        if ((await deleteAccountVerifications(tx, user)) > 0) return advance("verifications");
        if (!(await resources.keyUseStopped(userId)))
          return { complete: false, phase: "finalizing" };
        await resources.retireKeyState(userId);
        await tx.user.delete({ where: { id: userId }, select: { id: true } });
        return { complete: true, phase: "complete" };
      },
      { isolationLevel: "ReadCommitted", timeout: 60_000 },
    ),
  );
}

let cursor: string | undefined;

/** Existing minute reconcile job retries indefinitely; one account cannot starve peers. */
export async function sweepAccountDeletions(signal?: AbortSignal) {
  const rows = await prisma.user.findMany({
    where: {
      deletionRequestedAt: { not: null },
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: 5,
  });
  cursor = rows.length === 5 ? rows.at(-1)?.id : undefined;
  for (const row of rows) {
    if (signal?.aborted) break;
    try {
      await cleanupAccountDeletion(row.id);
    } catch {
      // Do not log exception objects: DB/filesystem failures may include data.
      console.error("[account-deletion] Cleanup pending; next sweep retries", { userId: row.id });
    }
  }
}
