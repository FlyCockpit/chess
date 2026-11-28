import { ownerActiveInTransaction } from "@cockpit-chess/auth/account-deletion";
import type { Prisma } from "@cockpit-chess/db";
import { ORPCError } from "@orpc/server";

/**
 * The advisory lock (`pg_advisory_xact_lock(hashtext(...))`) that serializes every
 * hosted match create with an OpenRouter Disconnect: a create that bills the caller's
 * own key re-checks the connection under it, so it either commits before Disconnect's
 * transaction (which then cancels it while queued) or finds no key and is refused.
 */
export const CHESS_CREATE_LOCK = "cockpit-chess:chess-create";
/**
 * Shared hosted admission seam. Call inside the transaction that inserts the queued
 * row, before inserting it. Keep model/human validation and the per-user procedure
 * budget at the caller; every hosted player type uses these same indexed counts.
 * Read Committed is intentional: a waiter must see the previous lock holder's insert.
 */
export async function admitHostedMatch(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; ownKey: boolean; queueMax: number; dailyMax: number },
) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${CHESS_CREATE_LOCK}))::text AS locked`;
  if (!(await ownerActiveInTransaction(tx, input.ownerId))) throw new ORPCError("UNAUTHORIZED");
  if (
    (await tx.chessMatch.count({ where: { source: "hosted", status: "queued" } })) >= input.queueMax
  )
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "The match queue is full",
      data: { reason: "queue-full" },
    });
  if (!input.ownKey) return;
  // Compute time after the lock wait: a key may expire while admission is queued.
  const now = new Date();
  const connected = await tx.openRouterConnection.findFirst({
    where: {
      userId: input.ownerId,
      status: "active",
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true },
  });
  if (!connected)
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Connect OpenRouter first",
      data: { reason: "not-connected" },
    });
  const active = await tx.chessMatch.count({
    where: {
      ownerId: input.ownerId,
      source: "hosted",
      credentialSource: "owner-openrouter",
      status: { in: ["queued", "running"] },
    },
  });
  if (active > 0)
    throw new ORPCError("CONFLICT", {
      message: "You already have a match queued or running",
      data: { reason: "active-match" },
    });
  const today = await tx.chessMatch.count({
    where: {
      ownerId: input.ownerId,
      source: "hosted",
      credentialSource: "owner-openrouter",
      createdAt: { gte: new Date(now.getTime() - 86_400_000) },
    },
  });
  if (today >= input.dailyMax)
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "Daily hosted match limit reached",
      data: { reason: "daily-limit" },
    });
}
