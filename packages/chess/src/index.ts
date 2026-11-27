import { Chess, DEFAULT_POSITION, type Square } from "chess.js";
import { z } from "zod";
import { assertPinnedPrompt, pinnedPromptSchema, pinPrompt, promptVersionSchema } from "./prompts";
import { turnStateSchema } from "./turn";

export type { Color, PieceSymbol, Square } from "chess.js";
export { Chess, DEFAULT_POSITION } from "chess.js";
export type { ActiveTurn, TurnExpectation, TurnState } from "./turn";
export {
  acceptHumanMove,
  beginTurn,
  clearTurn,
  expectTurn,
  MAX_TURN_MS,
  pendingHumanMoveSchema,
  turnStateSchema,
} from "./turn";

/** True when chess.js can load the position, so `new Chess(fen)` will not throw later. */
function isLoadableFen(fen: string): boolean {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

/** The wire protocols a hosted model is reached on (all through OpenRouter). */
export const MODEL_PROTOCOLS = ["openai-chat", "openai-responses", "anthropic"] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];
/**
 * The wire protocol a model speaks unless the operator overrides it: Anthropic
 * models (`anthropic/…`, or a `~anthropic/…` alias) use Anthropic Messages, and
 * every other model uses OpenAI Chat Completions, which OpenRouter serves for
 * all of them. The one derivation shared by the server's model catalog and the
 * create form (which also needs it for a typed model id).
 */
export function protocolForModel(model: string): ModelProtocol {
  return /^~?anthropic\//.test(model.trim()) ? "anthropic" : "openai-chat";
}
/**
 * The output ceiling of a request when the model's catalog lists no maximum: widely
 * supported, and room for hidden reasoning, which many providers count against it.
 */
export const FALLBACK_MAX_OUTPUT_TOKENS = 8192;
/**
 * A model's output limits as an OpenRouter catalog entry lists them (`GET /models`):
 * its own maximum output per reply (`top_provider.max_completion_tokens`) and its
 * context window, each null when missing or not a positive number. The runner sends
 * each request the model's maximum (within the context and the side's budgets).
 */
export function catalogOutputLimits(entry: unknown): {
  maxOutputTokens: number | null;
  contextLength: number | null;
} {
  const positive = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const item = record(entry);
  return {
    maxOutputTokens: positive(record(item.top_provider).max_completion_tokens),
    contextLength: positive(item.context_length),
  };
}
export const playerSchema = z
  .object({
    name: z.string().min(1).max(80),
    model: z.string().min(1).max(160),
    protocol: z.enum([...MODEL_PROTOCOLS, "random", "human"]),
  })
  .strict();
/**
 * The schema ceilings of a side's budgets ($1,000 and 100M tokens). A server's own
 * operator limits (`CHESS_MAX_COST_USD`, `CHESS_MAX_TOKENS`) sit at or below these.
 */
export const MAX_COST_BUDGET_MICROS = 1_000_000_000;
export const MAX_TOKEN_BUDGET = 100_000_000;
/**
 * What a rejected attempt costs a side: "forfeit" loses the game after `maxAttempts`
 * rejections on one turn; "retry" never forfeits, so the side keeps trying until it
 * submits a legal move or its budgets, clock or per-move limit end the game.
 */
