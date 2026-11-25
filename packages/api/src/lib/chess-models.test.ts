import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_TTL_MS,
  getModelCatalog,
  OPENROUTER_MODELS_URL,
  parseCatalog,
  resetModelCatalogCache,
} from "./chess-models";

const body = {
  data: [
    {
      id: "openai/gpt-4.1-nano",
      name: "OpenAI: GPT-4.1 Nano",
      context_length: 1047576,
      architecture: { output_modalities: ["text"] },
      pricing: { prompt: "0.0000001", completion: "0.0000004" },
      supported_parameters: ["tools", "temperature"],
    },
    {
      id: "anthropic/claude-haiku-4.5",
      name: "Anthropic: Claude Haiku 4.5",
      context_length: 200000,
      pricing: { prompt: "0.000001", completion: "0.000005" },
      supported_parameters: ["tools"],
    },
    // Variable pricing ("-1") and image-only output cannot run a priced match.
    { id: "openrouter/auto", name: "Auto Router", pricing: { prompt: "-1", completion: "-1" } },
    {
      id: "acme/image-only",
      architecture: { output_modalities: ["image"] },
      pricing: { prompt: "0", completion: "0" },
    },
    { id: "meta/llama-free", pricing: { prompt: "0", completion: "0" } },
    { name: "missing id" },
  ],
};
const ok = () => new Response(JSON.stringify(body), { status: 200 });

describe("parseCatalog", () => {
  it("keeps runnable models with prices, provider, tools and the derived protocol", () => {
    const models = parseCatalog(body);
    expect(models.map((model) => model.id)).toEqual([
      "anthropic/claude-haiku-4.5",
      "meta/llama-free",
      "openai/gpt-4.1-nano",
    ]);
    expect(models[2]).toEqual({
      id: "openai/gpt-4.1-nano",
      name: "GPT-4.1 Nano",
      provider: "OpenAI",
      contextLength: 1047576,
      promptPerMillion: 0.1,
      completionPerMillion: 0.4,
      tools: true,
      protocol: "openai-chat",
    });
    expect(models[0]?.protocol).toBe("anthropic");
    expect(models[1]).toMatchObject({ name: "meta/llama-free", provider: "meta", tools: false });
  });
  it("tolerates a malformed body", () => {
    expect(parseCatalog(null)).toEqual([]);
    expect(parseCatalog({ data: "nope" })).toEqual([]);
  });
});

describe("getModelCatalog", () => {
  beforeEach(() => resetModelCatalogCache());
  it("fetches once without credentials and serves the cache within the TTL", async () => {
    const fetcher = vi.fn(async () => ok());
    const first = await getModelCatalog(Date.now(), fetcher);
    await getModelCatalog(Date.now(), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENROUTER_MODELS_URL);
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
    expect(first.models).toHaveLength(3);
  });
  it("coalesces concurrent refreshes", async () => {
    const fetcher = vi.fn(async () => ok());
    await Promise.all([getModelCatalog(0, fetcher), getModelCatalog(0, fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("serves the stale copy when a refresh fails, and throws with no copy", async () => {
    const failing = vi.fn(async () => new Response("down", { status: 503 }));
    await expect(getModelCatalog(Date.now(), failing)).rejects.toThrow(/503/);
    await getModelCatalog(
      Date.now(),
      vi.fn(async () => ok()),
    );
    const fresh = await getModelCatalog(Date.now());
    expect(fresh.stale).toBe(false);
    const stale = await getModelCatalog(Date.now() + CATALOG_TTL_MS + 1, failing);
    expect(stale.models).toHaveLength(3);
    expect(stale.stale).toBe(true);
    // A retry goes upstream again (no pause) and keeps saying stale while it fails.
    const calls = failing.mock.calls.length;
    expect((await getModelCatalog(Date.now(), failing)).stale).toBe(true);
    expect(failing.mock.calls.length).toBe(calls + 1);
    // A later successful refresh clears the flag.
    const recovered = await getModelCatalog(
      Date.now() + CATALOG_TTL_MS * 2,
      vi.fn(async () => ok()),
    );
    expect(recovered.stale).toBe(false);
  });
});
