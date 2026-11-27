import {
  type AgentMessage,
  type AgentModel,
  type AgentTool,
  classifyModelError,
  defineTool,
  runAgentLoop,
} from "@cockpit-chess/agent-runtime";
import { z } from "zod";
import { evaluatePosition } from "./engine";
import {
  applyUci,
  archiveByteLength,
  boardAt,
  Chess,
  type EngineEvaluation,
  FALLBACK_MAX_OUTPUT_TOKENS,
  finishMatch,
  illegalPolicy,
  legalMoves,
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  type MatchEvent,
  matchStats,
  positionText,
  type ReplyStopReason,
  type Rules,
  replyCap,
  type Side,
  settleBoard,
  sideClockMs,
  submitMove,
  utf8ByteLength,
} from "./index";
import {
  assertPinnedPrompt,
  engineFeedback,
  matchSystemPrompt,
  promptLoopGuardMessages,
  promptToolInputs,
  rejectionMessage,
  renderTurnPrompt,
} from "./prompts";

export { matchSystemPrompt, REMARK_PROMPTS, rejectionMessage } from "./prompts";

import type { SpectatorEvaluations } from "./spectator";
import { sharedInputTokens, sharedOutputText, sharedOutputTokens } from "./tokenizer";

/** Abort reason for shutdown, lost ownership, or an exhausted heartbeat error allowance. */
export const MATCH_INTERRUPTED = "chess:interrupted";
/** Abort reason when the paying key was disconnected or replaced mid-match (hosted). */
export const CREDENTIAL_REVOKED = "chess:credential-revoked";

/** Unreasoned local/CLI aborts remain operator stops; hosted infrastructure sets a reason. */
export function finishAbortedMatch(match: MatchArchive, signal?: AbortSignal) {
  if (signal?.reason === CREDENTIAL_REVOKED) {
    finishMatch(match, "*", "credential-revoked", "error");
    return;
  }
  const interrupted = signal?.reason === MATCH_INTERRUPTED;
  finishMatch(
    match,
    "*",
    interrupted ? "interrupted" : "cancelled",
    interrupted ? "error" : "stopped",
  );
}

/**
 * The unscored ending a failed model call leads to. OpenRouter's 401 means the key
 * was revoked or expired; a 402 means its limit or the account's credits ran out
 * (the transient in-flight budget is retried by the runtime, so if it still fails it
 * is an ordinary provider failure). Only the status and code are read: the
 * provider's message never reaches the archive.
 */
export function providerFailureTermination(
  error: unknown,
): "credential-revoked" | "account-limit" | "provider-error" {
  const { status, code } = classifyModelError(error);
  if (status === 401) return "credential-revoked";
  if (status === 402 && code !== "openrouter_in_flight_budget") return "account-limit";
  return "provider-error";
}

/** A persistent turn's opening prompt (`turnPrompt`) always starts with this. */
const TURN_START = /^You play (?:White|Black)\./;
const isTurnStart = (entry: AgentMessage) => {
  if (entry.role !== "user") return false;
  const first = entry.parts[0];
  return (
    first?.type === "text" &&
    "content" in first &&
    typeof first.content === "string" &&
    TURN_START.test(first.content)
  );
};

/**
 * Bounds one side's private conversation between turns: while it is over `maxBytes`
 * (as JSON), the oldest whole turns are dropped, always at a turn boundary so no tool
 * call loses its result. When the newest turn alone is still over the limit, nothing
 * is kept (the side's next turn starts without history), so the stored memory never
 * exceeds `maxBytes`.
 *
 * The exact bound (CHESS_CONVERSATION_MAX_BYTES): stored history between turns never
 * exceeds `maxBytes`. Before every dispatch, `fitConversation` drops the oldest
 * completed turns (never the turn in flight) so the request fits; only a turn that
 * alone exceeds `maxBytes` ends the game, unscored ("event-limit"). Nothing is checked
 * mid-stream, so the turn in flight can exceed `maxBytes` by at most its own last
 * dispatch's output and tool results: `maxOutputTokens` per dispatch (at most
 * `maxDispatches` of them, each of which passed the check first) plus tool outputs,
 * which the archive limit (MAX_ARCHIVE_BYTES) bounds.
 */
export function trimConversation(messages: AgentMessage[], maxBytes?: number): AgentMessage[] {
  if (maxBytes === undefined) return messages;
  const sizes = messages.map((entry) => Buffer.byteLength(JSON.stringify(entry)));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  while (total > maxBytes) {
    let next = start + 1;
    while (next < messages.length && !isTurnStart(messages[next] as AgentMessage)) next += 1;
    if (next >= messages.length) return [];
    for (let index = start; index < next; index++) total -= sizes[index] ?? 0;
    start = next;
  }
  return start === 0 ? messages : messages.slice(start);
}

/**
 * Before a dispatch: drops the oldest completed turns from `messages` in place (the
 * runtime owns the array between dispatches, as its prune pass does) until it fits in
 * `maxBytes`, never touching the turn that starts at the message `currentTurnId`.
 * Returns the bytes left; more than `maxBytes` means the current turn alone is over.
 */
export function fitConversation(
  messages: AgentMessage[],
  maxBytes: number,
  currentTurnId: string,
): number {
  const sizes = messages.map((entry) => Buffer.byteLength(JSON.stringify(entry)));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  const current = messages.findIndex((entry) => entry.id === currentTurnId);
  if (total <= maxBytes || current <= 0) return total;
  let drop = 0;
  while (total > maxBytes && drop < current) {
    let next = drop + 1;
    while (next < current && !isTurnStart(messages[next] as AgentMessage)) next += 1;
    for (let index = drop; index < next; index++) total -= sizes[index] ?? 0;
    drop = next;
  }
  messages.splice(0, drop);
  return total;
}

