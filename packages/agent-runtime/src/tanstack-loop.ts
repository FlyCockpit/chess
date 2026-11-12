import {
  chat,
  convertMessagesToModelMessages,
  fromSpecTokenUsage,
  maxIterations,
  type StreamChunk,
  StreamProcessor,
  toolDefinition,
  type UIMessage,
} from "@tanstack/ai";

import { createModelAdapter, outputTokenOptions, resolveMaxOutputTokens } from "./adapters";
import { pruneAgentMessages } from "./context-prune";
import { isDeadlineAbort, startDeadline } from "./deadline";
import { AgentRuntimeError, FatalToolError } from "./errors";
import {
  isTruncatedFinish,
  normalizeFinishReason,
  runErrorTruncationReason,
} from "./finish-reason";
import { LoopGuard } from "./loop-guard";
import { MAX_FAILOVER_CANDIDATES, toModelRuntimeError } from "./retry";
import { createRetryFailoverAdapter } from "./retry-adapter";
import { executeToolWithAbort } from "./tool-execution";
import { buildRetrieveToolResultTool, serializeToolResultWithStore } from "./tools";
import type { AgentLoopOptions, AgentMessage, AgentMessagePart, AgentUsage } from "./types";

export interface TanstackLoopResult {
  messages: AgentMessage[];
  usage: AgentUsage;
  hitIterationLimit: boolean;
  /**
   * The model's output hit the token ceiling (any provider spelling of `length`), so its
   * final message — plausibly a long tool call — was cut off mid-stream. Never a clean
   * finish; see the `"output-truncated"` stop reason.
   */
  outputTruncated?: boolean;
  /** Raw provider finish reason of the last completed dispatch, when reported. */
  finishReason?: string;
  /** The wall-clock deadline elapsed. */
  timedOut?: boolean;
  /** The caller's abort signal fired between or during dispatches (not the deadline). */
  aborted?: boolean;
  vetoed?: boolean;
  vetoReason?: string;
}

const toUIMessage = (message: AgentMessage): UIMessage => ({
  id: message.id,
  role: message.role,
  parts: message.parts as UIMessage["parts"],
  createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
  ...(message.metadata ? { metadata: message.metadata } : {}),
});

