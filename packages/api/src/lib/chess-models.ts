import { catalogOutputLimits, type ModelProtocol, protocolForModel } from "@cockpit-chess/chess";
import { env } from "@cockpit-chess/env/shared";
import { z } from "zod";

/**
 * The hosted model catalog behind the create-match picker: OpenRouter's public
 * `GET /models` (no key is sent; the worker prices runs from the same endpoint),
 * filtered to the models the worker can run, cached in memory for an hour with
 * one fetch in flight at a time. A failed refresh keeps serving the last good
 * copy, marked stale, and the next request tries upstream again.
 */
export const openRouterModelsUrl = () => `${env.OPENROUTER_ORIGIN}/api/v1/models`;
export const CATALOG_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
/** Bounds the response the server keeps (OpenRouter lists a few hundred models). */
const MAX_MODELS = 1000;

export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  contextLength: number | null;
  /** The model's own maximum output per reply in tokens, when OpenRouter lists one. */
  maxOutputTokens: number | null;
  /** USD per million tokens, as OpenRouter quotes them. */
  promptPerMillion: number;
  completionPerMillion: number;
  tools: boolean;
  protocol: ModelProtocol;
};
export type ModelCatalog = {
  models: CatalogModel[];
  fetchedAt: string;
  /** True while the last refresh failed and an older copy is being served. */
  stale: boolean;
};

const entrySchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().max(200).optional(),
  context_length: z.number().nullish(),
  architecture: z.object({ output_modalities: z.array(z.string()).optional() }).nullish(),
  pricing: z.object({ prompt: z.unknown(), completion: z.unknown() }).nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  top_provider: z.unknown().optional(),
});

/** Same rule as the worker: a finite, non-negative per-token quote, or the model cannot run. */
function price(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** "OpenAI: GPT-4.1 Nano" → { provider: "OpenAI", name: "GPT-4.1 Nano" }. */
function splitName(id: string, raw: string | undefined) {
  const slug = id.replace(/^~/, "").split("/")[0] ?? id;
  const label = raw?.trim() || id;
  const match = /^([^:]{1,40}):\s+(.+)$/.exec(label);
  return match?.[1] && match[2]
    ? { provider: match[1].trim(), name: match[2].trim() }
    : { provider: slug, name: label };
}

export function parseCatalog(body: unknown): CatalogModel[] {
  const data =
    typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data)
      ? body.data
      : [];
  const models: CatalogModel[] = [];
  for (const raw of data.slice(0, MAX_MODELS)) {
    const entry = entrySchema.safeParse(raw);
    if (!entry.success) continue;
    const { id, architecture, pricing, supported_parameters } = entry.data;
    const outputs = architecture?.output_modalities;
    if (outputs && !outputs.includes("text")) continue;
    const prompt = price(pricing?.prompt);
    const completion = price(pricing?.completion);
    if (prompt === null || completion === null) continue;
    const contextLength = entry.data.context_length;
    models.push({
      id,
      ...splitName(id, entry.data.name),
      contextLength:
        typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0
          ? Math.round(contextLength)
          : null,
      maxOutputTokens: catalogOutputLimits(entry.data).maxOutputTokens,
      // OpenRouter quotes USD per token; round away float noise at the per-million scale.
      promptPerMillion: Math.round(prompt * 1e6 * 1e6) / 1e6,
      completionPerMillion: Math.round(completion * 1e6 * 1e6) / 1e6,
      tools: supported_parameters?.includes("tools") ?? false,
      protocol: protocolForModel(id),
    });
  }
  return models.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
  );
}

type CacheState = {
  value: ModelCatalog | null;
  expiresAt: number;
  inflight: Promise<ModelCatalog> | null;
};
const cache: CacheState = { value: null, expiresAt: 0, inflight: null };

/** Passive trusted snapshot for erasure; never refresh or wait on upstream IO. */
export function getCachedModelCatalog(): ModelCatalog | null {
  return cache.value;
}

export function resetModelCatalogCache() {
  cache.value = null;
  cache.expiresAt = 0;
  cache.inflight = null;
}

async function fetchCatalog(fetcher: typeof fetch): Promise<ModelCatalog> {
  const response = await fetcher(openRouterModelsUrl(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Model catalog responded ${response.status}`);
  const models = parseCatalog(await response.json());
  if (models.length === 0) throw new Error("Model catalog is empty");
  return { models, fetchedAt: new Date().toISOString(), stale: false };
}

/** The cached catalog; throws only when no copy has ever been fetched. */
export async function getModelCatalog(
  now = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<ModelCatalog> {
  if (cache.value && now < cache.expiresAt) return cache.value;
  if (!cache.inflight) {
    cache.inflight = fetchCatalog(fetcher)
      .then((value) => {
        cache.value = value;
        cache.expiresAt = Date.now() + CATALOG_TTL_MS;
        return value;
      })
      .finally(() => {
        cache.inflight = null;
      });
  }
  try {
    return await cache.inflight;
  } catch (error) {
    if (cache.value) {
      // Serve the older copy, marked stale so the picker can say so. It stays
      // expired, so the next request (a retry, or the picker's poll) tries
      // upstream again; the in-flight promise keeps that to one fetch at a time.
      cache.value = { ...cache.value, stale: true };
      cache.expiresAt = 0;
      return cache.value;
    }
    throw error;
  }
}