/**
 * Upper bound on the canonical (pretty-printed) bytes one archive event adds when it is
 * appended without being measured first. Every event type except `tool` is bounded by
 * its schema well below this (a schema-maximal attempt event, all escaped characters,
 * is under 12 KB; runner.test.ts proves it). Tool events are measured exactly before
 * each push, so they need no share of the headroom.
 */
export const MAX_UNMEASURED_EVENT_BYTES = 12_288;
/**
 * Unmeasured events that may still be appended after a limit check passes: one
 * dispatch's reservation, reply and shared-usage events plus two usage reports (slack for a
 * retried stream), then this attempt's timing, attempt and post-move evaluation events.
 * Every other append point (each dispatch, each attempt, each random or human move)
 * checks first.
 */
const UNMEASURED_EVENTS_AFTER_CHECK = 5 + 3;
/**
 * Terminal bookkeeping after the last check: status/result/termination rewrites and
 * in-place growth of numeric fields (a streamed shared-usage count starts at 0).
 */
export const TERMINAL_BOOKKEEPING_BYTES = 1024;
/** Bytes kept free below MAX_ARCHIVE_BYTES at every check. */
export const ARCHIVE_HEADROOM_BYTES =
  UNMEASURED_EVENTS_AFTER_CHECK * MAX_UNMEASURED_EVENT_BYTES + TERMINAL_BOOKKEEPING_BYTES;
/**
 * True when the archive as it stands (including an event the caller just pushed to
 * measure it) leaves less than ARCHIVE_HEADROOM_BYTES below the interchange limit.
 * Callers end the match as unscored "event-limit" instead of continuing, so the archive
 * never exceeds MAX_ARCHIVE_BYTES and every written snapshot is accepted by replay,
 * upload and import.
 */
export function archiveLimitReached(match: MatchArchive) {
  return archiveByteLength(match) + ARCHIVE_HEADROOM_BYTES > MAX_ARCHIVE_BYTES;
}
/**
 * Canonical bytes one event adds as an element of the archive's `events` array: its
 * pretty-printed text, four spaces of indentation per line (JSON escapes every newline
 * inside strings, so lines are structural) and the `,\n` separator. For a non-empty
 * array, `archiveByteLength` equals the empty-array archive plus the sum of these plus 2.
 */
export function eventEntryBytes(event: MatchEvent) {
  const text = JSON.stringify(event, null, 2);
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1))
    lines += 1;
  return utf8ByteLength(text) + 4 * lines + 2;
}
/**
 * In-place growth the running estimate does not see: the first event's array framing
 * (2 bytes) and streamed shared-usage counts that grow after being counted (at most
 * 7 digits each). The meter measures exactly again after SLACK_SHARED_EVENTS of them,
 * so a turn that keeps retrying stays inside this slack however many dispatches it takes.
 */
const ESTIMATE_SLACK_BYTES = 1024;
const SLACK_SHARED_EVENTS = 120;
/**
 * The per-turn limit check. Re-serializing a 2 MB archive per tool call or dispatch
 * would make a long turn quadratic, so it keeps a running upper bound (the last exact
 * measurement plus each new event's entry bytes plus slack) and measures exactly only
 * when that bound comes within the headroom of the limit, or when an event was removed.
 * Valid while earlier events stay append-only apart from shared-usage counts, which is
 * how the runner writes them within one turn.
 */
export function archiveMeter(match: MatchArchive) {
  let counted = -1;
  let estimate = 0;
  /** Shared-usage events appended since the last exact measurement. */
  let growing = 0;
  const measure = () => {
    estimate = archiveByteLength(match);
    counted = match.events.length;
    growing = 0;
  };
  return () => {
    if (counted < 0 || counted > match.events.length) measure();
    else {
      for (const event of match.events.slice(counted)) {
        estimate += eventEntryBytes(event);
        if (event.type === "shared-usage") growing += 1;
      }
      counted = match.events.length;
      if (
        growing < SLACK_SHARED_EVENTS &&
        estimate + ESTIMATE_SLACK_BYTES + ARCHIVE_HEADROOM_BYTES <= MAX_ARCHIVE_BYTES
      )
        return false;
      measure();
    }
    return estimate + ARCHIVE_HEADROOM_BYTES > MAX_ARCHIVE_BYTES;
  };
}
/** Ends a running match on the archive limit; returns true when the limit was reached. */
export function endAtArchiveLimit(match: MatchArchive) {
  if (!archiveLimitReached(match)) return false;
  if (match.status === "running") finishMatch(match, "*", "event-limit", "error");
  return true;
}

/**
 * Recorded before turn completion so terminal positions also retain their evaluation.
 * `context.chess` (the current board) and `context.ply` (accepted moves so far) are
 * optional replay shortcuts; they must match the archive.
 */
export async function evaluateAfterMove(
  match: MatchArchive,
  options: MatchRunnerOptions = {},
  context: { chess?: Chess; ply?: number } = {},
) {
  if (!["after-move", "both"].includes(match.config.rules.engineEvaluation)) return;
  const chess = context.chess ?? boardAt(match);
  try {
    const evaluation = await evaluatePosition(chess.fen(), {
      nodes: match.config.rules.engineNodes,
      signal: options.signal,
    });
    match.events.push({
      type: "evaluation",
      purpose: "after-move",
      seq: match.events.length,
      at: new Date().toISOString(),
      side: chess.turn(),
      ply: context.ply ?? matchStats(match).moves,
      evaluation,
    });
    return evaluation;
  } catch {
    // A finished game (checkmate, draw, ply limit) keeps its outcome; the evaluation is dropped.
    if (match.status !== "running") return;
    if (options.signal?.aborted) finishAbortedMatch(match, options.signal);
    else finishMatch(match, "*", "engine-error", "error");
  }
}