export const illegalPolicies = ["forfeit", "retry"] as const;
export type IllegalPolicy = (typeof illegalPolicies)[number];
const sharedRules = {
  context: z.enum(["fresh", "persistent"]).default("fresh"),
  opponentIdentity: z.enum(["hidden", "disclosed"]).default("hidden"),
  representation: z.enum(["fen", "ascii", "pieces"]).default("ascii"),
  legalMoves: z.enum(["hidden", "tool", "provided"]).default("tool"),
  /** "lenient" also extracts a JSON reply embedded in prose and converts legal SAN to UCI. */
  moveFormat: z.enum(["strict", "lenient"]).default("strict"),
  tokenAccounting: z.enum(["provider", "cl100k_base"]).default("provider"),
  engineEvaluation: z.enum(["off", "tool", "after-move", "both"]).default("off"),
  engineNodes: z.number().int().min(1000).max(100000).default(10000),
  engineCallsPerTurn: z.number().int().min(1).max(8).default(2),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  /** Per-move safety limit; never longer than either side's clock. */
  turnTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
  maxDispatches: z.number().int().min(1).max(12).default(6),
  tokenBudget: z.number().int().min(256).max(MAX_TOKEN_BUDGET).default(1000000),
  costBudgetMicros: z.number().int().min(100).max(MAX_COST_BUDGET_MICROS).default(1000000),
};
/** Bounds of one side's clock (also the form's limits): 30 s to 60 min. */
export const CLOCK_MIN_MS = 30_000;
export const CLOCK_MAX_MS = 3_600_000;
const clockMs = z.number().int().min(CLOCK_MIN_MS).max(CLOCK_MAX_MS);
export const remarkTones = ["off", "commentary", "trash-talk"] as const;
export type RemarkTone = (typeof remarkTones)[number];
/** Bounds of the optional reply cap (`maxOutputTokens`) a cockpit-v1 ruleset may set. */
export const REPLY_CAP_MIN = 64;
export const REPLY_CAP_MAX = 131_072;
/**
 * cockpit-v1: no move cap (the rules engine's own draws, the archive limit and the
 * spend budgets end every game), a remark tone, an optional per-side clock
 * (null = untimed: only the per-move safety limit applies) and no fixed reply cap:
 * each request may use the model's own maximum output, limited by what the side's
 * budgets can still pay for, unless the optional `maxOutputTokens` caps it lower.
 * A reply cut off at that limit is rejected as `truncated`.
 * See README.md § Rules and endings
 */
export const RULES_VERSION = "cockpit-v1";
export const rulesSchema = z
  .object({
    version: z.literal(RULES_VERSION).default(RULES_VERSION),
    ...sharedRules,
    /** Optional reply cap in tokens, for experiments; absent = no rules cap. */
    maxOutputTokens: z.number().int().min(REPLY_CAP_MIN).max(REPLY_CAP_MAX).optional(),
    remarks: z.enum(remarkTones).default("off"),
    clock: z.object({ w: clockMs, b: clockMs }).strict().nullable().default(null),
    /**
     * Absent means "forfeit"; `createMatch` records only "retry" so the default has one rules key.
     */
    illegalPolicy: z.enum(illegalPolicies).optional(),
  })
  .strict()
  .refine(
    (rules) => !rules.clock || rules.turnTimeoutMs <= Math.min(rules.clock.w, rules.clock.b),
    {
      message: "The per-move limit cannot be longer than a side's clock",
      path: ["turnTimeoutMs"],
    },
  );
/** Whether a stored row cannot be replayed by this build. */
export function isOldRulesVersion(version: string | null | undefined): boolean {
  return version !== RULES_VERSION;
}
/** The reply cap a ruleset sets in tokens, or null when it sets none (the default). */
export function replyCap(rules: Rules): number | null {
  return rules.maxOutputTokens ?? null;
}
/** What repeated illegal moves do under a ruleset. */
export function illegalPolicy(rules: Rules): IllegalPolicy {
  return rules.illegalPolicy ?? "forfeit";
}
/** Whether this many rejected attempts on one turn forfeit the game. */
export function forfeitsAfter(rules: Rules, rejectedThisTurn: number) {
  return illegalPolicy(rules) === "forfeit" && rejectedThisTurn >= rules.maxAttempts;
}
/** One side's whole-game clock in ms, or null when the game is untimed. */
export function sideClockMs(rules: Rules, side: Side): number | null {
  return rules.clock?.[side] ?? null;
}
const configFields = {
  title: z.string().min(1).max(140).default("Agent showdown"),
  white: playerSchema,
  black: playerSchema,
  initialFen: z
    .string()
    .max(160)
    .refine(isLoadableFen, { message: "Invalid FEN" })
    .default(DEFAULT_POSITION),
};
/** A new match's configuration (current ruleset only). */
export const matchConfigSchema = z
  .object({ ...configFields, rules: rulesSchema, promptVersion: promptVersionSchema.optional() })
  .strict();
/** A recorded match's configuration under the current ruleset. */
export const archivedConfigSchema = z
  .object({ ...configFields, rules: rulesSchema, prompt: pinnedPromptSchema })
  .strict()
  .superRefine((config, context) => {
    try {
      assertPinnedPrompt(config);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Unsupported prompt bundle/archive",
        path: ["prompt"],
      });
    }
  });
