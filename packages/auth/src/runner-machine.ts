import { createHash, randomBytes } from "node:crypto";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { isAccountDeletionPending } from "./account-state.js";
import { isUserBanned } from "./ban.js";
import { lockCliCredentials, withCliCredentialLockSlot } from "./device-redemption-lock.js";
import { runnerMachineRevocationWrites } from "./runner-machine-revocation.js";
import {
  forcedTwoFactorSettingKeyForRole,
  isForcedTwoFactorEnabled,
  isTwoFactorRequirementSatisfied,
} from "./two-factor-policy.js";

export const RUNNER_MACHINE_TOKEN_PREFIX = "cockpit_chess_runner_";
export const RUNNER_MACHINE_SECRET_BYTES = 32;
export const RUNNER_MACHINE_DIGEST_DOMAIN = "cockpit-chess:runner-machine:v1\0";
export const RUNNER_MACHINE_MAX_ACTIVE = 25;
export const RUNNER_MACHINE_DEFAULT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export { RUNNER_MACHINE_REVOCATION_CHANNEL } from "./runner-machine-revocation.js";
export const RUNNER_MACHINE_DISPLAY_NAME_MAX_LENGTH = 100;

/** Disclosure boundary shared by inventory and mint; never select the digest. */
export const runnerMachinePublicSelect = {
  id: true,
  userId: true,
  displayName: true,
  credentialPrefix: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
  lastSeenAt: true,
  connectionGeneration: true,
} satisfies Prisma.RunnerMachineSelect;

export type RunnerMachinePublic = Prisma.RunnerMachineGetPayload<{
  select: typeof runnerMachinePublicSelect;
}>;
export type RunnerMachineSession = { userId: string; sessionId: string };
export type MintRunnerMachineInput = { displayName: string; expiresAt?: Date };
export type RunnerMachineTransaction = Pick<
  Prisma.TransactionClient,
  "$executeRaw" | "session" | "appSetting" | "runnerMachine"
>;

export class RunnerMachineSessionRevokedError extends Error {
  readonly code = "UNAUTHORIZED";
  constructor() {
    super("UNAUTHORIZED");
    this.name = "RunnerMachineSessionRevokedError";
  }
}

export class RunnerMachineLimitError extends Error {
  readonly code = "TOO_MANY_REQUESTS";
  constructor() {
    super("TOO_MANY_REQUESTS");
    this.name = "RunnerMachineLimitError";
  }
}

export class RunnerMachineForbiddenError extends Error {
  readonly code = "FORBIDDEN";
  constructor() {
    super("FORBIDDEN");
    this.name = "RunnerMachineForbiddenError";
  }
}

export class RunnerMachineInputError extends Error {
  readonly code = "BAD_REQUEST";
  constructor() {
    super("BAD_REQUEST");
    this.name = "RunnerMachineInputError";
  }
}

/** Canonical, purpose-specific encoding: exactly 32 random bytes as lower-case hex. */
export function parseRunnerMachineSecret(secret: string): string | null {
  if (
    secret.length !== RUNNER_MACHINE_TOKEN_PREFIX.length + RUNNER_MACHINE_SECRET_BYTES * 2 ||
    !secret.startsWith(RUNNER_MACHINE_TOKEN_PREFIX)
  ) {
    return null;
  }
  const entropy = secret.slice(RUNNER_MACHINE_TOKEN_PREFIX.length);
  return entropy.length === RUNNER_MACHINE_SECRET_BYTES * 2 && /^[0-9a-f]+$/.test(entropy)
    ? secret
    : null;
}

/** Invalid or other-purpose tokens never acquire a runner digest. */
export function digestRunnerMachineSecret(secret: string): string | null {
  if (!parseRunnerMachineSecret(secret)) return null;
  return createHash("sha256").update(RUNNER_MACHINE_DIGEST_DOMAIN).update(secret).digest("hex");
}