/**
 * The spectators' evaluation of a game as it is played (see `./spectator`). `update`
 * replays only the events added since its last call (a cursor, so the caller's move
 * path pays for the new moves, not the whole game) and queues each new position;
 * positions are analysed one at a time, in the background, on the spectator engine
 * lane (never the players'), and handed to `record`. Nothing here touches the match:
 * the first failure (engine unavailable, search or write failed) stops the feed and
 * leaves the remaining positions for a backfill. `drain` resolves once the queue is
 * empty or the feed stopped; `remaining` counts positions not evaluated.
 */
export function spectatorFeed(options: {
  record: (ply: number, evaluation: EngineEvaluation) => Promise<void> | void;
  known?: SpectatorEvaluations | null;
  signal?: AbortSignal;
}) {
  const queued = new Map<number, string>(
    Object.entries(options.known ?? {}).map(([ply, evaluation]) => [Number(ply), evaluation.fen]),
  );
  const pending: Array<{ ply: number; fen: string; nodes: number }> = [];
  let cursor: { id: string; events: number; chess: Chess; ply: number } | undefined;
  let running: Promise<void> | undefined;
  let failed = false;
  const stopped = () => failed || options.signal?.aborted === true;
  const queue = (ply: number, fen: string, nodes: number) => {
    if (queued.get(ply) === fen) return;
    queued.set(ply, fen);
    pending.push({ ply, fen, nodes });
  };
  const pump = () => {
    if (running || !pending.length) return;
    running = (async () => {
      while (pending.length && !stopped()) {
        const next = pending.shift() as (typeof pending)[number];
        try {
          const evaluation = await evaluatePosition(next.fen, {
            nodes: next.nodes,
            signal: options.signal,
            lane: "spectators",
          });
          await options.record(next.ply, evaluation);
        } catch {
          failed = true;
        }
      }
    })().finally(() => {
      running = undefined;
    });
  };
  return {
    update(match: MatchArchive) {
      if (stopped()) return;
      const nodes = match.config.rules.engineNodes;
      try {
        if (!cursor || cursor.id !== match.id || match.events.length < cursor.events) {
          const chess = new Chess(match.config.initialFen);
          cursor = { id: match.id, events: 0, chess, ply: 0 };
          queue(0, chess.fen(), nodes);
        }
        for (let index = cursor.events; index < match.events.length; index++) {
          const event = match.events[index];
          if (event?.type !== "attempt" || !event.accepted) continue;
          applyUci(cursor.chess, event.move);
          cursor.ply += 1;
          queue(cursor.ply, cursor.chess.fen(), nodes);
        }
        cursor.events = match.events.length;
      } catch {
        // A move that does not replay: nothing after it can be scored.
        failed = true;
        return;
      }
      pump();
    },
    drain: async () => {
      while (running) await running;
    },
    get failed() {
      return failed;
    },
    get remaining() {
      return pending.length;
    },
  };
}

export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string;
  anthropicAuth?: "api-key" | "bearer";
  /** Extra request headers (OpenRouter app attribution); never a credential. */
  headers?: Record<string, string>;
  /** Called right before every provider request; throwing refuses it (AgentModel). */
  beforeDispatch?: () => void;
  /** Conservative price quotes, integer microdollars per million tokens. */
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  /**
   * The model's own maximum output per reply, in tokens, when its catalog lists one
   * (OpenRouter `top_provider.max_completion_tokens`); else FALLBACK_MAX_OUTPUT_TOKENS.
   */
  maxOutputTokens?: number | null;
  /** The model's context window in tokens, when known: input plus output must fit it. */
  contextLength?: number | null;
}
export type MatchRunnerOptions = {
  credentials?: Partial<Record<Side, ProviderCredentials>>;
  signal?: AbortSignal;
  onUpdate?: (match: MatchArchive) => void | Promise<void>;
  /** The process hosting the match owns persistence of private conversation memory. */
  memory?: Partial<Record<Side, AgentMessage[]>>;
  /** Most bytes (as JSON) one side's persistent conversation keeps; see trimConversation. */
  conversationMaxBytes?: number;
  random?: () => number;
};

const message = (content: string): AgentMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", content }],
});
/** Current board state stays outside the versioned immutable prefix. */
export function turnPrompt(match: MatchArchive, side: Side, board?: Chess): string {
  const chess = board ?? boardAt(match);
  const rules = match.config.rules;
  const stats = matchStats(match, side);
  const clock = sideClockMs(rules, side);
  return renderTurnPrompt(match, side, {
    position: positionText(chess, rules.representation),
    moves: rules.legalMoves === "provided" ? legalMoves(chess) : [],
    remainingTokens:
      rules.tokenBudget -
      (rules.tokenAccounting === "cl100k_base"
        ? stats.sharedInputTokens + stats.sharedOutputTokens
        : stats.committedTokens),
    remainingClock: clock === null ? null : Math.max(0, clock - stats.elapsedMs),
    threefold: chess.isThreefoldRepetition(),
    fifty: chess.isDrawByFiftyMoves(),
    evaluation: match.events
      .flatMap((event) =>
        event.type === "evaluation" && event.evaluation.fen === chess.fen()
          ? [event.evaluation]
          : [],
      )
      .at(-1),
    remark: match.events
      .flatMap((event) =>
        event.type === "attempt" && event.side !== side && event.comment ? [event.comment] : [],
      )
      .at(-1),
  });
}

/**
 * One turn. The caller serializes turns and owns the archive and private memory.
 * `board`, when given, must be the archive's current position; accepted moves are
 * applied to it in place, so a caller driving successive turns can reuse one instance.
 */
