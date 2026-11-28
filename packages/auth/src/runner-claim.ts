import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { z } from "zod";
import { lockCliCredentials } from "./device-redemption-lock.js";
import { releaseSlots, tryAcquireSlots } from "./lock-slots.js";
import {
  digestRunnerMachineSecret,
  mintRunnerMachineInTransaction,
  RUNNER_MACHINE_MAX_ACTIVE,
  RUNNER_MACHINE_TOKEN_PREFIX,
  RunnerMachineInputError,
  RunnerMachineLimitError,
  type RunnerMachineSession,
  requireRunnerMachineMintAuthority,
} from "./runner-machine.js";

export const RUNNER_CLAIM_LIFETIME_MS = 10 * 60 * 1000;
export const RUNNER_CLAIM_MAX_ROWS = 1000;
export const RUNNER_CLAIM_CLEANUP_BATCH = 100;
export const RUNNER_CLAIM_POLL_INTERVAL_MS = 2000;
export const RUNNER_CLAIM_CONTROL_PATH = "/en-US/settings/cli" as const;
const entropySchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
export const runnerClaimTokenSchema = entropySchema;
export const runnerClaimBeginSchema = z.strictObject({ proof: entropySchema });
export const runnerClaimProofSchema = z.strictObject({
  claimId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  proof: entropySchema,
});
type ProofInput = z.infer<typeof runnerClaimProofSchema>;

const claimSelect = {
  id: true,
  proofDigest: true,
  expiresAt: true,
  userId: true,
  sessionId: true,
  machineId: true,
} satisfies Prisma.RunnerClaimSelect;
type Claim = Prisma.RunnerClaimGetPayload<{ select: typeof claimSelect }>;

export class RunnerClaimNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor() {
    super("NOT_FOUND");
    this.name = "RunnerClaimNotFoundError";
  }
}

function digest(purpose: "token" | "proof", secret: string): string {
  return createHash("sha256")
    .update(`cockpit-chess:runner-claim:${purpose}:v1\0`)
    .update(secret)
    .digest("hex");
}

function requireLiveClaim(claim: Claim | null): asserts claim is Claim {
  if (!claim || claim.expiresAt.getTime() <= Date.now()) throw new RunnerClaimNotFoundError();
}

function requireProof(claim: Claim | null, proof: string): asserts claim is Claim {
  requireLiveClaim(claim);
  const expected = Buffer.from(digest("proof", proof), "hex");
  const actual = Buffer.from(claim.proofDigest, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new RunnerClaimNotFoundError();
  }
}

/** The proof is a 256-bit CLI secret, not the URL token. Only its digest is stored.
 * Domain-separated HMAC recovers the same runner credential after a lost response
 * without storing plaintext/encrypted credentials or needing another signing key.
 */
function machineSecret(input: ProofInput): string {
  return (
    RUNNER_MACHINE_TOKEN_PREFIX +
    createHmac("sha256", Buffer.from(input.proof, "hex"))
      .update("cockpit-chess:runner-claim:machine:v1\0")
      .update(input.claimId)
      .digest("hex")
  );
}

function requireCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RunnerMachineLimitError();
  return value;
}

/** No unbounded local wait queue: overload refuses before pinning a DB connection.
 * Credential lock always precedes claim lock; begin's capacity lock never takes
 * credential locks. Reset never waits on a claim lock, preserving E1 lock order.
 */
type ClaimDatabase = {
  $transaction<T>(
    run: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { timeout: number; maxWait: number; isolationLevel: "ReadCommitted" },
  ): Promise<T>;
};

