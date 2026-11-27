import { lockCliCredentials } from "@cockpit-chess/auth/device-redemption-lock";
import { withLockSlot } from "@cockpit-chess/auth/lock-slots";
import prisma from "@cockpit-chess/db";
import { type RunnerMachineIdentity, resolveRunnerMachineCredential } from "./runner-session.js";

/** D2a supplies the durable deletion fence. Errors must deny authority. */
export type RunnerOwnerActive = (userId: string) => Promise<boolean>;

export function createRunnerAuthority(isOwnerActive: RunnerOwnerActive) {
  return {
    async resolve(authorization: string): Promise<RunnerMachineIdentity | null> {
      const identity = await resolveRunnerMachineCredential(authorization);
      return identity && (await isOwnerActive(identity.userId)) ? identity : null;
    },
    async claim(authorization: string): Promise<RunnerMachineIdentity | null> {
      const deadline = performance.now() + 4000;
      const initial = await resolveRunnerMachineCredential(authorization);
      if (!initial) return null;
      return withLockSlot(
        () => {
          const remaining = Math.floor(deadline - performance.now());
          if (remaining < 2) return Promise.resolve(null);
          // maxWait and timeout are independent Prisma budgets. Their sum must
          // fit this attempt, rather than each receiving the full remainder.
          const maxWait = Math.min(500, Math.floor(remaining / 2));
          const timeout = remaining - maxWait;
          return prisma.$transaction(
            async (tx) => {
              const transactionDeadline = Math.min(deadline, performance.now() + timeout);
              const requireTime = () => {
                const ms = Math.floor(transactionDeadline - performance.now());
                if (ms <= 0) throw new Error("RUNNER_CLAIM_EXPIRED");
                return ms;
              };
              // Bound PostgreSQL work too: a Promise.race/Prisma timeout cannot
              // by itself cancel a driver query waiting on a database lock.
              await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${requireTime()}ms`}, true)`;
              await lockCliCredentials(initial.userId, tx);
              requireTime();
              const live = await resolveRunnerMachineCredential(authorization, tx);
              if (!live || !(await isOwnerActive(live.userId))) return null;
              requireTime();
              if (live.connectionGeneration >= 2_147_483_646) return null;
              await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${requireTime()}ms`}, true)`;
              requireTime();
              // A reset/revoke takes the same lock; it cannot be overwritten by a
              // late socket claim. Generation never comes from the remote peer.
              const claimed = await tx.runnerMachine.updateMany({
                where: {
                  id: live.machineId,
                  userId: live.userId,
                  revokedAt: null,
                  expiresAt: { gt: new Date() },
                  connectionGeneration: live.connectionGeneration,
                },
                data: { connectionGeneration: { increment: 1 }, lastSeenAt: new Date() },
              });
              // A late write must roll back; returning null would commit it.
              requireTime();
              if (claimed.count !== 1) return null;
              return { ...live, connectionGeneration: live.connectionGeneration + 1 };
            },
            { isolationLevel: "ReadCommitted", timeout, maxWait },
          );
        },
        { deadline },
      );
    },
    async ownsMatch(identity: RunnerMachineIdentity, matchId: string): Promise<boolean> {
      // E4 adds the runner-machine association and the authoritative match CAS.
      // E2 never executes/persists match commands; this is only a disclosure gate.
      return (
        (await prisma.chessMatch.findFirst({
          where: { id: matchId, ownerId: identity.userId, source: "runner" },
          select: { id: true },
        })) !== null
      );
    },
  };
}

export type RunnerAuthority = ReturnType<typeof createRunnerAuthority>;
