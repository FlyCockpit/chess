import { HTTPClient } from "@openrouter/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createModelAdapter } from "./adapters";
import type { AgentModel } from "./types";

// Capture the args each provider factory is called with so we can assert the config
// (notably the injected `httpClient`) without reaching into adapter internals.
const openRouterCalls: unknown[][] = [];
const openaiCalls: unknown[][] = [];
const chatCompletionsCalls: unknown[][] = [];
const anthropicCalls: unknown[][] = [];

vi.mock("@tanstack/ai-openrouter", () => ({
  createOpenRouterText: (...args: unknown[]) => {
    openRouterCalls.push(args);
    return { name: "openrouter-adapter" };
  },
}));
vi.mock("@tanstack/ai-anthropic", () => ({
  createAnthropicChat: (...args: unknown[]) => {
    anthropicCalls.push(args);
    return { name: "anthropic-adapter" };
  },
}));
vi.mock("@tanstack/ai-openai", () => ({
  createOpenaiChatCompletions: (...args: unknown[]) => {
    chatCompletionsCalls.push(args);
    return { name: "openai-chat-completions-adapter" };
  },
  createOpenaiChat: (...args: unknown[]) => {
    openaiCalls.push(args);
    return { name: "openai-adapter" };
  },
}));

const openai: AgentModel = { provider: "openai-responses", model: "gpt-4o", apiKey: "test-key" };
const anthropic: AgentModel = {
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4-5",
  apiKey: "test-key",
};
const nonAnthropicOpenRouter: AgentModel = {
  provider: "openrouter",
  model: "openai/gpt-4o",
  apiKey: "test-key",
};

/** The config (third) argument the OpenRouter factory was last called with. */
const lastOpenRouterConfig = (): Record<string, unknown> | undefined =>
  openRouterCalls.at(-1)?.[2] as Record<string, unknown> | undefined;

beforeEach(() => {
  openRouterCalls.length = 0;
  openaiCalls.length = 0;
  chatCompletionsCalls.length = 0;
  anthropicCalls.length = 0;
});

describe("createModelAdapter — OpenAI-compatible caching", () => {
  it("sets a stable prompt_cache_key for OpenAI-compatible providers", () => {
    const bundle = createModelAdapter(openai, { enabled: true, cacheKey: "run-1:person" });
    expect(bundle.adapter).toBeDefined();
    expect(bundle.modelOptions).toEqual({ prompt_cache_key: "run-1:person" });
  });

  it("produces byte-identical cache key wiring across sibling calls with the same key", () => {
    const a = createModelAdapter(openai, { enabled: true, cacheKey: "run-1:person" });
    const b = createModelAdapter(openai, { enabled: true, cacheKey: "run-1:person" });
    expect(a.modelOptions).toEqual(b.modelOptions);
  });

  it("omits the cache key when caching is disabled (debug off-switch)", () => {
    const bundle = createModelAdapter(openai, { enabled: false, cacheKey: "run-1:person" });
    expect(bundle.modelOptions).toBeUndefined();
  });

  it("omits the cache key when no key is provided", () => {
    const bundle = createModelAdapter(openai, { enabled: true });
    expect(bundle.modelOptions).toBeUndefined();
  });
});

describe("createModelAdapter — Anthropic-via-OpenRouter cache breakpoints", () => {
  it("wires a beforeRequest HTTPClient for Anthropic models when caching is on", () => {
    const bundle = createModelAdapter(anthropic, { enabled: true, cacheKey: "run-1:person" });
    expect(bundle.adapter).toBeDefined();
    // OpenRouter never uses modelOptions (breakpoints are injected at the HTTP layer).
    expect(bundle.modelOptions).toBeUndefined();
    expect(lastOpenRouterConfig()?.httpClient).toBeInstanceOf(HTTPClient);
  });

  it("defaults caching on when the flag is unset", () => {
    createModelAdapter(anthropic);
    expect(lastOpenRouterConfig()?.httpClient).toBeInstanceOf(HTTPClient);
  });

  it("does not wire the HTTPClient when caching is disabled (off-switch)", () => {
    createModelAdapter(anthropic, { enabled: false, cacheKey: "run-1:person" });
    expect(lastOpenRouterConfig()?.httpClient).toBeUndefined();
  });

  it("is a no-op for non-Anthropic OpenRouter models", () => {
    const bundle = createModelAdapter(nonAnthropicOpenRouter, { enabled: true, cacheKey: "k" });
    expect(bundle.adapter).toBeDefined();
    expect(bundle.modelOptions).toBeUndefined();
    expect(lastOpenRouterConfig()?.httpClient).toBeUndefined();
  });

  it("forwards baseUrl as serverURL and still wires the cache hook", () => {
    createModelAdapter(
      { ...anthropic, baseUrl: "https://proxy.example/api/v1" },
      { enabled: true },
    );
    const config = lastOpenRouterConfig();
    expect(config?.serverURL).toBe("https://proxy.example/api/v1");
    expect(config?.httpClient).toBeInstanceOf(HTTPClient);
  });

  it("disables the SDK's own retries so the runtime's retry adapter is the only layer", () => {
    createModelAdapter(nonAnthropicOpenRouter);
    expect(lastOpenRouterConfig()?.retryConfig).toEqual({ strategy: "none" });
  });

  it("does not throw when no cache options are provided", () => {
    expect(() => createModelAdapter(openai)).not.toThrow();
    expect(() => createModelAdapter(anthropic)).not.toThrow();
    expect(() => createModelAdapter(nonAnthropicOpenRouter)).not.toThrow();
  });
});