export function createRunnerClaimService(db: ClaimDatabase = prisma) {
  async function transaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (!tryAcquireSlots()) throw new RunnerMachineLimitError();
    try {
      return await db.$transaction(run, {
        timeout: 15_000,
        maxWait: 2000,
        isolationLevel: "ReadCommitted",
      });
    } finally {
      releaseSlots();
    }
  }

  async function lockClaim(tx: Prisma.TransactionClient, id: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`runner-claim:${id}`}))`;
  }

  async function originalAuthority(tx: Prisma.TransactionClient, claim: Claim) {
    if (!claim.userId || !claim.sessionId) throw new RunnerClaimNotFoundError();
    try {
      return await requireRunnerMachineMintAuthority(tx, {
        userId: claim.userId,
        sessionId: claim.sessionId,
      });
    } catch {
      // Original session/owner/2FA failures reveal no identity to a consumed link.
      throw new RunnerClaimNotFoundError();
    }
  }

  async function requireMachine(
    tx: Prisma.TransactionClient,
    claim: Claim,
    credentialDigest?: string,
  ) {
    if (!claim.machineId) throw new RunnerClaimNotFoundError();
    const machine = await tx.runnerMachine.findFirst({
      where: {
        id: claim.machineId,
        userId: claim.userId ?? "",
        revokedAt: null,
        expiresAt: { gt: new Date() },
        ...(credentialDigest ? { credentialDigest } : {}),
      },
      select: { id: true, expiresAt: true },
    });
    if (!machine) throw new RunnerClaimNotFoundError();
    return machine;
  }

  async function begin(input: z.infer<typeof runnerClaimBeginSchema>) {
    if (!runnerClaimBeginSchema.safeParse(input).success) throw new RunnerMachineInputError();
    const claimToken = randomBytes(32).toString("hex");
    return transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"runner-claim:capacity:v1"}))`;
      const now = new Date();
      const expired = await tx.runnerClaim.findMany({
        where: { expiresAt: { lte: now } },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        take: RUNNER_CLAIM_CLEANUP_BATCH,
        select: { id: true },
      });
      if (expired.length) {
        await tx.runnerClaim.deleteMany({
          where: { id: { in: expired.map((row) => row.id) }, expiresAt: { lte: now } },
        });
      }
      // Includes claimed/exchanged rows: neither abandoned approvals nor proof
      // recovery records can grow without bound. Cleanup never deletes machines.
      if (requireCount(await tx.runnerClaim.count()) >= RUNNER_CLAIM_MAX_ROWS)
        throw new RunnerMachineLimitError();
      const claim = await tx.runnerClaim.create({
        data: {
          tokenDigest: digest("token", claimToken),
          proofDigest: digest("proof", input.proof),
          expiresAt: new Date(now.getTime() + RUNNER_CLAIM_LIFETIME_MS),
        },
        select: { id: true, expiresAt: true },
      });
      return {
        claimId: claim.id,
        claimToken,
        expiresAt: claim.expiresAt.toISOString(),
        pollIntervalMs: RUNNER_CLAIM_POLL_INTERVAL_MS,
      };
    });
  }

  async function claim(session: RunnerMachineSession, token: string) {
    if (!runnerClaimTokenSchema.safeParse(token).success) throw new RunnerMachineInputError();
    return transaction(async (tx) => {
      await lockCliCredentials(session.userId, tx);
      await requireRunnerMachineMintAuthority(tx, session);
      const tokenDigest = digest("token", token);
      await lockClaim(tx, tokenDigest);
      const row = await tx.runnerClaim.findUnique({ where: { tokenDigest }, select: claimSelect });
      requireLiveClaim(row);
      if (row.userId) {
        if (row.userId !== session.userId) throw new RunnerClaimNotFoundError();
        await originalAuthority(tx, row);
        if (row.machineId) await requireMachine(tx, row);
      } else {
        const now = new Date();
        const active = requireCount(
          await tx.runnerMachine.count({
            where: { userId: session.userId, revokedAt: null, expiresAt: { gt: now } },
          }),
        );
        const reserved = requireCount(
          await tx.runnerClaim.count({
            where: { userId: session.userId, machineId: null, expiresAt: { gt: now } },
          }),
        );
        if (active + reserved >= RUNNER_MACHINE_MAX_ACTIVE) throw new RunnerMachineLimitError();
        const won = await tx.runnerClaim.updateMany({
          where: { id: row.id, userId: null, expiresAt: { gt: now } },
          data: { userId: session.userId, sessionId: session.sessionId, claimedAt: now },
        });
        if (won.count !== 1) throw new RunnerClaimNotFoundError();
      }
      await requireRunnerMachineMintAuthority(tx, session);
      requireLiveClaim(row);
      return { claimed: true as const };
    });
  }

  async function withProof<T>(
    input: ProofInput,
    run: (tx: Prisma.TransactionClient, row: Claim) => Promise<T>,
  ) {
    if (!runnerClaimProofSchema.safeParse(input).success) throw new RunnerMachineInputError();
    return transaction(async (tx) => {
      const first = await tx.runnerClaim.findUnique({
        where: { id: input.claimId },
        select: claimSelect,
      });
      requireProof(first, input.proof);
      if (!first.userId) return run(tx, first);
      await lockCliCredentials(first.userId, tx);
      // Browser claims lock by token digest. The owner credential lock serializes
      // all operations once claimed, so no second claim lock is needed here.
      const row = await tx.runnerClaim.findUnique({
        where: { id: input.claimId },
        select: claimSelect,
      });
      requireProof(row, input.proof);
      if (row.userId !== first.userId) throw new RunnerClaimNotFoundError();
      return run(tx, row);
    });
  }

  async function poll(input: ProofInput) {
    return withProof(input, async (tx, row) => {
      if (!row.userId) return { status: "pending" as const };
      if (row.machineId) await requireMachine(tx, row);
      const user = await originalAuthority(tx, row);
      requireLiveClaim(row);
      return {
        status: "claimed" as const,
        claimant: { email: user.email },
        controlPath: RUNNER_CLAIM_CONTROL_PATH,
      };
    });
  }

  async function exchange(input: ProofInput) {
    return withProof(input, async (tx, row) => {
      await originalAuthority(tx, row);
      const credential = machineSecret(input);
      const credentialDigest = digestRunnerMachineSecret(credential);
      if (!credentialDigest || !row.userId || !row.sessionId) throw new RunnerClaimNotFoundError();
      if (!row.machineId) {
        const minted = await mintRunnerMachineInTransaction(
          tx,
          { userId: row.userId, sessionId: row.sessionId },
          { displayName: "Chess runner" },
          credential,
        );
        const bound = await tx.runnerClaim.updateMany({
          where: {
            id: row.id,
            userId: row.userId,
            sessionId: row.sessionId,
            machineId: null,
            expiresAt: { gt: new Date() },
          },
          data: { machineId: minted.machine.id },
        });
        if (bound.count !== 1) throw new RunnerClaimNotFoundError();
        row.machineId = minted.machine.id;
      }
      const machine = await requireMachine(tx, row, credentialDigest);
      const user = await originalAuthority(tx, row);
      requireLiveClaim(row);
      return {
        machineId: machine.id,
        credential,
        expiresAt: machine.expiresAt.toISOString(),
        claimant: { email: user.email },
        controlPath: RUNNER_CLAIM_CONTROL_PATH,
      };
    });
  }

  return { begin, claim, poll, exchange };
}

export const runnerClaimService = createRunnerClaimService();
