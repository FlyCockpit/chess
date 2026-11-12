import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { isDeadlineAbort } from "./deadline";
import type { AgentLoopOptions } from "./types";

// Capture the options passed to the mocked @tanstack/ai `chat()` so we can assert that
// tanstack-loop stays provider-agnostic and merely forwards the adapter's modelOptions.
const chatCalls: Array<Record<string, unknown>> = [];
let scriptedChunks: Array<Record<string, unknown>> = [];
/** Per-chunk delay, so a dispatch can outlive a wall-clock deadline in tests. */
let chunkDelayMs = 0;
/**
 * Messages the fake StreamProcessor appends per dispatch — `scriptedAppends[n]` is
 * what dispatch `n` adds to the conversation. Drives the onTurn tests.
 */
let scriptedAppends: Array<Array<Record<string, unknown>>> = [];
let dispatchIndex = 0;
/** Mutates the harness message array before a dispatch appends, as prune does. */
let onProcessStart: ((messages: unknown[]) => void) | null = null;
/**
 * The tool executors the loop handed to `toolDefinition().server(...)`, in
 * registration order. Real `chat()` calls these when the model asks for a tool;
 * the fake dispatch below does the same when `toolCallDuringDispatch` is set.
 */
let serverExecutors: Array<(input: unknown) => Promise<unknown>> = [];
let toolCallDuringDispatch: { index: number; input: unknown } | null = null;

vi.mock("@tanstack/ai", async (importOriginal) => {
  class StreamProcessor {
    private readonly messages: unknown[];
    private readonly onMessagesChange?: (messages: unknown[]) => void;
    constructor(config: {
      initialMessages: unknown[];
      events?: { onMessagesChange?: (messages: unknown[]) => void };
    }) {
      this.messages = config.initialMessages;
      this.onMessagesChange = config.events?.onMessagesChange;
    }
    async process(iterable: AsyncIterable<unknown>) {
      // Drive the observe() wrapper so its RUN_FINISHED handling (usage/onUsage) runs.
      for await (const _chunk of iterable) {
        // no-op; consuming the stream is the point
      }
      onProcessStart?.(this.messages);
      const appended = scriptedAppends[dispatchIndex] ?? [];
      for (const message of appended) {
        this.messages.push(message);
      }
      if (appended.length > 0) this.onMessagesChange?.([...this.messages]);
      dispatchIndex += 1;
    }
    getMessages() {
      return this.messages;
    }
  }
  return {
    ...(await importOriginal<typeof import("@tanstack/ai")>()),
    StreamProcessor,
    chat: (options: Record<string, unknown>) => {
      chatCalls.push(options);
      return (async function* () {
        if (toolCallDuringDispatch) {
          const { index, input } = toolCallDuringDispatch;
          // Mid-stream, exactly where a real tool call happens: the dispatch
          // cannot finish until the tool does.
          await serverExecutors[index]?.(input);
        }
        for (const chunk of scriptedChunks) {
          if (chunkDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
          }
          yield chunk;
        }
      })();
    },
    convertMessagesToModelMessages: (messages: unknown[]) => messages,
    maxIterations: (n: number) => ({ kind: "maxIterations", n }),
    toolDefinition: () => ({
      server: (execute: (input: unknown) => Promise<unknown>) => {
        serverExecutors.push(execute);
        return { __tool: true };
      },
    }),
  };
});

const createModelAdapter = vi.fn();
// Only the provider-factory seam is faked; the real output-ceiling policy
// (resolveMaxOutputTokens / DEFAULT_MAX_OUTPUT_TOKENS) must stay under test.
vi.mock("./adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./adapters")>()),
  createModelAdapter,
}));

const { executeTanstackLoop } = await import("./tanstack-loop");
// The real caller-facing entry point, over the real loop — the stop reason a
// consumer actually sees is part of what the deadline test asserts.
const { runAgentLoop } = await import("./loop");
// Imported after the mocks are registered (the factory spreads the real module, so this
// is the real policy constant).
const { DEFAULT_MAX_OUTPUT_TOKENS } = await import("./adapters");

