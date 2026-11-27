import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runAgentLoop } from "./loop";
import type { AgentLoopOptions, AgentModel } from "./types";

// Real SDKs, adapters, AG-UI normalization and runtime; only HTTP is replaced.
const sse = (events: Record<string, unknown>[]) =>
  new Response(
    events
      .map((event) => `event: ${event.type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const chatResponse = (
  usage?: Record<string, unknown>,
  model: string | null = "gpt-4o",
  provider?: string,
) => {
  const shared = {
    id: "chat-1",
    object: "chat.completion.chunk",
    created: 0,
    ...(model === null ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
  };
  return sse([
    {
      ...shared,
      choices: [{ index: 0, delta: { role: "assistant", content: "e2e4" }, finish_reason: null }],
    },
    { ...shared, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ...(usage ? [{ ...shared, choices: [], usage }] : []),
  ]);
};

const responsesResponse = (
  usage?: Record<string, unknown>,
  model: string | null = "gpt-4o",
  provider?: string,
) => {
  const item = {
    type: "message",
    id: "msg-1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "e2e4", annotations: [] }],
  };
  const response = {
    id: "resp-1",
    object: "response",
    ...(model === null ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
    status: "completed",
    output: [item],
    ...(usage ? { usage } : {}),
  };
  return sse([
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "e2e4",
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]);
};

const anthropicResponse = (
  cacheUsage: Record<string, unknown> = {},
  model: string | null = "claude-haiku-4-5",
  provider?: string,
  withUsage = true,
) =>
  sse([
    {
      type: "message_start",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        ...(model === null ? {} : { model }),
        ...(provider === undefined ? {} : { provider }),
        content: [],
        stop_reason: null,
        stop_sequence: null,
        ...(withUsage ? { usage: { input_tokens: 5, output_tokens: 0, ...cacheUsage } } : {}),
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "e2e4" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      ...(withUsage ? { usage: { output_tokens: 7 } } : {}),
    },
    { type: "message_stop" },
  ]);

const chatUsage = {
  prompt_tokens: 100,
  completion_tokens: 7,
  total_tokens: 107,
  prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 15 },
};

const responseFor = (protocol: AgentModel["provider"], cacheCounts = true) => {
  if (protocol === "anthropic")
    return anthropicResponse(
      cacheCounts ? { cache_read_input_tokens: 80, cache_creation_input_tokens: 15 } : {},
    );
  if (protocol === "openai-responses")
    return responsesResponse({
      input_tokens: 100,
      output_tokens: 7,
      total_tokens: 107,
      ...(cacheCounts
        ? { input_tokens_details: { cached_tokens: 80, cache_write_tokens: 15 } }
        : {}),
    });
  return chatResponse(
    cacheCounts ? chatUsage : { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 },
  );
};

const options = (provider: AgentModel["provider"]): AgentLoopOptions => ({
  model: {
    provider,
    model:
      provider === "anthropic"
        ? "claude-haiku-4-5"
        : provider === "openrouter"
          ? "anthropic/claude-haiku-4.5"
          : "gpt-4o",
    apiKey: "test-key",
    baseUrl: "https://openrouter.ai/api/v1",
    headers: { "X-OpenRouter-Title": "Cockpit Chess" },
  },
  cacheKey: "match-1:white",
  systemPrompt: "Play chess.",
  messages: [{ id: "u1", role: "user", parts: [{ type: "text", content: "White to move." }] }],
  tools: [
    {
      name: "legal_moves",
      description: "Legal moves",
      inputSchema: z.object({ piece: z.string() }),
      maxResultChars: 100,
      execute: () => ["e2e4"],
    },
  ],
  maxIterations: 1,
  maxOutputTokens: 64,
});

const captureHttp = (respond: () => Response) => {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...[input, init]: Parameters<typeof fetch>) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        headers: request.headers,
        body: z.record(z.string(), z.unknown()).parse(await request.json()),
      });
      return respond();
    }),
  );
  return requests;
};

const cacheMarkers = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + cacheMarkers(item), 0);
  if (typeof value !== "object" || value === null) return 0;
  return Object.entries(value).reduce(
    (sum, [key, item]) =>
      sum + (key === "cache_control" ? Number(item != null) : cacheMarkers(item)),
    0,
  );
};

afterEach(() => vi.unstubAllGlobals());

describe("reply identity lifecycle", () => {
  it("does not announce a failed dispatch as a reply", async () => {
    captureHttp(
      () =>
        new Response('{"error":{"message":"Fixture rejection"}}', {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const onReply = vi.fn();
    await expect(runAgentLoop({ ...options("openai-chat"), onReply })).rejects.toThrow();
    expect(onReply).not.toHaveBeenCalled();
  });

  it("does not announce identity from an aborted dispatch", async () => {
    captureHttp(() => chatResponse(chatUsage, "reported-before-abort"));
    const controller = new AbortController();
    const onReply = vi.fn();
    const result = await runAgentLoop({
      ...options("openai-chat"),
      abortSignal: controller.signal,
      onReply,
      onChunk: () => controller.abort(),
    });
    expect(result.stopReason).toBe("aborted");
    expect(onReply).not.toHaveBeenCalled();
  });
});

describe.each<AgentModel["provider"]>(["anthropic", "openai-chat", "openai-responses"])(
  "%s native cache routing on the wire",
  (protocol) => {
    it("uses the same per-side affinity across independent loops and preserves attribution", async () => {
      const requests = captureHttp(() => responseFor(protocol));
      for (const cacheKey of ["match-1:white", "match-1:white", "match-1:black"]) {
        const result = await runAgentLoop({ ...options(protocol), cacheKey });
        expect(result.stopReason).toBe("completed");
      }
      expect(requests.map((request) => request.headers.get("x-session-id"))).toEqual([
        "match-1:white",
        "match-1:white",
        "match-1:black",
      ]);
      for (const request of requests) {
        expect(new URL(request.url).hostname).toBe("openrouter.ai");
        expect(request.headers.get("x-openrouter-title")).toBe("Cockpit Chess");
        if (protocol !== "anthropic")
          expect(request.body.prompt_cache_key).toBe(request.headers.get("x-session-id"));
      }
      if (protocol === "anthropic") {
        // One system, one tool, one user marker supplied by TanStack itself.
        expect(cacheMarkers(requests[0]?.body)).toBe(3);
      }
    });

    it.each(["api.openai.com", "inference.example", "api.openrouter.ai", "openrouter.ai.example"])(
      "does not send OpenRouter affinity to %s",
      async (hostname) => {
        const requests = captureHttp(() => responseFor(protocol));
        const base = options(protocol);
        await runAgentLoop({
          ...base,
          model: { ...base.model, baseUrl: `https://${hostname}/v1` },
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers.has("x-session-id")).toBe(false);
        if (protocol !== "anthropic")
          expect(requests[0]?.body.prompt_cache_key).toBe(base.cacheKey);
      },
    );

    it("disables routing affinity and automatic cache wiring with cache:false", async () => {
      const requests = captureHttp(() => responseFor(protocol));
      await runAgentLoop({ ...options(protocol), cache: false });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.has("x-session-id")).toBe(false);
      expect(requests[0]?.body).not.toHaveProperty("prompt_cache_key");
      expect(cacheMarkers(requests[0]?.body)).toBe(0);
    });

    it("does not invent a native routing header without a stable cache key", async () => {
      const requests = captureHttp(() => responseFor(protocol));
      await runAgentLoop({ ...options(protocol), cacheKey: undefined });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.has("x-session-id")).toBe(false);
    });
  },
);

