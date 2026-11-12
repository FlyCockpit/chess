import { Chess, DEFAULT_POSITION, type Square } from "chess.js";
import { z } from "zod";

export type { Color, PieceSymbol, Square } from "chess.js";
export { Chess, DEFAULT_POSITION } from "chess.js";

/** True when chess.js can load the position, so `new Chess(fen)` will not throw later. */
function isLoadableFen(fen: string): boolean {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

export const playerSchema = z
  .object({
    name: z.string().min(1).max(80),
    model: z.string().min(1).max(160),
    protocol: z.enum(["openai-chat", "openai-responses", "anthropic", "random", "human"]),
  })
  .strict();
export const rulesSchema = z
  .object({
    version: z.literal("cockpit-v1").default("cockpit-v1"),
    context: z.enum(["fresh", "persistent"]).default("fresh"),
    opponentIdentity: z.enum(["hidden", "disclosed"]).default("hidden"),
    representation: z.enum(["fen", "ascii", "pieces"]).default("ascii"),
    legalMoves: z.enum(["hidden", "tool", "provided"]).default("tool"),
    trashTalk: z.boolean().default(false),
    /** "lenient" also extracts a JSON reply embedded in prose and converts legal SAN to UCI. */
    moveFormat: z.enum(["strict", "lenient"]).default("strict"),
    tokenAccounting: z.enum(["provider", "cl100k_base"]).default("provider"),
    engineEvaluation: z.enum(["off", "tool", "after-move", "both"]).default("off"),
    engineNodes: z.number().int().min(1000).max(100000).default(10000),
    engineCallsPerTurn: z.number().int().min(1).max(8).default(2),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    maxPlies: z.number().int().min(2).max(600).default(200),
    turnTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
    maxDispatches: z.number().int().min(1).max(12).default(6),
    maxOutputTokens: z.number().int().min(64).max(4096).default(512),
    tokenBudget: z.number().int().min(256).max(1000000).default(1000000),
    timeBudgetMs: z.number().int().min(1000).max(3600000).default(600000),
    costBudgetMicros: z.number().int().min(100).max(100000000).default(1000000),
  })
  .strict();
export const matchConfigSchema = z
  .object({
    title: z.string().min(1).max(140).default("Agent showdown"),
    white: playerSchema,
    black: playerSchema,
    rules: rulesSchema,
    initialFen: z
      .string()
      .max(160)
      .refine(isLoadableFen, { message: "Invalid FEN" })
      .default(DEFAULT_POSITION),
  })
  .strict();
export type Player = z.infer<typeof playerSchema>;
export type MatchConfig = z.infer<typeof matchConfigSchema>;
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
export const eventSchema = z.discriminatedUnion("type", [
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
      reason: z.enum(["illegal", "unparseable"]).nullable(),
      comment: z.string().max(500).default(""),
      /** The model's raw reply (truncated) when lenient parsing changed what was submitted. */
      normalizedFrom: z.string().max(256).optional(),
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
    config: matchConfigSchema,
    source: z.enum(["local", "hosted", "demo"]),
    status: z.enum(["running", "completed", "stopped", "error"]),
    result: z.enum(["1-0", "0-1", "1/2-1/2", "*"]),
    termination: z.enum([
      "playing",
      "checkmate",
      "draw",
      "illegal-forfeit",
      "timeout",
      "token-budget",
      "cost-budget",
      "ply-limit",
      "cancelled",
      "interrupted",
      "provider-error",
      "engine-error",
      "resignation",
      "event-limit",
    ]),
    // No separate event-count cap: MAX_ARCHIVE_BYTES bounds every archive a reader accepts.
    events: z.array(eventSchema),
  })
  .strict();
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
  const config = matchConfigSchema.parse(input);
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
}
export function settleBoard(match: MatchArchive, chess: Chess) {
  if (chess.isCheckmate()) finishMatch(match, chess.turn() === "w" ? "0-1" : "1-0", "checkmate");
  else if (chess.isDraw()) finishMatch(match, "1/2-1/2", "draw");
  else if (
    match.events.filter((event) => event.type === "attempt" && event.accepted).length >=
    match.config.rules.maxPlies
  )
    finishMatch(match, "1/2-1/2", "ply-limit");
}
export function submitMove(
  match: MatchArchive,
  chess: Chess,
  rawMove: string,
  comment = "",
  normalizedFrom?: string,
): AttemptEvent {
  if (match.status !== "running" || chess.isGameOver())
    throw new Error("Game is not accepting moves");
  rawMove = rawMove.slice(0, 256);
  const before = chess.fen();
  const side = chess.turn();
  const ply = match.events.filter((event) => event.type === "attempt" && event.accepted).length;
  let san: string | null = null;
  let reason: AttemptEvent["reason"] = null;
  try {
    san = applyUci(chess, rawMove).san;
  } catch {
    reason = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(rawMove) ? "illegal" : "unparseable";
  }
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
    comment: match.config.rules.trashTalk ? comment.slice(0, 500) : "",
    ...(normalizedFrom !== undefined && match.config.rules.moveFormat === "lenient"
      ? { normalizedFrom: normalizedFrom.slice(0, 256) }
      : {}),
  };
  match.events.push(event);
  if (event.accepted) settleBoard(match, chess);
  else if (
    match.events.filter((entry) => entry.type === "attempt" && entry.ply === ply).length >=
    match.config.rules.maxAttempts
  )
    finishMatch(match, side === "w" ? "0-1" : "1-0", "illegal-forfeit");
  return event;
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
    /** Reported usage plus reservations not settled by a usage report. */
    committedTokens,
    committedCostMicros,
    moves: attempts.filter((event) => event.accepted).length,
    illegalAttempts: attempts.filter((event) => !event.accepted).length,
    inputTokens: usage.reduce((n, event) => n + event.inputTokens, 0),
    outputTokens: usage.reduce((n, event) => n + event.outputTokens, 0),
    elapsedMs: events.reduce((n, event) => n + (event.type === "timing" ? event.elapsedMs : 0), 0),
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

