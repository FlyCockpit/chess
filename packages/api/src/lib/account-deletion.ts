import { isUserBanned } from "@cockpit-chess/auth/ban";
import { revokeCredentialsInTransaction } from "@cockpit-chess/auth/credential-revocation";
import { lockCliCredentials } from "@cockpit-chess/auth/device-redemption-lock";
import { withLockSlot } from "@cockpit-chess/auth/lock-slots";
import { passwordWriteLockKey } from "@cockpit-chess/auth/password-write-lock";
import { hasRole } from "@cockpit-chess/auth/roles";
import { lockSetPasswordLinks } from "@cockpit-chess/auth/set-password-link-lock";
import prisma, { Prisma } from "@cockpit-chess/db";
import { env } from "@cockpit-chess/env/shared";
import { ORPCError } from "@orpc/server";
import {
  appendAccountDeletionSuppression,
  assertAccountDeletionRegisterAvailable,
} from "../../../../scripts/backup/account-deletion-suppression.mjs";
import { type AdminMutationActor, withAdminRemovalGuard } from "./admin-presence";
import { CHESS_CREATE_LOCK } from "./chess-locks";
import { forEachPage, keysetWhere } from "./pagination";
import { isTwoFactorPolicySatisfied } from "./two-factor-policy";

const REAUTH_AGE_MS = 5 * 60_000;
const TRANSACTION_TIMEOUT_MS = 30_000;
const SAFE_LOCK_MS = 25_000;
const DELETION_ATTEMPTS = 3;

export type DeletionStatus = {
  status: "pending";
  requestedAt: Date;
  phase: string;
  complete: false;
};

/** A new browser sign-in is recent proof for password and SSO accounts alike. */
async function assertRecentBrowserSession(
  tx: Prisma.TransactionClient,
  userId: string,
  sessionId: string,
  now: Date,
) {
  const session = await tx.session.findFirst({
    where: {
      id: sessionId,
      userId,
      origin: "sign-in",
      impersonatedBy: null,
      expiresAt: { gt: now },
      authenticatedAt: { gte: new Date(now.getTime() - REAUTH_AGE_MS), lte: now },
    },
    select: { id: true },
  });
  if (!session)
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Sign in again, then confirm account deletion within five minutes.",
      data: { reason: "REAUTH_REQUIRED" },
    });
}

/**
 * Accept a durable erasure request. This is an access fence, never completion.
 * D2b resumes the bounded physical cleanup from deletionState/deletionCursor.
 *
 * Acquire password -> CLI credentials -> setup -> admission BEFORE starting
 * the Serializable admin-removal snapshot. That short transaction commits the
 * marker and credential revocations without reading or writing hot match rows.
 * Settle matches on this ReadCommitted client afterwards: a crash still leaves
 * a durable pending fence and cannot roll access/spending authority back.
 */