export type Player = z.infer<typeof playerSchema>;
export type MatchConfig = z.infer<typeof matchConfigSchema>;
export type ArchivedConfig = z.infer<typeof archivedConfigSchema>;
export type Rules = z.infer<typeof rulesSchema>;
export type Side = "w" | "b";

const eventBase = {
  seq: z.number().int().nonnegative(),
  at: z.string().datetime(),
  side: z.enum(["w", "b"]),
  ply: z.number().int().nonnegative(),
};
export const evaluationSchema = z
  .object({
    engine: z.literal("stockfish-19-lite-single"),
    fen: z.string().max(160),
    depth: z.number().int().nonnegative(),
    nodes: z.number().int().nonnegative(),
    cp: z.number().int().nullable(),
    mate: z.number().int().nullable(),
    bestMove: z
      .string()
      .regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/)
      .nullable(),
  })
  .strict();
export type EngineEvaluation = z.infer<typeof evaluationSchema>;
/**
 * Why an attempt was rejected: `illegal` (a well-formed UCI move the position does not
 * allow), `unparseable` (a finished reply that names no move) or `truncated` (the
 * reply was cut off at its output limit before it gave a move: "ran out of space").
 */
export const attemptReasons = ["illegal", "unparseable", "truncated"] as const;
export type AttemptReason = (typeof attemptReasons)[number];
/** How a model's reply ended: finished, cut off at its output limit, or out of tool rounds. */
export const replyStopReasons = ["completed", "output-truncated", "max-iterations"] as const;
export type ReplyStopReason = (typeof replyStopReasons)[number];
/** The bound of a recorded rejected reply, in UTF-8 bytes of its JSON string body. */
export const MAX_REPLY_BYTES = 2048;
const replyBytes = (text: string) => utf8ByteLength(JSON.stringify(text)) - 2;
function replyFits(text: string) {
  return replyBytes(text) <= MAX_REPLY_BYTES;
}
/**
 * The end of a reply, kept for the record: whole when it fits MAX_REPLY_BYTES as an
 * escaped JSON string, else its last characters after a leading "…". The end is
 * where a cut-off reply stopped and where a finished one put its answer.
 */
export function boundReply(text: string): string {
  if (replyFits(text)) return text;
  const chars = Array.from(text);
  let start = chars.length;
  let bytes = replyBytes("…");
  while (start > 0) {
    const next = replyBytes(chars[start - 1] as string);
    if (bytes + next > MAX_REPLY_BYTES) break;
    bytes += next;
    start -= 1;
  }
  return `…${chars.slice(start).join("")}`;
}
export const eventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...eventBase,
      type: z.literal("reply"),
      dispatch: z.number().int().nonnegative(),
      /** Only response-reported identity; null means unknown, including absent token usage. */
      resolvedModel: z.string().min(1).max(160).nullable(),
      resolvedProvider: z.string().min(1).max(160).nullable(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("timing"),
      /** Full agent-loop interval for one inference attempt, independent of usage. */
      elapsedMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("shared-usage"),
      encoding: z.literal("cl100k_base"),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("evaluation"),
      purpose: z.literal("after-move"),
      evaluation: evaluationSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("reservation"),
      /** 0-based index among the match's reservations; usage events settle it by this id. */
      dispatch: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
      costMicros: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("attempt"),
      move: z.string().max(256),
      accepted: z.boolean(),
      before: z.string().max(160),
      fen: z.string().max(160),
      san: z.string().max(32).nullable(),
      reason: z.enum(attemptReasons).nullable(),
      comment: z.string().max(500).default(""),
      /** The model's raw reply (truncated) when lenient parsing changed what was submitted. */
      normalizedFrom: z.string().max(256).optional(),
      /**
       * A rejected model attempt only: the end of the reply text (untrusted, at most
       * MAX_REPLY_BYTES as escaped JSON, identities redacted when withheld) and why the
       * reply stopped. `output-truncated` is what makes the reason `truncated`.
       */
      reply: z.string().max(MAX_REPLY_BYTES).refine(replyFits).optional(),
      stopReason: z.enum(replyStopReasons).optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("tool"),
      name: z.enum(["legal_moves", "board", "engine_eval"]),
      input: z.string().max(1000),
      output: z.string().max(16000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("usage"),
      /** The `dispatch` of the reservation this provider-reported usage settles. */
      dispatch: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      /** Absent when the provider did not report cache usage. */
      cachedInputTokens: z.number().int().nonnegative().optional(),
      cacheCreationInputTokens: z.number().int().nonnegative().optional(),
      resolvedModel: z.string().min(1).max(160).nullable(),
      resolvedProvider: z.string().min(1).max(160).nullable(),
      costMicros: z.number().int().nonnegative().nullable(),
    })
    .strict(),
]);
export type MatchEvent = z.infer<typeof eventSchema>;
export type AttemptEvent = Extract<MatchEvent, { type: "attempt" }>;
/**
 * The one archive interchange limit, in UTF-8 bytes of the canonical file form
 * (`serializeArchive`, the pretty-printed JSON the CLI writes). The runner ends a match
 * as unscored "event-limit" before it would exceed this, and the CLI reader, the web
 * importers and the server import reject anything larger, so every archive the runner
 * writes is accepted everywhere. Compact JSON of the same archive is always smaller.
 */