/** Reconstruct every attempt; uploaded snapshots never authorize a board position. */
export function validateArchive(input: unknown): MatchArchive {
  const match = archiveSchema.parse(input);
  const chess = new Chess(match.config.initialFen);
  let ply = 0;
  let illegalThisTurn = 0;
  let terminal = chess.isGameOver();
  const dispatches = new Map<number, { side: Side; ply: number }>();
  for (const [index, event] of match.events.entries()) {
    if (event.seq !== index || event.ply !== ply || event.side !== chess.turn())
      throw new Error("Invalid event order");
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
    if (event.type === "usage") {
      const reservation = dispatches.get(event.dispatch);
      if (reservation?.side !== event.side || reservation.ply !== event.ply)
        throw new Error("Usage without reservation");
    }
    if (event.type !== "attempt") continue;
    if (event.before !== chess.fen()) throw new Error("Position mismatch");
    let san: string | null = null;
    try {
      san = applyUci(chess, event.move).san;
    } catch {
      /* Rejections are legitimate recorded events. */
    }
    if (event.accepted !== (san !== null) || event.san !== san || event.fen !== chess.fen())
      throw new Error("Move validation mismatch");
    const reason = san
      ? null
      : /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(event.move)
        ? "illegal"
        : "unparseable";
    if (event.reason !== reason) throw new Error("Attempt reason mismatch");
    if (!match.config.rules.trashTalk && event.comment)
      throw new Error("Commentary violates ruleset");
    if (event.normalizedFrom !== undefined && match.config.rules.moveFormat !== "lenient")
      throw new Error("Move normalization violates ruleset");
    if (san) {
      ply += 1;
      illegalThisTurn = 0;
    } else illegalThisTurn += 1;
    terminal =
      chess.isGameOver() ||
      ply >= match.config.rules.maxPlies ||
      illegalThisTurn >= match.config.rules.maxAttempts;
  }
  if (match.status === "running" && terminal) throw new Error("Running game is terminal");
  if (
    match.termination === "checkmate" &&
    (!chess.isCheckmate() || match.result !== (chess.turn() === "w" ? "0-1" : "1-0"))
  )
    throw new Error("Invalid checkmate result");
  if (match.termination === "draw" && (!chess.isDraw() || match.result !== "1/2-1/2"))
    throw new Error("Invalid draw result");
  if (
    match.termination === "ply-limit" &&
    (ply < match.config.rules.maxPlies || match.result !== "1/2-1/2")
  )
    throw new Error("Invalid ply limit");
  if (
    match.termination === "illegal-forfeit" &&
    (illegalThisTurn < match.config.rules.maxAttempts ||
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
      (!["provider-error", "engine-error", "event-limit", "interrupted"].includes(
        match.termination,
      ) ||
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
        ].includes(match.termination)))
  )
    throw new Error("Invalid terminal status");
  if (
    ["timeout", "token-budget", "cost-budget", "resignation"].includes(match.termination) &&
    match.result !== (chess.turn() === "w" ? "0-1" : "1-0")
  )
    throw new Error("Invalid side-to-move forfeit");
  if (match.status === "completed" && terminal) {
    const expected = chess.isCheckmate()
      ? "checkmate"
      : chess.isDraw()
        ? "draw"
        : ply >= match.config.rules.maxPlies
          ? "ply-limit"
          : "illegal-forfeit";
    if (match.termination !== expected) throw new Error("Terminal board result mismatch");
  }
  return match;
}
export function exportPgn(match: MatchArchive): string {
  const chess = boardAt(match);
  chess.header(
    "Event",
    match.config.title,
    "White",
    match.config.white.name,
    "Black",
    match.config.black.name,
    "Result",
    match.result,
    "CockpitRules",
    JSON.stringify(match.config.rules),
  );
  return chess.pgn();
}
