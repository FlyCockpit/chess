import { describe, expect, it, vi } from "vitest";

import { responseIdentityFetch } from "./response-identity";

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
