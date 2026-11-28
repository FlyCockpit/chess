import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createMatch } from "@cockpit-chess/chess";
import { advanceMatch } from "@cockpit-chess/chess/runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { localCredentials } from "./chess-provider";
import { RunnerCatalog } from "./runner-catalog";
import { RunnerPolicy } from "./runner-policy";
import { openRunnerSpend, spendingAuthorityId } from "./runner-spend";

type Protocol = "openai-chat" | "openai-responses" | "anthropic";
const models: Record<Protocol, string> = {
  "openai-chat": "google/gemini-fixture",
  "openai-responses": "openai/gpt-fixture",
  anthropic: "anthropic/claude-fixture",
};
const prices = {
  prompt: "0.000001",
  completion: "0.000002",
  request: "0.001",
  input_cache_read: "0.0000001",
  input_cache_write: "0.00000125",
};
const cleanups: (() => Promise<void>)[] = [];

async function fixture(protocol: Protocol, matchLimitMicros?: number, endpointRows?: unknown[]) {
  await mkdir(resolve(".turbo"), { recursive: true });
  const directory = await mkdtemp(resolve(".turbo/runner-provider-http-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "spend.json");
  const spend = await openRunnerSpend({
    authorityId: spendingAuthorityId("synthetic-http-policy-key"),
    file,
  });
  let endpointPrices: Record<string, string> = { ...prices };
  const model = models[protocol];
  const catalog = new RunnerCatalog({
    fetch: vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(
        JSON.stringify(
          String(input).endsWith("/endpoints")
            ? {
                data: {
                  id: model,
                  endpoints: endpointRows ?? [
                    {
                      tag: "priced-provider",
                      model_id: model,
                      context_length: 16_384,
                      max_prompt_tokens: 16_384,
                      max_completion_tokens: 100,
                      status: 0,
                      pricing: endpointPrices,
                    },
                  ],
                },
              }
            : {
                data: [
                  {
                    id: model,
                    context_length: 16_384,
                    pricing: prices,
                    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
                  },
                ],
              },
        ),
      );
    }),
  });
  const policy = await RunnerPolicy.open(
    {},
    {
      catalog,
      spend,
      env: { OPENROUTER_API_KEY: "synthetic-http-policy-key" },
    },
  );
  cleanups.push(() => policy.close());
  if (matchLimitMicros !== undefined)
    policy.applyOperatingLimits(
      { matchMicros: matchLimitMicros, dayMicros: 1_000_000, concurrency: 2 },
      1,
    );
  const white = { name: "White", model, protocol };
  const black = { name: "Black", model, protocol };
  const match = createMatch({ white, black, rules: { legalMoves: "provided" } });
  const authority = policy.beginMatch(match.id, new AbortController().signal);
  const credentials = await localCredentials(match, { runnerAuthority: authority });
  return {
    policy,
    spend,
    match,
    authority,
    credentials,
    file,
    setPrice: (value: Record<string, string>) => {
      endpointPrices = value;
    },
  };
}

