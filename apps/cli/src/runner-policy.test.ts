import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createMatch } from "@cockpit-chess/chess";
import { advanceMatch } from "@cockpit-chess/chess/runner";
import { runnerHardLimitsSchema } from "@cockpit-chess/chess/runner-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { responseJsonUsage } from "../../../packages/agent-runtime/src/response-identity";

import { t } from "./chess-i18n";
import { localCredentials } from "./chess-provider";
import { RunnerCatalog } from "./runner-catalog";
import { RunnerPolicy, RunnerPolicyError, readLocalRunnerOptions } from "./runner-policy";
import { openRunnerSpend, spendingAuthorityId } from "./runner-spend";

const model = "anthropic/claude-policy-fixture";
const price = {
  prompt: "0.000001",
  completion: "0.000002",
  request: "0.001",
  input_cache_read: "0.0000001",
  input_cache_write: "0.00000125",
};
const cleanups: (() => Promise<void>)[] = [];
async function fixture(local = false) {
  await mkdir(resolve(".turbo"), { recursive: true });
  const directory = await mkdtemp(resolve(".turbo/runner-policy-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "spend.json");
  const spend = await openRunnerSpend({ authorityId: spendingAuthorityId("synthetic-key"), file });
  let wall = Date.now();
  let monotonic = 0;
  let currentPrice: Record<string, string> = { ...price };
  const catalog = new RunnerCatalog({
    now: () => wall,
    fetch: vi.fn<typeof fetch>(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/endpoints")
              ? {
                  data: {
                    id: model,
                    endpoints: [
                      {
                        tag: "anthropic",
                        model_id: model,
                        context_length: 1000,
                        max_prompt_tokens: 1000,
                        max_completion_tokens: 100,
                        pricing: currentPrice,
                        status: 0,
                      },
                    ],
                  },
                }
              : {
                  data: [
                    {
                      id: model,
                      context_length: 1000,
                      pricing: price,
                      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
                    },
                  ],
                },
          ),
        ),
    ),
  });
  const policy = await RunnerPolicy.open(
    local ? { baseUrl: "http://127.0.0.1:8000/v1", allowModels: [model] } : {},
    {
      catalog,
      spend,
      env: { OPENROUTER_API_KEY: "synthetic-key" },
      now: () => wall,
      monotonicNow: () => monotonic,
    },
  );
  cleanups.push(() => policy.close());
  return {
    policy,
    spend,
    catalog,
    directory,
    file,
    setPrice: (value: Record<string, string>) => {
      currentPrice = value;
    },
    advanceTime: (ms: number, rollback = false) => {
      wall += rollback ? -ms : ms;
      monotonic += ms;
    },
  };
}
function request(
  body: Record<string, unknown> = {},
  url = "https://openrouter.ai/api/v1/chat/completions",
) {
  return {
    url,
    method: "POST",
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "e4" }],
      max_completion_tokens: 10,
      ...body,
    }),
    signal: new AbortController().signal,
  };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