export async function requireRunnerMachineMintAuthority(
  tx: RunnerMachineTransaction,
  session: RunnerMachineSession,
) {
  const liveSession = await tx.session.findFirst({
    where: {
      id: session.sessionId,
      userId: session.userId,
      expiresAt: { gt: new Date() },
      origin: "sign-in",
      impersonatedBy: null,
    },
    select: {
      id: true,
      user: {
        select: {
          id: true,
          email: true,
          emailVerified: true,
          banned: true,
          deletionRequestedAt: true,
          banExpires: true,
          role: true,
          twoFactorEnabled: true,
          createdAt: true,
        },
      },
    },
  });
  if (!liveSession) throw new RunnerMachineSessionRevokedError();
  const user = liveSession.user;
  if (!user.emailVerified || isAccountDeletionPending(user) || isUserBanned(user))
    throw new RunnerMachineForbiddenError();
  const settingKey = forcedTwoFactorSettingKeyForRole(user.role);
  const setting = await tx.appSetting.findUnique({
    where: { key: settingKey },
    select: { value: true },
  });
  if (
    !isTwoFactorRequirementSatisfied(user, isForcedTwoFactorEnabled(settingKey, setting?.value))
  ) {
    throw new RunnerMachineForbiddenError();
  }
  return user;
}

/**
 * Internal enrollment for a live browser session; never expose as a general
 * CLI/API-key mint. Callers composing a claim must reserve a CLI lock slot
 * around their transaction and follow password-write → CLI → setup lock order.
 * Use ReadCommitted so post-lock reads see completed revocations. All authority
 * reads and the insert use THIS transaction, never the pool.
 */
export async function mintRunnerMachineInTransaction(
  tx: RunnerMachineTransaction,
  session: RunnerMachineSession,
  input: MintRunnerMachineInput,
  claimSecret?: string,
): Promise<{ machine: RunnerMachinePublic; secret: string }> {
  await lockCliCredentials(session.userId, tx);
  await requireRunnerMachineMintAuthority(tx, session);
  const now = new Date();
  const displayName = input.displayName.trim();
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + RUNNER_MACHINE_DEFAULT_LIFETIME_MS);
  if (
    !displayName ||
    displayName.length > RUNNER_MACHINE_DISPLAY_NAME_MAX_LENGTH ||
    /[\r\n]/.test(displayName) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= now.getTime()
  ) {
    throw new RunnerMachineInputError();
  }
  const active = await tx.runnerMachine.count({
    where: { userId: session.userId, revokedAt: null, expiresAt: { gt: now } },
  });
  if (!Number.isSafeInteger(active) || active < 0 || active >= RUNNER_MACHINE_MAX_ACTIVE)
    throw new RunnerMachineLimitError();

  const secret =
    claimSecret ??
    RUNNER_MACHINE_TOKEN_PREFIX + randomBytes(RUNNER_MACHINE_SECRET_BYTES).toString("hex");
  const credentialDigest = digestRunnerMachineSecret(secret);
  // A generated token always parses; do not allow a nullable digest into storage.
  if (!credentialDigest) throw new RunnerMachineInputError();
  const machine = await tx.runnerMachine.create({
    data: {
      userId: session.userId,
      displayName,
      credentialDigest,
      credentialPrefix: secret.slice(0, RUNNER_MACHINE_TOKEN_PREFIX.length + 8),
      expiresAt,
    },
    select: runnerMachinePublicSelect,
  });
  // Sign-out/session expiry can happen while the insert awaits storage. A
  // failed final check rolls the insert back instead of returning authority.
  await requireRunnerMachineMintAuthority(tx, session);
  if (expiresAt.getTime() <= Date.now()) throw new RunnerMachineInputError();
  return { machine, secret };
}

/** Production entry: bounded lock slot and one atomic transaction. */
export function mintRunnerMachineForSession(
  session: RunnerMachineSession,
  input: MintRunnerMachineInput,
): Promise<{ machine: RunnerMachinePublic; secret: string }> {
  return withCliCredentialLockSlot(() =>
    prisma.$transaction((tx) => mintRunnerMachineInTransaction(tx, session, input), {
      timeout: 30_000,
      isolationLevel: "ReadCommitted",
    }),
  );
}

/**
 * Caller already holds this user's CLI credential lock. PG delivers the
 * ID-only invalidation on commit; any notification failure rolls back revocation.
 * Repeated revocation never advances the generation of an already revoked row.
 */
export async function revokeRunnerMachinesInTransaction(
  tx: Pick<Prisma.TransactionClient, "runnerMachine" | "$executeRaw">,
  userId: string,
  machineId?: string,
): Promise<number> {
  // An accidentally empty scoped ID must never turn into a bulk reset.
  if (machineId === "") throw new RunnerMachineInputError();
  const [update, notification] = runnerMachineRevocationWrites(userId, tx, machineId);
  const { count } = await update;
  await notification;
  return count;
}