export async function advanceMatch(
  match: MatchArchive,
  options: MatchRunnerOptions = {},
  board?: Chess,
): Promise<MatchArchive> {
  if (match.status !== "running") return match;
  assertPinnedPrompt(match.config);
  const chess = board ?? boardAt(match);
  settleBoard(match, chess);
  if (match.status !== "running") return match;
  if (options.signal?.aborted) {
    finishAbortedMatch(match, options.signal);
    return match;
  }
  const side = chess.turn();
  const player = side === "w" ? match.config.white : match.config.black;
  if (player.protocol === "human") return match;
  const ply = matchStats(match).moves;
  if (player.protocol === "random") {
    if (endAtArchiveLimit(match)) {
      await options.onUpdate?.(match);
      return match;
    }
    const moves = legalMoves(chess);
    const index = Math.min(
      moves.length - 1,
      Math.floor((options.random?.() ?? Math.random()) * moves.length),
    );
    const move = moves[index];
    if (move) {
      submitMove(match, chess, move);
      await evaluateAfterMove(match, options, { chess, ply: ply + 1 });
    }
    await options.onUpdate?.(match);
    return match;
  }
  const credential = options.credentials?.[side];
  if (
    !credential?.apiKey ||
    !Number.isFinite(credential.inputMicrosPerMillion) ||
    !Number.isFinite(credential.outputMicrosPerMillion) ||
    credential.inputMicrosPerMillion < 0 ||
    credential.outputMicrosPerMillion < 0
  )
    throw new Error("Provider credentials and price quotes are required");
  const rules = match.config.rules;
  const clock = sideClockMs(rules, side);
  const model: AgentModel = {
    provider: player.protocol,
    model: player.model,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl,
    anthropicAuth: credential.anthropicAuth,
    ...(credential.headers ? { headers: credential.headers } : {}),
    ...(credential.beforeDispatch ? { beforeDispatch: credential.beforeDispatch } : {}),
  };
  const bundle = assertPinnedPrompt(match.config);
  const systemPrompt = matchSystemPrompt(match);
  let messages = rules.context === "persistent" ? [...(options.memory?.[side] ?? [])] : [];
  const turnMessage = message(turnPrompt(match, side, chess));
  messages.push(turnMessage);
  const turnStarted = Date.now();
  const eventBase = () => ({ seq: match.events.length, at: new Date().toISOString(), side, ply });
  const limitReached = archiveMeter(match);
  /**
   * Measures the tool event exactly (push, measure, and pop synchronously, so no
   * snapshot sees it) and ends the match instead of keeping an event that would leave
   * too little headroom below the archive limit.
   */
  const recordTool = (
    event: Omit<Extract<MatchEvent, { type: "tool" }>, keyof ReturnType<typeof eventBase>>,
  ) => {
    if (match.status !== "running") {
      budgetController.abort();
      return;
    }
    match.events.push({ ...eventBase(), ...event });
    if (limitReached()) {
      match.events.pop();
      finishMatch(match, "*", "event-limit", "error");
      budgetController.abort();
    }
  };
  const tools: AgentTool[] = [
    defineTool({
      name: "board",
      description: bundle.manifest.tools.board.description,
      inputSchema: promptToolInputs.board,
      execute: ({ representation }) => {
        const output = positionText(chess, representation);
        recordTool({
          type: "tool",
          name: "board",
          input: JSON.stringify({ representation }),
          output,
        });
        return output;
      },
    }),
  ];
  if (rules.legalMoves === "tool")
    tools.push(
      defineTool({
        name: "legal_moves",
        description: bundle.manifest.tools.legal_moves.description,
        inputSchema: promptToolInputs.legal_moves,
        execute: ({ square }) => {
          const output = legalMoves(chess, square).join(" ");
          recordTool({
            type: "tool",
            name: "legal_moves",
            input: JSON.stringify({ square }),
            output,
          });
          return output;
        },
      }),
    );
  let engineFailed = false;
  let engineCalls = 0;
  if (["tool", "both"].includes(rules.engineEvaluation))
    tools.push(
      defineTool({
        name: "engine_eval",
        description: bundle.manifest.tools.engine_eval.description,
        inputSchema: promptToolInputs.engine_eval,
        execute: async (_input, signal) => {
          let output: string;
          if (engineCalls >= rules.engineCallsPerTurn)
            output = JSON.stringify({ error: bundle.manifest.engineExhausted });
          else {
            engineCalls += 1;
            try {
              const evaluation = await evaluatePosition(chess.fen(), {
                nodes: rules.engineNodes,
                signal,
              });
              output = JSON.stringify(evaluation);
            } catch {
              output = JSON.stringify({ error: bundle.manifest.engineUnavailable });
              if (!signal?.aborted) {
                engineFailed = true;
                budgetController.abort();
              }
            }
          }
          recordTool({ type: "tool", name: "engine_eval", input: "{}", output });
          return output;
        },
      }),
    );
  // The tool set is fixed for the turn: serialize its schemas once, not per dispatch.
  const encoder = new TextEncoder();
  const toolSchemas = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: z.toJSONSchema(tool.inputSchema),
  }));
  const reserveFramingBytes = encoder.encode(
    systemPrompt + JSON.stringify(toolSchemas.map(({ name, schema }) => ({ name, schema }))),
  ).length;
  const budgetController = new AbortController();
  const turnSignal = options.signal
    ? AbortSignal.any([options.signal, budgetController.signal])
    : budgetController.signal;
  let nextDispatch = match.events.filter((event) => event.type === "reservation").length;
  let dispatch = nextDispatch;
  let sharedExceeded = false;
  let sharedEvent: Extract<MatchEvent, { type: "shared-usage" }> | undefined;
  /** Shared tokens of this side outside the current dispatch's output. */
  let sharedBaseline = 0;
  /** Latest streamed output whose exact count was skipped as provably under budget. */
  let uncountedOutput: AgentMessage[] | undefined;
  let initialMessageIds = new Set<string>();
  const countExactly = (output: AgentMessage[]) => {
    if (!sharedEvent) return;
    uncountedOutput = undefined;
    sharedEvent.outputTokens = sharedOutputTokens(output);
    // One boundary rule for every budget: exceeding it is the violation; reaching it is not.
    if (sharedBaseline + sharedEvent.outputTokens > rules.tokenBudget) {
      sharedExceeded = true;
      budgetController.abort();
    }
  };
  /** Settle a deferred count so recorded shared-usage stays exact. */
  const flushOutput = () => {
    if (uncountedOutput) countExactly(uncountedOutput);
  };
  const countOutput = (pending: AgentMessage[], final = false) => {
    if (!sharedEvent || sharedExceeded) return;
    const output = pending.filter(
      (entry) => entry.role === "assistant" && !initialMessageIds.has(entry.id),
    );
    // Aborted runtimes may return only seed messages; retain the last streamed count.
    if (!output.length) {
      if (final) flushOutput();
      return;
    }
    // A cl100k_base token spans at least one UTF-8 byte, so bytes upper-bound the count;
    // exact tokenization of every streamed delta is needed only near the budget.
    if (
      !final &&
      sharedBaseline + encoder.encode(sharedOutputText(output)).length <= rules.tokenBudget
    ) {
      uncountedOutput = output;
      return;
    }
    countExactly(output);
  };
  // Widened: closures assign it, so flow narrowing of the initializer would be wrong.
  let veto = "token-budget" as MatchArchive["termination"];
  /** The output ceiling of the latest dispatch, in tokens (what a cut-off reply hit). */
  let dispatchLimit: number | undefined;
  // "retry" keeps the turn going until a legal move; the per-move limit (always set),
  // the clock, the budgets and the archive limit still end it, so it is never endless.
  const retries = illegalPolicy(rules) === "retry";
  for (
    let attempt = 0;
    (retries || attempt < rules.maxAttempts) && match.status === "running";
    attempt += 1
  ) {
    // Even a vetoed or failed loop records timing; reserve its slot before entering.
    if (limitReached()) {
      finishMatch(match, "*", "event-limit", "error");
      break;
    }
    const before = matchStats(match, side);
    const clockLeft = clock === null ? Number.POSITIVE_INFINITY : clock - before.elapsedMs;
    const moveLeft = rules.turnTimeoutMs - (Date.now() - turnStarted);
    if (clockLeft <= 0 || moveLeft <= 0) {
      finishMatch(match, side === "w" ? "0-1" : "1-0", timeLimitHit(clockLeft, moveLeft));
      break;
    }
    const started = Date.now();
    const messagesBeforeAttempt = [...messages];
    try {
      const result = await runAgentLoop({
        model,
        systemPrompt,
        messages,
        tools,
        maxIterations: rules.maxDispatches,
        loopGuardMessages: promptLoopGuardMessages(match.config.prompt.version),
        // Every dispatch sets its own ceiling from onBeforeDispatch; this is never used.
        maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
        timeoutMs: Math.max(1, Math.min(moveLeft, clockLeft)),
        abortSignal: turnSignal,
        onMessagesChange: (pending) => countOutput(pending),
        prune: { enabled: false },
        // Both context modes reuse the stable instructions, settings and tools.
        // Persistent mode additionally reuses the growing per-side conversation.
        cache: true,
        cacheKey: `chess-${match.id}-${side}`,
        onBeforeDispatch: async ({ messages: pending }) => {
          flushOutput();
          if (limitReached()) {
            veto = "event-limit";
            return { veto: { reason: veto } };
          }
          // The conversation memory bound (see trimConversation): older turns make room
          // first; only a turn that alone outgrows it ends unscored, like the archive
          // limit (a system limit, not a forfeit).
          if (
            options.conversationMaxBytes !== undefined &&
            fitConversation(pending, options.conversationMaxBytes, turnMessage.id) >
              options.conversationMaxBytes
          ) {
            veto = "event-limit";
            return { veto: { reason: veto } };
          }
          const pendingBytes = encoder.encode(JSON.stringify(pending)).length;
          // Budgets count reported usage plus reservations not yet settled by a report.
          const current = matchStats(match, side);
          const limit = dispatchOutputLimit({
            inputBytes: pendingBytes + reserveFramingBytes,
            modelMaxOutputTokens: credential.maxOutputTokens,
            contextLength: credential.contextLength,
            replyCap: replyCap(rules),
            price: credential,
            remainingTokens:
              rules.tokenAccounting === "provider"
                ? rules.tokenBudget - current.committedTokens
                : Number.POSITIVE_INFINITY,
            remainingCostMicros: rules.costBudgetMicros - current.committedCostMicros,
          });
          const sharedInput =
            rules.tokenAccounting === "cl100k_base"
              ? sharedInputTokens(systemPrompt, pending, toolSchemas)
              : 0;
          if (
            ("veto" in limit && limit.veto === "token-budget") ||
            (rules.tokenAccounting === "cl100k_base" &&
              current.sharedInputTokens + current.sharedOutputTokens + sharedInput >
                rules.tokenBudget)
          ) {
            veto = "token-budget";
            return { veto: { reason: veto } };
          }
          if ("veto" in limit) {
            veto = limit.veto;
            return { veto: { reason: veto } };
          }
          const { tokens: tokenReserve, costMicros: costReserve } = limit;
          dispatchLimit = limit.maxOutputTokens;
          dispatch = nextDispatch;
          nextDispatch += 1;
          match.events.push({
            ...eventBase(),
            type: "reservation",
            dispatch,
            tokens: tokenReserve,
            costMicros: costReserve,
          });
          if (rules.tokenAccounting === "cl100k_base") {
            initialMessageIds = new Set(pending.map((entry) => entry.id));
            sharedBaseline = current.sharedInputTokens + current.sharedOutputTokens + sharedInput;
            sharedEvent = {
              ...eventBase(),
              type: "shared-usage",
              encoding: "cl100k_base",
              inputTokens: sharedInput,
              outputTokens: 0,
            };
            match.events.push(sharedEvent);
          }
          await options.onUpdate?.(match);
          return { maxOutputTokens: limit.maxOutputTokens };
        },
        onReply: (identity) => {
          match.events.push({
            ...eventBase(),
            type: "reply",
            dispatch,
            resolvedModel: identity.reportedModel ?? null,
            resolvedProvider: identity.reportedProvider ?? null,
          });
        },
        onUsage: (usage) => {
          const costMicros = Math.ceil(
            (usage.inputTokens * credential.inputMicrosPerMillion +
              usage.outputTokens * credential.outputMicrosPerMillion) /
              1000000,
          );
          match.events.push({
            ...eventBase(),
            type: "usage",
            dispatch,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            resolvedModel: usage.reportedModel ?? null,
            resolvedProvider: usage.reportedProvider ?? null,
            ...(usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: usage.cachedInputTokens }
              : {}),
            ...(usage.cacheCreationInputTokens !== undefined
              ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
              : {}),
            costMicros,
          });
        },
      }).finally(() => {
        // Record exactly once, including failures and usage-less completions, before
        // accepting a move changes the side/ply. Token/cost reservations stay separate.
        match.events.push({
          ...eventBase(),
          type: "timing",
          elapsedMs: Math.max(0, Date.now() - started),
        });
      });
      countOutput(result.messages, true);
      messages = result.messages;
      // The archive limit may already have ended the match from inside a tool.
      if (match.status !== "running") break;
      if (sharedExceeded) {
        finishMatch(match, side === "w" ? "0-1" : "1-0", "token-budget");
        break;
      }
      if (engineFailed) {
        finishMatch(match, "*", "engine-error", "error");
        break;
      }
      if (options.signal?.aborted || result.stopReason === "aborted") {
        finishAbortedMatch(match, options.signal);
        break;
      }
      if (result.stopReason === "timeout") {
        // The loop's timeout was the smaller of the two limits at this attempt's start.
        finishMatch(match, side === "w" ? "0-1" : "1-0", timeLimitHit(clockLeft, moveLeft));
        break;
      }
      if (result.stopReason === "vetoed") {
        // The archive limit is a system limit players are never told about, so it ends the
        // game unscored (like an engine or provider failure) rather than as a forfeit.
        if (veto === "event-limit") finishMatch(match, "*", "event-limit", "error");
        else finishMatch(match, side === "w" ? "0-1" : "1-0", veto);
        break;
      }
      const rejectedOutput = ["output-truncated", "max-iterations"].includes(result.stopReason);
      if (result.stopReason !== "completed" && !rejectedOutput) {
        finishMatch(match, "*", "provider-error", "error");
        break;
      }
      const last = messages.filter((entry) => entry.role === "assistant").at(-1);
      const raw = assistantText(last);
      // Incomplete output is a rejected attempt even if its prefix looks like a move.
      const reply: ReturnType<typeof readMoveReply> = rejectedOutput
        ? {
            move: result.stopReason === "output-truncated" ? "[truncated]" : "[unparseable]",
            comment: "",
          }
        : readMoveReply(raw, rules.moveFormat, chess);
      // The record of a rejected reply: this attempt's own last text, not an older turn's.
      const seen = new Set(messagesBeforeAttempt.map((entry) => entry.id));
      const replyText = redactIdentities(
        match,
        assistantText(
          messages.filter((entry) => entry.role === "assistant" && !seen.has(entry.id)).at(-1),
        ),
        rules.opponentIdentity === "hidden",
      );
      const { move } = reply;
      let { comment } = reply;
      if (move === "resign") {
        finishMatch(match, side === "w" ? "0-1" : "1-0", "resignation");
        break;
      }
      comment = redactIdentities(
        match,
        comment,
        rules.opponentIdentity === "hidden" && rules.remarks !== "off",
      );
      const event = submitMove(match, chess, move, comment, reply.normalizedFrom, {
        text: replyText,
        stopReason: result.stopReason as ReplyStopReason,
      });
      if (event.accepted) {
        const evaluation = await evaluateAfterMove(match, options, { chess, ply: ply + 1 });
        if (evaluation && rules.context === "persistent")
          messages.push(message(engineFeedback(evaluation, match.config.prompt.version)));
        break;
      }
      // Turn end persists accepted moves and terminal rejections; persist retries here.
      if (match.status === "running") await options.onUpdate?.(match);
      // Incomplete output can contain unpaired or truncated tool calls. Retry from
      // the seed history so providers never receive that failed conversation tail.
      if (rejectedOutput) messages = messagesBeforeAttempt;
      messages.push(
        message(
          rejectionMessage(
            {
              reason: event.reason ?? "unparseable",
              move: event.move,
              stopReason: event.stopReason,
              limitTokens: dispatchLimit,
              maxDispatches: rules.maxDispatches,
              tone: rules.remarks,
              attemptsLeft: retries ? null : rules.maxAttempts - attempt - 1,
            },
            match.config.prompt.version,
          ),
        ),
      );
    } catch (error) {
      flushOutput();
      if (match.status !== "running") {
        /* Already ended, e.g. by the archive limit. */
      } else if (sharedExceeded) finishMatch(match, side === "w" ? "0-1" : "1-0", "token-budget");
      else if (engineFailed) finishMatch(match, "*", "engine-error", "error");
      else if (options.signal?.aborted) finishAbortedMatch(match, options.signal);
      else finishMatch(match, "*", providerFailureTermination(error), "error");
      break;
    }
  }
  if (options.memory && rules.context === "persistent")
    options.memory[side] = trimConversation(messages, options.conversationMaxBytes);
  await options.onUpdate?.(match);
  return match;
}
/** The text parts of an assistant message, joined and trimmed ("" when there is none). */
function assistantText(entry: AgentMessage | undefined) {
  return (
    entry?.parts
      .filter((part) => part.type === "text")
      .map((part) => ("content" in part && typeof part.content === "string" ? part.content : ""))
      .join("")
      .trim() ?? ""
  );
}
/**
 * Replaces both players' names and model ids (3+ characters) with "[identity withheld]"
 * when `hidden`: the redaction remarks get under hidden identities, also applied to the
 * recorded text of rejected replies.
 */
