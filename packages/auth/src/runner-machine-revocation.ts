import prisma, { type Prisma } from "@cockpit-chess/db";

/** IDs only. PostgreSQL delivers NOTIFY only after the enclosing commit. */
export const RUNNER_MACHINE_REVOCATION_CHANNEL = "runner_machine_revoked";

/**
 * Composable with the existing reset batch and activation transaction. The
 * caller holds the user's CLI-credential lock before either write executes.
 * Every replica must also recheck durable authority on connect/action/heartbeat;
 * a notification is a prompt to close a socket, never authority to keep it open.
 */
export function runnerMachineRevocationWrites(
  userId: string,
  db: Pick<Prisma.TransactionClient, "runnerMachine" | "$executeRaw"> = prisma,
  machineId?: string,
) {
  return [
    db.runnerMachine.updateMany({
      where: { userId, ...(machineId ? { id: machineId } : {}), revokedAt: null },
      data: { revokedAt: new Date(), connectionGeneration: { increment: 1 } },
    }),
    db.$executeRaw`SELECT pg_notify(${RUNNER_MACHINE_REVOCATION_CHANNEL}, ${JSON.stringify({ userId, ...(machineId ? { machineId } : {}) })})`,
  ] as const;
}
