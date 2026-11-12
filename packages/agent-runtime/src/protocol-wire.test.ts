import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runAgentLoop } from "./loop";
import type { AgentLoopOptions, AgentModel } from "./types";

// Provider SDKs, TanStack adapters, stream processing and the agent loop are real.
// Only HTTP is substituted: these fixtures exercise each provider's native wire
// protocol without spending credits or opening sockets in the unit-test process.
const sse = (events: Record<string, unknown>[], named = false) =>
  new Response(
    events
      .map((event) => `${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const chatResponse = (tool: boolean, finishReason = "stop") => {
  const shared = { id: "chat-1", object: "chat.completion.chunk", created: 0, model: "gpt-4o" };
  return sse([
    {
      ...shared,
      choices: [
        {
          index: 0,
          delta: tool
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "legal_moves", arguments: '{"piece":"e2"}' },
                  },
                ],
              }
            : { role: "assistant", content: "e2e4" },
          finish_reason: null,
        },
      ],
    },
    {
      ...shared,
      choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : finishReason }],
    },
    {
      ...shared,
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    },
  ]);
};

const responsesResponse = (tool: boolean, truncated = false) => {
  const output = tool
    ? {
        type: "function_call",
        id: "fc-1",
        call_id: "call-1",
        name: "legal_moves",
        arguments: '{"piece":"e2"}',
        status: "completed",
      }
    : {
        type: "message",
        id: "msg-1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "e2e4", annotations: [] }],
      };
  const response = {
    id: "resp-1",
    object: "response",
    model: "gpt-4o",
    status: truncated ? "incomplete" : "completed",
    ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    output: [output],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  };
  return sse(
    [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: tool ? { ...output, arguments: "" } : { ...output, content: [] },
      },
      ...(tool
        ? [
            {
              type: "response.function_call_arguments.delta",
              item_id: "fc-1",
              output_index: 0,
              delta: '{"piece":"e2"}',
            },
            {
              type: "response.function_call_arguments.done",
              item_id: "fc-1",
              output_index: 0,
              arguments: '{"piece":"e2"}',
            },
          ]
        : [
            {
              type: "response.output_text.delta",
              item_id: "msg-1",
              output_index: 0,
              content_index: 0,
              delta: "e2e4",
            },
          ]),
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: truncated ? "response.incomplete" : "response.completed", response },
    ],
    true,
  );
};

const anthropicResponse = (tool: boolean, stopReason = "end_turn") =>
  sse(
    [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: tool
          ? { type: "tool_use", id: "call-1", name: "legal_moves", input: {} }
          : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: tool
          ? { type: "input_json_delta", partial_json: '{"piece":"e2"}' }
          : { type: "text_delta", text: "e2e4" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : stopReason, stop_sequence: null },
        usage: { output_tokens: 7 },
      },
      { type: "message_stop" },
    ],
    true,
  );

type Protocol = Extract<AgentModel["provider"], "openai-chat" | "openai-responses" | "anthropic">;
const options = (provider: Protocol): AgentLoopOptions => ({
  model: {
    provider,
    model: provider === "anthropic" ? "claude-haiku-4-5" : "gpt-4o",
    apiKey: "test-key",
    baseUrl: "https://inference.example/v1",
  },
  systemPrompt: "Play chess. Use legal_moves before choosing a move.",
  messages: [{ id: "u1", role: "user", parts: [{ type: "text", content: "White to move." }] }],
  maxIterations: 3,
  maxOutputTokens: 64,
  timeoutMs: 2000,
  tools: [],
});

const responseFor = (protocol: Protocol, tool: boolean) =>
  protocol === "anthropic"
    ? anthropicResponse(tool)
    : protocol === "openai-chat"
      ? chatResponse(tool)
      : responsesResponse(tool);

const captureHttp = (respond: (index: number) => Response | Promise<Response>) => {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...[input, init]: Parameters<typeof fetch>) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push({
        url: request.url,
        body: JSON.parse(await request.text()),
        headers: request.headers,
      });
      return respond(requests.length - 1);
    }),
  );
  return requests;
};

afterEach(() => vi.unstubAllGlobals());

describe.each<Protocol>(["openai-chat", "openai-responses", "anthropic"])(
  "native %s wire protocol",
  (protocol) => {
    it("executes a tool and feeds its result back through the provider's native message shape", async () => {
      const requests = captureHttp((index) => responseFor(protocol, index === 0));
      const execute = vi.fn((input: unknown) => ({
        piece: z.object({ piece: z.string() }).parse(input).piece,
        moves: ["e2e3", "e2e4"],
      }));
      const result = await runAgentLoop({
        ...options(protocol),
        tools: [
          {
            name: "legal_moves",
            description: "Get legal moves for one piece",
            inputSchema: z.object({ piece: z.string() }),
            maxResultChars: 1000,
            execute,
          },
        ],
      });
      expect(result.stopReason).toBe("completed");
      expect(execute).toHaveBeenCalledExactlyOnceWith({ piece: "e2" }, expect.any(AbortSignal));
      expect(requests).toHaveLength(2);
      expect(result.usage).toMatchObject({ inputTokens: 22, outputTokens: 14 });
      expect(JSON.stringify(result.messages)).toContain("e2e4");
      const first = requests[0]!;
      const second = requests[1]!;
      expect(first.headers.get("content-type")).toContain("application/json");
      if (protocol === "openai-chat") {
        expect(first.url).toBe("https://inference.example/v1/chat/completions");
        expect(first.body).toMatchObject({
          max_completion_tokens: 64,
          stream: true,
          tools: [{ type: "function", function: { name: "legal_moves" } }],
        });
        expect(second.body.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "tool",
              tool_call_id: "call-1",
              content: expect.stringContaining("e2e4"),
            }),
          ]),
        );
      } else if (protocol === "openai-responses") {
        expect(first.url).toBe("https://inference.example/v1/responses");
        expect(first.body).toMatchObject({
          max_output_tokens: 64,
          stream: true,
          tools: [{ type: "function", name: "legal_moves" }],
        });
        expect(second.body.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "function_call_output",
              call_id: "call-1",
              output: expect.stringContaining("e2e4"),
            }),
          ]),
        );
      } else {
        expect(new URL(first.url).pathname).toBe("/v1/messages");
        expect(first.body).toMatchObject({
          max_tokens: 64,
          stream: true,
          tools: [{ name: "legal_moves", input_schema: expect.any(Object) }],
        });
        expect(first.headers.get("x-api-key")).toBe("test-key");
        expect(second.body.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "user",
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: "tool_result",
                  tool_use_id: "call-1",
                  content: expect.stringContaining("e2e4"),
                }),
              ]),
            }),
          ]),
        );
      }
    });

    it("stops at the model dispatch budget with a completed tool round retained", async () => {
      const requests = captureHttp(() => responseFor(protocol, true));
      const result = await runAgentLoop({
        ...options(protocol),
        maxIterations: 1,
        tools: [
          {
            name: "legal_moves",
            description: "Legal moves",
            inputSchema: z.object({ piece: z.string() }),
            maxResultChars: 100,
            execute: () => ["e2e4"],
          },
        ],
      });
      expect(result.stopReason).toBe("max-iterations");
      expect(requests).toHaveLength(1);
      expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
    });

    it("surfaces provider HTTP rejection instead of reporting a completed turn", async () => {
      const requests = captureHttp(
        () =>
          new Response(
            JSON.stringify({
              error: { type: "authentication_error", message: "Invalid test credentials" },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      );
      await expect(runAgentLoop(options(protocol))).rejects.toMatchObject({
        name: "AgentRuntimeError",
        status: 401,
        retryable: false,
      });
      expect(requests).toHaveLength(1);
    });

    // The installed adapters turn an HTTP failure into RUN_STARTED + RUN_ERROR chunks
    // instead of throwing. This is the end-to-end proof that the retry layer still sees
    // it as a pre-content failure — and that it is the ONLY retry layer (the SDK's own
    // retries are off, so exactly two requests go out).
    it("retries a provider 503 and completes on the next attempt", async () => {
      const requests = captureHttp((index) =>
        index === 0
          ? new Response(
              JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }),
              {
                status: 503,
                headers: {
                  "content-type": "application/json",
                  "retry-after-ms": "0",
                  "retry-after": "0",
                },
              },
            )
          : responseFor(protocol, false),
      );
      const result = await runAgentLoop(options(protocol));
      expect(result.stopReason).toBe("completed");
      expect(requests).toHaveLength(2);
      expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
      expect(JSON.stringify(result.messages)).toContain("e2e4");
    });

    it("does not retry a permanent credential rejection", async () => {
      const requests = captureHttp(
        () =>
          new Response(
            JSON.stringify(
              protocol === "anthropic"
                ? {
                    type: "error",
                    error: { type: "authentication_error", message: "invalid x-api-key" },
                  }
                : {
                    error: {
                      message: "Incorrect API key provided",
                      type: "invalid_request_error",
                      code: "invalid_api_key",
                    },
                  },
            ),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      );
      const error = await runAgentLoop(options(protocol)).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: "AgentRuntimeError", retryable: false });
      if (protocol !== "anthropic") expect(error).toMatchObject({ code: "invalid_api_key" });
      expect(requests).toHaveLength(1);
    });

    it("returns promptly when aborted while the provider stream has gone silent", async () => {
      // Deliver the opening events (including some text), then never send another
      // byte — and never react to the abort signal either, so only the runtime's own
      // abort race can end the wait.
      const full = await responseFor(protocol, false).text();
      const opening = full
        .split("\n\n")
        .filter(Boolean)
        .slice(0, protocol === "openai-chat" ? 1 : 3);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  for (const event of opening)
                    controller.enqueue(new TextEncoder().encode(`${event}\n\n`));
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        ),
      );
      const controller = new AbortController();
      const startedAt = Date.now();
      const result = await runAgentLoop({
        ...options(protocol),
        timeoutMs: 30_000,
        abortSignal: controller.signal,
        onChunk: (chunk) => {
          if ((chunk as { type?: string }).type === "TEXT_MESSAGE_CONTENT") controller.abort();
        },
      });
      expect(result.stopReason).toBe("aborted");
      expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    it("reports native output truncation without dispatching again", async () => {
      const requests = captureHttp(() =>
        protocol === "anthropic"
          ? anthropicResponse(false, "max_tokens")
          : protocol === "openai-chat"
            ? chatResponse(false, "length")
            : responsesResponse(false, true),
      );
      const result = await runAgentLoop(options(protocol));
      expect(result.stopReason).toBe("output-truncated");
      expect(requests).toHaveLength(1);
    });

    it("enforces its wall-clock deadline during provider HTTP", async () => {
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (...[input, init]: Parameters<typeof fetch>) => {
          signal = input instanceof Request ? input.signal : (init?.signal ?? undefined);
          return await new Promise<Response>((_resolve, reject) =>
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            ),
          );
        }),
      );
      const result = await runAgentLoop({ ...options(protocol), timeoutMs: 20 });
      expect(result.stopReason).toBe("timeout");
      expect(signal?.aborted).toBe(true);
    });

    it("forwards cancellation to an in-flight provider request", async () => {
      const controller = new AbortController();
      let requestSignal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (...[input, init]: Parameters<typeof fetch>) => {
          requestSignal = input instanceof Request ? input.signal : (init?.signal ?? undefined);
          return await new Promise<Response>((_resolve, reject) => {
            requestSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
            controller.abort();
          });
        }),
      );
      const result = await runAgentLoop({ ...options(protocol), abortSignal: controller.signal });
      expect(result.stopReason).toBe("aborted");
      expect(requestSignal?.aborted).toBe(true);
    });
  },
);

describe("Anthropic-compatible bearer gateway", () => {
  it("serializes ordinary function tools for the OpenRouter Messages gateway", async () => {
    const requests = captureHttp(() => anthropicResponse(false));
    const base = options("anthropic");
    const result = await runAgentLoop({
      ...base,
      model: { ...base.model, baseUrl: "https://openrouter.ai/api/v1", anthropicAuth: "bearer" },
      tools: [
        {
          name: "engine_eval",
          description: "Evaluate the current board",
          inputSchema: z.object({}).strict(),
          maxResultChars: 2000,
          execute: () => ({ cp: 0 }),
        },
        {
          name: "board_view",
          description: "View the current board",
          inputSchema: z.object({}).strict(),
          maxResultChars: 2000,
          execute: () => "board",
        },
      ],
    });
    expect(result.stopReason).toBe("completed");
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/messages?beta=true");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-key");
    expect(requests[0]?.body.tools).toEqual([
      {
        name: "engine_eval",
        description: "Evaluate the current board",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "board_view",
        description: "View the current board",
        input_schema: { type: "object", properties: {}, required: [] },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("keeps the key in Authorization and removes x-api-key", async () => {
    const requests = captureHttp(() => anthropicResponse(false));
    const base = options("anthropic");
    const result = await runAgentLoop({
      ...base,
      model: { ...base.model, anthropicAuth: "bearer" },
    });
    expect(result.stopReason).toBe("completed");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-key");
    expect(requests[0]?.headers.has("x-api-key")).toBe(false);
  });
});

describe("existing OpenRouter adapter", () => {
  it("forwards the output ceiling through the SDK's camelCase request mapping", async () => {
    const requests = captureHttp(() => chatResponse(false));
    const base = options("openai-chat");
    const result = await runAgentLoop({
      ...base,
      model: { ...base.model, provider: "openrouter", model: "openai/gpt-4o" },
    });
    expect(result.stopReason).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ max_completion_tokens: 64, stream: true });
  });
});

// TanStack AI 1.0 turns automatic prompt caching on by default and applies it inside
// each adapter, so the runtime's cache switch and the OpenRouter cache hook are checked
// on the real serialized request.
/** Real (non-null) `cache_control` breakpoints anywhere in a request body. */
const countCacheControls = (value: unknown): number =>
  Array.isArray(value)
    ? value.reduce<number>((total, item) => total + countCacheControls(item), 0)
    : typeof value === "object" && value !== null
      ? Object.entries(value).reduce<number>(
          // The Anthropic tool converter emits `cache_control: null` on unmarked tools.
          (total, [key, item]) =>
            total + (key === "cache_control" ? (item === null ? 0 : 1) : countCacheControls(item)),
          0,
        )
      : 0;

const legalMovesTool = {
  name: "legal_moves",
  description: "Legal moves",
  inputSchema: z.object({ piece: z.string() }),
  maxResultChars: 100,
  execute: () => ["e2e4"],
};

describe("prompt caching on the wire", () => {
  const openrouterClaude = (): AgentLoopOptions => {
    const base = options("openai-chat");
    return {
      ...base,
      cacheKey: "run-1:white",
      tools: [legalMovesTool],
      model: { ...base.model, provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
    };
  };

  it("marks the system block and the last tool for Anthropic via OpenRouter, within Anthropic's 4-breakpoint cap", async () => {
    const requests = captureHttp((index) => chatResponse(index === 0));
    const result = await runAgentLoop(openrouterClaude());
    expect(result.stopReason).toBe("completed");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const messages = request.body.messages as Array<Record<string, unknown>>;
      const system = messages.find((message) => message.role === "system");
      expect(system?.content).toEqual([
        expect.objectContaining({ type: "text", cache_control: { type: "ephemeral" } }),
      ]);
      const tools = request.body.tools as Array<Record<string, unknown>>;
      expect(tools.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
      expect(countCacheControls(request.body)).toBeLessThanOrEqual(4);
      // The caller's stable prefix key routes sibling requests to one OpenRouter session.
      expect(request.body.session_id).toBe("run-1:white");
    }
  });

  it("sends no cache wiring at all when caching is switched off", async () => {
    const requests = captureHttp(() => chatResponse(false));
    await runAgentLoop({ ...openrouterClaude(), cache: false });
    expect(countCacheControls(requests[0]?.body)).toBe(0);
    expect(requests[0]?.body).not.toHaveProperty("session_id");

    const anthropic = captureHttp(() => anthropicResponse(false));
    await runAgentLoop({ ...options("anthropic"), tools: [legalMovesTool], cache: false });
    expect(countCacheControls(anthropic[0]?.body)).toBe(0);
  });

  it("caches the native Anthropic prefix by default", async () => {
    const requests = captureHttp(() => anthropicResponse(false));
    await runAgentLoop({ ...options("anthropic"), tools: [legalMovesTool] });
    const body = requests[0]?.body ?? {};
    expect((body.tools as Array<Record<string, unknown>>).at(-1)).toMatchObject({
      cache_control: { type: "ephemeral" },
    });
    expect(countCacheControls(body)).toBeGreaterThan(0);
    expect(countCacheControls(body)).toBeLessThanOrEqual(4);
  });
});

describe("OpenRouter retry ownership", () => {
  const openrouter = (): AgentLoopOptions => {
    const base = options("openai-chat");
    return { ...base, model: { ...base.model, provider: "openrouter", model: "openai/gpt-4o" } };
  };

  // `retryConfig: { strategy: "none" }` keeps the SDK from retrying on its own, so the
  // runtime's retry adapter is the only layer: one failure, one retry, two requests.
  it("retries a 503 exactly once through the runtime, not the SDK", async () => {
    const requests = captureHttp((index) =>
      index === 0
        ? new Response(JSON.stringify({ error: { code: 503, message: "Overloaded" } }), {
            status: 503,
            headers: { "content-type": "application/json", "retry-after": "0" },
          })
        : chatResponse(false),
    );
    const result = await runAgentLoop(openrouter());
    expect(result.stopReason).toBe("completed");
    expect(requests).toHaveLength(2);
  });

  it("does not retry a credential rejection", async () => {
    const requests = captureHttp(
      () =>
        new Response(
          JSON.stringify({ error: { code: 401, message: "No auth credentials found" } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    await expect(runAgentLoop(openrouter())).rejects.toMatchObject({
      name: "AgentRuntimeError",
      retryable: false,
    });
    expect(requests).toHaveLength(1);
  });
});

describe("message metadata round trip", () => {
  // 1.0 records the writing provider/model and the finish reason on each assistant
  // message; adapters read them on replay, so the loop must carry them between dispatches.
  it("keeps TanStack message metadata on the returned assistant turns", async () => {
    captureHttp((index) => chatResponse(index === 0));
    const result = await runAgentLoop({ ...options("openai-chat"), tools: [legalMovesTool] });
    const assistant = result.messages.filter((message) => message.role === "assistant");
    expect(assistant).toHaveLength(2);
    expect(assistant[0]?.metadata).toMatchObject({
      tanstack: { source: { model: "gpt-4o" }, finishReason: "tool_calls" },
    });
    expect(assistant[1]?.metadata).toMatchObject({ tanstack: { finishReason: "stop" } });
  });
});