function redactIdentities(match: MatchArchive, text: string, hidden: boolean) {
  if (!hidden) return text;
  let redacted = text;
  // Also the JSON-escaped spelling a raw reply may carry ("vendor\/model").
  for (const identity of [
    match.config.white.name,
    match.config.white.model,
    match.config.black.name,
    match.config.black.model,
  ].filter((value) => value.length >= 3))
    for (const spelling of new Set([identity, identity.replaceAll("/", "\\/")]))
      redacted = redacted.replace(
        new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
        "[identity withheld]",
      );
  return redacted;
}
/** The smallest reply a request is sent with (a JSON move and a remark fit well inside). */
export const MIN_REPLY_TOKENS = 256;
/**
 * One dispatch's output ceiling and reservation. The ceiling is the model's own maximum
 * (FALLBACK_MAX_OUTPUT_TOKENS when unknown), the room its context window leaves after
 * this request's input (when known), the ruleset's optional reply cap, and what
 * the side's remaining token and cost budgets can pay for one attempt of this request,
 * whichever is smallest, so a single attempt never spends more than the budgets. When
 * those budgets cannot pay for even MIN_REPLY_TOKENS (or the cap, when it is smaller),
 * the side has run out of that budget.
 */
export function dispatchOutputLimit(input: {
  inputBytes: number;
  modelMaxOutputTokens: number | null | undefined;
  contextLength?: number | null;
  replyCap: number | null;
  price: Pick<ProviderCredentials, "inputMicrosPerMillion" | "outputMicrosPerMillion">;
  remainingTokens: number;
  remainingCostMicros: number;
}):
  | { maxOutputTokens: number; tokens: number; costMicros: number }
  | { veto: "token-budget" | "cost-budget" } {
  const modelMax =
    typeof input.modelMaxOutputTokens === "number" &&
    Number.isFinite(input.modelMaxOutputTokens) &&
    input.modelMaxOutputTokens >= 1
      ? Math.floor(input.modelMaxOutputTokens)
      : FALLBACK_MAX_OUTPUT_TOKENS;
  const inputBound = input.inputBytes + DISPATCH_FRAMING_BYTES;
  // Input bytes upper-bound its tokens, so `room` is the least the window has left and
  // the ceiling never exceeds it. When even that bound says nothing is left, the true
  // input (ordinary text runs several bytes per token) usually still fits: the request
  // asks for at most a minimal reply, and a window that really is full is refused by
  // the provider (the game then ends unscored as a provider error, as any refusal does).
  const room =
    typeof input.contextLength === "number" && input.contextLength >= 1
      ? input.contextLength - inputBound
      : Number.POSITIVE_INFINITY;
  const contextRoom = room >= 1 ? room : MIN_REPLY_TOKENS;
  const ceiling = Math.min(modelMax, contextRoom, input.replyCap ?? Number.POSITIVE_INFINITY);
  const byTokens = input.remainingTokens - inputBound;
  // Whole output tokens whose price, with the input's, fits what is left: the same
  // combined (unrounded) sum dispatchReservation rounds up once.
  const costLeft =
    input.remainingCostMicros * 1_000_000 - inputBound * input.price.inputMicrosPerMillion;
  const byCost =
    input.price.outputMicrosPerMillion > 0
      ? Math.floor(costLeft / input.price.outputMicrosPerMillion)
      : costLeft >= 0
        ? Number.POSITIVE_INFINITY
        : -1;
  const floor = Math.min(MIN_REPLY_TOKENS, ceiling);
  if (byTokens < floor) return { veto: "token-budget" };
  if (byCost < floor) return { veto: "cost-budget" };
  const maxOutputTokens = Math.min(ceiling, byTokens, byCost);
  const reservation = dispatchReservation({
    inputBytes: input.inputBytes,
    maxOutputTokens,
    price: input.price,
    remainingTokens: input.remainingTokens,
    remainingCostMicros: input.remainingCostMicros,
  });
  if (reservation.tokens === null) return { veto: "token-budget" };
  if (reservation.costMicros === null) return { veto: "cost-budget" };
  return { maxOutputTokens, tokens: reservation.tokens, costMicros: reservation.costMicros };
}
/** Fixed input framing a dispatch may add beyond its messages and tool schemas, in bytes. */
const DISPATCH_FRAMING_BYTES = 4096;
/** The runtime's maximum transport attempts for one dispatch (a retried stream may bill). */
const TRANSPORT_ATTEMPTS = 3;
/**
 * The reservation one dispatch takes against a side's budgets, from the request's size,
 * the model's price and the dispatch's output ceiling (`dispatchOutputLimit`). UTF-8 bytes upper-bound ordinary text
 * tokenization (a reservation, not a claim about the provider's tokenizer).
 *
 * The full reservation covers every transport attempt. When that does not fit what
 * remains but one attempt's whole bound does, the call goes ahead with the reservation
 * capped to what remains: a single attempt never spends more than the budget, and only
 * a transport retry (rare) could. When not even one attempt fits, the side cannot
 * afford the call and its value is null (the caller ends the game on that budget).
 * Reported usage replaces the reservation when it settles, so the record stays exact.
 */
