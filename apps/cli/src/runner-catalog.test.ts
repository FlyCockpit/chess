import { describe, expect, it, vi } from "vitest";
import { RunnerCatalog } from "./runner-catalog";

const model = "vendor/model";
const price = {
  prompt: "0.000001",
  completion: "0.000002",
  request: "0.001",
  input_cache_read: "0.0000001",
  input_cache_write: "0.00000125",
  internal_reasoning: "0.000003",
};
const entry = (id = model, pricing: unknown = price) => ({
  id,
  pricing,
  context_length: 128000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
});
const endpoint = (tag = "vendor", pricing: unknown = price) => ({
  tag,
  model_id: model,
  context_length: 128000,
  max_prompt_tokens: 100000,
  max_completion_tokens: 4000,
  pricing,
  status: 0,
  service_tier: null,
});
const response = (value: unknown) => new Response(JSON.stringify(value));
function fixture(endpoints: unknown[] = [endpoint()], entries: unknown[] = [entry()]) {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/endpoints")
      ? response({ data: { id: model, endpoints } })
      : response({ data: entries }),
  );
  return { fetcher, catalog: new RunnerCatalog({ fetch: fetcher, now: () => 1000 }) };
}

describe("local runner catalog", () => {
  it("discovers exact priced identifiers locally and narrows only with local allowlist", async () => {
    const { fetcher } = fixture(
      [],
      [
        entry(),
        entry("vendor/other"),
        entry("openrouter/auto"),
        entry("vendor/model:nitro"),
        entry("vendor/model:online"),
        entry("bad/../path"),
        entry("vendor/unpriced", { prompt: "-1", completion: "1" }),
      ],
    );
    const catalog = new RunnerCatalog({ fetch: fetcher, allowModels: [model] });
    expect(await catalog.models()).toEqual([model]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/models");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("headers");
    await expect(catalog.quote("vendor/other")).rejects.toThrow("RUNNER_CATALOG_UNSUPPORTED");
  });

  it("requires documented text input and exclusively text output architecture", async () => {
    const missing = { id: "vendor/missing", pricing: price, context_length: 128000 };
    const { catalog } = fixture(
      [],
      [
        entry(),
        missing,
        {
          ...entry("vendor/audio"),
          architecture: { input_modalities: ["text"], output_modalities: ["audio"] },
        },
        {
          ...entry("vendor/mixed"),
          architecture: { input_modalities: ["text"], output_modalities: ["text", "audio"] },
        },
        {
          ...entry("vendor/no-text"),
          architecture: { input_modalities: ["audio"], output_modalities: ["text"] },
        },
        {
          ...entry("vendor/vision"),
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        },
      ],
    );
    expect(await catalog.models()).toEqual([model, "vendor/vision"]);
  });

  it("validates the known one-hour cache tariff without applying a prohibited TTL", async () => {
    const { catalog } = fixture([
      endpoint("vendor", { ...price, input_cache_write_1h: "0.000002" }),
    ]);
    const quote = await catalog.quote(model);
    expect(quote.inputMicrosPerMillion).toBe(2350000);
    expect(quote.exactPrices?.cacheWriteMicrosPerMillion).toBe(1250000);
    const bad = fixture([endpoint("vendor", { ...price, input_cache_write_1h: "-1" })]);
    await expect(bad.catalog.quote(model)).rejects.toThrow("RUNNER_CATALOG_UNSUPPORTED");
  });

  it("reserves all cache categories and separate reasoning/request charges in integer micros", async () => {
    const { catalog } = fixture();
    expect(await catalog.quote(model)).toEqual({
      model,
      providerSlug: "vendor",
      inputTokenLimit: 100000,
      outputTokenLimit: 4000,
      inputMicrosPerMillion: 2350000,
      implicitInputMicrosPerMillion: 1100000,
      outputMicrosPerMillion: 5000000,
      requestMicros: 1000,
      cacheWriteKnown: true,
      prices: {
        promptMicrosPerMillion: 1000000,
        completionMicrosPerMillion: 2000000,
        cacheReadMicrosPerMillion: 100000,
        cacheWriteMicrosPerMillion: 1250000,
        reasoningMicrosPerMillion: 3000000,
        requestMicros: 1000,
      },
      exactPrices: {
        promptMicrosPerMillion: 1000000,
        completionMicrosPerMillion: 2000000,
        cacheReadMicrosPerMillion: 100000,
        cacheWriteMicrosPerMillion: 1250000,
        reasoningMicrosPerMillion: 3000000,
        requestMicros: 1000,
      },
      expiresAt: 16000,
      providerRouting: {
        only: ["vendor"],
        order: ["vendor"],
        allow_fallbacks: false,
        require_parameters: true,
        max_price: { prompt: 1, completion: 2, request: 0.001 },
      },
    });
  });

  it("rounds tiny decimal and exponential rates up without binary underestimation", async () => {
    const { catalog } = fixture([
      endpoint("vendor", {
        prompt: "1e-13",
        completion: "0.00000000000100000000000001",
        request: "0.0000000001",
      }),
    ]);
    expect(await catalog.quote(model)).toMatchObject({
      inputMicrosPerMillion: 2,
      outputMicrosPerMillion: 2,
      requestMicros: 1,
      cacheWriteKnown: false,
      providerRouting: { max_price: { prompt: 0.000001, completion: 0.000002, request: 0.000001 } },
    });
  });

  it("bounds every endpoint matched by a base slug, including higher cache tariffs", async () => {
    const { catalog } = fixture([
      endpoint(),
      {
        ...endpoint("vendor/region", { ...price, input_cache_write: "0.00001" }),
        context_length: 200000,
        max_prompt_tokens: null,
        max_completion_tokens: 2000,
      },
    ]);
    expect(await catalog.quote(model, undefined, "vendor")).toMatchObject({
      providerSlug: "vendor",
      inputTokenLimit: 200000,
      outputTokenLimit: 2000,
      inputMicrosPerMillion: 11100000,
    });
  });

  it("permits price-based settlement only when every matched tariff is identical", async () => {
    const same = fixture([endpoint(), endpoint("vendor/region")]);
    const sameQuote = await same.catalog.quote(model, undefined, "vendor");
    expect(sameQuote.exactPrices).toEqual(sameQuote.prices);
    expect(Object.isFrozen(sameQuote.exactPrices)).toBe(true);
    const different = fixture([
      endpoint(),
      endpoint("vendor/region", { ...price, input_cache_write: "0.000002" }),
    ]);
    const differentQuote = await different.catalog.quote(model, undefined, "vendor");
    expect(differentQuote.prices.cacheWriteMicrosPerMillion).toBe(2000000);
    expect(differentQuote).not.toHaveProperty("exactPrices");
  });

  it("does not invent missing category prices for successful settlement", async () => {
    const partialPrice = { prompt: "0.000001", completion: "0.000002", request: "0.001" };
    const { catalog } = fixture([endpoint(), endpoint("vendor/region", partialPrice)]);
    const quote = await catalog.quote(model, undefined, "vendor");
    expect(quote.prices).toEqual({
      promptMicrosPerMillion: 1000000,
      completionMicrosPerMillion: 2000000,
      reasoningMicrosPerMillion: 3000000,
      requestMicros: 1000,
    });
    expect(quote).not.toHaveProperty("exactPrices");
  });

  it("reserves known implicit cache reads even when a matching sibling omits its read price", async () => {
    const shared = { prompt: "0.000001", completion: "0", input_cache_write: "0.000001" };
    const { catalog } = fixture([
      {
        ...endpoint("vendor", { ...shared, input_cache_read: "0.000004" }),
        context_length: 1000,
        max_prompt_tokens: 1000,
        max_completion_tokens: 1,
      },
      {
        ...endpoint("vendor/region", shared),
        context_length: 1000,
        max_prompt_tokens: 1000,
        max_completion_tokens: 1,
      },
    ]);
    const quote = await catalog.quote(model, undefined, "vendor");
    expect(quote.inputMicrosPerMillion).toBe(6000000);
    expect(quote.implicitInputMicrosPerMillion).toBe(5000000);
    expect(quote.inputTokenLimit).toBe(1000);
    expect(quote.prices).not.toHaveProperty("cacheReadMicrosPerMillion");
    expect(quote).not.toHaveProperty("exactPrices");
  });

  it("does not overlook an unsupported matching variant when pinning base slug", async () => {
    const { catalog } = fixture([
      endpoint(),
      endpoint("vendor/region", { ...price, unknown_fee: "0.001" }),
    ]);
    await expect(catalog.quote(model, undefined, "vendor")).rejects.toThrow(
      "RUNNER_CATALOG_UNSUPPORTED",
    );
  });

  it("refreshes the pinned route on every request and never switches to an available alternative", async () => {
    const { fetcher, catalog } = fixture([endpoint(), endpoint("other")]);
    await catalog.quote(model, undefined, "vendor");
    fetcher.mockImplementationOnce(async () =>
      response({ data: { id: model, endpoints: [endpoint("other")] } }),
    );
    await expect(catalog.quote(model, undefined, "vendor")).rejects.toThrow(
      "RUNNER_CATALOG_UNSUPPORTED",
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("refreshes changed prices before authorizing another attempt", async () => {
    const { fetcher, catalog } = fixture();
    const old = await catalog.quote(model, undefined, "vendor");
    fetcher.mockImplementationOnce(async () =>
      response({
        data: { id: model, endpoints: [endpoint("vendor", { ...price, completion: "0.00002" })] },
      }),
    );
    const fresh = await catalog.quote(model, undefined, "vendor");
    expect(fresh.outputMicrosPerMillion).toBeGreaterThan(old.outputMicrosPerMillion);
    expect(fresh.providerRouting.max_price.completion).toBe(20);
  });

  it.each([
    { ...price, prompt: "-1" },
    { ...price, request: "variable" },
    { ...price, input_cache_write: "-0.1" },
    { ...price, internal_reasoning: "NaN" },
    { ...price, unreviewed: "0" },
    { ...price, prompt: "1e999" },
    { ...price, completion: "9007199254740992" },
    { ...price, prompt: { tiers: [] } },
  ])("fails closed on unsupported/variable prices %j", async (pricing) => {
    const { catalog } = fixture([endpoint("vendor", pricing)]);
    await expect(catalog.quote(model)).rejects.toThrow("RUNNER_CATALOG_UNSUPPORTED");
  });

  it("requires exact model identity and finite context/output limits", async () => {
    for (const bad of [
      { ...endpoint(), model_id: "vendor/different" },
      { ...endpoint(), max_completion_tokens: 0 },
      { ...endpoint(), context_length: Number.MAX_SAFE_INTEGER },
      { ...endpoint(), service_tier: "priority" },
    ]) {
      const { catalog } = fixture([bad]);
      await expect(catalog.quote(model)).rejects.toThrow("RUNNER_CATALOG_UNSUPPORTED");
    }
  });

  it("rejects unsafe local allowlist/remote aliases before any network IO", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const id of [
      "openrouter/auto",
      "vendor/model:nitro",
      "vendor/model:online",
      "../models",
      "vendor/model?key=x",
    ]) {
      expect(() => new RunnerCatalog({ fetch: fetcher, allowModels: [id] })).toThrow(
        "RUNNER_CATALOG_UNSUPPORTED",
      );
      await expect(new RunnerCatalog({ fetch: fetcher }).quote(id)).rejects.toThrow(
        "RUNNER_CATALOG_UNSUPPORTED",
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("permits known optional feature quotes only as text-only route metadata", async () => {
    const { catalog } = fixture([
      endpoint("vendor", { ...price, web_search: "0.01", image: "0.05" }),
    ]);
    expect(await catalog.quote(model)).toMatchObject({ providerSlug: "vendor" });
  });

  it("rejects redirected, oversized and invalid responses without leaking provider messages", async () => {
    const tooLarge = new Response("{}", { headers: { "content-length": "16777217" } });
    const redirected = response({});
    Object.defineProperty(redirected, "redirected", { value: true });
    for (const result of [
      tooLarge,
      redirected,
      new Response("secret upstream error", { status: 500 }),
      new Response("not json"),
    ]) {
      const catalog = new RunnerCatalog({
        fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(result),
      });
      await expect(catalog.models()).rejects.toThrow("RUNNER_CATALOG_UNAVAILABLE");
    }
  });

  it("rejects streams that exceed the limit even without content-length", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
          controller.close();
        },
      }),
    );
    const catalog = new RunnerCatalog({
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(response),
    });
    await expect(catalog.models()).rejects.toThrow("RUNNER_CATALOG_UNAVAILABLE");
  });

  it("propagates cancellation without authorizing a quote", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBeTruthy();
      controller.abort();
      throw new Error("secret");
    });
    const catalog = new RunnerCatalog({ fetch: fetcher });
    await expect(catalog.models(controller.signal)).rejects.toThrow("RUNNER_CATALOG_UNAVAILABLE");
  });
});

