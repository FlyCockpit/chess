import { isUserBanned } from "@cockpit-chess/auth/ban";
import {
  digestRunnerMachineSecret,
  runnerMachinePublicSelect,
} from "@cockpit-chess/auth/runner-machine";
import prisma, { type Prisma } from "@cockpit-chess/db";

const runnerCredentialSelect = {
  ...runnerMachinePublicSelect,
  User: { select: { id: true, emailVerified: true, banned: true, banExpires: true } },
} satisfies Prisma.RunnerMachineSelect;

/** Runner authority only: deliberately no Better-Auth Session or general role. */
export type RunnerMachineIdentity = {
  machineId: string;
  userId: string;
  connectionGeneration: number;
  expiresAt: Date;
};

/**
 * Runner-only bearer lookup. No cookies, device sessions or general API keys.
 * Re-run on each connection/action/heartbeat; a cached identity is not authority.
 * Unavailable storage fails closed without logging token-bearing query errors.
 * This helper is not mounted on any transport yet.
 */
export async function resolveRunnerMachineCredential(
  authorization: string | undefined,
): Promise<RunnerMachineIdentity | null> {
  const match = authorization && /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match?.[1] || match[0] !== authorization) return null;
  const credentialDigest = digestRunnerMachineSecret(match[1]);
  if (!credentialDigest) return null;
  try {
    const row = await prisma.runnerMachine.findUnique({
      where: { credentialDigest },
      select: runnerCredentialSelect,
    });
    if (
      !row ||
      row.revokedAt !== null ||
      row.expiresAt.getTime() <= Date.now() ||
      !row.User?.emailVerified ||
      isUserBanned(row.User)
    ) {
      return null;
    }
    return {
      machineId: row.id,
      userId: row.userId,
      connectionGeneration: row.connectionGeneration,
      expiresAt: row.expiresAt,
    };
  } catch {
    return null;
  }
}