const baseOptions = (overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions => ({
  model: { provider: "openai-responses", model: "gpt-4o", apiKey: "k" },
  systemPrompt: "system",
  messages: [{ id: "u", role: "user", parts: [{ type: "text", content: "hi" }] }],
  tools: [],
  maxIterations: 4,
  ...overrides,
});

beforeEach(() => {
  chatCalls.length = 0;
  // A clean, usage-less finish: every real dispatch ends with a terminal event, and a
  // stream that does not is an error (see "provider stream errors").
  scriptedChunks = [{ type: "RUN_FINISHED", finishReason: "stop" }];
  chunkDelayMs = 0;
  scriptedAppends = [];
  dispatchIndex = 0;
  onProcessStart = null;
  serverExecutors = [];
  toolCallDuringDispatch = null;
  createModelAdapter.mockReset();
  createModelAdapter.mockReturnValue({
    adapter: { name: "fake" },
    modelOptions: { prompt_cache_key: "run-1:person" },
  });
});

describe("executeTanstackLoop cache wiring", () => {
  it("forwards the adapter's modelOptions to chat() and passes the cache flags through", async () => {
    await executeTanstackLoop(
      baseOptions({ cacheKey: "run-1:person", cache: true }),
      new AbortController(),
    );
    expect(createModelAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai-responses" }),
      { enabled: true, cacheKey: "run-1:person" },
    );
    expect(chatCalls[0]?.modelOptions).toEqual({
      prompt_cache_key: "run-1:person",
      max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });
  });

  it("treats an unset cache flag as enabled and a false flag as the off-switch", async () => {
    await executeTanstackLoop(baseOptions({ cacheKey: "k" }), new AbortController());
    expect(createModelAdapter.mock.calls[0]?.[1]).toEqual({ enabled: true, cacheKey: "k" });

    await executeTanstackLoop(baseOptions({ cacheKey: "k", cache: false }), new AbortController());
    expect(createModelAdapter.mock.calls[1]?.[1]).toEqual({ enabled: false, cacheKey: "k" });
  });

  // TanStack AI 1.0: chat() requires a threadId and turns automatic prompt caching on
  // by default, keyed by the threadId unless a key is given.
  it("gives every dispatch of one loop the same threadId and keys the prompt cache by cacheKey", async () => {
    scriptedChunks = [{ type: "RUN_FINISHED", finishReason: "tool_calls" }];
    await executeTanstackLoop(
      baseOptions({ cacheKey: "run-1:person", maxIterations: 2 }),
      new AbortController(),
    );
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0]?.threadId).toEqual(expect.stringMatching(/^agent-/));
    expect(chatCalls[1]?.threadId).toBe(chatCalls[0]?.threadId);
    expect(chatCalls[0]?.promptCache).toEqual({ retention: "short", key: "run-1:person" });

    await executeTanstackLoop(baseOptions({ maxIterations: 1 }), new AbortController());
    expect(chatCalls[2]?.threadId).not.toBe(chatCalls[0]?.threadId);
    expect(chatCalls[2]?.promptCache).toEqual({ retention: "short" });
  });

  it("maps the cache off-switch to promptCache 'none' so 1.0's default caching stays off", async () => {
    await executeTanstackLoop(baseOptions({ cacheKey: "k", cache: false }), new AbortController());
    expect(chatCalls[0]?.promptCache).toBe("none");
  });

  it("omits modelOptions from chat() when the adapter returns none", async () => {
    createModelAdapter.mockReturnValue({ adapter: { name: "fake" } });
    await executeTanstackLoop(baseOptions({ maxOutputTokens: null }), new AbortController());
    expect(chatCalls[0]).not.toHaveProperty("modelOptions");
  });

  it("surfaces provider cache token counts through onUsage when present", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "stop",
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          cachedTokens: 80,
          cacheCreationTokens: 15,
        },
      },
    ];
    const onUsage = vi.fn();
    const result = await executeTanstackLoop(baseOptions({ onUsage }), new AbortController());
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 80,
      cacheCreationInputTokens: 15,
      model: "gpt-4o",
    });
    expect(result.usage.cachedInputTokens).toBe(80);
    expect(result.usage.cacheCreationInputTokens).toBe(15);
  });

  it("aggregates AG-UI usage and cache counts without counting metadata twice", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        usage: [
          { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
          { inputTokens: 30, outputTokens: 5, cachedInputTokens: 10 },
        ],
        metadata: {
          tanstack: {
            finishReason: "stop",
            usage: { promptTokensDetails: { cacheWriteTokens: 15 } },
          },
        },
      },
    ];
    const onUsage = vi.fn();
    const result = await executeTanstackLoop(baseOptions({ onUsage }), new AbortController());
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 130,
      outputTokens: 25,
      cachedInputTokens: 90,
      cacheCreationInputTokens: 15,
      model: "gpt-4o",
    });
    expect(result.usage).toEqual({
      inputTokens: 130,
      outputTokens: 25,
      cachedInputTokens: 90,
      cacheCreationInputTokens: 15,
      model: "gpt-4o",
    });
    expect(result.finishReason).toBe("stop");
  });

  it("keeps a metadata-only output ceiling from looking like a clean finish", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        usage: [],
        metadata: { tanstack: { finishReason: "length" } },
      },
    ];
    const onUsage = vi.fn();
    const result = await executeTanstackLoop(baseOptions({ onUsage }), new AbortController());
    expect(result.outputTruncated).toBe(true);
    expect(result.finishReason).toBe("length");
    expect(onUsage).not.toHaveBeenCalled();
    // Unknown, not zero: the dispatch ran and reported no counts.
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, usageIncomplete: true });
  });

  it("auto-registers retrieve_tool_result only when a resultStore is present", async () => {
    const store = {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => null),
    };
    await executeTanstackLoop(baseOptions({ resultStore: store }), new AbortController());
    // options.tools is empty, so the single tool passed to chat() is the runtime-provided
    // retrieve_tool_result.
    expect(chatCalls[0]?.tools).toHaveLength(1);

    chatCalls.length = 0;
    await executeTanstackLoop(baseOptions(), new AbortController());
    expect(chatCalls[0]?.tools).toHaveLength(0);
  });

  it("tolerates the absence of cache token counts", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
      },
    ];
    const onUsage = vi.fn();
    await executeTanstackLoop(baseOptions({ onUsage }), new AbortController());
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 3, model: "gpt-4o" });
  });

  it("invokes onBeforeDispatch once per model dispatch including the first", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ];
    const onBeforeDispatch = vi.fn().mockResolvedValue(undefined);
    await executeTanstackLoop(
      baseOptions({ onBeforeDispatch, maxIterations: 3 }),
      new AbortController(),
    );
    // finishReason stop ends the outer loop after one dispatch.
    expect(onBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(onBeforeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ iteration: 0, lastDispatchAt: null }),
    );
  });

  it("honors a veto from onBeforeDispatch without calling chat", async () => {
    chatCalls.length = 0;
    const onBeforeDispatch = vi.fn().mockResolvedValue({ veto: { reason: "budget" } });
    const result = await executeTanstackLoop(
      baseOptions({ onBeforeDispatch }),
      new AbortController(),
    );
    expect(result.vetoed).toBe(true);
    expect(result.vetoReason).toBe("budget");
    expect(chatCalls).toHaveLength(0);
  });
});

