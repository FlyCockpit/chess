import { isUserBanned } from "@cockpit-chess/auth/ban";
import { revokeCredentialsInTransaction } from "@cockpit-chess/auth/credential-revocation";
import { lockCliCredentials } from "@cockpit-chess/auth/device-redemption-lock";
import { withLockSlot } from "@cockpit-chess/auth/lock-slots";
import { passwordWriteLockKey } from "@cockpit-chess/auth/password-write-lock";
import { hasRole } from "@cockpit-chess/auth/roles";
import { lockSetPasswordLinks } from "@cockpit-chess/auth/set-password-link-lock";
import prisma, { Prisma } from "@cockpit-chess/db";
import { ORPCError } from "@orpc/server";
import { type AdminMutationActor, withAdminRemovalGuard } from "./admin-presence";
import { CHESS_CREATE_LOCK } from "./chess-locks";

const REAUTH_AGE_MS = 5 * 60_000;
const TRANSACTION_TIMEOUT_MS = 30_000;
const SAFE_LOCK_MS = 25_000;

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
 * the Serializable admin-removal snapshot. A waiting Serializable transaction
 * would otherwise miss a credential or match committed by the previous holder.
 */
export async function requestAccountDeletion(
  userId: string,
  authority: { kind: "self"; sessionId: string } | ({ kind: "admin" } & AdminMutationActor),
): Promise<DeletionStatus> {
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
          const remaining = Math.floor(deadline - performance.now());
          if (remaining <= 0)
            throw new ORPCError("SERVICE_UNAVAILABLE", {
              message: "Account security is still updating. Try again shortly.",
            });
          return withAdminRemovalGuard(
            userId,
            async (tx, target) => {
              const user = await tx.user.findUniqueOrThrow({
                where: { id: userId },
                select: {
                  deletionRequestedAt: true,
                  deletionState: true,
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
              }
              await tx.user.update({
                where: { id: userId },
                data: { deletionRequestedAt: now, deletionState: "pending" },
                select: { id: true },
              });
              // Set deletion's cause before the generic reset revoker settles
              // anything: the official ledger's first terminal write is final.
              await tx.chessMatch.updateMany({
                where: { ownerId: userId, status: { in: ["queued", "running"] } },
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
              await revokeCredentialsInTransaction(tx, userId);
              await tx.openRouterConnection.deleteMany({ where: { userId } });
              return { status: "pending", requestedAt: now, phase: "pending", complete: false };
            },
            authority.kind === "admin" ? authority : { ...authority, userId },
            undefined,
            Math.min(20_000, remaining),
          );
        },
        { timeout: TRANSACTION_TIMEOUT_MS, isolationLevel: "ReadCommitted" },
      );
    },
    { nested: 1 },
  );
}