export async function requestAccountDeletion(
  userId: string,
  authority: { kind: "self"; sessionId: string } | ({ kind: "admin" } & AdminMutationActor),
): Promise<DeletionStatus> {
  try {
    await assertAccountDeletionRegisterAvailable(env.ACCOUNT_DELETION_REGISTER_DIR);
  } catch {
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message:
        "Account deletion cannot be started right now. Contact the operator or try again later.",
      data: { reason: "DELETION_NOT_READY" },
    });
  }
  return withLockSlot(
    () => {
      const deadline = performance.now() + SAFE_LOCK_MS;
      return prisma.$transaction(
        async (locks) => {
          await locks.$executeRaw`SELECT set_config('statement_timeout', '25000ms', true)`;
          await locks.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${passwordWriteLockKey(userId)}))`;
          await lockCliCredentials(userId, locks);
          await lockSetPasswordLinks(userId, locks);
          await locks.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${CHESS_CREATE_LOCK}))::text AS locked`;
          // Only authority contention can invalidate the short snapshot. Hot
          // match writes are deliberately outside it. Retain the original bounded
          // retry/deadline and all locks until ReadCommitted settlement completes.
          for (let attempt = 1; ; attempt++) {
            try {
              const remaining = Math.floor(deadline - performance.now());
              if (remaining <= 0)
                throw new ORPCError("SERVICE_UNAVAILABLE", {
                  message: "Account security is still updating. Try again shortly.",
                });
              const accepted = await withAdminRemovalGuard<DeletionStatus>(
                userId,
                async (tx, target) => {
                  const user = await tx.user.findUniqueOrThrow({
                    where: { id: userId },
                    select: {
                      deletionRequestedAt: true,
                      deletionState: true,
                      role: true,
                      twoFactorEnabled: true,
                      createdAt: true,
                      banned: true,
                      banExpires: true,
                    },
                  });
                  if (user.deletionRequestedAt)
                    return {
                      status: "pending",
                      requestedAt: user.deletionRequestedAt,
                      phase: user.deletionState,
                      complete: false,
                    };
                  const now = new Date();
                  if (authority.kind === "self") {
                    if (isUserBanned(user)) throw new ORPCError("UNAUTHORIZED");
                    if (hasRole(target.role, "admin"))
                      throw new ORPCError("FORBIDDEN", {
                        message: "Transfer your administrator role before deleting your account.",
                        data: { reason: "ADMIN_TRANSFER_REQUIRED" },
                      });
                    await assertRecentBrowserSession(tx, userId, authority.sessionId, now);
                    // The route's policy snapshot predates the owner-lock wait.
                    // Read current policy on this authority transaction, not a
                    // cached/global client, before committing destructive intent.
                    if (!(await isTwoFactorPolicySatisfied(user, tx)))
                      throw new ORPCError("FORBIDDEN", {
                        message: "Two-factor authentication setup is required.",
                      });
                  }
                  await tx.user.update({
                    where: { id: userId },
                    data: { deletionRequestedAt: now, deletionState: "pending" },
                    select: { id: true },
                  });
                  // Match writes belong to the outer ReadCommitted transaction,
                  // never this authority snapshot. The pending marker is the
                  // durable refusal for every future credential/spend action;
                  // worker effect writes take our credential lock before checking it.
                  await revokeCredentialsInTransaction(tx, userId, {
                    activeMatches: "deletion-pending",
                  });
                  await tx.openRouterConnection.deleteMany({ where: { userId } });
                  return { status: "pending", requestedAt: now, phase: "pending", complete: false };
                },
                authority.kind === "admin" ? authority : { ...authority, userId },
                undefined,
                Math.min(20_000, remaining),
              );
              // Acceptance is not returned until its suppression is durable
              // outside database backups. An append failure cannot undo the
              // already committed access fence; a retry records the same intent.
              try {
                await appendAccountDeletionSuppression({
                  directory: env.ACCOUNT_DELETION_REGISTER_DIR,
                  userId,
                  requestedAt: accepted.requestedAt,
                });
              } catch {
                throw new ORPCError("SERVICE_UNAVAILABLE", {
                  message:
                    "Your account is blocked pending cleanup. Contact support or retry shortly.",
                  data: { reason: "CLEANUP_UNAVAILABLE" },
                });
              }
              // The fence and revocations are durable now. Finish the active
              // matches in ReadCommitted before releasing any lock or
              // answering. A failure leaves pending intent for safe cleanup retry.
              await locks.chessMatch.updateMany({
                where: {
                  ownerId: userId,
                  source: { not: "runner" },
                  status: { in: ["queued", "running"] },
                },
                data: {
                  status: "stopped",
                  runToken: null,
                  terminalCause: "owner-delete",
                  ending: { kind: "cancelled" },
                  turnType: "idle",
                  turnId: null,
                  turnSide: null,
                  turnExpectedSeq: null,
                  turnStartedAt: null,
                  turnDeadline: null,
                  pendingMove: Prisma.DbNull,
                },
              });
              // Runner state and its outbox share the terminal transition. A
              // bounded keyset scan preserves the existing per-match CAS and
              // cancels commands only for rows this request actually stopped.
              await forEachPage(
                ({ take, afterId }) =>
                  locks.chessMatch.findMany({
                    where: {
                      ownerId: userId,
                      source: "runner",
                      status: { in: ["queued", "running"] },
                      ...keysetWhere(afterId),
                    },
                    select: { id: true },
                    orderBy: { id: "asc" },
                    take,
                  }),
                50,
                async (rows) => {
                  for (const row of rows) {
                    const stopped = await locks.chessMatch.updateMany({
                      where: {
                        id: row.id,
                        ownerId: userId,
                        source: "runner",
                        status: { in: ["queued", "running"] },
                      },
                      data: {
                        status: "stopped",
                        runToken: null,
                        terminalCause: "owner-delete",
                        ending: { kind: "cancelled" },
                        turnType: "idle",
                        turnId: null,
                        turnSide: null,
                        turnExpectedSeq: null,
                        turnStartedAt: null,
                        turnDeadline: null,
                        pendingMove: Prisma.DbNull,
                        runnerState: "stopped",
                        runnerGeneration: null,
                        runnerResumeDeadline: null,
                        runnerRevision: { increment: 1 },
                      },
                    });
                    if (stopped.count === 1)
                      await locks.runnerCommand.updateMany({
                        where: { matchId: row.id, ackedAt: null, cancelledAt: null },
                        data: { cancelledAt: new Date() },
                      });
                  }
                },
              );
              return accepted;
            } catch (error) {
              if (
                attempt >= DELETION_ATTEMPTS ||
                !(error instanceof ORPCError) ||
                error.code !== "CONFLICT" ||
                typeof error.data !== "object" ||
                error.data === null ||
                !("reason" in error.data) ||
                error.data.reason !== "USER_CHANGE_CONFLICT"
              )
                throw error;
            }
          }
        },
        { timeout: TRANSACTION_TIMEOUT_MS, isolationLevel: "ReadCommitted" },
      );
    },
    { nested: 1 },
  );
}