describe("executeTanstackLoop output ceiling", () => {
  it("forwards an explicit native output ceiling to the provider by default", async () => {
    await executeTanstackLoop(baseOptions(), new AbortController());
    expect(chatCalls[0]?.modelOptions).toMatchObject({
      max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(16384);
  });

  it("honors a caller override", async () => {
    await executeTanstackLoop(baseOptions({ maxOutputTokens: 4096 }), new AbortController());
    expect(chatCalls[0]?.modelOptions).toMatchObject({ max_output_tokens: 4096 });
  });

  it("falls back to the provider default only when explicitly passed null", async () => {
    await executeTanstackLoop(baseOptions({ maxOutputTokens: null }), new AbortController());
    expect(chatCalls[0]).not.toHaveProperty("maxTokens");
  });
});

describe("executeTanstackLoop truncation detection", () => {
  const truncationSpellings = [
    "length",
    "LENGTH",
    "max_tokens",
    "MAX_TOKENS",
    "max_output_tokens",
    "model_length",
  ];

  for (const spelling of truncationSpellings) {
    it(`reports finishReason "${spelling}" as output truncation, not a clean finish`, async () => {
      scriptedChunks = [
        {
          type: "RUN_FINISHED",
          finishReason: spelling,
          usage: { promptTokens: 10, completionTokens: 16384 },
        },
      ];
      const result = await executeTanstackLoop(baseOptions(), new AbortController());
      expect(result.outputTruncated).toBe(true);
      expect(result.finishReason).toBe(spelling);
      expect(result.hitIterationLimit).toBe(false);
      expect(result.vetoed).toBeUndefined();
      expect(result.timedOut).toBeUndefined();
    });
  }

  it("detects truncation reported only through a native passthrough field", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "stop",
        native_finish_reason: "MAX_TOKENS",
        usage: { promptTokens: 10, completionTokens: 8192 },
      },
    ];
    const result = await executeTanstackLoop(baseOptions(), new AbortController());
    expect(result.outputTruncated).toBe(true);
  });

  it("stops rather than dispatching again when tool_calls arrives alongside truncation", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "tool_calls",
        nativeFinishReason: "length",
        usage: { promptTokens: 10, completionTokens: 8192 },
      },
    ];
    const result = await executeTanstackLoop(
      baseOptions({ maxIterations: 5 }),
      new AbortController(),
    );
    expect(result.outputTruncated).toBe(true);
    expect(result.hitIterationLimit).toBe(false);
    expect(chatCalls).toHaveLength(1);
  });

  it("does not flag a clean stop or an exhausted iteration budget as truncation", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ];
    const clean = await executeTanstackLoop(baseOptions(), new AbortController());
    expect(clean.outputTruncated).toBeUndefined();
    expect(clean.hitIterationLimit).toBe(false);
    expect(clean.finishReason).toBe("stop");

    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "tool_calls",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ];
    const exhausted = await executeTanstackLoop(
      baseOptions({ maxIterations: 2 }),
      new AbortController(),
    );
    expect(exhausted.hitIterationLimit).toBe(true);
    expect(exhausted.outputTruncated).toBeUndefined();
  });

  it("does not let a truncated spawn_children look like success with zero children", async () => {
    // The realistic failure: the model emits `spawn_children({ inputs: [...200] })`, the
    // argument JSON is cut off at the ceiling, so the tool never executes. Before the fix
    // the loop returned a clean finish and the caller marked the task SUCCEEDED with zero
    // children spawned. The loop must now report truncation for exactly this transcript.
    const spawnChildren = vi.fn();
    scriptedChunks = [
      { type: "TOOL_CALL_START", toolCallId: "c1", toolName: "spawn_children" },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"inputs":[{"name":"Aar' },
      {
        type: "RUN_FINISHED",
        finishReason: "length",
        usage: { promptTokens: 500, completionTokens: 16384 },
      },
    ];
    const result = await executeTanstackLoop(
      baseOptions({
        maxIterations: 8,
        tools: [
          {
            name: "spawn_children",
            description: "Spawn child tasks",
            inputSchema: z.object({ inputs: z.array(z.object({ name: z.string() })) }),
            maxResultChars: 1000,
            execute: spawnChildren,
          },
        ],
      }),
      new AbortController(),
    );
    // Zero children were spawned...
    expect(spawnChildren).not.toHaveBeenCalled();
    // ...and the result says so: truncated, not a clean finish.
    expect(result.outputTruncated).toBe(true);
    expect(result.hitIterationLimit).toBe(false);
    expect(result.finishReason).toBe("length");
  });
});