describe("OpenRouter adapter cache routing", () => {
  it("already maps promptCache.key to session_id for Anthropic and other models", async () => {
    const requests = captureHttp(() => chatResponse(chatUsage));
    for (const model of ["anthropic/claude-haiku-4.5", "openai/gpt-4o"]) {
      const base = options("openrouter");
      await runAgentLoop({ ...base, model: { ...base.model, model } });
    }
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.body.session_id)).toEqual([
      "match-1:white",
      "match-1:white",
    ]);
    expect(cacheMarkers(requests[0]?.body)).toBe(3);
    expect(cacheMarkers(requests[1]?.body)).toBe(0);
  });

  it("disables session_id and cache markers with cache:false", async () => {
    const requests = captureHttp(() => chatResponse(chatUsage));
    await runAgentLoop({ ...options("openrouter"), cache: false });
    expect(requests[0]?.body).not.toHaveProperty("session_id");
    expect(cacheMarkers(requests[0]?.body)).toBe(0);
  });
});

describe.each<AgentModel["provider"]>(["openai-chat", "openrouter"])(
  "%s Gemini explicit prefix caching",
  (protocol) => {
    it("marks only the fixed system content across changing turns", async () => {
      const requests = captureHttp(() => chatResponse(chatUsage));
      const base = options(protocol);
      for (const position of ["position one", "position two"]) {
        await runAgentLoop({
          ...base,
          model: { ...base.model, model: "google/gemini-2.5-flash" },
          messages: [
            { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", content: position }] },
          ],
        });
      }
      expect(requests).toHaveLength(2);
      const systems = requests.map((request) => {
        const messages = request.body.messages as Array<Record<string, unknown>>;
        expect(cacheMarkers(messages.at(-1))).toBe(0);
        expect(cacheMarkers(request.body)).toBe(1);
        return messages[0];
      });
      expect(systems[1]).toEqual(systems[0]);
      expect(systems[0]).toMatchObject({ content: [{ cache_control: { type: "ephemeral" } }] });
    });

    it("honors cache:false for Gemini too", async () => {
      const requests = captureHttp(() => chatResponse(chatUsage));
      const base = options(protocol);
      await runAgentLoop({
        ...base,
        cache: false,
        model: { ...base.model, model: "google/gemini-2.5-flash" },
      });
      expect(cacheMarkers(requests[0]?.body)).toBe(0);
    });
  },
);

describe.each<AgentModel["provider"]>([
  "anthropic",
  "openai-chat",
  "openai-responses",
  "openrouter",
])("%s usage from real wire fixtures", (protocol) => {
  it("reports cache reads/writes once through normalized AG-UI and onUsage", async () => {
    captureHttp(() => responseFor(protocol));
    const onUsage = vi.fn();
    const onChunk = vi.fn();
    const base = options(protocol);
    const result = await runAgentLoop({ ...base, onUsage, onChunk });
    const expected = {
      inputTokens: 100,
      outputTokens: 7,
      cachedInputTokens: 80,
      cacheCreationInputTokens: 15,
      model: base.model.model,
    };
    expect(result.stopReason).toBe("completed");
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      ...expected,
      reportedModel: protocol === "anthropic" ? "claude-haiku-4-5" : "gpt-4o",
    });
    // Anthropic input_tokens=5 is uncached: 5 + 80 read + 15 write = 100.
    // OpenAI/OpenRouter prompt/input tokens already include those cache parts.
    expect(result.usage).toEqual(expected);
    expect(onChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "RUN_FINISHED",
        // chat() rebuilds the rich usage object while retaining AG-UI leftovers.
        usage: expect.objectContaining({
          promptTokens: 100,
          promptTokensDetails: { cachedTokens: 80, cacheWriteTokens: 15 },
        }),
        metadata: expect.objectContaining({
          tanstack: expect.objectContaining({
            usage: expect.objectContaining({
              promptTokensDetails: expect.objectContaining({ cacheWriteTokens: 15 }),
            }),
          }),
        }),
      }),
    );
  });

  it("leaves unreported cache counts absent instead of fabricating zero", async () => {
    captureHttp(() => responseFor(protocol, false));
    const onUsage = vi.fn();
    const base = options(protocol);
    const result = await runAgentLoop({ ...base, onUsage });
    const expected = {
      inputTokens: protocol === "anthropic" ? 5 : 100,
      outputTokens: 7,
      model: base.model.model,
    };
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      ...expected,
      reportedModel: protocol === "anthropic" ? "claude-haiku-4-5" : "gpt-4o",
    });
    expect(result.usage).toEqual(expected);
  });

  it("records response-reported model and provider rather than configured identities", async () => {
    const model = "vendor/resolved-model";
    captureHttp(() =>
      protocol === "anthropic"
        ? anthropicResponse({}, model, "Serving Provider")
        : protocol === "openai-responses"
          ? responsesResponse(chatUsage, model, "Serving Provider")
          : chatResponse(chatUsage, model, "Serving Provider"),
    );
    const onUsage = vi.fn();
    const result = await runAgentLoop({ ...options(protocol), onUsage });
    expect(result.stopReason).toBe("completed");
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reportedModel: model, reportedProvider: "Serving Provider" }),
    );
    // Aggregate usage has no single response identity across multiple dispatches.
    expect(result.usage).not.toHaveProperty("reportedModel");
  });

  it("awaits response identity even when the provider reports no token counts", async () => {
    const model = "vendor/no-usage-model";
    captureHttp(() =>
      protocol === "anthropic"
        ? anthropicResponse({}, model, "Serving Provider", false)
        : protocol === "openai-responses"
          ? responsesResponse(undefined, model, "Serving Provider")
          : chatResponse(undefined, model, "Serving Provider"),
    );
    let recorded = false;
    const onReply = vi.fn(async () => {
      await Promise.resolve();
      recorded = true;
    });
    const onUsage = vi.fn();
    const result = await runAgentLoop({ ...options(protocol), onReply, onUsage });
    expect(result.stopReason).toBe("completed");
    expect(result.usage.usageIncomplete).toBe(true);
    expect(onUsage).not.toHaveBeenCalled();
    expect(onReply).toHaveBeenCalledExactlyOnceWith({
      reportedModel: model,
      reportedProvider: "Serving Provider",
    });
    expect(recorded).toBe(true);
  });

  it("reports an unknown reply identity when no response identity is supplied", async () => {
    captureHttp(() =>
      protocol === "anthropic"
        ? anthropicResponse({}, null, undefined, false)
        : protocol === "openai-responses"
          ? responsesResponse(undefined, null)
          : chatResponse(undefined, null),
    );
    const onReply = vi.fn();
    const result = await runAgentLoop({ ...options(protocol), onReply });
    expect(result.stopReason).toBe("completed");
    expect(onReply).toHaveBeenCalledExactlyOnceWith({});
  });

  it.each([null, "", "x".repeat(161), "unsafe\nmodel"])(
    "does not invent reported identity for missing or invalid model %j",
    async (model) => {
      captureHttp(() =>
        protocol === "anthropic"
          ? anthropicResponse({}, model)
          : protocol === "openai-responses"
            ? responsesResponse(chatUsage, model)
            : chatResponse(chatUsage, model),
      );
      const onUsage = vi.fn();
      const result = await runAgentLoop({ ...options(protocol), onUsage });
      expect(result.stopReason).toBe("completed");
      expect(onUsage).toHaveBeenCalledOnce();
      expect(onUsage.mock.calls[0]?.[0]).not.toHaveProperty("reportedModel");
      expect(onUsage.mock.calls[0]?.[0]).not.toHaveProperty("reportedProvider");
    },
  );
});
