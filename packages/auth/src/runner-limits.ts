import { createHash, randomBytes, randomUUID } from "node:crypto";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { z } from "zod";
import { ownerActiveInTransaction } from "./account-deletion.js";
import { lockCliCredentials, withCliCredentialLockSlot } from "./device-redemption-lock.js";
import { type RunnerMachineSession, requireRunnerMachineMintAuthority } from "./runner-machine.js";
import {
  type RunnerStepUp,
  runnerStepUpSchema,
  verifyRunnerLimitStepUp,
} from "./runner-step-up.js";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const runnerLimitValuesSchema = z.strictObject({
  matchMicros: integer.min(1),
  dayMicros: integer.min(1),
  concurrency: integer.min(1).max(64),
});
const operatingSchema = runnerLimitValuesSchema.extend({ revision: integer });
const commandSchema = runnerLimitValuesSchema.extend({
  commandId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  expectedRevision: integer,
  revision: integer,
});
const resultSchema = z.strictObject({
  commandId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  revision: integer,
  status: z.enum(["applied", "rejected"]),
  reason: z.enum(["applied", "ceiling", "stale", "stopped", "storage"]),
  operatingLimits: operatingSchema,
  hardLimits: runnerLimitValuesSchema,
});
export type RunnerLimitsCommand = z.infer<typeof commandSchema>;
export type RunnerLimitsResult = z.infer<typeof resultSchema>;
export type RunnerLimitsIdentity = {
  userId: string;
  machineId: string;
  connectionGeneration: number;
};
const stateSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string().min(1).max(128),
  machineId: z.string().min(1).max(128),
  generation: integer,
  operatingLimits: operatingSchema,
  hardLimits: runnerLimitValuesSchema,
  pending: commandSchema.nullable(),
  lastResult: resultSchema.nullable(),
});
type State = z.infer<typeof stateSchema>;
const requestShape = {
  id: z.string().min(1).max(64),
  expectedRevision: integer,
  limits: runnerLimitValuesSchema,
};
export const runnerLimitsRequestSchema = z.strictObject(requestShape);
export const runnerLimitsProofRequestSchema = z.strictObject({
  ...requestShape,
  verification: runnerStepUpSchema,
});
export const runnerLimitsSetRequestSchema = z.strictObject({
  ...requestShape,
  proof: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
type Request = z.infer<typeof runnerLimitsRequestSchema>;
const proofSchema = z.strictObject({
  userId: z.string(),
  sessionId: z.string(),
  machineId: z.string(),
  generation: integer,
  expectedRevision: integer,
  limits: runnerLimitValuesSchema,
});
export class RunnerLimitsError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "FORBIDDEN" | "BAD_REQUEST" | "SERVICE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "RunnerLimitsError";
  }
}
export const RUNNER_LIMIT_PROOF_MS = 120_000;
const stateId = (id: string) => `runner-limits:v1:${id}`;
const proofId = (proof: string) =>
  `runner-limit-proof:v1:${createHash("sha256").update(proof).digest("hex")}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const values = (value: z.infer<typeof operatingSchema>) => ({
  matchMicros: value.matchMicros,
  dayMicros: value.dayMicros,
  concurrency: value.concurrency,
});
const within = (
  limit: z.infer<typeof runnerLimitValuesSchema>,
  hard: z.infer<typeof runnerLimitValuesSchema>,
) =>
  limit.matchMicros <= hard.matchMicros &&
  limit.dayMicros <= hard.dayMicros &&
  limit.concurrency <= hard.concurrency;
const raises = (
  limit: z.infer<typeof runnerLimitValuesSchema>,
  current: z.infer<typeof runnerLimitValuesSchema>,
) =>
  limit.matchMicros > current.matchMicros ||
  limit.dayMicros > current.dayMicros ||
  limit.concurrency > current.concurrency;

type Database = {
  $transaction<T>(
    run: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { timeout: number; maxWait: number; isolationLevel: "ReadCommitted" },
  ): Promise<T>;
};

/** All reads/writes share reset/revoke's lock, including real PG fixtures. */
export function createRunnerLimitsService(db: Database = prisma, verify = verifyRunnerLimitStepUp) {
  const transaction = <T>(userId: string, run: (tx: Prisma.TransactionClient) => Promise<T>) =>
    withCliCredentialLockSlot(() =>
      db.$transaction(
        async (tx) => {
          await lockCliCredentials(userId, tx);
          return run(tx);
        },
        { timeout: 15_000, maxWait: 2000, isolationLevel: "ReadCommitted" },
      ),
    );

  async function machine(
    tx: Prisma.TransactionClient,
    identity: { userId: string; machineId: string; connectionGeneration?: number },
  ) {
    const row = await tx.runnerMachine.findFirst({
      where: {
        id: identity.machineId,
        userId: identity.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        ...(identity.connectionGeneration === undefined
          ? {}
          : { connectionGeneration: identity.connectionGeneration }),
      },
      select: {
        id: true,
        userId: true,
        connectionGeneration: true,
        expiresAt: true,
        User: { select: { emailVerified: true } },
      },
    });
    if (!row?.User.emailVerified || !(await ownerActiveInTransaction(tx, identity.userId)))
      throw new RunnerLimitsError("NOT_FOUND");
    return row;
  }
  async function read(
    tx: Prisma.TransactionClient,
    userId: string,
    machineId: string,
  ): Promise<State | null> {
    const row = await tx.verification.findUnique({
      where: { id: stateId(machineId) },
      select: { value: true, expiresAt: true },
    });
    if (!row) return null;
    if (row.expiresAt <= new Date() || row.value.length > 8192)
      throw new RunnerLimitsError("SERVICE_UNAVAILABLE");
    try {
      const state = stateSchema.parse(JSON.parse(row.value));
      if (
        state.userId !== userId ||
        state.machineId !== machineId ||
        !within(state.operatingLimits, state.hardLimits)
      )
        throw new Error();
      return state;
    } catch {
      throw new RunnerLimitsError("SERVICE_UNAVAILABLE");
    }
  }
  async function write(tx: Prisma.TransactionClient, state: State, expiresAt: Date) {
    const id = stateId(state.machineId);
    const value = JSON.stringify(stateSchema.parse(state));
    await tx.verification.upsert({
      where: { id },
      create: { id, identifier: id, value, expiresAt },
      update: { value, expiresAt },
    });
  }
  async function methods(
    tx: Prisma.TransactionClient,
    userId: string,
    enabled: boolean | null | undefined,
  ) {
    const account = await tx.account.findFirst({
      where: { userId, providerId: "credential", password: { not: null } },
      select: { password: true },
    });
    const factor = enabled
      ? await tx.twoFactor.findUnique({ where: { userId }, select: { verified: true } })
      : null;
    return { password: !!account?.password, totp: !!factor?.verified };
  }
  const view = (state: State | null, availableMethods: { password: boolean; totp: boolean }) => ({
    available: state !== null,
    operatingLimits: state?.operatingLimits ?? null,
    hardLimits: state?.hardLimits ?? null,
    pending: state?.pending ?? null,
    lastResult: state?.lastResult ?? null,
    methods: availableMethods,
  });
  async function browser(tx: Prisma.TransactionClient, session: RunnerMachineSession, id: string) {
    const user = await requireRunnerMachineMintAuthority(tx, session);
    const row = await machine(tx, { userId: session.userId, machineId: id });
    const state = await read(tx, session.userId, id);
    return { row, state, user };
  }
  function requireRequest(state: State | null, request: Request) {
    if (!state) throw new RunnerLimitsError("CONFLICT");
    if (
      state.pending ||
      state.operatingLimits.revision !== request.expectedRevision ||
      request.expectedRevision >= Number.MAX_SAFE_INTEGER
    )
      throw new RunnerLimitsError("CONFLICT");
    if (!within(request.limits, state.hardLimits)) throw new RunnerLimitsError("BAD_REQUEST");
    return state;
  }

  return {
    get(session: RunnerMachineSession, id: string) {
      return transaction(session.userId, async (tx) => {
        const { state, user } = await browser(tx, session, id);
        return view(state, await methods(tx, session.userId, user.twoFactorEnabled));
      });
    },
    prove(session: RunnerMachineSession, raw: z.infer<typeof runnerLimitsProofRequestSchema>) {
      const input = runnerLimitsProofRequestSchema.parse(raw);
      return transaction(session.userId, async (tx) => {
        const { state: initial, row, user } = await browser(tx, session, input.id);
        const state = requireRequest(initial, input);
        if (!raises(input.limits, state.operatingLimits))
          throw new RunnerLimitsError("BAD_REQUEST");
        const availableMethods = await methods(tx, session.userId, user.twoFactorEnabled);
        const verification: RunnerStepUp = input.verification;
        if (!availableMethods[verification.method === "password" ? "password" : "totp"])
          return null;
        const account =
          verification.method === "password"
            ? await tx.account.findFirst({
                where: { userId: session.userId, providerId: "credential" },
                select: { password: true },
              })
            : null;
        const factor =
          verification.method === "totp"
            ? await tx.twoFactor.findUnique({
                where: { userId: session.userId },
                select: {
                  secret: true,
                  verified: true,
                  lockedUntil: true,
                  failedVerificationCount: true,
                },
              })
            : null;
        if (factor?.lockedUntil && factor.lockedUntil > new Date()) return null;
        const valid = await verify(verification, {
          password: account?.password,
          totpSecret: factor?.verified ? factor.secret : undefined,
        });
        // Sign-out and session expiry do not necessarily take this lock.
        await requireRunnerMachineMintAuthority(tx, session);
        if (!valid) {
          if (factor) {
            const count = factor.lockedUntil ? 1 : factor.failedVerificationCount + 1;
            await tx.twoFactor.update({
              where: { userId: session.userId },
              data: {
                failedVerificationCount: count,
                lockedUntil: count >= 5 ? new Date(Date.now() + 900_000) : null,
              },
            });
          }
          return null;
        }
        if (verification.method === "totp") {
          const usedId = `runner-limit-totp:v1:${createHash("sha256").update(session.userId).update("\0").update(verification.code).digest("hex")}`;
          const used = await tx.verification.findUnique({
            where: { id: usedId },
            select: { expiresAt: true },
          });
          if (used && used.expiresAt > new Date()) return null;
          const expiresAt = new Date(Date.now() + 90_000);
          await tx.verification.upsert({
            where: { id: usedId },
            create: { id: usedId, identifier: usedId, value: "used", expiresAt },
            update: { expiresAt },
          });
          await tx.twoFactor.update({
            where: { userId: session.userId },
            data: { failedVerificationCount: 0, lockedUntil: null },
          });
        }
        const proof = randomBytes(32).toString("hex");
        const id = proofId(proof);
        const expiresAt = new Date(Date.now() + RUNNER_LIMIT_PROOF_MS);
        const binding = {
          userId: session.userId,
          sessionId: session.sessionId,
          machineId: row.id,
          generation: row.connectionGeneration,
          expectedRevision: input.expectedRevision,
          limits: input.limits,
        };
        await tx.verification.create({
          data: { id, identifier: id, value: JSON.stringify(binding), expiresAt },
        });
        return { proof, expiresAt };
      });
    },
    set(session: RunnerMachineSession, raw: z.infer<typeof runnerLimitsSetRequestSchema>) {
      const input = runnerLimitsSetRequestSchema.parse(raw);
      return transaction(session.userId, async (tx) => {
        const { state: initial, row, user } = await browser(tx, session, input.id);
        const state = requireRequest(initial, input);
        if (raises(input.limits, state.operatingLimits)) {
          if (!input.proof) throw new RunnerLimitsError("FORBIDDEN");
          const id = proofId(input.proof);
          const proof = await tx.verification.findUnique({
            where: { id },
            select: { value: true, expiresAt: true },
          });
          let binding: z.infer<typeof proofSchema> | undefined;
          try {
            if (proof && proof.value.length < 2048)
              binding = proofSchema.parse(JSON.parse(proof.value));
          } catch {
            /* Refuse corrupt proof. */
          }
          const expected = {
            userId: session.userId,
            sessionId: session.sessionId,
            machineId: row.id,
            generation: row.connectionGeneration,
            expectedRevision: input.expectedRevision,
            limits: input.limits,
          };
          if (!proof || proof.expiresAt <= new Date() || !same(binding, expected))
            throw new RunnerLimitsError("FORBIDDEN");
          const consumed = await tx.verification.deleteMany({
            where: { id, expiresAt: { gt: new Date() }, value: proof.value },
          });
          if (consumed.count !== 1) throw new RunnerLimitsError("FORBIDDEN");
        }
        const command: RunnerLimitsCommand = {
          commandId: randomUUID(),
          expectedRevision: input.expectedRevision,
          revision: input.expectedRevision + 1,
          ...input.limits,
        };
        const next = { ...state, pending: command };
        await write(tx, next, row.expiresAt);
        await requireRunnerMachineMintAuthority(tx, session);
        return view(next, await methods(tx, session.userId, user.twoFactorEnabled));
      });
    },
    hello(
      identity: RunnerLimitsIdentity,
      raw: {
        operatingLimits: z.infer<typeof operatingSchema>;
        hardLimits: z.infer<typeof runnerLimitValuesSchema>;
      },
    ) {
      const input = z
        .strictObject({ operatingLimits: operatingSchema, hardLimits: runnerLimitValuesSchema })
        .parse(raw);
      return transaction(identity.userId, async (tx) => {
        const row = await machine(tx, identity);
        if (!within(input.operatingLimits, input.hardLimits))
          throw new RunnerLimitsError("BAD_REQUEST");
        const previous = await read(tx, identity.userId, identity.machineId);
        if (
          previous &&
          !same(previous.operatingLimits, input.operatingLimits) &&
          !(
            previous.pending &&
            same(input.operatingLimits, {
              ...values(previous.pending),
              revision: previous.pending.revision,
            })
          )
        )
          throw new RunnerLimitsError("CONFLICT");
        const state: State = {
          version: 1,
          userId: identity.userId,
          machineId: identity.machineId,
          generation: identity.connectionGeneration,
          ...input,
          pending: previous?.pending ?? null,
          lastResult: previous?.lastResult ?? null,
        };
        await write(tx, state, row.expiresAt);
        return state.pending;
      });
    },
    pending(identity: RunnerLimitsIdentity) {
      return transaction(identity.userId, async (tx) => {
        await machine(tx, identity);
        const state = await read(tx, identity.userId, identity.machineId);
        return state?.pending ?? null;
      });
    },
    result(identity: RunnerLimitsIdentity, raw: RunnerLimitsResult) {
      const result = resultSchema.parse(raw);
      return transaction(identity.userId, async (tx) => {
        const row = await machine(tx, identity);
        const state = await read(tx, identity.userId, identity.machineId);
        const pending = state?.pending;
        if (
          !state ||
          !pending ||
          pending.commandId !== result.commandId ||
          pending.revision !== result.revision
        )
          return false;
        if (
          !within(result.operatingLimits, result.hardLimits) ||
          !same(result.hardLimits, state.hardLimits)
        )
          throw new RunnerLimitsError("BAD_REQUEST");
        if (result.status === "applied") {
          if (
            result.reason !== "applied" ||
            !same(result.operatingLimits, { ...values(pending), revision: pending.revision })
          )
            throw new RunnerLimitsError("BAD_REQUEST");
        } else if (
          result.reason === "applied" ||
          result.operatingLimits.revision > pending.revision ||
          result.operatingLimits.revision < pending.expectedRevision
        )
          throw new RunnerLimitsError("BAD_REQUEST");
        await write(
          tx,
          { ...state, operatingLimits: result.operatingLimits, pending: null, lastResult: result },
          row.expiresAt,
        );
        return true;
      });
    },
  };
}
export const runnerLimitsService = createRunnerLimitsService();