describe("executeTanstackLoop wall-clock deadline", () => {
  it.each(["hook", "callback"] as const)(
    "preserves an event-limit veto when the deadline passes during the %s",
    async (phase) => {
      let now = 1000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      scriptedChunks = [{ type: "RUN_FINISHED", finishReason: "tool_calls" }];
      scriptedAppends = [[{ id: "a", role: "assistant", parts: [] }]];
      let finishCallback: (() => void) | undefined;
      try {
        const result = await runAgentLoop(
          baseOptions({
            deadlineAt: 1010,
            onMessagesChange: () =>
              phase === "callback"
                ? new Promise<void>((resolve) => {
                    finishCallback = () => {
                      now = 1011;
                      resolve();
                    };
                  })
                : undefined,
            onBeforeDispatch: ({ iteration }) => {
              if (iteration === 0) return;
              if (phase === "hook") now = 1011;
              else finishCallback?.();
              return { veto: { reason: "event-limit" } };
            },
          }),
        );
        expect(result).toMatchObject({ stopReason: "vetoed", vetoReason: "event-limit" });
        expect(chatCalls).toHaveLength(1);
      } finally {
        clock.mockRestore();
      }
    },
  );
  it.each(["onChunk", "onTurn", "onMessagesChange"] as const)(
    "checks the deadline after final %s work even before its timer fires",
    async (phase) => {
      let now = 1000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      scriptedChunks = [
        {
          type: "RUN_FINISHED",
          finishReason: "stop",
          usage: { promptTokens: 7, completionTokens: 3 },
        },
      ];
      scriptedAppends = [[{ id: "a", role: "assistant", parts: [] }]];
      try {
        const result = await runAgentLoop(
          baseOptions({
            maxIterations: 1,
            deadlineAt: 1010,
            onChunk: () => {
              if (phase === "onChunk") now = 1011;
            },
            onTurn: ({ role }) => {
              if (phase === "onTurn" && role === "assistant") now = 1011;
            },
            onMessagesChange: () => {
              if (phase === "onMessagesChange") now = 1011;
            },
          }),
        );
        expect(result).toMatchObject({
          stopReason: "timeout",
          finishReason: "stop",
          usage: { inputTokens: 7, outputTokens: 3 },
        });
        expect(chatCalls).toHaveLength(1);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("checks the deadline after awaiting the final message callback", async () => {
    vi.useFakeTimers();
    scriptedAppends = [[{ id: "a", role: "assistant", parts: [] }]];
    try {
      const pending = runAgentLoop(
        baseOptions({
          maxIterations: 1,
          timeoutMs: 10,
          onMessagesChange: () => new Promise((resolve) => setTimeout(resolve, 30)),
        }),
      );
      await vi.advanceTimersByTimeAsync(30);
      const result = await pending;
      expect(result.stopReason).toBe("timeout");
      expect(result.finishReason).toBe("stop");
      expect(result.usage.usageIncomplete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["onTurn", "onMessagesChange"] as const)(
    "reports caller cancellation during final %s delivery",
    async (phase) => {
      const controller = new AbortController();
      scriptedAppends = [[{ id: "a", role: "assistant", parts: [] }]];
      const result = await runAgentLoop(
        baseOptions({
          maxIterations: 1,
          abortSignal: controller.signal,
          onTurn: ({ role }) => {
            if (phase === "onTurn" && role === "assistant") controller.abort("cancelled");
          },
          onMessagesChange: () => {
            if (phase === "onMessagesChange") controller.abort("cancelled");
          },
        }),
      );
      expect(result.stopReason).toBe("aborted");
      expect(result.finishReason).toBe("stop");
      expect(chatCalls).toHaveLength(1);
    },
  );

  it("retains truncation metadata and billed usage when final settlement times out", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "length",
        usage: { promptTokens: 7, completionTokens: 3 },
      },
    ];
    scriptedAppends = [[{ id: "a", role: "assistant", parts: [] }]];
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const result = await executeTanstackLoop(
        baseOptions({
          maxIterations: 1,
          deadlineAt: 1010,
          onMessagesChange: () => {
            now = 1011;
          },
        }),
        new AbortController(),
      );
      expect(result).toMatchObject({
        timedOut: true,
        outputTruncated: true,
        finishReason: "length",
        hitIterationLimit: false,
        usage: { inputTokens: 7, outputTokens: 3 },
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("does not dispatch at all when the deadline has already passed", async () => {
    const result = await executeTanstackLoop(
      baseOptions({ deadlineAt: Date.now() - 1_000 }),
      new AbortController(),
    );
    expect(result.timedOut).toBe(true);
    expect(result.hitIterationLimit).toBe(false);
    expect(chatCalls).toHaveLength(0);
  });

  it("stops with timedOut and aborts the shared controller mid-run", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "tool_calls",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ];
    chunkDelayMs = 60;
    const controller = new AbortController();
    const result = await executeTanstackLoop(
      baseOptions({ maxIterations: 10, timeoutMs: 5 }),
      controller,
    );
    expect(result.timedOut).toBe(true);
    expect(result.hitIterationLimit).toBe(false);
    // Cooperates with the existing abort plumbing instead of duplicating it.
    expect(controller.signal.aborted).toBe(true);
    expect(isDeadlineAbort(controller.signal.reason)).toBe(true);
    expect(chatCalls).toHaveLength(1);
  });

  it("attributes a caller abort to the caller, not to the deadline", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "tool_calls",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ];
    const controller = new AbortController();
    const result = await executeTanstackLoop(
      baseOptions({
        maxIterations: 10,
        timeoutMs: 60_000,
        onBeforeDispatch: () => {
          controller.abort("run cancelled");
          return undefined;
        },
      }),
      controller,
    );
    expect(result.timedOut).toBeUndefined();
    expect(result.aborted).toBe(true);
    expect(isDeadlineAbort(controller.signal.reason)).toBe(false);
  });

  // An abort that lands between dispatches used to `break` out of the loop and be
  // reported as a clean "completed" — the most misleading stop reason available.
  it("reports an abort between dispatches as aborted, with the usage already billed", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "tool_calls",
        usage: { promptTokens: 7, completionTokens: 3 },
      },
    ];
    const controller = new AbortController();
    let dispatches = 0;
    const result = await runAgentLoop(
      baseOptions({
        maxIterations: 10,
        abortSignal: controller.signal,
        onBeforeDispatch: () => {
          dispatches += 1;
          if (dispatches === 2) controller.abort("run cancelled");
          return undefined;
        },
      }),
    );
    expect(result.stopReason).toBe("aborted");
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(chatCalls).toHaveLength(1);
  });

  it("returns accumulated usage, not zeros, when an abort throws mid-run", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "tool_calls",
        usage: { promptTokens: 5, completionTokens: 2 },
      },
    ];
    const controller = new AbortController();
    let processed = 0;
    onProcessStart = () => {
      processed += 1;
      if (processed === 2) {
        controller.abort("run cancelled");
        throw new DOMException("Aborted", "AbortError");
      }
    };
    const result = await runAgentLoop(
      baseOptions({ maxIterations: 10, abortSignal: controller.signal }),
    );
    expect(result.stopReason).toBe("aborted");
    // Both dispatches reported usage before the second was cut off.
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
  });

  it("bounds an unlimited iteration budget (maxIterations: null) by the deadline", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "tool_calls",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ];
    chunkDelayMs = 5;
    const result = await executeTanstackLoop(
      baseOptions({ maxIterations: null, timeoutMs: 40 }),
      new AbortController(),
    );
    expect(result.timedOut).toBe(true);
    // Unlimited means unlimited: it kept dispatching until the clock ran out.
    expect(chatCalls.length).toBeGreaterThan(1);
    expect(result.hitIterationLimit).toBe(false);
  });

  it("leaves an uncapped run untouched when no deadline is configured", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ];
    const controller = new AbortController();
    const result = await executeTanstackLoop(baseOptions(), controller);
    expect(result.timedOut).toBeUndefined();
    expect(controller.signal.aborted).toBe(false);
  });
});