export function dispatchReservation(input: {
  inputBytes: number;
  maxOutputTokens: number;
  price: Pick<ProviderCredentials, "inputMicrosPerMillion" | "outputMicrosPerMillion">;
  remainingTokens: number;
  remainingCostMicros: number;
}): { tokens: number | null; costMicros: number | null } {
  const inputBound = input.inputBytes + DISPATCH_FRAMING_BYTES;
  const oneTokens = inputBound + input.maxOutputTokens;
  const oneCost = Math.ceil(
    (inputBound * input.price.inputMicrosPerMillion +
      input.maxOutputTokens * input.price.outputMicrosPerMillion) /
      1_000_000,
  );
  const fit = (one: number, remaining: number) =>
    one > remaining ? null : Math.min(one * TRANSPORT_ATTEMPTS, remaining);
  return {
    tokens: fit(oneTokens, input.remainingTokens),
    costMicros: fit(oneCost, input.remainingCostMicros),
  };
}
/** The smaller of the whole-game clock and per-move safety limit owns the timeout. */
function timeLimitHit(clockLeft: number, moveLeft: number): "timeout" | "move-timeout" {
  return clockLeft <= moveLeft ? "timeout" : "move-timeout";
}
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
// A bounded move token may be archived even when illegal; free text must never be.
const SAN_MOVE = /^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?$/;
function moveToken(move: string) {
  return move === "resign" || UCI_MOVE.test(move) || SAN_MOVE.test(move)
    ? move.slice(0, 256)
    : "[unparseable]";
}
/** Extra keys are ignored and submitMove truncates the comment. */
const replySchema = z.object({ move: z.string().max(256), comment: z.string().optional() });
type Reply = z.infer<typeof replySchema>;
/**
 * Bounds the lenient scan of a reply: characters read (the reply's end, where a long
 * reply puts its answer) and candidate objects parsed.
 */
