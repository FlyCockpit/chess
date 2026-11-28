import type IORedis from "ioredis";

/** Shared with the transport store: never delete a live lease to simulate a stop. */
export const runnerMachineLeaseKey = (machineId: string) => `runner:ws:lease:${machineId}`;
export const RUNNER_DELETION_LEASE_MS = 60_000;

/** A restarted store cannot prove that a former replica's sockets have stopped. */
export async function runnerDeletionLeasesBlocking(
  connection: Pick<IORedis, "multi">,
  machineIds: readonly string[],
): Promise<boolean> {
  if (machineIds.length > 50) throw new Error("Deletion lease page is too large");
  const multi = connection.multi();
  multi.info("server");
  for (const id of machineIds) multi.exists(runnerMachineLeaseKey(id));
  const results = await multi.exec();
  if (!results || results.some(([error]) => error))
    throw new Error("Runner termination cannot be confirmed");
  const info = results[0]?.[1];
  const uptime = typeof info === "string" ? /^uptime_in_seconds:(\d+)/m.exec(info)?.[1] : undefined;
  if (uptime === undefined || Number(uptime) * 1000 < RUNNER_DELETION_LEASE_MS)
    throw new Error("Runner lease store restarted recently");
  return results.slice(1).some(([, value]) => value !== 0);
}