// THE DEADLINE HAS TO COVER THE TOOL SEAM TOO. `maxIterations` counts finished
// dispatches, so a tool whose promise never settles is not bounded by anything
// else: the loop parked inside `await tool.execute(input)` forever, the deadline
// timer fired into a controller nobody was listening to, and the advertised
// wall-clock bound silently did not apply. In a queue consumer that means a
// BullMQ job stuck `active` and a worker slot gone for good.
describe("executeTanstackLoop hung tools", () => {
  const hangingTool = (execute: (input: unknown, signal?: AbortSignal) => Promise<unknown>) => ({
    name: "hang",
    description: "Never settles",
    inputSchema: z.object({}),
    maxResultChars: 8,
    execute,
  });

  it("abandons a tool that never settles at the deadline and reports a timeout", async () => {
    vi.useFakeTimers();
    try {
      scriptedChunks = [
        {
          type: "RUN_FINISHED",
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1 },
        },
      ];
      let toolSignal: AbortSignal | undefined;
      let resolveHung: (value: unknown) => void = () => {};
      const hung = new Promise<unknown>((resolve) => {
        resolveHung = resolve;
      });
      const store = { put: vi.fn(async () => {}), get: vi.fn(async () => null) };
      toolCallDuringDispatch = { index: 0, input: {} };

      const run = runAgentLoop(
        baseOptions({
          maxIterations: 5,
          timeoutMs: 30_000,
          resultStore: store,
          tools: [
            hangingTool((_input, signal) => {
              toolSignal = signal;
              return hung;
            }),
          ],
        }),
      );

      // No real waiting: advance past the deadline and let the microtasks run.
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await run;

      // The EXISTING stop reason, so callers need no new handling.
      expect(result.stopReason).toBe("timeout");
      // Cancellation reached the tool rather than merely abandoning it.
      expect(toolSignal?.aborted).toBe(true);
      expect(isDeadlineAbort(toolSignal?.reason)).toBe(true);

      // The abandoned call settles afterwards. It must not be able to write
      // anything: an 8-char cap means a stored result would hit the store, and
      // a serialized one would land in the transcript.
      resolveHung("a result nobody is waiting for any more");
      await vi.advanceTimersByTimeAsync(0);
      expect(store.put).not.toHaveBeenCalled();
      expect(JSON.stringify(result.messages)).not.toContain("nobody is waiting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still lets a prompt tool call finish normally", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ];
    toolCallDuringDispatch = { index: 0, input: {} };
    const result = await runAgentLoop(
      baseOptions({
        maxIterations: 5,
        timeoutMs: 30_000,
        tools: [hangingTool(async () => "done")],
      }),
    );
    expect(result.stopReason).toBe("completed");
  });
});