// Real runtime/SDK parsing; only the HTTP boundary is faked. No sockets or paid calls.
function reply(protocol: Protocol, model: string, move = "e2e4"): Response {
  const text = JSON.stringify({ move });
  let events: Record<string, unknown>[];
  if (protocol === "openai-chat") {
    const base = { id: "chat-fixture", object: "chat.completion.chunk", created: 0, model };
    events = [
      {
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      {
        ...base,
        choices: [],
        usage: {
          cost: 0.001046,
          prompt_tokens: 100,
          completion_tokens: 7,
          total_tokens: 107,
          prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 15 },
        },
      },
    ];
  } else if (protocol === "openai-responses") {
    const item = {
      type: "message",
      id: "msg-fixture",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const response = {
      id: "resp-fixture",
      object: "response",
      model,
      status: "completed",
      output: [item],
      usage: {
        cost: 0.001046,
        input_tokens: 100,
        output_tokens: 7,
        total_tokens: 107,
        input_tokens_details: { cached_tokens: 80, cache_write_tokens: 15 },
      },
    };
    events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
  } else {
    events = [
      {
        type: "message_start",
        message: {
          id: "msg-fixture",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            cost: 0.001046,
            input_tokens: 5,
            output_tokens: 0,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 15,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 7 },
      },
      { type: "message_stop" },
    ];
  }
  return new Response(
    events
      .map((event) => `event: ${event.type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function cacheMarkers(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + cacheMarkers(item), 0);
  if (typeof value !== "object" || value === null) return 0;
  return Object.entries(value).reduce(
    (sum, [key, item]) =>
      sum + (key === "cache_control" ? Number(item != null) : cacheMarkers(item)),
    0,
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

describe.each<Protocol>(["openai-chat", "openai-responses", "anthropic"])(
  "%s actual local runner spending boundary",
  (protocol) => {
    it("persists authority before the wire, pins routing/privacy and preserves the cache contract", async () => {
      const { match, authority, credentials, spend, file } = await fixture(protocol);
      const sent: Request[] = [];
      const bodies: Record<string, unknown>[] = [];
      const http = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const records = JSON.parse(await readFile(file, "utf8")).records;
        expect(records).toHaveLength(sent.length + 1);
        expect(records.at(-1)).toMatchObject({ matchId: match.id, micros: expect.any(Number) });
        expect(records.at(-1).micros).toBeGreaterThan(1_000);
        expect(spend.snapshot().requests).toBe(records.length);
        expect(request.redirect).toBe("error");
        const suffix = {
          "openai-chat": "chat/completions",
          "openai-responses": "responses",
          anthropic: "messages?beta=true",
        }[protocol];
        expect(request.url).toBe(`https://openrouter.ai/api/v1/${suffix}`);
        expect(request.headers.get("x-session-id")).toBe(`chess-${match.id}-w`);
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-http-policy-key");
        sent.push(request);
        bodies.push(JSON.parse(await request.text()));
        return reply(protocol, models[protocol]);
      });
      vi.stubGlobal("fetch", http);
      await advanceMatch(match, { credentials, signal: authority.signal });
      expect(http).toHaveBeenCalledTimes(1);
      expect(bodies[0]).toMatchObject({
        model: models[protocol],
        provider: {
          only: ["priced-provider"],
          order: ["priced-provider"],
          allow_fallbacks: false,
          require_parameters: true,
          data_collection: "deny",
        },
      });
      if (protocol !== "anthropic") expect(bodies[0]?.prompt_cache_key).toBe(`chess-${match.id}-w`);
      if (protocol === "anthropic") expect(cacheMarkers(bodies[0])).toBeGreaterThan(0);
      if (protocol === "openai-chat") expect(cacheMarkers(bodies[0])).toBe(0);
      expect(match.events.find((event) => event.type === "attempt")).toMatchObject({
        accepted: true,
        move: "e2e4",
      });
      expect(spend.snapshot().requests).toBe(1);
      const persisted = JSON.parse(await readFile(file, "utf8")).records[0];
      expect(persisted.settled).toBe(true);
      expect(persisted.micros).toBe(1046);
      expect(persisted.reservedMicros).toBeGreaterThan(persisted.micros);
      expect(JSON.stringify(match)).not.toContain("synthetic-http-policy-key");
    });

    if (protocol !== "openai-responses")
      it("disables explicit cache writes when their price is unavailable", async () => {
        const { match, authority, credentials, spend, setPrice } = await fixture(protocol);
        setPrice({ prompt: prices.prompt, completion: prices.completion, request: prices.request });
        const http = vi.fn<typeof fetch>(async () => reply(protocol, models[protocol]));
        vi.stubGlobal("fetch", http);
        await advanceMatch(match, { credentials, signal: authority.signal });
        expect(http).toHaveBeenCalledTimes(1);
        expect(spend.snapshot().requests).toBe(1);
        expect(match.events.some((event) => event.type === "attempt" && event.accepted)).toBe(true);
      });
  },
);

it("keeps failed retry reservations across both sides under the combined match ceiling", async () => {
  const { match, authority, credentials, spend, file } = await fixture("openai-chat", 30_000);
  if (!credentials.b?.authorizeRequest) throw new Error("Missing black request authority");
  const blackAuthorize = vi.fn(credentials.b.authorizeRequest);
  credentials.b.authorizeRequest = blackAuthorize;
  // White settles to exact cost; one full failed Black request then fits, its retry cannot.
  let sent = 0;
  const http = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const records = JSON.parse(await readFile(file, "utf8")).records;
    expect(records).toHaveLength(sent + 1);
    expect(request.redirect).toBe("error");
    sent += 1;
    if (sent === 1) return reply("openai-chat", models["openai-chat"]);
    expect(request.headers.get("x-session-id")).toBe(`chess-${match.id}-b`);
    return new Response('{"error":{"message":"Charged failure","type":"server_error"}}', {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", http);
  await advanceMatch(match, { credentials, signal: authority.signal });
  expect(match.events.find((event) => event.type === "attempt")).toMatchObject({ accepted: true });
  await advanceMatch(match, { credentials, signal: authority.signal });
  expect(http).toHaveBeenCalledTimes(2);
  expect(blackAuthorize.mock.calls.length).toBeGreaterThanOrEqual(2);
  const records = JSON.parse(await readFile(file, "utf8")).records;
  expect(records).toHaveLength(2);
  expect(new Set(records.map((record: { matchId: string }) => record.matchId))).toEqual(
    new Set([match.id]),
  );
  expect(spend.snapshot().dayMicros).toBe(
    records.reduce((sum: number, record: { micros: number }) => sum + record.micros, 0),
  );
  expect(spend.snapshot().dayMicros).toBeLessThanOrEqual(30_000);
  expect(match.events.filter((event) => event.type === "attempt" && event.accepted)).toHaveLength(
    1,
  );
});

it("marks actual credential-bearing fetches as redirect:error and sends no redirected request", async () => {
  const { match, authority, credentials, spend } = await fixture("openai-chat");
  const destinations: string[] = [];
  const http = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    destinations.push(request.url);
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-http-policy-key");
    expect(request.redirect).toBe("error");
    return new Response(null, {
      status: 302,
      headers: { location: "https://unapproved.example/steal" },
    });
  });
  vi.stubGlobal("fetch", http);
  await advanceMatch(match, { credentials, signal: authority.signal });
  expect(destinations.length).toBeGreaterThan(0);
  expect(new Set(destinations)).toEqual(new Set(["https://openrouter.ai/api/v1/chat/completions"]));
  // Runtime retries may revisit the approved URL; each keeps its reservation.
  expect(spend.snapshot().requests).toBe(destinations.length);
  expect(match.events.some((event) => event.type === "attempt" && event.accepted)).toBe(false);
});

