import { describe, expect, it, vi } from "vitest";

import { responseIdentityFetch, responseJsonUsage, responseUsage } from "./response-identity";

const response = (text: string, chunks = 1) => {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunks)
          controller.enqueue(bytes.slice(offset, offset + chunks));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream", "x-proof": "retained" } },
  );
};

describe("response identity observer", () => {
  it("preserves every byte while observing split UTF-8 SSE data", async () => {
    const text =
      'data: {"choices":[],"model":"vendor/échecs","provider":"Serving Provider"}\r\n\r\n';
    const observe = vi.fn();
    const base = vi.fn<typeof fetch>(async () => response(text));
    const result = await responseIdentityFetch(
      "openai-chat",
      observe,
      base,
    )("https://example.test");
    expect(await result.text()).toBe(text);
    expect(result.status).toBe(200);
    expect(result.headers.get("x-proof")).toBe("retained");
    expect(observe.mock.calls).toEqual([
      [{}],
      [{ reportedModel: "vendor/échecs", reportedProvider: "Serving Provider" }],
    ]);
  });

  it("accepts multiline SSE data without interpreting content as identity", async () => {
    const text =
      'event: completion\ndata: {"choices":[{"delta":{"content":"provider: impostor"}}],\ndata: "model":"actual-model"}\n\n';
    const observe = vi.fn();
    const base = vi.fn<typeof fetch>(async () => response(text, 7));
    await (await responseIdentityFetch("openrouter", observe, base)("https://example.test")).text();
    expect(observe.mock.calls).toEqual([[{}], [{ reportedModel: "actual-model" }]]);
  });

  it.each([
    `data: {"choices":[],"model":"${"x".repeat(70_000)}"}\n\n`,
    `data: {"choices":[],\n${'data: "padding":"'.concat("x".repeat(40_000), '",\n').repeat(2)}data: "model":"oversized"}\n\n`,
    "data: {malformed}\n\n",
  ])("ignores malformed or bounded-out events and resumes at the next event", async (bad) => {
    const text = `${bad}data: {"choices":[],"model":"valid"}\n\n`;
    const observe = vi.fn();
    const base = vi.fn<typeof fetch>(async () => response(text, 1024));
    const result = await responseIdentityFetch(
      "openai-chat",
      observe,
      base,
    )("https://example.test");
    expect(await result.text()).toBe(text);
    expect(observe.mock.calls).toEqual([[{}], [{ reportedModel: "valid" }]]);
  });

  it("resets identity on each actual HTTP request", async () => {
    const observe = vi.fn();
    const base = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('data: {"choices":[],"model":"first"}\n\n'))
      .mockResolvedValueOnce(response('data: {"choices":[]}\n\n'));
    const fetcher = responseIdentityFetch("openai-chat", observe, base);
    await (await fetcher("https://example.test")).text();
    await (await fetcher("https://example.test")).text();
    expect(observe.mock.calls).toEqual([[{}], [{ reportedModel: "first" }], [{}]]);
  });

  it("leaves non-stream and error responses untouched", async () => {
    const original = new Response('{"model":"not-a-completion"}', {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const observe = vi.fn();
    const base = vi.fn<typeof fetch>(async () => original);
    expect(await responseIdentityFetch("openai-chat", observe, base)("https://example.test")).toBe(
      original,
    );
    expect(observe.mock.calls).toEqual([[{}]]);
    expect(await original.json()).toEqual({ model: "not-a-completion" });
  });

  it("preserves single-argument fetch for Request objects on Bun", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { authorization: "Bearer fixture-key" },
      body: "fixture-body",
    });
    const base = vi.fn<typeof fetch>(async () => new Response("ok"));
    await responseIdentityFetch("openrouter", vi.fn(), base)(request);
    expect(base).toHaveBeenCalledExactlyOnceWith(request);
  });
});