// The per-turn observability seam. A long run is thousands of turns and the only
// other way to see one think is to wait for it to end, so these
// guarantees — every turn, in order, monotonic seq, and never able to fail the loop —
// are the whole feature.
describe("executeTanstackLoop onTurn", () => {
  type Turn = { seq: number; role: string; message: { id: string } };

  const toolCallsThenStop = () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "tool_calls",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ];
  };

  it("announces the seed messages before the first dispatch", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ];
    const turns: Turn[] = [];
    await executeTanstackLoop(
      baseOptions({ onTurn: (turn) => void turns.push(turn as Turn) }),
      new AbortController(),
    );
    // The prompt the node was actually given is turn 0 — without it the persisted
    // history opens mid-conversation.
    expect(turns[0]).toMatchObject({ seq: 0, role: "user", message: { id: "u" } });
  });

  it("fires once per message, in order, with a monotonic 0-based seq", async () => {
    toolCallsThenStop();
    scriptedAppends = [
      [
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "tool-call", id: "c1", name: "t", arguments: "{}", state: "done" }],
        },
        {
          id: "t1",
          role: "assistant",
          parts: [{ type: "tool-result", toolCallId: "c1", content: "ok", state: "done" }],
        },
      ],
      [{ id: "a2", role: "assistant", parts: [{ type: "text", content: "final" }] }],
    ];
    const turns: Turn[] = [];
    await executeTanstackLoop(
      baseOptions({ maxIterations: 2, onTurn: (turn) => void turns.push(turn as Turn) }),
      new AbortController(),
    );
    expect(turns.map((turn) => turn.seq)).toEqual([0, 1, 2, 3]);
    expect(turns.map((turn) => turn.message.id)).toEqual(["u", "a1", "t1", "a2"]);
    // A message whose parts are all tool-results is stored as role "tool" — AgentMessage
    // has no such role, so it is derived once here rather than at each call site.
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("announces each message exactly once across dispatches", async () => {
    toolCallsThenStop();
    scriptedAppends = [
      [{ id: "a1", role: "assistant", parts: [{ type: "text", content: "one" }] }],
      [{ id: "a2", role: "assistant", parts: [{ type: "text", content: "two" }] }],
      [{ id: "a3", role: "assistant", parts: [{ type: "text", content: "three" }] }],
    ];
    const turns: Turn[] = [];
    await executeTanstackLoop(
      baseOptions({ maxIterations: 3, onTurn: (turn) => void turns.push(turn as Turn) }),
      new AbortController(),
    );
    expect(turns.map((turn) => turn.message.id)).toEqual(["u", "a1", "a2", "a3"]);
  });

  it("keeps seq as the APPEND ORDER of turns across a context prune", async () => {
    // Prune rewrites message bodies in place between dispatches. Any positional scheme
    // would renumber history the moment the array is rebuilt or compacted; seq must
    // stay the order the turns happened in.
    toolCallsThenStop();
    scriptedAppends = [
      [
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "tool-result", toolCallId: "c1", content: "x".repeat(50), state: "done" },
          ],
        },
      ],
      [{ id: "a2", role: "assistant", parts: [{ type: "text", content: "after prune" }] }],
    ];
    // Stand in for the prune pass: rewrite an already-announced body, and drop the
    // oldest message entirely (the most hostile thing a future compaction could do).
    onProcessStart = (messages) => {
      if (dispatchIndex !== 1) return;
      for (const message of messages as Array<{ parts: Array<Record<string, unknown>> }>) {
        for (const part of message.parts) {
          if (typeof part.content === "string") part.content = "[stored result id=abc]";
        }
      }
      messages.shift();
    };
    const turns: Turn[] = [];
    await executeTanstackLoop(
      baseOptions({ maxIterations: 2, onTurn: (turn) => void turns.push(turn as Turn) }),
      new AbortController(),
    );
    expect(turns.map((turn) => turn.seq)).toEqual([0, 1, 2]);
    expect(turns.map((turn) => turn.message.id)).toEqual(["u", "a1", "a2"]);
    // The pruned-away message is NOT re-announced under a new seq.
    expect(turns.filter((turn) => turn.message.id === "u")).toHaveLength(1);
  });

  it("never fails the loop when onTurn throws or rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    toolCallsThenStop();
    scriptedAppends = [
      [{ id: "a1", role: "assistant", parts: [{ type: "text", content: "one" }] }],
      [{ id: "a2", role: "assistant", parts: [{ type: "text", content: "two" }] }],
    ];
    let calls = 0;
    const result = await executeTanstackLoop(
      baseOptions({
        maxIterations: 2,
        onTurn: () => {
          calls += 1;
          if (calls % 2 === 0) return Promise.reject(new Error("observer down"));
          throw new Error("observer down");
        },
      }),
      new AbortController(),
    );
    // Every turn was still attempted and the loop ran to its normal conclusion.
    expect(calls).toBe(3);
    expect(result.messages).toHaveLength(3);
    expect(result.hitIterationLimit).toBe(true);
    warn.mockRestore();
  });

  it("costs nothing and stays silent when no hook is registered", async () => {
    toolCallsThenStop();
    scriptedAppends = [
      [{ id: "a1", role: "assistant", parts: [{ type: "text", content: "one" }] }],
    ];
    const result = await executeTanstackLoop(
      baseOptions({ maxIterations: 1 }),
      new AbortController(),
    );
    expect(result.messages).toHaveLength(2);
  });

  it("announces the seed turns even when onBeforeDispatch vetoes before any dispatch", async () => {
    const turns: Turn[] = [];
    const result = await executeTanstackLoop(
      baseOptions({
        onTurn: (turn) => void turns.push(turn as Turn),
        onBeforeDispatch: () => ({ veto: { reason: "budget" } }),
      }),
      new AbortController(),
    );
    expect(result.vetoed).toBe(true);
    expect(turns.map((turn) => turn.seq)).toEqual([0]);
  });

  it("does not announce a turn from a dispatch that failed mid-stream", async () => {
    // Chunks stream through as they arrive (the retry/failover adapter only holds
    // back RUN_STARTED), so partial assistant text does reach the stream processor —
    // but a dispatch that throws must not announce it as a completed turn.
    scriptedChunks = [{ type: "RUN_FINISHED", finishReason: "stop" }];
    scriptedAppends = [
      [{ id: "a1", role: "assistant", parts: [{ type: "text", content: "partial" }] }],
    ];
    onProcessStart = () => {
      throw new Error("stream failed");
    };
    const turns: Turn[] = [];
    await expect(
      executeTanstackLoop(
        baseOptions({ onTurn: (turn) => void turns.push(turn as Turn) }),
        new AbortController(),
      ),
    ).rejects.toThrow("stream failed");
    expect(turns.map((turn) => turn.message.id)).toEqual(["u"]);
  });
});