export const MAX_ARCHIVE_BYTES = 2_000_000;
export const archiveSchema = z
  .object({
    format: z.literal("cockpit-chess/v1"),
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    config: archivedConfigSchema,
    source: z.enum(["local", "hosted", "demo"]),
    status: z.enum(["running", "completed", "stopped", "error"]),
    result: z.enum(["1-0", "0-1", "1/2-1/2", "*"]),
    termination: z.enum([
      "playing",
      "checkmate",
      "draw",
      "illegal-forfeit",
      /** The side's whole-game clock ran out. */
      "timeout",
      /** The per-move safety limit ran out (the clock, if any, had time left). */
      "move-timeout",
      "token-budget",
      "cost-budget",
      "cancelled",
      "interrupted",
      "provider-error",
      "engine-error",
      "resignation",
      "event-limit",
      /** The paying OpenRouter key's limit or the account's credits ran out (hosted, user keys). */
      "account-limit",
      /** The paying OpenRouter key was revoked, expired or disconnected mid-match. */
      "credential-revoked",
    ]),
    turn: turnStateSchema,
    // No separate event-count cap: MAX_ARCHIVE_BYTES bounds every archive a reader accepts.
    events: z.array(eventSchema),
  })
  .strict()
  .superRefine((match, context) => {
    const turn = match.turn;
    if (turn.type === "idle") return;
    const human = match.config[turn.side === "w" ? "white" : "black"].protocol === "human";
    if (
      match.status !== "running" ||
      match.termination !== "playing" ||
      match.result !== "*" ||
      (turn.type === "model" ? human : !human) ||
      turn.expectedSeq > match.events.length ||
      (turn.type !== "model" && turn.expectedSeq !== match.events.length) ||
      Date.parse(turn.deadline) - Date.parse(turn.startedAt) > match.config.rules.turnTimeoutMs
    )
      context.addIssue({ code: "custom", message: "Invalid archive turn state", path: ["turn"] });
  });
export type MatchArchive = z.infer<typeof archiveSchema>;