describe("actual-response terminal usage observer", () => {
  const sse = (...events: Record<string, unknown>[]) =>
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const chatFinish = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  const chatUsage = {
    prompt_tokens: 100,
    completion_tokens: 7,
    cost: 0.0002,
    prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 15 },
  };
  const observe = (
    text: string,
    onUsage: (usage: unknown) => Promise<void>,
    protocol: "openai-chat" | "openrouter" | "openai-responses" | "anthropic" = "openai-chat",
    signal = new AbortController().signal,
  ) => responseUsage(response(text, 7), protocol, onUsage, signal);

  it.each(["openai-chat", "openrouter"] as const)(
    "settles %s final usage once and preserves every byte",
    async (protocol) => {
      const text = `${sse(chatFinish, { choices: [], usage: chatUsage }, { choices: [], usage: chatUsage })}data: [DONE]\n\n`;
      const usage = vi.fn(async (_value: unknown) => undefined);
      const result = observe(text, usage, protocol);
      expect(await result.text()).toBe(text);
      expect(usage).toHaveBeenCalledExactlyOnceWith(chatUsage);
      expect(result.headers.get("x-proof")).toBe("retained");
    },
  );

  it("accepts terminal DONE after usage without an earlier explicit finish chunk", async () => {
    const usage = vi.fn(async (_value: unknown) => undefined);
    const text = `${sse({ choices: [], usage: chatUsage })}data: [DONE]\n\n`;
    expect(await observe(text, usage).text()).toBe(text);
    expect(usage).toHaveBeenCalledExactlyOnceWith(chatUsage);
  });

  it("settles Responses completion usage before forwarding the terminal bytes", async () => {
    const reported = {
      input_tokens: 100,
      output_tokens: 7,
      input_tokens_details: { cached_tokens: 80 },
      cost: 0.0003,
    };
    const text = sse(
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.completed", response: { status: "completed", usage: reported } },
    );
    let durable = false;
    const result = observe(
      text,
      async (usage) => {
        expect(usage).toEqual(reported);
        await Promise.resolve();
        durable = true;
      },
      "openai-responses",
    );
    const reader = result.body?.getReader();
    if (!reader) throw new Error("Missing body");
    let received = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += new TextDecoder().decode(next.value);
      if (received.includes('"response.completed"') && received.endsWith("\n\n"))
        expect(durable).toBe(true);
    }
    expect(durable).toBe(true);
    expect(received).toBe(text);
  });

  it("merges Anthropic initial input/cache counts with final cumulative output/cost at message_stop", async () => {
    const initial = {
      input_tokens: 5,
      output_tokens: 0,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 15,
      cache_creation: { ephemeral_5m_input_tokens: 15 },
    };
    const final = { output_tokens: 7, cost: 0.0004 };
    const text = sse(
      { type: "message_start", message: { usage: initial } },
      { type: "message_delta", delta: {}, usage: { output_tokens: 3 } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: final },
      { type: "message_stop" },
    );
    const usage = vi.fn(async (_value: unknown) => undefined);
    expect(await observe(text, usage, "anthropic").text()).toBe(text);
    expect(usage).toHaveBeenCalledExactlyOnceWith({ ...initial, ...final });
  });

  it.each([
    sse(chatFinish),
    sse({ choices: [], usage: chatUsage }),
    `${sse(chatFinish)}data: {malformed}\n\n${sse({ choices: [], usage: chatUsage })}`,
    `${sse(chatFinish)}data: {"padding":"${"x".repeat(70_000)}"}\n\n${sse({ choices: [], usage: chatUsage })}`,
    `${sse(chatFinish, { error: { code: "provider_error" } })}${sse({ choices: [], usage: chatUsage })}`,
    `${sse(chatFinish)}event: error\ndata: {"message":"Failed"}\n\n${sse({ choices: [], usage: chatUsage })}`,
    `${sse(chatFinish)}data: ${JSON.stringify({ choices: [], usage: chatUsage })}`,
  ])(
    "retains the conservative hold for missing, unproven, malformed or oversized reports",
    async (text) => {
      const usage = vi.fn(async (_value: unknown) => undefined);
      expect(await observe(text, usage).text()).toBe(text);
      expect(usage).not.toHaveBeenCalled();
    },
  );

  it("does not settle an HTTP error, an incomplete Responses result or an incomplete Anthropic stream", async () => {
    const usage = vi.fn(async (_value: unknown) => undefined);
    const error = new Response(sse(chatFinish, { choices: [], usage: chatUsage }), {
      status: 503,
      headers: { "content-type": "text/event-stream" },
    });
    expect(responseUsage(error, "openai-chat", usage, new AbortController().signal)).toBe(error);
    await observe(
      sse({ type: "response.incomplete", response: { usage: chatUsage } }),
      usage,
      "openai-responses",
    ).text();
    await observe(
      sse(
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
      ),
      usage,
      "anthropic",
    ).text();
    expect(usage).not.toHaveBeenCalled();
  });

  it("retains the hold on abort or a transport failure before terminal usage", async () => {
    const usage = vi.fn(async (_value: unknown) => undefined);
    const controller = new AbortController();
    controller.abort();
    await observe(
      sse(chatFinish, { choices: [], usage: chatUsage }),
      usage,
      "openai-chat",
      controller.signal,
    ).text();
    const failed = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.error(new Error("fixture transport lost"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    await expect(
      responseUsage(failed, "openai-chat", usage, new AbortController().signal).text(),
    ).rejects.toThrow("fixture transport lost");
    expect(usage).not.toHaveBeenCalled();
  });

  it("propagates settlement failure before terminal bytes reach the SDK", async () => {
    const usage = vi.fn(async () => {
      throw new Error("durable settlement failed");
    });
    const text = sse(chatFinish, { choices: [], usage: chatUsage });
    await expect(observe(text, usage).text()).rejects.toThrow("durable settlement failed");
    expect(usage).toHaveBeenCalledExactlyOnceWith(chatUsage);
  });
});