describe("explicit provider protocols", () => {
  it("routes Chat Completions to the chat-only adapter", () => {
    createModelAdapter({ ...openai, provider: "openai-chat", baseUrl: "http://localhost:1234/v1" });
    expect(chatCompletionsCalls).toEqual([
      ["gpt-4o", "test-key", { maxRetries: 0, baseURL: "http://localhost:1234/v1" }],
    ]);
    expect(openaiCalls).toHaveLength(0);
  });
  it("routes Responses to the Responses adapter", () => {
    createModelAdapter({ ...openai, provider: "openai-responses" });
    expect(openaiCalls).toEqual([["gpt-4o", "test-key", { maxRetries: 0 }]]);
    expect(chatCompletionsCalls).toHaveLength(0);
  });
  it("routes native Anthropic Messages without OpenAI cache options", () => {
    const result = createModelAdapter(
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        apiKey: "test-key",
        baseUrl: "https://proxy.example/v1",
      },
      { enabled: true, cacheKey: "key" },
    );
    expect(anthropicCalls).toEqual([
      [
        "claude-haiku-4-5",
        "test-key",
        { baseURL: "https://proxy.example", auth: "api-key", maxRetries: 0 },
      ],
    ]);
    expect(result.modelOptions).toBeUndefined();
    expect(openaiCalls).toHaveLength(0);
  });
});

describe("Anthropic gateway authentication", () => {
  it("allows explicit bearer authentication without interpreting credential contents", () => {
    createModelAdapter({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      apiKey: "test-key",
      anthropicAuth: "bearer",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(anthropicCalls).toEqual([
      [
        "claude-haiku-4-5",
        "test-key",
        {
          auth: "bearer",
          maxRetries: 0,
          baseURL: "https://openrouter.ai/api",
          fetch: expect.any(Function),
        },
      ],
    ]);
  });
});

describe("createModelAdapter — extra request headers", () => {
  const headers = {
    "HTTP-Referer": "https://chess.example",
    "X-OpenRouter-Title": "Cockpit Chess",
  };
  it("adds them to every OpenRouter request through a beforeRequest hook", async () => {
    createModelAdapter({ ...nonAnthropicOpenRouter, headers });
    const client = lastOpenRouterConfig()?.httpClient as HTTPClient;
    expect(client).toBeInstanceOf(HTTPClient);
    const seen: Request[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen.push(input as Request);
      return new Response("{}");
    });
    await client.request(
      new Request("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer k" },
      }),
    );
    fetchSpy.mockRestore();
    expect(seen[0]?.headers.get("x-openrouter-title")).toBe("Cockpit Chess");
    expect(seen[0]?.headers.get("http-referer")).toBe("https://chess.example");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer k");
  });
  it("passes them as defaultHeaders to the Anthropic and OpenAI SDKs", () => {
    createModelAdapter({ provider: "anthropic", model: "claude", apiKey: "k", headers });
    expect(
      (anthropicCalls.at(-1)?.[2] as Record<string, unknown> | undefined)?.defaultHeaders,
    ).toEqual(headers);
    createModelAdapter({ provider: "openai-chat", model: "gpt", apiKey: "k", headers });
    expect(
      (chatCompletionsCalls.at(-1)?.[2] as Record<string, unknown> | undefined)?.defaultHeaders,
    ).toEqual(headers);
  });
});