describe("local hard runner authority", () => {
  it("uses confirmed hard and operating defaults and prints a safe startup policy", async () => {
    const { policy } = await fixture();
    expect(policy.capabilities()).toEqual({
      models: [model],
      hard: { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
      operating: { matchMicros: 1_000_000, dayMicros: 10_000_000, concurrency: 2 },
      revision: 0,
    });
    expect(policy.startupNotice()).toContain("25.00");
    expect(policy.startupNotice()).toContain("100.00");
    expect(policy.startupNotice()).toContain("8 concurrent");
    expect(policy.startupNotice()).toContain("prices checked right before each request");
    expect(policy.startupNotice()).toContain("exceed a limit once");
    expect(policy.startupNotice()).toContain("spend limit on the OpenRouter key");
    expect(policy.journalScope()).toBe(spendingAuthorityId("synthetic-key"));
    expect(JSON.stringify(policy.capabilities())).not.toContain(policy.journalScope());
    expect(policy.startupNotice()).not.toContain(policy.journalScope());
    expect(JSON.stringify(policy.capabilities())).not.toMatch(
      /synthetic|openrouter.ai|apiKey|baseUrl/,
    );
    policy.capabilities().hard.matchMicros = 999_000_000;
    expect(policy.capabilities().hard.matchMicros).toBe(25_000_000);
  });

  it("only local startup configuration/flags can raise hard ceilings", async () => {
    const { directory, spend, catalog } = await fixture();
    const file = join(directory, "runner-policy.json");
    await writeFile(
      file,
      JSON.stringify({ maxMatchUsd: "50", maxDayUsd: "500", maxConcurrent: 16 }),
    );
    const options = await readLocalRunnerOptions({ maxMatchUsd: "60.000001" }, file);
    const local = await RunnerPolicy.open(options, {
      catalog,
      spend,
      env: { OPENROUTER_API_KEY: "synthetic-key" },
    });
    expect(local.capabilities().hard).toEqual({
      matchMicros: 60_000_001,
      dayMicros: 500_000_000,
      concurrency: 16,
    });
    for (const bad of ["-1", "NaN", "1e8", "1.0000001"])
      await expect(RunnerPolicy.open({ maxMatchUsd: bad }, { catalog, spend })).rejects.toThrow(
        RunnerPolicyError,
      );
    await writeFile(file, JSON.stringify({ hard: { matchMicros: 999999999 } }));
    await expect(readLocalRunnerOptions({}, file)).rejects.toThrow(RunnerPolicyError);
  });

  it("accepts the paired wire's local ceiling64 and rejects65 before catalog or startup authority", async () => {
    const { directory, catalog, spend } = await fixture();
    const models = vi.spyOn(catalog, "models");
    const local = await RunnerPolicy.open(
      { maxConcurrent: 64 },
      {
        catalog,
        spend,
        env: { OPENROUTER_API_KEY: "synthetic-key" },
      },
    );
    expect(local.capabilities().hard.concurrency).toBe(64);
    expect(runnerHardLimitsSchema.safeParse(local.capabilities().hard).success).toBe(true);
    expect(models).toHaveBeenCalledOnce();
    await expect(
      RunnerPolicy.open(
        { maxConcurrent: 65 },
        {
          catalog,
          spend,
          env: { OPENROUTER_API_KEY: "synthetic-key" },
        },
      ),
    ).rejects.toThrow(RunnerPolicyError);
    expect(models).toHaveBeenCalledOnce();
    const file = join(directory, "too-many-concurrent.json");
    await writeFile(file, JSON.stringify({ maxConcurrent: 65 }));
    await expect(readLocalRunnerOptions({}, file)).rejects.toThrow(RunnerPolicyError);
  });

  it("refuses forged hard fields, excess remote limits and stale revisions", async () => {
    const { policy } = await fixture();
    for (const limits of [
      { matchMicros: 25_000_001, dayMicros: 100_000_000, concurrency: 8 },
      { matchMicros: 25_000_000, dayMicros: 100_000_001, concurrency: 8 },
      { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 9 },
      { matchMicros: 1, dayMicros: 1, concurrency: 1, baseUrl: "https://evil.example" },
    ])
      expect(() => policy.applyOperatingLimits(limits, 1)).toThrow(RunnerPolicyError);
    policy.applyOperatingLimits(
      { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
      1,
    );
    expect(() =>
      policy.applyOperatingLimits({ matchMicros: 1, dayMicros: 1, concurrency: 1 }, 1),
    ).toThrow(RunnerPolicyError);
    expect(policy.capabilities().hard.concurrency).toBe(8);
  });

  it("limits active matches and a local stop cannot be undone by reconnect", async () => {
    const { policy } = await fixture();
    const signal = new AbortController().signal;
    const one = policy.beginMatch("one", signal);
    policy.beginMatch("two", signal);
    expect(() => policy.beginMatch("three", signal)).toThrow(RunnerPolicyError);
    one.finish();
    expect(() => policy.beginMatch("one", signal)).toThrow(RunnerPolicyError);
    policy.beginMatch("three", signal);
    await policy.close();
    expect(() => policy.beginMatch("four", signal)).toThrow(RunnerPolicyError);
    expect(() =>
      policy.applyOperatingLimits(
        { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
        1,
      ),
    ).toThrow(RunnerPolicyError);
  });

  it("pins local endpoints and rejects server aliases, credential and routing fields", async () => {
    const { policy, catalog, spend } = await fixture();
    for (const baseUrl of [
      "https://evil.example/v1",
      "https://openrouter.ai:444/api/v1",
      "https://openrouter.ai/api/v1?key=x",
      "https://u:p@openrouter.ai/api/v1",
    ])
      await expect(RunnerPolicy.open({ baseUrl }, { catalog, spend })).rejects.toThrow(
        RunnerPolicyError,
      );
    const authority = policy.beginMatch("match", new AbortController().signal);
    for (const selection of [
      { model: `${model}:nitro`, protocol: "openai-chat" },
      { model, protocol: "openai-chat", apiKey: "evil" },
      { model, protocol: "openai-chat", baseUrl: "https://evil.example" },
    ])
      await expect(authority.credentials(selection)).rejects.toThrow(RunnerPolicyError);
  });

  it("reserves both sides against one match and refuses a separately charged retry", async () => {
    const { policy, spend, file } = await fixture();
    policy.applyOperatingLimits({ matchMicros: 8600, dayMicros: 8600, concurrency: 2 }, 1);
    const authority = policy.beginMatch("combined-match", new AbortController().signal);
    const white = await authority.credentials({ model, protocol: "openai-chat" });
    const black = await authority.credentials({ model, protocol: "openai-chat" });
    await white.authorizeRequest?.(request());
    expect(spend.snapshot().dayMicros).toBe(3370);
    await black.authorizeRequest?.(request());
    await expect(white.authorizeRequest?.(request())).rejects.toMatchObject({ code: "limits" });
    expect(spend.snapshot().requests).toBe(2);
    expect(JSON.parse(await readFile(file, "utf8")).records).toHaveLength(2);
  });

  it("a reduction below accrued spend stops old authorities and preserves the rolling-day charge", async () => {
    const { policy, spend } = await fixture();
    const match = policy.beginMatch("spent", new AbortController().signal);
    const credentials = await match.credentials({ model, protocol: "openai-chat" });
    await credentials.authorizeRequest?.(request());
    const accrued = spend.snapshot().dayMicros;
    expect(accrued).toBeGreaterThan(1);
    policy.applyOperatingLimits({ matchMicros: 1, dayMicros: 1, concurrency: 1 }, 1);
    expect(match.signal.aborted).toBe(true);
    await expect(credentials.authorizeRequest?.(request())).rejects.toMatchObject({
      code: "offline",
    });
    match.finish();
    const next = policy.beginMatch("new", new AbortController().signal);
    const nextCredentials = await next.credentials({ model, protocol: "openai-chat" });
    await expect(nextCredentials.authorizeRequest?.(request())).rejects.toMatchObject({
      code: "limits",
    });
    expect(spend.snapshot().dayMicros).toBe(accrued);
  });

  it("restores a durable local revision only before matches and cannot restore a stopped policy", async () => {
    const { policy } = await fixture();
    policy.restoreOperatingLimits({
      matchMicros: 2_000_000,
      dayMicros: 20_000_000,
      concurrency: 3,
      revision: 9,
    });
    expect(policy.capabilities()).toMatchObject({
      operating: { matchMicros: 2_000_000 },
      revision: 9,
    });
    expect(() =>
      policy.restoreOperatingLimits({ matchMicros: 1, dayMicros: 1, concurrency: 1, revision: 10 }),
    ).toThrow(RunnerPolicyError);
    policy.stopOperatingLimits();
    expect(() =>
      policy.applyOperatingLimits({ matchMicros: 1, dayMicros: 1, concurrency: 1 }, 10),
    ).toThrow(RunnerPolicyError);
  });

  it("refreshes local price bounds for each wire request and refuses unknown prices", async () => {
    const { policy, setPrice, spend } = await fixture();
    const authority = policy.beginMatch("price", new AbortController().signal);
    const credentials = await authority.credentials({ model, protocol: "openai-chat" });
    setPrice({ ...price, input_cache_write: "0.0001" });
    await credentials.authorizeRequest?.(request());
    expect(spend.snapshot().dayMicros).toBe(102120);
    setPrice({ ...price, prompt: "-1" });
    await expect(credentials.authorizeRequest?.(request())).rejects.toThrow();
    expect(spend.snapshot().requests).toBe(1);
  });

  it("preserves canonical runtime privacy and cache fields while pinning provider routing", async () => {
    const { policy } = await fixture();
    const authority = policy.beginMatch("cache", new AbortController().signal);
    const credentials = await authority.credentials({ model, protocol: "openai-chat" });
    const result = await credentials.authorizeRequest?.(
      request({
        prompt_cache_key: "chess-cache-w",
        session_id: "chess-cache-w",
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "fixed", cache_control: { type: "ephemeral" } }],
          },
        ],
        provider: { only: ["evil"], data_collection: "deny" },
      }),
    );
    expect(credentials.dataCollection).toBe("deny");
    expect(result).toBeDefined();
    if (!result) throw new Error("missing approved body");
    expect(JSON.parse(result.body)).toMatchObject({
      prompt_cache_key: "chess-cache-w",
      session_id: "chess-cache-w",
      messages: [{ content: [{ cache_control: { type: "ephemeral" }, text: "fixed" }] }],
      provider: {
        only: ["anthropic"],
        order: ["anthropic"],
        allow_fallbacks: false,
        data_collection: "deny",
      },
    });
  });

  it("disables unpriced explicit cache creation and refuses unsupported long TTL", async () => {
    const { policy, setPrice } = await fixture();
    const credentials = await policy
      .beginMatch("cache-price", new AbortController().signal)
      .credentials({ model, protocol: "openai-chat" });
    const cached = (ttl?: string) =>
      request({
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "fixed",
                cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) },
              },
            ],
          },
        ],
      });
    await expect(credentials.authorizeRequest?.(cached("1h"))).rejects.toThrow(RunnerPolicyError);
    setPrice({ prompt: price.prompt, completion: price.completion });
    const approved = await credentials.authorizeRequest?.(cached());
    expect(approved?.body).not.toContain("cache_control");
    expect(approved?.body).toContain("fixed");
  });

  it("fails closed on redirects/off-host requests, opaque context and billable features", async () => {
    const { policy, spend } = await fixture();
    const credentials = await policy
      .beginMatch("request", new AbortController().signal)
      .credentials({ model, protocol: "openai-chat" });
    for (const body of [
      { models: ["expensive/model"] },
      { plugins: [{ id: "web" }] },
      { service_tier: "priority" },
      { previous_response_id: "opaque" },
      { max_completion_tokens: null },
      { max_completion_tokens: 101 },
      { n: 2 },
      { tools: [{ type: "web_search_preview" }] },
      { messages: [{ content: [{ type: "image_url", image_url: { url: "x" } }] }] },
    ])
      await expect(credentials.authorizeRequest?.(request(body))).rejects.toThrow(
        RunnerPolicyError,
      );
    await expect(
      credentials.authorizeRequest?.(request({}, "https://evil.example/chat/completions")),
    ).rejects.toThrow(RunnerPolicyError);
    expect(spend.snapshot().requests).toBe(0);
  });

  it("stops new attempts on transport liveness loss or a concurrent limit reduction", async () => {
    const { policy, spend } = await fixture();
    const connection = new AbortController();
    const credentials = await policy
      .beginMatch("offline", connection.signal)
      .credentials({ model, protocol: "openai-chat" });
    connection.abort();
    expect(() => credentials.beforeDispatch?.()).toThrow(RunnerPolicyError);
    await expect(credentials.authorizeRequest?.(request())).rejects.toThrow(RunnerPolicyError);
    expect(spend.snapshot().requests).toBe(0);
    const second = await policy
      .beginMatch("reduction", new AbortController().signal)
      .credentials({ model, protocol: "openai-chat" });
    const original = spend.reserve.bind(spend);
    vi.spyOn(spend, "reserve").mockImplementation(async (input) => {
      await original(input);
      policy.applyOperatingLimits({ matchMicros: 1, dayMicros: 1, concurrency: 1 }, 1);
      // The final policy check must refuse even if the reservation became durable.
      expect(input.micros).toBeGreaterThan(1);
      return undefined;
    });
    await expect(second.authorizeRequest?.(request())).rejects.toThrow(RunnerPolicyError);
    expect(spend.snapshot().requests).toBe(1);
  });

  it("supports only startup-permitted loopback models without exporting a listener or key", async () => {
    const { policy, spend } = await fixture(true);
    const credentials = await policy
      .beginMatch("local", new AbortController().signal)
      .credentials({ model, protocol: "openai-chat" });
    expect(credentials.apiKey).toBe("local-inference");
    await credentials.authorizeRequest?.(request({}, "http://127.0.0.1:8000/v1/chat/completions"));
    expect(spend.snapshot().dayMicros).toBe(0);
    expect(policy.capabilities()).not.toHaveProperty("baseUrl");
  });

  it("retains match spend when a locally reconciled loop resumes a new connection", async () => {
    const { policy, spend } = await fixture();
    const old = new AbortController();
    const authority = policy.beginMatch("resume-known-turn", old.signal);
    const credentials = await authority.credentials({ model, protocol: "openai-chat" });
    await credentials.authorizeRequest?.(request());
    expect(() => authority.resumeConnection(new AbortController().signal)).toThrow(
      RunnerPolicyError,
    );
    old.abort();
    expect(() => credentials.beforeDispatch?.()).toThrow(RunnerPolicyError);
    authority.resumeConnection(new AbortController().signal);
    await credentials.authorizeRequest?.(request());
    expect(spend.snapshot().matches.get(authority.matchId)).toBe(6740);
    authority.stop();
    expect(() => authority.resumeConnection(new AbortController().signal)).toThrow(
      RunnerPolicyError,
    );
  });

  it("keeps reservations but refuses a tariff that expires during durable persistence", async () => {
    const { policy, spend, advanceTime } = await fixture();
    const credentials = await policy
      .beginMatch("expired", new AbortController().signal)
      .credentials({ model, protocol: "openai-chat" });
    const original = spend.reserve.bind(spend);
    vi.spyOn(spend, "reserve").mockImplementation(async (input) => {
      await original(input);
      advanceTime(15_001);
    });
    await expect(credentials.authorizeRequest?.(request())).rejects.toMatchObject({
      code: "model",
    });
    expect(spend.snapshot().requests).toBe(1);
  });

  it("rechecks auxiliary tariffs after fsync even when capped base prices are unchanged", async () => {
    const { policy, spend, setPrice } = await fixture();
    const credentials = await policy
      .beginMatch("tariff-change", new AbortController().signal)
      .credentials({ model, protocol: "openai-chat" });
    const original = spend.reserve.bind(spend);
    vi.spyOn(spend, "reserve").mockImplementation(async (input) => {
      await original(input);
      setPrice({ ...price, input_cache_write: "0.0001" });
    });
    await expect(credentials.authorizeRequest?.(request())).rejects.toMatchObject({
      code: "model",
    });
    expect(spend.snapshot().requests).toBe(1);
  });

  it("checks monotonic tariff expiry again immediately before HTTP despite wall rollback", async () => {
    const { policy, spend, advanceTime } = await fixture();
    const credentials = await policy
      .beginMatch("final-expiry", new AbortController().signal)
      .credentials({ model, protocol: "openai-chat" });
    const authorized = await credentials.authorizeRequest?.(request());
    if (!authorized?.beforeSend) throw new Error("missing final freshness guard");
    advanceTime(15_001, true);
    expect(() => authorized.beforeSend?.()).toThrow(RunnerPolicyError);
    expect(spend.snapshot().requests).toBe(1);
  });

  it("settles provider-reported cost durably so a successful call frees unused allowance", async () => {
    const { policy, spend, file } = await fixture();
    policy.applyOperatingLimits({ matchMicros: 6000, dayMicros: 6000, concurrency: 2 }, 1);
    const credentials = await policy
      .beginMatch("settle", new AbortController().signal)
      .credentials({ model, protocol: "openai-chat" });
    const authorized = await credentials.authorizeRequest?.(request());
    await authorized?.onUsage?.({ cost: 0.0001 });
    expect(spend.snapshot().dayMicros).toBe(100);
    expect(JSON.parse(await readFile(file, "utf8")).records[0]).toMatchObject({
      settled: true,
      micros: 100,
      reservedMicros: 3370,
    });
    await credentials.authorizeRequest?.(request());
    expect(spend.snapshot().requests).toBe(2);
  });

  it.each(["openai-chat", "anthropic"] as const)(
    "settles exact complete cache categories with local prices for %s",
    async (protocol) => {
      const { policy, spend } = await fixture();
      const credentials = await policy
        .beginMatch(`tokens-${protocol}`, new AbortController().signal)
        .credentials({ model, protocol });
      const authorized = await credentials.authorizeRequest?.(
        protocol === "anthropic"
          ? request({ max_tokens: 10 }, "https://openrouter.ai/api/v1/messages?beta=true")
          : request(),
      );
      await authorized?.onUsage?.(
        protocol === "anthropic"
          ? {
              input_tokens: 70,
              output_tokens: 10,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 10,
            }
          : {
              prompt_tokens: 100,
              completion_tokens: 10,
              prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
            },
      );
      expect(spend.snapshot().dayMicros).toBe(1105);
    },
  );

  it("keeps full holds on missing, malformed or incomplete usage", async () => {
    const { policy, spend } = await fixture();
    const credentials = await policy
      .beginMatch("unknown", new AbortController().signal)
      .credentials({ model, protocol: "openai-chat" });
    for (const usage of [
      {},
      { cost: "NaN" },
      { cost: -1 },
      { prompt_tokens: 100, completion_tokens: 10 },
    ]) {
      const authorized = await credentials.authorizeRequest?.(request());
      await authorized?.onUsage?.(usage);
    }
    expect(spend.snapshot().dayMicros).toBe(4 * 3370);
  });

  it("documents the acceptance-time auxiliary tariff race and blocks an above-reservation bill", async () => {
    const { policy, setPrice, file } = await fixture();
    const credentials = await policy
      .beginMatch("over-bill", new AbortController().signal)
      .credentials({ model, protocol: "openai-chat" });
    const authorized = await credentials.authorizeRequest?.(request());
    // No upstream atomic tariff lease exists: this change happens after both reads.
    setPrice({ ...price, input_cache_write: "0.0001" });
    expect(() => authorized?.beforeSend?.()).not.toThrow();
    await expect(authorized?.onUsage?.({ cost: "1" })).rejects.toThrow(RunnerPolicyError);
    expect(JSON.parse(await readFile(file, "utf8")).blocked).toBe(true);
    expect(() => credentials.beforeDispatch?.()).toThrow(RunnerPolicyError);
    expect(() => policy.beginMatch("again", new AbortController().signal)).toThrow(
      RunnerPolicyError,
    );
  });

  it("settles complete JSON category bills without cost and keeps incomplete JSON holds", async () => {
    const { policy, spend } = await fixture();
    const credentials = await policy
      .beginMatch("json-usage", new AbortController().signal)
      .credentials({ model, protocol: "anthropic" });
    const complete = {
      input_tokens: 70,
      output_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 10,
    };
    for (const usage of [
      complete,
      { input_tokens: 70, output_tokens: 10, cache_read_input_tokens: 20 },
    ]) {
      const authorized = await credentials.authorizeRequest?.(
        request({ max_tokens: 10 }, "https://openrouter.ai/api/v1/messages?beta=true"),
      );
      if (!authorized?.onUsage) throw new Error("missing settlement callback");
      const original = JSON.stringify({ type: "message", stop_reason: "end_turn", usage });
      const response = await responseJsonUsage(
        new Response(original, {
          headers: { "content-type": "application/json", "x-fixture": "unchanged" },
        }),
        "anthropic",
        authorized.onUsage,
        new AbortController().signal,
      );
      expect(response.headers.get("x-fixture")).toBe("unchanged");
      expect(await response.text()).toBe(original);
    }
    expect(spend.snapshot().dayMicros).toBe(1105 + 3370);
  });

  it("carries local authority through real chess/provider/SDK HTTP before sending", async () => {
    const { policy, spend } = await fixture();
    const match = createMatch({
      white: { name: "Model", model, protocol: "openai-chat" },
      black: { name: "Random", model: "random", protocol: "random" },
      rules: { legalMoves: "provided" },
    });
    const authority = policy.beginMatch(match.id, new AbortController().signal);
    const credentials = await localCredentials(match, { runnerAuthority: authority });
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const wire = new Request(input, init);
        expect(wire.redirect).toBe("error");
        expect(spend.snapshot().requests).toBe(sent.length + 1);
        expect(wire.headers.get("x-session-id")).toBe(`chess-${match.id}-w`);
        sent.push(JSON.parse(await wire.text()));
        const base = { id: "reply", object: "chat.completion.chunk", created: 0, model };
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
        ];
        return new Response(
          `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    await advanceMatch(match, { credentials, signal: authority.signal });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      prompt_cache_key: `chess-${match.id}-w`,
      provider: { only: ["anthropic"], data_collection: "deny" },
    });
    expect(match.events.find((event) => event.type === "attempt")).toMatchObject({
      accepted: true,
      move: "e2e4",
    });
    expect(JSON.stringify(match)).not.toContain("synthetic-key");
  });

  it.each(["en-US", "es-MX"])("has translated safe errors and startup policy in %s", (lng) => {
    for (const code of ["Config", "Model", "Request", "Limits", "Offline", "Storage", "Policy"])
      expect(t(`cli:runner${code}`, { lng })).not.toContain(`runner${code}`);
  });
});
