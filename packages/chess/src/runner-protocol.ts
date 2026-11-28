import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { validateFen } from "chess.js";
import { z } from "zod";
import { archiveSchema, Chess, MODEL_PROTOCOLS, matchConfigSchema } from "./index";
import { promptVersionSchema } from "./prompts";

export const RUNNER_PROTOCOL_VERSION = 1;
export const RUNNER_MAX_FRAME_BYTES = 65_536;
export const RUNNER_HEARTBEAT_MS = 25_000;
export const RUNNER_LIVENESS_MS = 60_000;
export const RUNNER_RESUME_GRACE_MS = 120_000;
export const RUNNER_MAX_BUFFERED_BYTES = 262_144;
/** Per-socket chess command credit, with headroom for liveness and limit replies. */
export const RUNNER_COMMAND_WINDOW = 4;
export const RUNNER_WS_PATH = "/api/cli/runner/ws";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = integer.min(1);
const protocol = z.enum(MODEL_PROTOCOLS);
const modelIdentifier = z
  .string()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/,
  );
const fen = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => validateFen(value).ok);
const uci = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
const hardLimits = {
  matchMicros: positiveInteger,
  dayMicros: positiveInteger,
  concurrency: positiveInteger.max(64),
};
const limits = {
  ...hardLimits,
  revision: integer,
};
export const runnerHardLimitsSchema = z.object(hardLimits).strict();
export const runnerOperatingLimitsSchema = z.object(limits).strict();
const command = { commandId: identifier };
export const runnerLimitUpdateSchema = z
  .object({ ...command, ...limits, expectedRevision: integer })
  .strict();
export const runnerLimitResultSchema = z
  .object({
    commandId: identifier,
    revision: integer,
    status: z.enum(["applied", "rejected"]),
    reason: z.enum(["applied", "ceiling", "stale", "stopped", "storage"]),
    operatingLimits: runnerOperatingLimitsSchema,
    hardLimits: runnerHardLimitsSchema,
  })
  .strict();
const nonce = z.object({ nonce: identifier }).strict();
const error = z
  .object({ code: z.enum(["INVALID", "UNAUTHORIZED", "STALE", "UNSUPPORTED", "BUSY"]) })
  .strict();
const ack = z.object(command).strict();
const envelope = {
  version: z.literal(RUNNER_PROTOCOL_VERSION),
  generation: integer,
  id: identifier,
  seq: positiveInteger,
  ack: integer,
};

function frame<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...envelope, type: z.literal(type), payload }).strict();
}
function matchFrame<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return frame(type, payload).extend({ matchId: identifier });
}

/** Current settings only. Fixed instructions are resolved locally, never accepted as text. */
export const runnerMatchConfigSchema = matchConfigSchema.extend({
  promptVersion: promptVersionSchema,
});
export type RunnerMatchConfig = z.infer<typeof runnerMatchConfigSchema>;

/** A schema-ordered canonical digest, shared by the website controller and local executor. */
export function runnerConfigDigest(input: RunnerMatchConfig): string {
  const config = runnerMatchConfigSchema.parse(input);
  config.initialFen = new Chess(config.initialFen).fen();
  if (config.rules.illegalPolicy === "forfeit") delete config.rules.illegalPolicy;
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export const runnerClientMessageSchema = z.discriminatedUnion("type", [
  frame(
    "hello",
    z
      .object({
        models: z.array(z.object({ id: modelIdentifier, protocol }).strict()).max(512),
        engine: z.boolean(),
        operatingLimits: runnerOperatingLimitsSchema,
        hardLimits: runnerHardLimitsSchema,
      })
      .strict(),
  ),
  frame("heartbeat", nonce),
  frame("pong", nonce),
  frame("limits-result", runnerLimitResultSchema),
  matchFrame("accept", ack),
  matchFrame(
    "reject",
    z.object({ ...command, reason: z.enum(["busy", "policy", "unsupported"]) }).strict(),
  ),
  matchFrame("move", z.object({ uci, ply: integer, fen }).strict()),
  matchFrame(
    "evaluation",
    z
      .object({
        ply: integer,
        fen,
        score: z.union([
          z.object({ cp: z.number().int().min(-100_000).max(100_000) }).strict(),
          z.object({ mate: z.number().int().min(-1000).max(1000) }).strict(),
        ]),
        nodes: positiveInteger.min(1000).max(100_000),
        purpose: z.enum(["player", "spectator"]),
      })
      .strict(),
  ),
  matchFrame("snapshot", z.object({ acceptedSeq: integer, fen, ply: integer }).strict()),
  matchFrame(
    "event",
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("started") }).strict(),
      z
        .object({
          kind: z.enum(["stopped", "completed", "interrupted"]),
          result: archiveSchema.shape.result,
          termination: archiveSchema.shape.termination,
        })
        .strict(),
    ]),
  ),
  frame("ack", ack),
  frame("error", error),
]);