it("bounds Gemini implicit reads per selectable variant before applying settlement missingness", async () => {
  const endpoint = (tag: string, read?: string) => ({
    tag,
    model_id: models["openai-chat"],
    context_length: 1000,
    max_prompt_tokens: 1000,
    max_completion_tokens: 100,
    status: 0,
    pricing: {
      prompt: "0.000001",
      completion: "0",
      request: "0",
      input_cache_write: "0.000001",
      ...(read ? { input_cache_read: read } : {}),
    },
  });
  const { policy, match, authority, credentials, spend, file } = await fixture(
    "openai-chat",
    2500,
    [endpoint("priced-provider", "0.000004"), endpoint("priced-provider/variant")],
  );
  const refused = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", refused);
  const reserve = vi.spyOn(spend, "reserve");
  await advanceMatch(match, { credentials, signal: authority.signal });
  expect(refused).not.toHaveBeenCalled();
  expect(reserve.mock.calls.length).toBeGreaterThan(0);
  expect(reserve.mock.calls.every(([ticket]) => ticket.micros === 5000)).toBe(true);
  expect(spend.snapshot().requests).toBe(0);
  authority.finish();
  policy.applyOperatingLimits({ matchMicros: 5000, dayMicros: 10_000, concurrency: 2 }, 2);
  const next = createMatch({
    white: match.config.white,
    black: match.config.black,
    rules: match.config.rules,
  });
  const nextAuthority = policy.beginMatch(next.id, new AbortController().signal);
  const nextCredentials = await localCredentials(next, { runnerAuthority: nextAuthority });
  const sent = vi.fn<typeof fetch>(async (input, init) => {
    const wire = new Request(input, init);
    const body = JSON.parse(await wire.text());
    expect(body.prompt_cache_key).toBe(`chess-${next.id}-w`);
    expect(wire.headers.get("x-session-id")).toBe(`chess-${next.id}-w`);
    expect(cacheMarkers(body)).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8")).records[0].reservedMicros).toBe(5000);
    const base = {
      id: "gemini-variant",
      object: "chat.completion.chunk",
      created: 0,
      model: models["openai-chat"],
    };
    const events = [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: '{"move":"e2e4"}' },
            finish_reason: null,
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      {
        ...base,
        choices: [],
        usage: {
          cost: "0.00396",
          prompt_tokens: 990,
          completion_tokens: 10,
          total_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 990, cache_write_tokens: 0 },
        },
      },
    ];
    return new Response(
      `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  vi.stubGlobal("fetch", sent);
  await advanceMatch(next, { credentials: nextCredentials, signal: nextAuthority.signal });
  expect(sent).toHaveBeenCalledTimes(1);
  expect(spend.snapshot().dayMicros).toBe(3960);
});

it("does not generalize the Anthropic SDK beta query exception to other URLs or query parameters", async () => {
  const { credentials, spend } = await fixture("anthropic");
  const authorize = credentials.w?.authorizeRequest;
  if (!authorize) throw new Error("Missing Anthropic request authority");
  const http = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", http);
  for (const url of [
    "https://openrouter.ai/api/v1/messages?beta=false",
    "https://openrouter.ai/api/v1/messages?beta=true&extra=true",
    "https://openrouter.ai/api/v1/messages?beta=true&beta=true",
    "https://openrouter.ai/api/v1/messages?key=not-allowed",
    "https://openrouter.ai/api/v1/messages/other?beta=true",
    "https://unapproved.example/api/v1/messages?beta=true",
  ]) {
    await expect(
      authorize({
        url,
        method: "POST",
        body: JSON.stringify({
          model: models.anthropic,
          max_tokens: 10,
          messages: [{ role: "user", content: "Play chess" }],
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "request" });
  }
  expect(http).not.toHaveBeenCalled();
  expect(spend.snapshot().requests).toBe(0);
});