describe("bounded JSON terminal-usage observation", () => {
  const usage = { cost: 0.000125, prompt_tokens: 100, completion_tokens: 7 };
  const chat = {
    id: "fixture",
    choices: [{ finish_reason: "stop", message: { content: "échecs" } }],
    usage,
  };
  const jsonResponse = (text: string, chunkSize = 7, headers: Record<string, string> = {}) => {
    const original = response(text, chunkSize);
    const result = new Response(original.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-proof": "retained",
        ...headers,
      },
    });
    Object.defineProperties(result, {
      url: { value: "https://openrouter.ai/api/v1/fixture" },
      redirected: { value: false },
      type: { value: "cors" },
    });
    return result;
  };
  it.each([
    ["openai-chat", chat],
    ["openrouter", chat],
    ["openai-responses", { object: "response", status: "completed", usage }],
    ["anthropic", { type: "message", stop_reason: "end_turn", usage }],
  ] as const)(
    "settles proven %s JSON cost before handing any bytes back to the SDK",
    async (protocol, payload) => {
      const text = JSON.stringify(payload);
      const onUsage = vi.fn(async (_raw: unknown) => {
        await Promise.resolve();
      });
      const result = await responseJsonUsage(
        jsonResponse(text, 1),
        protocol,
        onUsage,
        new AbortController().signal,
      );
      expect(onUsage).toHaveBeenCalledExactlyOnceWith(usage);
      expect(await result.text()).toBe(text);
      expect(result.headers.get("x-proof")).toBe("retained");
      expect(result.url).toBe("https://openrouter.ai/api/v1/fixture");
      expect(result.type).toBe("cors");
      expect(result.redirected).toBe(false);
    },
  );

  it.each([
    "{malformed}",
    JSON.stringify({ ...chat, error: { message: "Failed" } }),
    JSON.stringify({ ...chat, choices: [{ finish_reason: null }] }),
    JSON.stringify({ ...chat, choices: [{ finish_reason: "unknown" }] }),
    JSON.stringify({ ...chat, status: "failed" }),
    JSON.stringify({ ...chat, usage: undefined }),
    JSON.stringify({ ...chat, usage: null }),
    JSON.stringify({ ...chat, usage: [] }),
  ])("does not report usage from a malformed or unproven terminal JSON response", async (text) => {
    const onUsage = vi.fn(async (_raw: unknown) => undefined);
    const result = await responseJsonUsage(
      jsonResponse(text),
      "openai-chat",
      onUsage,
      new AbortController().signal,
    );
    expect(await result.text()).toBe(text);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it.each([
    [
      "openai-chat",
      {
        ...chat,
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 15 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      },
    ],
    [
      "openrouter",
      {
        ...chat,
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 15 },
        },
      },
    ],
    [
      "openai-responses",
      {
        object: "response",
        status: "completed",
        usage: {
          input_tokens: 100,
          output_tokens: 7,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 15 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    ],
    [
      "anthropic",
      {
        type: "message",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 15,
          cache_creation: { ephemeral_5m_input_tokens: 15 },
        },
      },
    ],
  ] as const)(
    "forwards %s exact usage categories without requiring provider-reported cost",
    async (protocol, payload) => {
      const text = JSON.stringify(payload);
      const onUsage = vi.fn(async (_raw: unknown) => undefined);
      const result = await responseJsonUsage(
        jsonResponse(text),
        protocol,
        onUsage,
        new AbortController().signal,
      );
      expect(onUsage).toHaveBeenCalledExactlyOnceWith(payload.usage);
      expect(await result.text()).toBe(text);
    },
  );

  it.each([{ prompt_tokens: 100 }, { cost: -1 }, { cost: "not-a-cost" }, { cost: "1e999" }])(
    "passes raw terminal report validity to the financial classifier without fabricating counts",
    async (raw) => {
      const text = JSON.stringify({ ...chat, usage: raw });
      const onUsage = vi.fn(async (_raw: unknown) => undefined);
      const result = await responseJsonUsage(
        jsonResponse(text),
        "openai-chat",
        onUsage,
        new AbortController().signal,
      );
      // Forwarding is not a refund: the caller's classifier retains the full hold
      // when these reports cannot establish a trustworthy bill.
      expect(onUsage).toHaveBeenCalledExactlyOnceWith(raw);
      expect(await result.text()).toBe(text);
    },
  );

  it("caps eager JSON buffering and preserves an oversized response byte for byte without settlement", async () => {
    const text = JSON.stringify({ ...chat, padding: "x".repeat(80_000) });
    const onUsage = vi.fn(async (_raw: unknown) => undefined);
    const result = await responseJsonUsage(
      jsonResponse(text, 1024),
      "openai-chat",
      onUsage,
      new AbortController().signal,
    );
    expect(await result.text()).toBe(text);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("skips eager reading when Content-Length already exceeds the cap", async () => {
    const original = jsonResponse(JSON.stringify(chat), 7, { "content-length": "65537" });
    const onUsage = vi.fn(async (_raw: unknown) => undefined);
    expect(
      await responseJsonUsage(original, "openai-chat", onUsage, new AbortController().signal),
    ).toBe(original);
    expect(original.bodyUsed).toBe(false);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("races abort against a hung JSON body and never waits for a hung cancellation", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => await new Promise<never>(() => {}));
    const original = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "content-type": "application/json" },
    });
    const onUsage = vi.fn(async (_raw: unknown) => undefined);
    const pending = responseJsonUsage(original, "openai-chat", onUsage, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("propagates a failed durable JSON settlement instead of handing a successful result to the SDK", async () => {
    const onUsage = vi.fn(async () => {
      throw new Error("durable settlement failed");
    });
    await expect(
      responseJsonUsage(
        jsonResponse(JSON.stringify(chat)),
        "openai-chat",
        onUsage,
        new AbortController().signal,
      ),
    ).rejects.toThrow("durable settlement failed");
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(usage);
  });
});
