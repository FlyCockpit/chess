import prisma, { type Prisma } from "@cockpit-chess/db";
import { DbNull } from "../../db/prisma/generated/internal/prismaNamespace";

/** IDs only. PostgreSQL delivers NOTIFY only after the enclosing commit. */
export const RUNNER_MACHINE_REVOCATION_CHANNEL = "runner_machine_revoked";

/**
 * Composable with the existing reset batch and activation transaction. The
 * caller holds the user's CLI-credential lock before any write executes.
 * Every replica must also recheck durable authority on connect/action/heartbeat;
 * a notification is a prompt to close a socket, never authority to keep it open.
 */
export function runnerMachineRevocationWrites(
  userId: string,
  db: Pick<Prisma.TransactionClient, "runnerMachine" | "chessMatch" | "$executeRaw"> = prisma,
  machineId?: string,
  { activeMatches = "cancel" }: { activeMatches?: "cancel" | "deletion-pending" } = {},
) {
  const update = db.runnerMachine.updateMany({
    where: { userId, ...(machineId ? { id: machineId } : {}), revokedAt: null },
    data: { revokedAt: new Date(), connectionGeneration: { increment: 1 } },
  });
  const notification = db.$executeRaw`SELECT pg_notify(${RUNNER_MACHINE_REVOCATION_CHANNEL}, ${JSON.stringify({ userId, ...(machineId ? { machineId } : {}) })})`;
  // Deletion commits its authority marker without touching hot match rows.
  // Do not even construct a match promise on that path: its outer cleanup owns
  // the terminal transition and outbox cancellation after the marker commits.
  const cancellations =
    activeMatches === "deletion-pending"
      ? []
      : ([true, false] as const).map((pending) =>
          db.chessMatch.updateMany({
            where: {
              ownerId: userId,
              source: "runner",
              ...(machineId ? { runnerMachineId: machineId } : {}),
              status: { in: ["queued", "running"] },
              Owner: { deletionRequestedAt: pending ? { not: null } : null },
            },
            data: {
              status: "stopped",
              runnerState: "stopped",
              runnerGeneration: null,
              runnerResumeDeadline: null,
              runnerRevision: { increment: 1 },
              runToken: null,
              heartbeatAt: null,
              turnType: "idle",
              turnId: null,
              turnSide: null,
              turnExpectedSeq: null,
              turnStartedAt: null,
              turnDeadline: null,
              pendingMove: DbNull,
              terminalCause: pending ? "owner-delete" : "runner-revoked",
              ending: { kind: "cancelled" },
            },
          }),
        );
  return [update, notification, ...cancellations] as const;
}