describe("catalog IO deadlines", () => {
  it("times out an uncooperative fetch", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    try {
      const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
      const pending = new RunnerCatalog({ fetch: fetcher }).models();
      const checked = expect(pending).rejects.toThrow("RUNNER_CATALOG_UNAVAILABLE");
      await vi.advanceTimersByTimeAsync(15001);
      await checked;
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("cancels a hung body without awaiting a hung stream cancel", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel,
      });
      const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
      const pending = new RunnerCatalog({ fetch: fetcher }).models(controller.signal);
      const checked = expect(pending).rejects.toThrow("RUNNER_CATALOG_UNAVAILABLE");
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      await checked;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("catalog category visibility", () => {
  it("exposes a reasoning surcharge even when another variant masks its aggregate output rate", async () => {
    const id = "openai/gpt-6";
    const { internal_reasoning: _reasoning, ...ordinary } = price;
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/endpoints")
        ? response({
            data: {
              id,
              endpoints: [
                { ...endpoint("openai", { ...ordinary, completion: "0.00001" }), model_id: id },
                {
                  ...endpoint("openai/region", {
                    ...price,
                    completion: "0.000005",
                    internal_reasoning: "0.000005",
                  }),
                  model_id: id,
                },
              ],
            },
          })
        : response({ data: [entry(id, ordinary)] }),
    );
    const quote = await new RunnerCatalog({ fetch: fetcher }).quote(id, undefined, "openai");
    // Aggregate output alone equals the maximum base completion price here.
    expect(quote.outputMicrosPerMillion).toBe(10000000);
    expect(quote.prices.completionMicrosPerMillion).toBe(10000000);
    expect(quote.prices.reasoningMicrosPerMillion).toBe(5000000);
    expect(quote).not.toHaveProperty("exactPrices");
  });
});