/** The canonical archive file form; MAX_ARCHIVE_BYTES is measured on exactly this. */
export function serializeArchive(match: MatchArchive): string {
  return `${JSON.stringify(match, null, 2)}\n`;
}
/** UTF-8 length without allocating an encoded copy (JSON output has no lone surrogates). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
export function archiveByteLength(match: MatchArchive): number {
  return utf8ByteLength(serializeArchive(match));
}

export function createMatch(
  input: z.input<typeof matchConfigSchema>,
  source: MatchArchive["source"] = "local",
): MatchArchive {
  const { promptVersion, ...parsed } = matchConfigSchema.parse(input);
  // Omit the default so a default ruleset keeps one rules key.
  if (parsed.rules.illegalPolicy === "forfeit") delete parsed.rules.illegalPolicy;
  const config = {
    ...parsed,
    prompt: pinPrompt(parsed.rules, [parsed.white, parsed.black], promptVersion),
  };
  config.initialFen = new Chess(config.initialFen).fen();
  const match: MatchArchive = {
    format: "cockpit-chess/v1",
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    config,
    source,
    status: "running",
    result: "*",
    termination: "playing",
    turn: { type: "idle" },
    events: [],
  };
  settleBoard(match, new Chess(config.initialFen));
  return match;
}
export function boardAt(match: MatchArchive, eventIndex = match.events.length - 1): Chess {
  const chess = new Chess(match.config.initialFen);
  for (const event of match.events.slice(0, eventIndex + 1))
    if (event.type === "attempt" && event.accepted) applyUci(chess, event.move);
  return chess;
}
export function applyUci(chess: Chess, move: string) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw new Error("unparseable");
  return chess.move({
    from: move.slice(0, 2),
    to: move.slice(2, 4),
    ...(move[4] ? { promotion: move[4] } : {}),
  });
}
export function finishMatch(
  match: MatchArchive,
  result: MatchArchive["result"],
  termination: MatchArchive["termination"],
  status: MatchArchive["status"] = "completed",
) {
  match.status = status;
  match.result = result;
  match.termination = termination;
  match.turn = { type: "idle" };
}
export function settleBoard(match: MatchArchive, chess: Chess) {
  if (chess.isCheckmate()) finishMatch(match, chess.turn() === "w" ? "0-1" : "1-0", "checkmate");
  else if (chess.isDraw()) finishMatch(match, "1/2-1/2", "draw");
}
/** Whether an attempt with this move and reply ending is rejected, and why. */
export function attemptReason(
  san: string | null,
  move: string,
  stopReason: ReplyStopReason | undefined,
): AttemptReason | null {
  if (san !== null) return null;
  if (stopReason === "output-truncated") return "truncated";
  return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move) ? "illegal" : "unparseable";
}
/** What the runner knows about the model reply behind an attempt (kept when rejected). */
export type ReplyRecord = { text: string; stopReason: ReplyStopReason };
export function submitMove(
  match: MatchArchive,
  chess: Chess,
  rawMove: string,
  comment = "",
  normalizedFrom?: string,
  reply?: ReplyRecord,
): AttemptEvent {
  if (match.status !== "running" || chess.isGameOver())
    throw new Error("Game is not accepting moves");
  rawMove = rawMove.slice(0, 256);
  const before = chess.fen();
  const side = chess.turn();
  const ply = match.events.filter((event) => event.type === "attempt" && event.accepted).length;
  let san: string | null = null;
  // A cut-off reply is never played, even when its prefix looked like a move.
  if (reply?.stopReason !== "output-truncated")
    try {
      san = applyUci(chess, rawMove).san;
    } catch {
      /* Rejected below. */
    }
  const reason = attemptReason(san, rawMove, reply?.stopReason);
  const event: AttemptEvent = {
    type: "attempt",
    seq: match.events.length,
    at: new Date().toISOString(),
    side,
    ply,
    move: rawMove,
    accepted: san !== null,
    before,
    fen: chess.fen(),
    san,
    reason,
    comment: match.config.rules.remarks === "off" ? "" : comment.slice(0, 500),
    ...(normalizedFrom !== undefined && match.config.rules.moveFormat === "lenient"
      ? { normalizedFrom: normalizedFrom.slice(0, 256) }
      : {}),
    ...(reply && san === null
      ? { reply: boundReply(reply.text), stopReason: reply.stopReason }
      : {}),
  };
  match.events.push(event);
  if (event.accepted) settleBoard(match, chess);
  else if (
    forfeitsAfter(
      match.config.rules,
      match.events.filter((entry) => entry.type === "attempt" && entry.ply === ply).length,
    )
  )
    finishMatch(match, side === "w" ? "0-1" : "1-0", "illegal-forfeit");
  return event;
}
/**
 * What remains of the side to move's clock, in ms (never below zero), or null when the
 * game is untimed. Counts recorded turns only, not the turn in progress.
 */
export function clockLeftMs(match: MatchArchive, side: Side): number | null {
  const clock = sideClockMs(match.config.rules, side);
  return clock === null ? null : Math.max(0, clock - matchStats(match, side).elapsedMs);
}
/**
 * A human's turn on the local companion (hosted games have no human players). Charges
 * the turn's wall time to the side's clock as a timing event, then forfeits on time
 * when the clock ran out, else submits `move`. Without a move it is the clock's expiry.
 * Humans have no per-move limit: that safety limit bounds inference, not people.
 * Returns the attempt, or null when the side lost on time.
 */