describe("unknown usage", () => {
  it("does not call onUsage when the provider reported no token counts", async () => {
    // fromSpecTokenUsage zero-fills: booking these as 0 would claim a free dispatch.
    for (const usage of [[{ totalTokens: 12 }], { totalTokens: 12 }, undefined]) {
      scriptedChunks = [{ type: "RUN_FINISHED", finishReason: "stop", usage }];
      const onUsage = vi.fn();
      const result = await executeTanstackLoop(baseOptions({ onUsage }), new AbortController());
      expect(onUsage).not.toHaveBeenCalled();
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, usageIncomplete: true });
    }
  });

  it("flags usage incomplete when only some dispatches reported it", async () => {
    let dispatches = 0;
    onProcessStart = () => {
      dispatches += 1;
      scriptedChunks = [{ type: "RUN_FINISHED", finishReason: "stop" }];
    };
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "tool_calls",
        usage: [{ inputTokens: 4, outputTokens: 1 }],
      },
    ];
    const onUsage = vi.fn();
    const result = await executeTanstackLoop(baseOptions({ onUsage }), new AbortController());
    expect(dispatches).toBe(2);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 4,
      outputTokens: 1,
      model: "gpt-4o",
    });
    expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 1, usageIncomplete: true });
  });

  it("leaves usageIncomplete unset when every dispatch reported usage", async () => {
    scriptedChunks = [
      {
        type: "RUN_FINISHED",
        finishReason: "stop",
        usage: { promptTokens: 2, completionTokens: 1 },
      },
    ];
    const result = await executeTanstackLoop(baseOptions(), new AbortController());
    expect(result.usage.usageIncomplete).toBeUndefined();
  });
});