describe("createModelAdapter — beforeDispatch", () => {
  const refuse = () => {
    throw new Error("key lease ended");
  };
  it("runs the guard before every OpenRouter request, sending nothing when it throws", async () => {
    createModelAdapter({ ...nonAnthropicOpenRouter, beforeDispatch: refuse });
    const client = lastOpenRouterConfig()?.httpClient as HTTPClient;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await expect(
      client.request(new Request("https://openrouter.ai/api/v1/chat/completions")),
    ).rejects.toThrow("key lease ended");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("wraps the Anthropic and OpenAI SDK fetch with the guard", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    let allow = false;
    const guard = () => {
      if (!allow) refuse();
    };
    createModelAdapter({
      provider: "anthropic",
      model: "claude",
      apiKey: "k",
      beforeDispatch: guard,
    });
    createModelAdapter({
      provider: "openai-chat",
      model: "gpt",
      apiKey: "k",
      beforeDispatch: guard,
    });
    createModelAdapter({
      provider: "openai-responses",
      model: "gpt",
      apiKey: "k",
      beforeDispatch: guard,
    });
    const fetches = [anthropicCalls, chatCompletionsCalls, openaiCalls].map(
      (calls) => (calls.at(-1)?.[2] as { fetch?: typeof fetch } | undefined)?.fetch,
    );
    for (const wrapped of fetches) {
      expect(wrapped).toBeTypeOf("function");
      expect(() => wrapped?.("https://x.example/")).toThrow("key lease ended");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    allow = true;
    for (const wrapped of fetches) await wrapped?.("https://x.example/");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    fetchSpy.mockRestore();
  });
});

describe("createModelAdapter — durable actual-request authorization", () => {
  const endpoint = "https://openrouter.ai/api/v1/chat/completions";
  const body = JSON.stringify({
    model: "google/gemini-test",
    messages: [
      { role: "system", content: "Stable prefix" },
      { role: "user", content: "Turn" },
    ],
    max_completion_tokens: 20,
    prompt_cache_key: "match:side",
  });

  const requestFetcher = (model: AgentModel): typeof fetch => {
    createModelAdapter(model, { enabled: true, cacheKey: "match:side" });
    if (model.provider === "openrouter") {
      const client = lastOpenRouterConfig()?.httpClient as HTTPClient;
      return (input, init) => client.request(new Request(input, init));
    }
    const calls =
      model.provider === "anthropic"
        ? anthropicCalls
        : model.provider === "openai-chat"
          ? chatCompletionsCalls
          : openaiCalls;
    const fetcher = (calls.at(-1)?.[2] as { fetch?: typeof fetch } | undefined)?.fetch;
    if (!fetcher) throw new Error("Expected guarded SDK fetch");
    return fetcher;
  };

  for (const provider of ["openrouter", "openai-chat", "openai-responses", "anthropic"] as const) {
    it(`awaits durable authority before every ${provider} HTTP attempt and keeps failed attempts held`, async () => {
      const order: string[] = [];
      let held = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const sent = input as Request;
        expect(sent.redirect).toBe("error");
        expect(held).toBeGreaterThan(0);
        order.push("wire");
        return new Response("{}", { status: 503 });
      });
      const wrapped = requestFetcher({
        provider,
        model: "vendor/model",
        apiKey: "test-key",
        beforeDispatch: () => {
          order.push("guard");
        },
        authorizeRequest: async (request) => {
          expect(request.url).toBe(endpoint);
          expect(request.method).toBe("POST");
          expect(request.body).toBe(body);
          await Promise.resolve();
          held += 1;
          order.push("durable");
          if (held > 2) throw new Error("local cap");
          return undefined;
        },
      });
      try {
        for (let attempt = 0; attempt < 2; attempt += 1)
          expect((await wrapped(endpoint, { method: "POST", body })).status).toBe(503);
        await expect(wrapped(endpoint, { method: "POST", body })).rejects.toThrow("local cap");
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(order).toEqual([
          "guard",
          "durable",
          "guard",
          "wire",
          "guard",
          "durable",
          "guard",
          "wire",
          "guard",
          "durable",
        ]);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it(`binds ${provider} terminal usage to the individual awaited HTTP reservation`, async () => {
      let holds = 0;
      const settled: number[] = [];
      const raw =
        provider === "anthropic"
          ? { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 80 }
          : { prompt_tokens: 100, completion_tokens: 7 };
      const events =
        provider === "anthropic"
          ? [
              {
                type: "message_start",
                message: {
                  usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 80 },
                },
              },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 7 },
              },
              { type: "message_stop" },
            ]
          : provider === "openai-responses"
            ? [{ type: "response.completed", response: { usage: raw } }]
            : [{ choices: [{ finish_reason: "stop" }] }, { choices: [], usage: raw }];
      const bytes = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        expect(holds).toBeGreaterThan(0);
        return new Response(bytes, { headers: { "content-type": "text/event-stream" } });
      });
      const wrapped = requestFetcher({
        provider,
        model: "vendor/model",
        apiKey: "test-key",
        authorizeRequest: async () => {
          const reservation = ++holds;
          return {
            body,
            onUsage: async (usage) => {
              expect(usage).toEqual(raw);
              await Promise.resolve();
              settled.push(reservation);
            },
          };
        },
      });
      try {
        // Reverse response consumption proves callbacks never attach to a mutable
        // "latest reservation" slot shared by concurrent sides or retries.
        const first = await wrapped(endpoint, { method: "POST", body });
        const second = await wrapped(endpoint, { method: "POST", body });
        expect(await second.text()).toBe(bytes);
        expect(await first.text()).toBe(bytes);
        expect(settled).toEqual([2, 1]);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  }

  it("rechecks the hosted key-use guard after awaiting local persistence", async () => {
    let live = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const wrapped = requestFetcher({
      ...openai,
      beforeDispatch: () => {
        if (!live) throw new Error("key lease ended");
      },
      authorizeRequest: async () => {
        live = false;
        return undefined;
      },
    });
    try {
      await expect(wrapped(endpoint, { method: "POST", body })).rejects.toThrow("key lease ended");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("settles a known terminal JSON cost before returning the non-SSE response to the SDK", async () => {
    const events: string[] = [];
    const usage = { cost: 0.000125, prompt_tokens: 100, completion_tokens: 7 };
    const bytes = JSON.stringify({ choices: [{ finish_reason: "stop" }], usage });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      events.push("wire");
      return new Response(bytes, { headers: { "content-type": "application/json" } });
    });
    const wrapped = requestFetcher({
      ...openai,
      provider: "openai-chat",
      authorizeRequest: async () => {
        events.push("durable");
        return {
          body,
          onUsage: async (raw) => {
            expect(raw).toEqual(usage);
            await Promise.resolve();
            events.push("settled");
          },
        };
      },
    });
    try {
      const result = await wrapped(endpoint, { method: "POST", body });
      expect(events).toEqual(["durable", "wire", "settled"]);
      expect(await result.text()).toBe(bytes);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("cannot dispatch after an abort during durable persistence", async () => {
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const wrapped = requestFetcher({
      ...openai,
      authorizeRequest: async () => {
        controller.abort();
        return undefined;
      },
    });
    try {
      await expect(
        wrapped(endpoint, { method: "POST", body, signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("revalidates persisted authorization expiry synchronously immediately before HTTP", async () => {
    let held = 0;
    let now = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const beforeSend = vi.fn(() => {
      if (now >= 100) throw new Error("authorization expired");
    });
    const wrapped = requestFetcher({
      ...openai,
      beforeDispatch: () => {
        if (held > 0) now = 100;
      },
      authorizeRequest: async () => {
        await Promise.resolve();
        held += 1;
        return { body, beforeSend };
      },
    });
    try {
      await expect(wrapped(endpoint, { method: "POST", body })).rejects.toThrow(
        "authorization expired",
      );
      expect(held).toBe(1);
      expect(beforeSend).toHaveBeenCalledOnce();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("checks cancellation again after the final authorization guard", async () => {
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const wrapped = requestFetcher({
      ...openai,
      authorizeRequest: async () => ({ body, beforeSend: () => controller.abort() }),
    });
    try {
      await expect(
        wrapped(endpoint, { method: "POST", body, signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("authorizes transformed cache bytes and sends the exact locally rewritten body, preserving session headers", async () => {
    const seen: Request[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen.push(input as Request);
      return new Response("{}");
    });
    const authorized: string[] = [];
    const wrapped = requestFetcher({
      provider: "openai-chat",
      model: "google/gemini-test",
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      dataCollection: "deny",
      authorizeRequest: async (request) => {
        const final = JSON.parse(request.body);
        expect(final.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
        expect(final.prompt_cache_key).toBe("match:side");
        expect(final.provider).toMatchObject({ data_collection: "deny" });
        final.provider = { ...final.provider, allow_fallbacks: false };
        const replacement = JSON.stringify(final);
        authorized.push(replacement);
        return { body: replacement };
      },
    });
    try {
      await wrapped(endpoint, {
        method: "POST",
        body,
        headers: { "x-session-id": "match:side", authorization: "Bearer test-key" },
      });
      expect(await seen[0]?.text()).toBe(authorized[0]);
      expect(seen[0]?.headers.get("x-session-id")).toBe("match:side");
      expect(seen[0]?.headers.get("authorization")).toBe("Bearer test-key");
      expect(seen[0]?.redirect).toBe("error");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("authorizes the SDK's final OpenRouter cache-hook body without consuming the outbound request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const sent = input as Request;
      expect(JSON.parse(await sent.text()).messages[0].content[0].cache_control).toEqual({
        type: "ephemeral",
      });
      return new Response("{}");
    });
    const authorizeRequest = vi.fn(async (request: { body: string }) => {
      expect(JSON.parse(request.body).messages[0].content[0].cache_control).toEqual({
        type: "ephemeral",
      });
      return undefined;
    });
    const wrapped = requestFetcher({ ...anthropic, authorizeRequest });
    try {
      await wrapped(endpoint, {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      });
      expect(authorizeRequest).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each(["openrouter", "anthropic", "openai-chat", "openai-responses"] as const)(
    "%s rechecks persisted authorization expiry after the owner admission wait",
    async (provider) => {
      let expired = false;
      const beforeSend = vi.fn(() => {
        if (expired) throw new Error("authorization expired");
      });
      const beforeDispatch = vi.fn();
      const dispatchGuard = vi.fn(async (send: () => Promise<Response>) => {
        await Promise.resolve();
        expired = true;
        return send();
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
      const wrapped = requestFetcher({
        provider,
        model: "vendor/model",
        apiKey: "test-key",
        dataCollection: "deny",
        beforeDispatch,
        dispatchGuard,
        authorizeRequest: async () => ({ body, beforeSend }),
      });
      try {
        await expect(wrapped(endpoint, { method: "POST", body })).rejects.toThrow(
          "authorization expired",
        );
        expect(dispatchGuard).toHaveBeenCalledOnce();
        expect(beforeDispatch).toHaveBeenCalledTimes(2);
        expect(beforeSend).toHaveBeenCalledOnce();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  it.each(["openrouter", "anthropic", "openai-chat", "openai-responses"] as const)(
    "%s authorizes final privacy bytes before owner admission and settles usage outside it",
    async (provider) => {
      let admitted = false;
      const order: string[] = [];
      const usage = { cost: 0.000125 };
      let replacement = "";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        expect(admitted).toBe(true);
        expect(await (input as Request).text()).toBe(replacement);
        order.push("wire");
        const terminal =
          provider === "anthropic"
            ? { type: "message", stop_reason: "end_turn" }
            : provider === "openai-responses"
              ? { object: "response", status: "completed" }
              : { choices: [{ finish_reason: "stop" }] };
        return new Response(JSON.stringify({ ...terminal, usage }), {
          headers: { "content-type": "application/json" },
        });
      });
      const wrapped = requestFetcher({
        provider,
        model: "vendor/model",
        apiKey: "test-key",
        dataCollection: "deny",
        beforeDispatch: () => {
          order.push("lease");
        },
        authorizeRequest: async (request) => {
          expect(admitted).toBe(false);
          const final = JSON.parse(request.body);
          expect(final.provider).toMatchObject({ data_collection: "deny" });
          expect(final.prompt_cache_key).toBe("match:side");
          final.provider.allow_fallbacks = false;
          replacement = JSON.stringify(final);
          await Promise.resolve();
          order.push("authorized");
          return {
            body: replacement,
            beforeSend: () => {
              expect(admitted).toBe(true);
              order.push("expiry");
            },
            onUsage: async (raw) => {
              expect(admitted).toBe(false);
              expect(raw).toEqual(usage);
              order.push("settled");
            },
          };
        },
        dispatchGuard: async (send) => {
          await Promise.resolve();
          admitted = true;
          order.push("admitted");
          try {
            return await send();
          } finally {
            admitted = false;
          }
        },
      });
      try {
        await wrapped(endpoint, { method: "POST", body });
        expect(order).toEqual([
          "lease",
          "authorized",
          "admitted",
          "lease",
          "expiry",
          "wire",
          "settled",
        ]);
        expect(fetchSpy).toHaveBeenCalledOnce();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  it("refuses unsupported body carriers before invoking authorization or fetch", async () => {
    const authorizeRequest = vi.fn(async () => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const wrapped = requestFetcher({ ...openai, authorizeRequest });
    try {
      await expect(wrapped(endpoint, { method: "POST", body: new FormData() })).rejects.toThrow(
        "cannot be authorized",
      );
      expect(authorizeRequest).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("createModelAdapter — durable dispatchGuard", () => {
  it.each(["openrouter", "anthropic", "openai-chat", "openai-responses"] as const)(
    "%s admits only after the privacy rewrite and charges the immediate guard once",
    async (provider) => {
      let decoded: () => void = () => {};
      const decoding = new Promise<void>((resolve) => {
        decoded = resolve;
      });
      let finishDecode: () => void = () => {};
      const releaseDecode = new Promise<void>((resolve) => {
        finishDecode = resolve;
      });
      const originalJson = Request.prototype.json;
      const jsonSpy = vi.spyOn(Request.prototype, "json").mockImplementation(async function (
        this: Request,
      ) {
        const body: unknown = await originalJson.call(this);
        decoded();
        await releaseDecode;
        return body;
      });
      let allow = true;
      const beforeDispatch = vi.fn();
      const dispatchGuard = vi.fn(async (send: () => Promise<Response>) => {
        if (!allow) throw new Error("account pending deletion");
        return send();
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const body: unknown = JSON.parse(await request.text());
        expect(body).toMatchObject({ provider: { data_collection: "deny" } });
        return new Response("{}");
      });
      let inFlight: Promise<unknown> | undefined;
      try {
        createModelAdapter({
          provider,
          model: "test-model",
          apiKey: "k",
          baseUrl: "https://openrouter.ai/api/v1",
          dataCollection: "deny",
          dispatchGuard,
          beforeDispatch,
        });
        const request = () => {
          const value = new Request("https://openrouter.ai/api/v1/provider", {
            method: "POST",
            body: JSON.stringify({ messages: [] }),
          });
          if (provider === "openrouter") {
            const client = lastOpenRouterConfig()?.httpClient as HTTPClient;
            return client.request(value);
          }
          const calls =
            provider === "anthropic"
              ? anthropicCalls
              : provider === "openai-chat"
                ? chatCompletionsCalls
                : openaiCalls;
          const config = calls.at(-1)?.[2] as { fetch?: typeof fetch } | undefined;
          if (!config?.fetch) throw new Error("Missing guarded fetch");
          return config.fetch(value);
        };
        const waiting = request();
        inFlight = waiting;
        await decoding;
        expect(dispatchGuard).not.toHaveBeenCalled();
        allow = false;
        finishDecode();
        await expect(waiting).rejects.toThrow("account pending deletion");
        expect(beforeDispatch).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        allow = true;
        await request();
        expect(dispatchGuard).toHaveBeenCalledTimes(2);
        expect(beforeDispatch).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        finishDecode();
        await inFlight?.catch(() => undefined);
        jsonSpy.mockRestore();
        fetchSpy.mockRestore();
      }
    },
  );

  it.each(["openrouter", "anthropic", "openai-chat", "openai-responses"] as const)(
    "%s checks asynchronous admission and runs the immediate lease guard after it",
    async (provider) => {
      let allow = false;
      const order: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        order.push("fetch");
        return new Response("{}");
      });
      try {
        createModelAdapter({
          provider,
          model: "test-model",
          apiKey: "k",
          dispatchGuard: async (send) => {
            await Promise.resolve();
            if (!allow) throw new Error("account pending deletion");
            order.push("admitted");
            return send();
          },
          beforeDispatch: () => {
            order.push("lease");
          },
        });
        const request = () => {
          if (provider === "openrouter") {
            const client = lastOpenRouterConfig()?.httpClient as HTTPClient;
            return client.request(new Request("https://example.test/provider"));
          }
          const calls =
            provider === "anthropic"
              ? anthropicCalls
              : provider === "openai-chat"
                ? chatCompletionsCalls
                : openaiCalls;
          const config = calls.at(-1)?.[2] as { fetch?: typeof fetch } | undefined;
          if (!config?.fetch) throw new Error("Missing guarded fetch");
          const wrapped = config.fetch;
          return wrapped("https://example.test/provider");
        };
        await expect(request()).rejects.toThrow("account pending deletion");
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(order).toEqual([]);
        allow = true;
        await request();
        expect(order).toEqual(["admitted", "lease", "fetch"]);
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );
});