export function playHumanTurn(
  match: MatchArchive,
  chess: Chess,
  elapsedMs: number,
  move?: string,
): AttemptEvent | null {
  const side = chess.turn();
  const left = clockLeftMs(match, side);
  if (left !== null) {
    match.events.push({
      type: "timing",
      seq: match.events.length,
      at: new Date().toISOString(),
      side,
      ply: match.events.filter((event) => event.type === "attempt" && event.accepted).length,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
    });
    if (elapsedMs >= left || move === undefined) {
      finishMatch(match, side === "w" ? "0-1" : "1-0", "timeout");
      return null;
    }
  }
  if (move === undefined) throw new Error("An untimed human turn cannot expire");
  return submitMove(match, chess, move);
}
export function matchStats(match: MatchArchive, side?: Side) {
  const events = match.events.filter((event) => !side || event.side === side);
  const attempts = events.filter((event) => event.type === "attempt");
  const usage = events.filter((event) => event.type === "usage");
  const reservations = events.filter((event) => event.type === "reservation");
  const shared = events.filter((event) => event.type === "shared-usage");
  // Settle each dispatch's reservation to its reported usage. A reservation still in
  // flight, or whose dispatch ended without a usage report, keeps counting at its
  // reserved amount; a usage report without a cost keeps the reserved cost.
  const settled = new Map<number, { tokens: number; costMicros: number | null }>();
  for (const event of usage) {
    const entry = settled.get(event.dispatch) ?? { tokens: 0, costMicros: 0 };
    entry.tokens += event.inputTokens + event.outputTokens;
    entry.costMicros =
      entry.costMicros === null || event.costMicros === null
        ? null
        : entry.costMicros + event.costMicros;
    settled.set(event.dispatch, entry);
  }
  const reserved = new Set(reservations.map((event) => event.dispatch));
  let committedTokens = 0;
  let committedCostMicros = 0;
  for (const [dispatch, entry] of settled)
    if (!reserved.has(dispatch)) {
      committedTokens += entry.tokens;
      committedCostMicros += entry.costMicros ?? 0;
    }
  for (const event of reservations) {
    const entry = settled.get(event.dispatch);
    committedTokens += entry ? entry.tokens : event.tokens;
    committedCostMicros += entry?.costMicros ?? event.costMicros;
  }
  return {
    sharedInputTokens: shared.reduce((n, event) => n + event.inputTokens, 0),
    sharedOutputTokens: shared.reduce((n, event) => n + event.outputTokens, 0),
    /** Raw sum of every reservation, for the record; budgets use `committed*`. */
    reservedTokens: reservations.reduce((n, event) => n + event.tokens, 0),
    reservedCostMicros: reservations.reduce((n, event) => n + event.costMicros, 0),
    /**
     * The largest reservation one request took. Dispatches run one at a time and a usage
     * report replaces its reservation, so the raw sum overstates what was ever held.
     */
    peakReservedTokens: reservations.reduce((n, event) => Math.max(n, event.tokens), 0),
    /**
     * Reservations no usage report settled: in flight while the game runs, never
     * reported once it has ended.
     */
    unsettledDispatches: reservations.filter((event) => !settled.has(event.dispatch)).length,
    /** Usage reports that came without a cost. */
    uncostedReports: usage.filter((event) => event.costMicros === null).length,
    /** Reported usage plus reservations not settled by a usage report. */
    committedTokens,
    committedCostMicros,
    moves: attempts.filter((event) => event.accepted).length,
    /** Every rejected attempt (illegal, unparseable or truncated). */
    illegalAttempts: attempts.filter((event) => !event.accepted).length,
    /** Rejected attempts whose reply was cut off before it gave a move. */
    truncatedAttempts: attempts.filter((event) => event.reason === "truncated").length,
    inputTokens: usage.reduce((n, event) => n + event.inputTokens, 0),
    outputTokens: usage.reduce((n, event) => n + event.outputTokens, 0),
    cachedInputTokens: usage.reduce((n, event) => n + (event.cachedInputTokens ?? 0), 0),
    cacheCreationInputTokens: usage.reduce(
      (n, event) => n + (event.cacheCreationInputTokens ?? 0),
      0,
    ),
    /**
     * Reported reads / reported input: a lower bound when cache usage is omitted.
     * The installed adapters omit explicit zero cache counts too. All-unknown
     * unreported provider usage stays null, rather than being labeled a cache miss.
     */
    cacheReadShare:
      usage.some(
        (event) =>
          event.cachedInputTokens !== undefined || event.cacheCreationInputTokens !== undefined,
      ) && usage.reduce((n, event) => n + event.inputTokens, 0) > 0
        ? usage.reduce((n, event) => n + (event.cachedInputTokens ?? 0), 0) /
          usage.reduce((n, event) => n + event.inputTokens, 0)
        : null,
    elapsedMs: events.reduce((n, event) => n + (event.type === "timing" ? event.elapsedMs : 0), 0),
    /** Provider-reported cost so far (usage reports without a cost count as 0). */
    reportedCostMicros: usage.reduce((n, event) => n + (event.costMicros ?? 0), 0),
    costMicros:
      reservations.some((event) => !settled.has(event.dispatch)) ||
      usage.some((event) => event.costMicros === null)
        ? null
        : usage.reduce((n, event) => n + (event.costMicros ?? 0), 0),
    toolCalls: events.filter((event) => event.type === "tool").length,
  };
}
export function legalMoves(chess: Chess, square?: string): string[] {
  if (square && !/^[a-h][1-8]$/.test(square)) return [];
  return chess
    .moves({ verbose: true, ...(square ? { square: square as Square } : {}) })
    .map((move) => `${move.from}${move.to}${move.promotion ?? ""}`);
}
export function positionText(chess: Chess, representation: Rules["representation"]) {
  if (representation === "fen") return chess.fen();
  if (representation === "ascii") return `${chess.ascii()}\nFEN: ${chess.fen()}`;
  return `${chess
    .board()
    .flatMap((row) =>
      row.flatMap((piece) => (piece ? [`${piece.color}${piece.type}@${piece.square}`] : [])),
    )
    .join(" ")}\nFEN: ${chess.fen()}`;
}

