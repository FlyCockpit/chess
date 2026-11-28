import type { Prisma } from "@cockpit-chess/db";
import { z } from "zod";

// Worker-safe durable state only: no authentication instance, server environment
// validation or browser step-up dependencies may enter this module.
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const runnerLimitValuesSchema = z.strictObject({
  matchMicros: integer.min(1),
  dayMicros: integer.min(1),
  concurrency: integer.min(1).max(64),
});
export const runnerLimitOperatingSchema = runnerLimitValuesSchema.extend({ revision: integer });
export const runnerLimitCommandSchema = runnerLimitValuesSchema.extend({
  commandId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  expectedRevision: integer,
  revision: integer,
});
export const runnerLimitResultSchema = z.strictObject({
  commandId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  revision: integer,
  status: z.enum(["applied", "rejected"]),
  reason: z.enum(["applied", "ceiling", "stale", "stopped", "storage"]),
  operatingLimits: runnerLimitOperatingSchema,
  hardLimits: runnerLimitValuesSchema,
});
export type RunnerLimitsCommand = z.infer<typeof runnerLimitCommandSchema>;
export type RunnerLimitsResult = z.infer<typeof runnerLimitResultSchema>;
export type RunnerLimitsIdentity = {
  userId: string;
  machineId: string;
  connectionGeneration: number;
};
export const runnerLimitStateSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string().min(1).max(128),
  machineId: z.string().min(1).max(128),
  generation: integer,
  operatingLimits: runnerLimitOperatingSchema,
  hardLimits: runnerLimitValuesSchema,
  pending: runnerLimitCommandSchema.nullable(),
  lastResult: runnerLimitResultSchema.nullable(),
});
export type RunnerLimitState = z.infer<typeof runnerLimitStateSchema>;

export class RunnerLimitsError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "FORBIDDEN" | "BAD_REQUEST" | "SERVICE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "RunnerLimitsError";
  }
}
export const runnerLimitStateId = (id: string) => `runner-limits:v1:${id}`;

export const runnerLimitsWithin = (
  limit: z.infer<typeof runnerLimitValuesSchema>,
  hard: z.infer<typeof runnerLimitValuesSchema>,
) =>
  limit.matchMicros <= hard.matchMicros &&
  limit.dayMicros <= hard.dayMicros &&
  limit.concurrency <= hard.concurrency;

/** Caller holds the credential lock and separately validates live owner/machine authority. */
export async function readRunnerLimitsInTransaction(
  tx: Pick<Prisma.TransactionClient, "verification">,
  userId: string,
  machineId: string,
): Promise<RunnerLimitState | null> {
  const row = await tx.verification.findUnique({
    where: { id: runnerLimitStateId(machineId) },
    select: { value: true, expiresAt: true },
  });
  if (!row) return null;
  if (row.expiresAt <= new Date() || row.value.length > 8192)
    throw new RunnerLimitsError("SERVICE_UNAVAILABLE");
  try {
    const state = runnerLimitStateSchema.parse(JSON.parse(row.value));
    if (
      state.userId !== userId ||
      state.machineId !== machineId ||
      !runnerLimitsWithin(state.operatingLimits, state.hardLimits)
    )
      throw new Error();
    return state;
  } catch {
    throw new RunnerLimitsError("SERVICE_UNAVAILABLE");
  }
}