/** Read the first present, finite numeric field from a raw usage object; else undefined. */
const numericField = (source: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/**
 * Did the provider actually report token counts? TanStack's `fromSpecTokenUsage`
 * zero-fills missing fields, so the normalized object cannot answer this — a missing
 * count would be booked as a real 0. Missing usage is UNKNOWN, not free: only a raw
 * usage carrying an input or output number counts.
 */
const reportsTokenCounts = (rawUsage: unknown, leftover: unknown): boolean => {
  const keys = ["inputTokens", "outputTokens", "promptTokens", "completionTokens"];
  const entries = Array.isArray(rawUsage) ? rawUsage : [rawUsage];
  return [...entries, leftover].some((entry) => {
    const record = asRecord(entry);
    return record !== undefined && numericField(record, keys) !== undefined;
  });
};

// AG-UI `activity` messages are frontend-only render state — never model input or a
// stored turn — so they are dropped rather than widening `AgentMessage.role`.
const fromUIMessages = (messages: UIMessage[]): AgentMessage[] =>
  messages.flatMap((message) =>
    message.role === "activity"
      ? []
      : [
          {
            id: message.id,
            role: message.role,
            parts: message.parts as unknown as AgentMessagePart[],
            createdAt: message.createdAt?.toISOString(),
            ...(message.metadata ? { metadata: message.metadata } : {}),
          },
        ],
  );

/**
 * Storage role for one turn. `AgentMessage.role` has no `"tool"` member — a tool
 * result arrives as a message whose parts are all `tool-result` — so it is derived
 * here rather than invented at each call site.
 */
const turnRole = (message: AgentMessage): string =>
  message.parts.length > 0 && message.parts.every((part) => part.type === "tool-result")
    ? "tool"
    : message.role;

/**
 * Run the harness loop.
 *
 * `usage` is the accumulator token counts are added to as each dispatch reports them.
 * The caller may pass its own so it can still read the partial usage when this throws
 * (abort, deadline, provider failure) — tokens billed before the stop are real.
 */
export const executeTanstackLoop = async (
  options: AgentLoopOptions,
  abortController: AbortController,
  usage: AgentUsage = { inputTokens: 0, outputTokens: 0 },
): Promise<TanstackLoopResult> => {
  let currentMessages: AgentMessage[] = options.messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => ({ ...p })),
  }));
  let fatalError: FatalToolError | undefined;
  let runCount = 0;
  let finalFinishReason: string | null = null;
  let outputTruncated = false;

  // ── onMessagesChange delivery ─────────────────────────────────────────────────
  // Coalescing, not queueing: at most one callback in flight plus the LATEST pending
  // snapshot. Intermediate snapshots may be skipped (each is a full message array, so
  // a newer one supersedes an older), but the last one scheduled is always delivered.
  // The pump never rejects — the first callback error is captured and rethrown after
  // a successful loop, so a failing callback still fails the run, but can never
  // surface as an unhandled rejection (the worker treats those as fatal).
  let pendingSnapshot: AgentMessage[] | undefined;
  let callbackInFlight: Promise<void> | undefined;
  let callbackFailed = false;
  let callbackError: unknown;
  const pumpMessageCallbacks = async (): Promise<void> => {
    try {
      while (pendingSnapshot !== undefined) {
        const snapshot = pendingSnapshot;
        pendingSnapshot = undefined;
        try {
          await options.onMessagesChange?.(snapshot);
        } catch (error) {
          if (!callbackFailed) {
            callbackFailed = true;
            callbackError = error;
          }
        }
      }
    } finally {
      // Same synchronous step as the final empty-queue check, so a snapshot
      // scheduled after it always starts a fresh pump.
      callbackInFlight = undefined;
    }
  };
  const scheduleMessagesChange = (snapshot: AgentMessage[]) => {
    if (!options.onMessagesChange) return;
    pendingSnapshot = snapshot;
    callbackInFlight ??= pumpMessageCallbacks();
  };
  const drainMessageCallbacks = async (): Promise<void> => {
    while (callbackInFlight) await callbackInFlight;
  };
  /** Drain, then fail the run with the first callback error, if any. */
  const settleMessageCallbacks = async (): Promise<void> => {
    await drainMessageCallbacks();
    if (callbackFailed) throw callbackError;
  };
  let lastDispatchAt: number | null = null;
  // `null` maxIterations = unlimited; the deadline and the loop guard are then the
  // only backstops (see AgentLoopOptions.maxIterations).
  const iterationCap =
    options.maxIterations === null ? Number.POSITIVE_INFINITY : options.maxIterations;

  // When a store is injected, register `retrieve_tool_result` so the agent can page
  // any body that overflowed a tool's cap.
  const runtimeTools = options.resultStore
    ? [...options.tools, buildRetrieveToolResultTool(options.resultStore)]
    : options.tools;

  // Back-to-back identical tool calls waste iterations; the guard synthesizes a
  // stable error result instead of re-executing. Even tools whose results could
  // change from *sibling* agents cannot observe new writes from *this* agent
  // without an intervening call — so consecutive identical calls are safe to block.
  // ── Per-turn observability ────────────────────────────────────────────────────
  // `seq` is the APPEND ORDER of turns, not a position in `currentMessages`. Two
  // things make a positional scheme wrong: the pre-dispatch prune pass rewrites
  // message bodies in place (and may in future compact them), and the stream
  // processor returns a freshly constructed array on every dispatch. Tracking which
  // messages have already been announced by IDENTITY keeps `seq` stable and monotonic
  // across both. The counter only ever moves forward.
  let nextTurnSeq = 0;
  const announcedTurns = new Set<string>();
  const turnKey = (message: AgentMessage, index: number): string =>
    message.id ? `id:${message.id}` : `pos:${index}:${message.role}`;

  /**
   * Announce every message not yet seen, in array order. Never throws: an
   * observability hook must not be able to fail the agent loop.
   */
  const announceTurns = async (messages: AgentMessage[]): Promise<void> => {
    const onTurn = options.onTurn;
    if (!onTurn) return;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) continue;
      const key = turnKey(message, index);
      if (announcedTurns.has(key)) continue;
      announcedTurns.add(key);
      const seq = nextTurnSeq;
      nextTurnSeq += 1;
      try {
        await onTurn({ seq, role: turnRole(message), message });
      } catch (error) {
        console.warn(`[agent-runtime] onTurn hook failed at seq=${seq}`, error);
      }
    }
  };

  const loopGuard = new LoopGuard(options.loopGuardThreshold);
  const allToolNames = runtimeTools.map((tool) => tool.name);

  const tools = runtimeTools.map((tool) =>
    toolDefinition({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }).server(async (input) => {
      const guarded = loopGuard.check(tool.name, input, allToolNames);
      if (guarded !== null) {
        return guarded;
      }
      try {
        // Raced against the run's abort signal, which the deadline fires. A
        // tool that never settles would otherwise hold the loop open forever
        // and the wall-clock bound would not exist — see tool-execution.ts.
        // Nothing below this line runs for an abandoned call, so a late result
        // can never be stored, returned, or announced.
        const output = await executeToolWithAbort(tool, input, abortController.signal);
        return await serializeToolResultWithStore(output, tool.maxResultChars, {
          store: options.resultStore,
          untrusted: tool.untrusted,
        });
      } catch (error) {
        if (error instanceof FatalToolError) {
          fatalError = error;
          abortController.abort(error);
        }
        throw error;
      }
    }),
  );

  const cacheOpts = {
    enabled: options.cache !== false,
    cacheKey: options.cacheKey,
  };
  // TanStack AI 1.0 requires an AG-UI `threadId` on every chat() call, and uses it as
  // the default automatic prompt-cache key. One id per loop keeps every dispatch of
  // this agent on the same conversation; it is never persisted or sent as content.
  const threadId = `agent-${crypto.randomUUID()}`;
  // TanStack AI applies automatic prompt caching by default (`'short'`): Anthropic and
  // Anthropic-via-OpenRouter requests get `cache_control` breakpoints, OpenRouter gets
  // a `sessionId`, OpenAI gets `prompt_cache_key`. Under 0.69 the `cache: false` option
  // was silently ignored, so those markers were still sent; it now maps to `'none'` and
  // really disables them. Otherwise the caller's stable prefix key (shared by sibling
  // requests) wins over the per-loop id.
  const promptCache = cacheOpts.enabled
    ? { retention: "short" as const, ...(options.cacheKey ? { key: options.cacheKey } : {}) }
    : ("none" as const);
  const maxOutputTokens = resolveMaxOutputTokens(options.maxOutputTokens);
  const modelCandidates = [options.model, ...(options.fallbackModels ?? [])].slice(
    0,
    MAX_FAILOVER_CANDIDATES,
  );
  const { adapter, modelOptions, getServingModelId } = createRetryFailoverAdapter({
    candidates: modelCandidates.map((model) => {
      const bundle = createModelAdapter(model, cacheOpts);
      const ceiling = outputTokenOptions(model, maxOutputTokens);
      return {
        ...bundle,
        ...(ceiling ? { modelOptions: { ...bundle.modelOptions, ...ceiling } } : {}),
        modelId: model.model,
      };
    }),
    abortSignal: abortController.signal,
    onFailover: (serving, primary) => {
      console.warn(`[agent-runtime] model failover: primary=${primary} serving=${serving}`);
    },
  });

  // Wall-clock backstop. Expiry aborts the same controller the dispatch already uses,
  // so an in-flight stream is cut off instead of running to completion.
  const deadline = startDeadline(options, abortController);
  let timedOut = false;
  let aborted = false;
  /** Classify an abort of the shared controller: deadline expiry or caller cancel. */
  const recordAbort = () => {
    if (isDeadlineAbort(abortController.signal.reason)) timedOut = true;
    else aborted = true;
  };

  // Settlement can cross the deadline even after a terminal stream event. Check the
  // clock synchronously as well: CPU work may finish before the timer gets to run.
  const settleStop = () => {
    if (deadline.expired()) timedOut = true;
    if (abortController.signal.aborted) recordAbort();
    return timedOut || aborted;
  };

  try {
    // The seed messages are turns too: without them the persisted history opens
    // mid-conversation, with no record of the prompt the node was actually given.
    await announceTurns(currentMessages);

    // Harness-driven iterations so we own the message array between dispatches
    // (onBeforeDispatch + prune seam). Each chat() call runs a single model turn.
    for (let iteration = 0; iteration < iterationCap; iteration += 1) {
      if (deadline.expired()) {
        timedOut = true;
        break;
      }
      if (abortController.signal.aborted) {
        recordAbort();
        break;
      }

      // Built-in prune pass (first registered use of the pre-dispatch seam).
      if (options.prune?.enabled !== false && options.resultStore) {
        const pruneStats = await pruneAgentMessages(currentMessages, options.resultStore, {
          enabled: options.prune?.enabled,
          cacheTtlMs: options.prune?.cacheTtlMs,
          tokenThreshold: options.prune?.tokenThreshold,
          lastDispatchAt,
        });
        if (pruneStats.ran) {
          await options.onPruneStats?.(pruneStats);
        }
      }

      const hookResult = await options.onBeforeDispatch?.({
        messages: currentMessages,
        iteration,
        lastDispatchAt,
      });
      if (hookResult && typeof hookResult === "object" && "veto" in hookResult) {
        await settleMessageCallbacks();
        return {
          messages: currentMessages,
          usage,
          hitIterationLimit: false,
          // An explicit veto owns this stop even if its hook crossed the deadline.
          // Callers distinguish unscored limits from a timed-out model's forfeit.
          vetoed: true,
          vetoReason: hookResult.veto.reason,
        };
      }

      // The prune pass and the hook are awaited, so a cancel or the deadline can land
      // during them: do not start a dispatch the run no longer wants.
      if (settleStop()) break;

      lastDispatchAt = Date.now();
      // Per-dispatch state: a previous dispatch's finish must never be mistaken for
      // this one's (e.g. a stale "tool-calls" from a stream that ended silently).
      finalFinishReason = null;
      outputTruncated = false;
      let sawTerminal = false;
      let sawUsage = false;
      const uiMessages = currentMessages.map(toUIMessage);
      const processor = new StreamProcessor({
        initialMessages: uiMessages,
        events: {
          onMessagesChange: (messages) => {
            const serializable = fromUIMessages(messages);
            currentMessages = serializable;
            scheduleMessagesChange(serializable);
          },
        },
      });

      // SDK diagnostics must not corrupt CLI JSON or dump request credentials.
      const logDiagnostic = (message: string, meta?: Record<string, unknown>) => {
        const detail = meta?.error instanceof Error ? meta.error.message : "";
        let text = [message, detail].filter(Boolean).join(": ");
        for (const model of [options.model, ...(options.fallbackModels ?? [])])
          if (model.apiKey) text = text.replaceAll(model.apiKey, "[redacted]");
        console.error("[agent-runtime]", text.slice(0, 1000));
      };
      const stream = chat({
        adapter,
        messages: convertMessagesToModelMessages(uiMessages),
        threadId,
        promptCache,
        systemPrompts: [options.systemPrompt],
        tools,
        abortController,
        agentLoopStrategy: maxIterations(1),
        debug: {
          errors: true,
          provider: false,
          output: false,
          middleware: false,
          tools: false,
          agentLoop: false,
          config: false,
          request: false,
          sandbox: false,
          logger: {
            debug: logDiagnostic,
            info: logDiagnostic,
            warn: logDiagnostic,
            error: logDiagnostic,
          },
        },
        ...(modelOptions ? { modelOptions } : {}),
      });

      async function* observe(): AsyncIterable<StreamChunk> {
        for await (const chunk of stream) {
          await options.onChunk?.(chunk);
          // Adapters may encode truncation as RUN_ERROR rather than RUN_FINISHED.
          // Other stream failures must throw: StreamProcessor's UI callback alone
          // does not stop a caller from treating a closed error stream as success.
          if (chunk.type === "RUN_ERROR") {
            const reason = runErrorTruncationReason(chunk);
            if (reason) {
              sawTerminal = true;
              outputTruncated = true;
              finalFinishReason = reason;
            } else {
              throw toModelRuntimeError(chunk);
            }
          }
          if (chunk.type === "RUN_FINISHED") {
            sawTerminal = true;
            runCount += 1;
            finalFinishReason =
              chunk.finishReason ?? chunk.metadata?.tanstack?.finishReason ?? null;
            if (isTruncatedFinish(chunk) || isTruncatedFinish(chunk.metadata?.tanstack)) {
              outputTruncated = true;
            }
          }
          if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR") {
            // AG-UI reports an array; the public normalizer also restores cache details
            // from TanStack metadata. Older adapters still report the legacy object.
            const leftover = chunk.metadata?.tanstack?.usage;
            const tokenUsage = Array.isArray(chunk.usage)
              ? fromSpecTokenUsage(chunk.usage, leftover)
              : chunk.usage;
            if (tokenUsage && reportsTokenCounts(chunk.usage, leftover)) {
              sawUsage = true;
              const turnUsage: AgentUsage = {
                inputTokens: tokenUsage.promptTokens,
                outputTokens: tokenUsage.completionTokens,
                model: getServingModelId(),
              };
              const rawUsage = tokenUsage as unknown as Record<string, unknown>;
              const cachedInputTokens =
                tokenUsage.promptTokensDetails?.cachedTokens ??
                numericField(rawUsage, ["cachedTokens", "cached_tokens"]);
              const cacheCreationInputTokens =
                tokenUsage.promptTokensDetails?.cacheWriteTokens ??
                numericField(rawUsage, [
                  "cacheCreationTokens",
                  "cache_creation_input_tokens",
                  "cacheCreationInputTokens",
                ]);
              if (cachedInputTokens !== undefined) {
                turnUsage.cachedInputTokens = cachedInputTokens;
                usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + cachedInputTokens;
              }
              if (cacheCreationInputTokens !== undefined) {
                turnUsage.cacheCreationInputTokens = cacheCreationInputTokens;
                usage.cacheCreationInputTokens =
                  (usage.cacheCreationInputTokens ?? 0) + cacheCreationInputTokens;
              }
              usage.inputTokens += turnUsage.inputTokens;
              usage.outputTokens += turnUsage.outputTokens;
              if (usage.model === undefined) usage.model = turnUsage.model;
              await options.onUsage?.(turnUsage);
            }
          }
          yield chunk;
        }
      }

      try {
        await processor.process(observe());
      } catch (error) {
        if (fatalError) throw fatalError;
        throw error;
      } finally {
        // A dispatch that reported no token counts — finished, failed or cut off —
        // still may have been billed. Say so rather than letting a 0 pass as a count.
        if (!sawUsage) usage.usageIncomplete = true;
      }
      if (fatalError) throw fatalError;

      if (!sawTerminal) {
        // The stream closed without RUN_FINISHED or RUN_ERROR. If the run was
        // aborted, that is the abort cutting it off; otherwise the provider stream
        // ended early, and treating it as a clean finish would hide a failure.
        if (abortController.signal.aborted) {
          recordAbort();
          break;
        }
        throw new AgentRuntimeError("Model stream ended without a terminal event", {
          retryable: true,
        });
      }

      currentMessages = fromUIMessages(processor.getMessages());

      // Only now — the dispatch completed. Provider stream errors throw above,
      // so partial assistant output from a failed dispatch is not announced as a
      // completed turn. Truncated output is retained with its explicit stop reason.
      await announceTurns(currentMessages);
      if (settleStop()) break;

      // A truncated turn is never a reason to dispatch again: whatever the model was
      // emitting (very plausibly a long tool call) is incomplete, and the caller must be
      // told rather than shown a clean-looking stop.
      if (outputTruncated) break;

      // Continue only when the model requested more tools.
      if (normalizeFinishReason(finalFinishReason) !== "tool-calls") break;
    }

    await settleMessageCallbacks();
    if (fatalError) throw fatalError;
    settleStop();

    return {
      messages: currentMessages,
      usage,
      hitIterationLimit:
        !outputTruncated &&
        !timedOut &&
        !aborted &&
        runCount >= iterationCap &&
        normalizeFinishReason(finalFinishReason) === "tool-calls",
      ...(outputTruncated ? { outputTruncated: true } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      ...(aborted && !timedOut ? { aborted: true } : {}),
      ...(finalFinishReason !== null ? { finishReason: finalFinishReason } : {}),
    };
  } finally {
    deadline.cancel();
    // Never settle with a callback still running — on the throw path too.
    await drainMessageCallbacks();
  }
};
