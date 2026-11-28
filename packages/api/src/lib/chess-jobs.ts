import { ownerActiveInTransaction } from "@cockpit-chess/auth/account-deletion";
import { lockCliCredentials } from "@cockpit-chess/auth/device-redemption-lock";
import { withLockSlot } from "@cockpit-chess/auth/lock-slots";
import prisma, { type Prisma } from "@cockpit-chess/db";
import type { ChessSpectatorAccess } from "@cockpit-chess/queue";
import { spectatorAccessWhere } from "./chess-spectator-access";

/**
 * Publish only while deletion cannot pass its owner credential fence. The
 * initial owner lookup is never authority: re-read after taking the lock and
 * refuse any ownership change. Keep all queue mutation inside publish's
 * assertFresh boundary (publishRegisteredChessJob).
 */
export async function withChessJobPublication<T>(
  matchId: string,
  access: ChessSpectatorAccess | "run",
  publish: (assertFresh: () => void) => Promise<T>,
): Promise<T | undefined> {
  const initial = await prisma.chessMatch.findUnique({
    where: { id: matchId },
    select: { ownerId: true },
  });
  if (!initial) return;
  return withLockSlot(() =>
    prisma.$transaction(
      async (tx) => {
        const startedAt = Date.now();
        const startedMono = performance.now();
        const assertFresh = () => {
          if (Math.max(Date.now() - startedAt, performance.now() - startedMono) >= 120_000)
            throw new Error("Match job publication expired");
        };
        await tx.$executeRaw`SELECT set_config('statement_timeout', '20000ms', true)`;
        if (initial.ownerId !== null) {
          await lockCliCredentials(initial.ownerId, tx);
          if (!(await ownerActiveInTransaction(tx, initial.ownerId))) return;
        }
        const where: Prisma.ChessMatchWhereInput = {
          id: matchId,
          ownerId: initial.ownerId,
          ...(access === "run"
            ? { source: "hosted", status: "queued", ownerId: initial.ownerId ?? "" }
            : spectatorAccessWhere(access)),
        };
        const current = await tx.chessMatch.findFirst({
          where,
          select: { ownerId: true, slug: true },
        });
        if (!current || current.ownerId !== initial.ownerId) return;
        if (current.ownerId === null && !/^replay-[a-f0-9]{32}$/.test(current.slug)) return;
        assertFresh();
        return publish(assertFresh);
      },
      { isolationLevel: "ReadCommitted", timeout: 180_000, maxWait: 5000 },
    ),
  );
}