describe("onMessagesChange delivery", () => {
  const assistant = (id: string) => [
    { id, role: "assistant", parts: [{ type: "text", content: id }] },
  ];
  const toolCalls = { type: "RUN_FINISHED", finishReason: "tool_calls" };

  it("never leaks a callback rejection as an unhandled rejection, and fails the run with it", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      scriptedAppends = [assistant("a1")];
      const onMessagesChange = vi.fn().mockRejectedValue(new Error("db down"));
      await expect(
        executeTanstackLoop(baseOptions({ onMessagesChange }), new AbortController()),
      ).rejects.toThrow("db down");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("drains an in-flight callback before settling, even when the loop throws", async () => {
    scriptedChunks = [toolCalls];
    scriptedAppends = [assistant("a1")];
    let processed = 0;
    onProcessStart = () => {
      processed += 1;
      if (processed === 2) throw new Error("stream failed");
    };
    let finished = false;
    const onMessagesChange = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished = true;
    });
    await expect(
      executeTanstackLoop(baseOptions({ onMessagesChange }), new AbortController()),
    ).rejects.toThrow("stream failed");
    expect(onMessagesChange).toHaveBeenCalledTimes(1);
    expect(finished).toBe(true);
  });

  it("coalesces snapshots behind a slow callback but always delivers the final one", async () => {
    scriptedChunks = [toolCalls];
    scriptedAppends = [assistant("a1"), assistant("a2"), assistant("a3")];
    onProcessStart = () => {
      if (dispatchIndex === 2) scriptedChunks = [{ type: "RUN_FINISHED", finishReason: "stop" }];
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const onMessagesChange = vi.fn(async (_messages: unknown) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
    });
    const result = await executeTanstackLoop(
      baseOptions({ onMessagesChange, maxIterations: 5 }),
      new AbortController(),
    );
    expect(maxInFlight).toBe(1);
    const last = onMessagesChange.mock.calls.at(-1)?.[0] as Array<{ id: string }>;
    expect(last.map((message) => message.id)).toEqual(["u", "a1", "a2", "a3"]);
    expect(result.messages.map((message) => message.id)).toEqual(["u", "a1", "a2", "a3"]);
  });
});

describe("provider stream errors", () => {
  it("rejects a stream that ends without a terminal event instead of completing", async () => {
    scriptedChunks = [{ type: "TEXT_MESSAGE_CONTENT", delta: "half an ans" }];
    await expect(runAgentLoop(baseOptions())).rejects.toMatchObject({
      name: "AgentRuntimeError",
      retryable: true,
      message: expect.stringContaining("without a terminal event"),
    });
  });

  it("does not retry-classify a permanent provider code as transient", async () => {
    scriptedChunks = [
      { type: "RUN_ERROR", message: "Incorrect API key provided", code: "invalid_api_key" },
    ];
    await expect(runAgentLoop(baseOptions())).rejects.toMatchObject({
      name: "AgentRuntimeError",
      code: "invalid_api_key",
      retryable: false,
    });
  });

  it("rejects a RUN_ERROR event rather than returning completed", async () => {
    scriptedChunks = [{ type: "RUN_ERROR", message: "Provider rejected the request", code: "401" }];
    await expect(runAgentLoop(baseOptions())).rejects.toMatchObject({
      name: "AgentRuntimeError",
      status: 401,
      retryable: false,
    });
  });
});

describe("SDK diagnostic routing", () => {
  it("routes diagnostics to stderr without echoing credentials or arbitrary metadata", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { runAgentLoop } = await import("./loop");
      const options = baseOptions();
      options.model.apiKey = "sensitive-test-key";
      await runAgentLoop(options);
      const debug = chatCalls[0]?.debug as {
        logger: { error: (message: string, meta?: Record<string, unknown>) => void };
      };
      debug.logger.error("Provider failed: sensitive-test-key", {
        error: new Error("request sensitive-test-key"),
        headers: { authorization: "sensitive-test-key" },
      });
      expect(stderr).toHaveBeenCalledWith(
        "[agent-runtime]",
        "Provider failed: [redacted]: request [redacted]",
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