export const runnerServerMessageSchema = z.discriminatedUnion("type", [
  frame(
    "welcome",
    z
      .object({
        heartbeatMs: z.literal(RUNNER_HEARTBEAT_MS),
        livenessMs: z.literal(RUNNER_LIVENESS_MS),
        resumeGraceMs: z.literal(RUNNER_RESUME_GRACE_MS),
      })
      .strict(),
  ),
  frame("heartbeat", nonce),
  frame("pong", nonce),
  // No endpoint, key, path, prompt text or executable action can enter the offer.
  matchFrame(
    "offer",
    z
      .object({
        ...command,
        configDigest: z.string().regex(/^[a-f0-9]{64}$/),
        config: runnerMatchConfigSchema,
      })
      .strict(),
  ),
  matchFrame("start", z.object({ ...command, expectedSeq: integer }).strict()),
  matchFrame("stop", ack),
  matchFrame("human-move", z.object({ ...command, uci, expectedSeq: integer }).strict()),
  matchFrame("resume", z.object({ ...command, acceptedSeq: integer, fen, ply: integer }).strict()),
  frame("limits", runnerLimitUpdateSchema),
  frame("ack", ack),
  frame("error", error),
]);

export type RunnerClientMessage = z.infer<typeof runnerClientMessageSchema>;
export type RunnerServerMessage = z.infer<typeof runnerServerMessageSchema>;
/** Typed, envelope-free delivery. Persisted command IDs survive socket replacement. */
export type RunnerDelivery = RunnerServerMessage extends infer Message
  ? Message extends RunnerServerMessage
    ? Omit<Message, "version" | "generation" | "id" | "seq" | "ack">
    : never
  : never;

function parseFrame<T>(input: string, schema: z.ZodType<T>): T {
  try {
    // Bound decoding work before JSON.parse; never expose Zod/JSON input in errors.
    if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > RUNNER_MAX_FRAME_BYTES)
      throw new Error();
    return schema.parse(JSON.parse(input));
  } catch {
    throw new Error("RUNNER_PROTOCOL_INVALID");
  }
}

export function parseRunnerClientFrame(input: string): RunnerClientMessage {
  return parseFrame(input, runnerClientMessageSchema);
}
export function parseRunnerServerFrame(input: string): RunnerServerMessage {
  return parseFrame(input, runnerServerMessageSchema);
}

/** Validate either direction before encoding; no arbitrary object serialization. */
export function serializeRunnerFrame(message: RunnerClientMessage | RunnerServerMessage): string {
  try {
    const parsed = z.union([runnerClientMessageSchema, runnerServerMessageSchema]).parse(message);
    const output = JSON.stringify(parsed);
    if (Buffer.byteLength(output, "utf8") > RUNNER_MAX_FRAME_BYTES) throw new Error();
    return output;
  } catch {
    throw new Error("RUNNER_PROTOCOL_INVALID");
  }
}