const LENIENT_SCAN_CHARS = 32000;
const LENIENT_PARSE_ATTEMPTS = 64;

function parseReplyJson(text: string): Reply | null {
  try {
    return replySchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Where the object opening at `start` closes (one past its `}`), or -1. String-aware
 * from that brace on, so whatever came before it (even a cut-off string) cannot
 * mislead it.
 */
function objectEnd(text: string, start: number) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  return -1;
}
/** Opening braces tried from the end, so the work stays bounded. */
const LENIENT_OBJECT_CANDIDATES = 256;

/**
 * Finds one `{move, comment?}` object in a reply's last LENIENT_SCAN_CHARS characters
 * (replies may run to the model's own output limit: analysis first, the answer last):
 * the last fenced block that parses, else the last-closing object that does (so an
 * enclosing answer wins over an object nested in it). The window may begin inside an
 * earlier string or fence, so fences pair from the end and each candidate object is
 * read forward from its own opening brace (the latest braces, bounded). Bounded
 * candidates and parse attempts, no regex backtracking.
 */
function extractReplyJson(raw: string): Reply | null {
  const text = raw.slice(-LENIENT_SCAN_CHARS);
  const marks: number[] = [];
  for (let at = text.indexOf("```"); at !== -1; at = text.indexOf("```", at + 3)) marks.push(at);
  let attempts = 0;
  for (let close = marks.length - 1; close >= 1; close -= 2) {
    if (++attempts > LENIENT_PARSE_ATTEMPTS) return null;
    const block = text
      .slice((marks[close - 1] as number) + 3, marks[close])
      .replace(/^json\b/i, "");
    const parsed = parseReplyJson(block.trim());
    if (parsed) return parsed;
  }
  const spans: Array<[number, number]> = [];
  let start = text.lastIndexOf("{");
  for (let tried = 0; start !== -1 && tried < LENIENT_OBJECT_CANDIDATES; tried += 1) {
    const end = objectEnd(text, start);
    if (end !== -1) spans.push([start, end]);
    start = start > 0 ? text.lastIndexOf("{", start - 1) : -1;
  }
  // Last-closing first; of two closing together, the wider (enclosing) one.
  spans.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  for (const [from, to] of spans) {
    if (++attempts > LENIENT_PARSE_ATTEMPTS) return null;
    const parsed = parseReplyJson(text.slice(from, to));
    if (parsed) return parsed;
  }
  return null;
}

/** A legal SAN move in the current position as UCI, checked on a throwaway board. */
function sanToUci(chess: Chess, move: string): { move: string; san: string } | null {
  try {
    const played = new Chess(chess.fen()).move(move.trim());
    return { move: `${played.from}${played.to}${played.promotion ?? ""}`, san: played.san };
  } catch {
    return null;
  }
}

/**
 * Turns the final assistant text into the submitted move. Strict: a whole-reply JSON
 * object (optionally code-fenced), else a bare move token. Lenient additionally
 * extracts embedded JSON and converts legal SAN. Only move tokens are archived;
 * unparseable prose becomes a literal placeholder, including in normalization metadata.
 */
function readMoveReply(
  raw: string,
  moveFormat: Rules["moveFormat"],
  chess: Chess,
): { move: string; comment: string; normalizedFrom?: string } {
  const strict = parseReplyJson(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const move = moveToken(strict?.move ?? raw);
  const comment = strict?.comment ?? "";
  if (moveFormat !== "lenient" || move === "resign" || UCI_MOVE.test(move))
    return { move, comment };
  const candidate = strict ?? extractReplyJson(raw) ?? { move: raw };
  const candidateMove = candidate.move.trim();
  // chess.js accepts annotated SAN, zero-based castling and long algebraic moves.
  // Parse before filtering tokens, but archive only its canonical SAN, never prose.
  const parsed = sanToUci(chess, candidateMove);
  const lenientMove =
    candidateMove === "resign" || UCI_MOVE.test(candidateMove)
      ? candidateMove
      : (parsed?.move ?? moveToken(candidateMove));
  if (lenientMove === move || lenientMove === "[unparseable]") return { move, comment };
  return {
    move: lenientMove,
    comment: candidate.comment ?? "",
    normalizedFrom:
      candidateMove === "resign" || UCI_MOVE.test(candidateMove)
        ? candidateMove
        : moveToken(parsed?.san ?? candidateMove),
  };
}
export async function runMatch(match: MatchArchive, options: MatchRunnerOptions = {}) {
  options.memory ??= {};
  // runMatch is the only mutator while it runs, so one replayed board serves every turn.
  const chess = boardAt(match);
  while (match.status === "running") {
    const player = chess.turn() === "w" ? match.config.white : match.config.black;
    if (player.protocol === "human") break;
    await advanceMatch(match, options, chess);
  }
  return match;
}