/** Shape-only stored-reader path; malformed prerelease formats never receive an upgrade. */
export function parseArchive(input: unknown): MatchArchive {
  const supported = z.object({ config: z.object({ rules: rulesSchema }) }).safeParse(input);
  if (!supported.success) throw new Error("Unsupported ruleset/archive");
  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) throw new Error("Unsupported archive");
  return parsed.data;
}
/** Reconstruct every attempt; uploaded snapshots never authorize a board position. */
export function validateArchive(input: unknown): MatchArchive {
  const match = parseArchive(input);
  const chess = new Chess(match.config.initialFen);
  let ply = 0;
  let illegalThisTurn = 0;
  let terminal = chess.isGameOver();
  const dispatches = new Map<number, { side: Side; ply: number }>();
  for (const [index, event] of match.events.entries()) {
    if (event.seq !== index || event.ply !== ply || event.side !== chess.turn())
      throw new Error("Invalid event order");
    if (
      match.turn.type === "model" &&
      index === match.turn.expectedSeq &&
      chess.turn() !== match.turn.side
    )
      throw new Error("Invalid model turn anchor");
    if (event.type === "evaluation") {
      const previous = match.events[index - 1];
      if (
        !["after-move", "both"].includes(match.config.rules.engineEvaluation) ||
        event.evaluation.fen !== chess.fen() ||
        previous?.type !== "attempt" ||
        !previous.accepted
      )
        throw new Error("Invalid post-move evaluation");
      continue;
    }
    if (terminal) throw new Error("Events after game ended");
    if (event.type === "shared-usage" && match.config.rules.tokenAccounting !== "cl100k_base")
      throw new Error("Unexpected shared-token usage");
    if (
      event.type === "tool" &&
      event.name === "engine_eval" &&
      !["tool", "both"].includes(match.config.rules.engineEvaluation)
    )
      throw new Error("Unexpected engine tool");
    if (event.type === "reservation") {
      if (event.dispatch !== dispatches.size) throw new Error("Invalid dispatch order");
      dispatches.set(event.dispatch, { side: event.side, ply: event.ply });
    }
    if (event.type === "usage" || event.type === "reply") {
      const reservation = dispatches.get(event.dispatch);
      if (reservation?.side !== event.side || reservation.ply !== event.ply)
        throw new Error("Reply/usage without reservation");
    }
    if (event.type === "usage") {
      // Gemini can report a write and a read of the same prefix in one request.
      if (
        (event.cachedInputTokens ?? 0) > event.inputTokens ||
        (event.cacheCreationInputTokens ?? 0) > event.inputTokens
      )
        throw new Error("Cache usage exceeds input tokens");
    }
    if (event.type !== "attempt") continue;
    if (event.before !== chess.fen()) throw new Error("Position mismatch");
    let san: string | null = null;
    if (event.stopReason !== "output-truncated")
      try {
        san = applyUci(chess, event.move).san;
      } catch {
        /* Rejections are legitimate recorded events. */
      }
    if (event.accepted !== (san !== null) || event.san !== san || event.fen !== chess.fen())
      throw new Error("Move validation mismatch");
    if (event.reason !== attemptReason(san, event.move, event.stopReason))
      throw new Error("Attempt reason mismatch");
    if (san !== null && match.turn.type === "model" && index >= match.turn.expectedSeq)
      throw new Error("Model turn spans a completed turn");
    if (san !== null && (event.reply !== undefined || event.stopReason !== undefined))
      throw new Error("Reply record on an accepted move");
    if (match.config.rules.remarks === "off" && event.comment)
      throw new Error("Commentary violates ruleset");
    if (event.normalizedFrom !== undefined && match.config.rules.moveFormat !== "lenient")
      throw new Error("Move normalization violates ruleset");
    if (san) {
      ply += 1;
      illegalThisTurn = 0;
    } else illegalThisTurn += 1;
    terminal = chess.isGameOver() || forfeitsAfter(match.config.rules, illegalThisTurn);
  }
  if (match.turn.type !== "idle" && match.turn.side !== chess.turn())
    throw new Error("Turn does not match side to move");
  if (match.status === "running" && terminal) throw new Error("Running game is terminal");
  if (
    match.termination === "checkmate" &&
    (!chess.isCheckmate() || match.result !== (chess.turn() === "w" ? "0-1" : "1-0"))
  )
    throw new Error("Invalid checkmate result");
  if (match.termination === "draw" && (!chess.isDraw() || match.result !== "1/2-1/2"))
    throw new Error("Invalid draw result");
  if (
    match.termination === "illegal-forfeit" &&
    (!forfeitsAfter(match.config.rules, illegalThisTurn) ||
      match.result !== (chess.turn() === "w" ? "0-1" : "1-0"))
  )
    throw new Error("Invalid forfeit");
  if (match.status === "running" && (match.result !== "*" || match.termination !== "playing"))
    throw new Error("Invalid running result");
  if (match.status !== "running" && match.termination === "playing")
    throw new Error("Missing termination");
  if (
    (match.status === "stopped" && (match.termination !== "cancelled" || match.result !== "*")) ||
    (match.status === "error" &&
      (![
        "provider-error",
        "engine-error",
        "event-limit",
        "interrupted",
        "account-limit",
        "credential-revoked",
      ].includes(match.termination) ||
        match.result !== "*")) ||
    (match.status === "completed" &&
      (match.result === "*" ||
        [
          "playing",
          "cancelled",
          "provider-error",
          "engine-error",
          "event-limit",
          "interrupted",
          "account-limit",
          "credential-revoked",
        ].includes(match.termination)))
  )
    throw new Error("Invalid terminal status");
  if (match.termination === "timeout" && sideClockMs(match.config.rules, chess.turn()) === null)
    throw new Error("Clock forfeit in an untimed game");
  if (
    ["timeout", "move-timeout", "token-budget", "cost-budget", "resignation"].includes(
      match.termination,
    ) &&
    match.result !== (chess.turn() === "w" ? "0-1" : "1-0")
  )
    throw new Error("Invalid side-to-move forfeit");
  if (match.status === "completed" && terminal) {
    const expected = chess.isCheckmate()
      ? "checkmate"
      : chess.isDraw()
        ? "draw"
        : "illegal-forfeit";
    if (match.termination !== expected) throw new Error("Terminal board result mismatch");
  }
  return match;
}
