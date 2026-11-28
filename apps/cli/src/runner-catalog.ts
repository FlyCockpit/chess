import { z } from "zod";

// Sources: https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model
// https://openrouter.ai/docs/guides/routing/provider-selection (tag prefix and max_price units)
// https://openrouter.ai/docs/guides/routing/private-endpoints (only also restricts private fallback)
// https://openrouter.ai/docs/api/api-reference/models/get-models (text architecture)
const API = "https://openrouter.ai/api/v1";
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 10_000;
const MAX_TOKENS = 16_777_216;
const REQUEST_MS = 15_000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const modelId = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?::free)?$/i;
const providerTag = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){0,4}$/i;

const fail = () => new Error("RUNNER_CATALOG_UNSUPPORTED");

/** A custom transport/stream cannot keep authorization pending after cancellation. */
async function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("RUNNER_CATALOG_UNAVAILABLE"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([aborted, operation]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
const tokenLimit = z.number().int().positive().max(MAX_TOKENS);
// Pricing is a disclosure boundary: new billable dimensions require a deliberate policy update.
const pricing = z
  .object({
    prompt: z.string(),
    completion: z.string(),
    request: z.string().optional(),
    internal_reasoning: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
    // Known catalog metadata for a TTL the request policy refuses. Validate it,
    // but do not charge it or let it change the permitted default-5m tariff.
    input_cache_write_1h: z.string().optional(),
    image: z.string().optional(),
    audio: z.string().optional(),
    input_audio: z.string().optional(),
    output_audio: z.string().optional(),
    video: z.string().optional(),
    web_search: z.string().optional(),
    discount: z.number().min(0).max(1).optional(),
  })
  .strict();
type Pricing = z.infer<typeof pricing>;
const modelSchema = z.object({
  id: z.string().max(256),
  pricing,
  context_length: tokenLimit,
  architecture: z.object({
    input_modalities: z
      .array(z.string().max(64))
      .max(16)
      .refine((values) => values.includes("text")),
    // A model that defaults to audio/image output cannot be bounded as text-only.
    output_modalities: z.tuple([z.literal("text")]),
  }),
  top_provider: z.object({ max_completion_tokens: tokenLimit.nullable().optional() }).optional(),
});
const catalogSchema = z.object({ data: z.array(z.unknown()).max(MAX_MODELS) });
const endpointSchema = z.object({
  tag: z.string().regex(providerTag).max(256),
  model_id: z.string().max(256).optional(),
  context_length: tokenLimit,
  max_prompt_tokens: tokenLimit.nullable().optional(),
  max_completion_tokens: tokenLimit.nullable(),
  pricing,
  status: z.literal(0),
  service_tier: z.null().optional(),
});
const endpointsSchema = z.object({
  data: z.object({ id: z.string(), endpoints: z.array(z.unknown()).max(1024) }),
});

/** Decimal USD → integer units, rounding up without a floating-point underestimate. */
function units(raw: string, places: number): number {
  if (raw.length > 64) throw fail();
  const parsed = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(raw);
  if (!parsed) throw fail();
  const fraction = parsed[2] ?? "";
  const digits = BigInt(`${parsed[1]}${fraction}`);
  const shift = places + Number(parsed[3] ?? 0) - fraction.length;
  if (Math.abs(shift) > 100) throw fail();
  const scaled =
    shift >= 0
      ? digits * 10n ** BigInt(shift)
      : (digits + 10n ** BigInt(-shift) - 1n) / 10n ** BigInt(-shift);
  if (scaled > MAX_SAFE) throw fail();
  return Number(scaled);
}

function rates(value: Pricing) {
  // Validate optional prices too. Negative/variable, nondecimal, tiered or unknown prices
  // never become a free feature merely because the current request is text-only.
  for (const [key, raw] of Object.entries(value)) {
    if (key !== "discount") units(String(raw), 12);
  }
  const prompt = units(value.prompt, 12);
  const completion = units(value.completion, 12);
  const read = value.input_cache_read === undefined ? prompt : units(value.input_cache_read, 12);
  const write = value.input_cache_write === undefined ? 0 : units(value.input_cache_write, 12);
  const reasoning =
    value.internal_reasoning === undefined ? 0 : units(value.internal_reasoning, 12);
  // Gemini can charge both a read and a write for overlapping tokens. Never assume
  // the three input categories partition the prompt; reserve their sum instead.
  const implicitInput = prompt + read;
  const input = implicitInput + write;
  const output = completion + reasoning;
  if (
    !Number.isSafeInteger(implicitInput) ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output)
  )
    throw fail();
  return {
    input,
    implicitInput,
    output,
    prompt,
    completion,
    request: value.request === undefined ? 0 : units(value.request, 6),
    cacheWriteKnown: value.input_cache_write !== undefined,
    prices: Object.freeze({
      promptMicrosPerMillion: prompt,
      completionMicrosPerMillion: completion,
      ...(value.input_cache_read === undefined ? {} : { cacheReadMicrosPerMillion: read }),
      ...(value.input_cache_write === undefined ? {} : { cacheWriteMicrosPerMillion: write }),
      ...(value.internal_reasoning === undefined ? {} : { reasoningMicrosPerMillion: reasoning }),
      requestMicros: value.request === undefined ? 0 : units(value.request, 6),
    }),
  };
}

/** Locally fetched category rates; absent cache/reasoning values remain unknown. */
interface RunnerTariffPrices {
  readonly promptMicrosPerMillion: number;
  readonly completionMicrosPerMillion: number;
  readonly cacheReadMicrosPerMillion?: number;
  readonly cacheWriteMicrosPerMillion?: number;
  readonly reasoningMicrosPerMillion?: number;
  readonly requestMicros: number;
}

export interface RunnerRouteQuote {
  readonly model: string;
  readonly providerSlug: string;
  /** Full accepted context is reserved, independently of tokenizer/framing assumptions. */
  readonly inputTokenLimit: number;
  readonly outputTokenLimit: number;
  readonly inputMicrosPerMillion: number;
  /** Reservation for implicit-only caching, computed per route before settlement missingness. */
  readonly implicitInputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly requestMicros: number;
  readonly cacheWriteKnown: boolean;
  /**
   * Category maxima. Cache rates require every matching route to quote them;
   * reasoning exposes any known surcharge so a missing sibling cannot hide it.
   */
  readonly prices: RunnerTariffPrices;
  /** Present only for identical category rates/missingness across all matching routes. */
  readonly exactPrices?: RunnerTariffPrices;
  readonly expiresAt: number;
  readonly providerRouting: {
    readonly only: readonly string[];
    readonly order: readonly string[];
    readonly allow_fallbacks: false;
    readonly require_parameters: true;
    readonly max_price: {
      readonly prompt: number;
      readonly completion: number;
      readonly request: number;
    };
  };
}

interface CatalogOptions {
  /** Injected local IO for unit tests; remote commands cannot configure catalog URLs. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Local startup restriction. It can only narrow the priced official catalog. */
  allowModels?: readonly string[];
}

/**
 * Fixed-origin, keyless catalog. Quotes refresh at every request; no server quote
 * is accepted. A tariff snapshot is not an atomic upstream price cap: max_price
 * enforces the supported base dimensions, while auxiliary tariffs are locally
 * quoted and checked again before dispatch by the request policy.
 */
export class RunnerCatalog {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly allowModels?: ReadonlySet<string>;
  private permitted?: ReadonlySet<string>;

  constructor(options: CatalogOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    if (options.allowModels) {
      if (options.allowModels.length > MAX_MODELS || options.allowModels.some((id) => !isModel(id)))
        throw fail();
      this.allowModels = new Set(options.allowModels);
    }
  }

  async models(signal?: AbortSignal): Promise<readonly string[]> {
    const raw = catalogSchema.safeParse(await this.read(`${API}/models`, signal));
    if (!raw.success) throw fail();
    const models = new Set<string>();
    for (const item of raw.data.data) {
      const parsed = modelSchema.safeParse(item);
      if (!parsed.success || !isModel(parsed.data.id)) continue;
      if (this.allowModels && !this.allowModels.has(parsed.data.id)) continue;
      try {
        rates(parsed.data.pricing);
        models.add(parsed.data.id);
      } catch {
        // An unpriced/variable/unknown model is unavailable, not free.
      }
    }
    this.permitted = models;
    return [...models].sort();
  }

  async quote(
    model: string,
    signal?: AbortSignal,
    providerSlug?: string,
  ): Promise<RunnerRouteQuote> {
    if (!isModel(model) || (providerSlug !== undefined && !providerTag.test(providerSlug)))
      throw fail();
    if (!this.permitted) await this.models(signal);
    if (!this.permitted?.has(model)) throw fail();
    const raw = endpointsSchema.safeParse(
      await this.read(`${API}/models/${model}/endpoints`, signal),
    );
    if (!raw.success || raw.data.data.id !== model) throw fail();
    const parsedEndpoints = raw.data.data.endpoints.map((item) => endpointSchema.safeParse(item));
    const available = parsedEndpoints.flatMap((parsed) =>
      parsed.success && (!parsed.data.model_id || parsed.data.model_id === model)
        ? [parsed.data]
        : [],
    );
    const candidates = providerSlug
      ? [providerSlug]
      : [...new Set(available.map((item) => item.tag))].sort();
    for (const candidate of candidates) {
      // Base provider tags also select variants/regions. Include every matching raw
      // endpoint, even one whose price/state is unsupported, rather than overlooking it.
      const matching = raw.data.data.endpoints.filter((item) => {
        if (
          typeof item !== "object" ||
          item === null ||
          !("tag" in item) ||
          typeof item.tag !== "string"
        )
          return false;
        return item.tag === candidate || item.tag.startsWith(`${candidate}/`);
      });
      if (!matching.length) continue;
      try {
        const endpoints = matching.map((item) => endpointSchema.parse(item));
        if (endpoints.some((item) => item.model_id !== undefined && item.model_id !== model))
          throw fail();
        const prices = endpoints.map((item) => rates(item.pricing));
        const max = (values: number[]) => Math.max(...values);
        const prompt = max(prices.map((item) => item.prompt));
        const completion = max(prices.map((item) => item.completion));
        const request = max(prices.map((item) => item.request));
        const knownReasoning = prices.flatMap((item) =>
          item.prices.reasoningMicrosPerMillion === undefined
            ? []
            : [item.prices.reasoningMicrosPerMillion],
        );
        const categoryPrices: RunnerTariffPrices = Object.freeze({
          promptMicrosPerMillion: prompt,
          completionMicrosPerMillion: completion,
          ...categoryMaximum(
            prices.map((item) => item.prices.cacheReadMicrosPerMillion),
            "cacheReadMicrosPerMillion",
          ),
          ...categoryMaximum(
            prices.map((item) => item.prices.cacheWriteMicrosPerMillion),
            "cacheWriteMicrosPerMillion",
          ),
          ...(knownReasoning.length ? { reasoningMicrosPerMillion: max(knownReasoning) } : {}),
          requestMicros: request,
        });
        const firstPrices = prices[0]?.prices;
        const exactPrices =
          firstPrices &&
          prices.every((item) => JSON.stringify(item.prices) === JSON.stringify(firstPrices))
            ? firstPrices
            : undefined;
        return Object.freeze({
          model,
          providerSlug: candidate,
          inputTokenLimit: max(
            endpoints.map((item) => item.max_prompt_tokens ?? item.context_length),
          ),
          outputTokenLimit: Math.min(
            ...endpoints.map((item) => item.max_completion_tokens ?? item.context_length),
          ),
          inputMicrosPerMillion: max(prices.map((item) => item.input)),
          implicitInputMicrosPerMillion: max(prices.map((item) => item.implicitInput)),
          outputMicrosPerMillion: max(prices.map((item) => item.output)),
          requestMicros: request,
          cacheWriteKnown: prices.every((item) => item.cacheWriteKnown),
          prices: categoryPrices,
          ...(exactPrices ? { exactPrices } : {}),
          expiresAt: this.now() + REQUEST_MS,
          providerRouting: Object.freeze({
            only: Object.freeze([candidate]),
            order: Object.freeze([candidate]),
            allow_fallbacks: false,
            require_parameters: true,
            // max_price uses USD per million for tokens and USD per request.
            max_price: Object.freeze({
              prompt: prompt / 1e6,
              completion: completion / 1e6,
              request: request / 1e6,
            }),
          }),
        });
      } catch {
        // A pinned unavailable route never switches to a different provider.
      }
    }
    throw fail();
  }

  private async read(url: string, callerSignal?: AbortSignal): Promise<unknown> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(REQUEST_MS)])
      : AbortSignal.timeout(REQUEST_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      signal.throwIfAborted();
      const response = await untilAbort(
        this.fetcher(url, { method: "GET", redirect: "error", signal }),
        signal,
      );
      if (
        !response.ok ||
        response.redirected ||
        (response.url && response.url !== url) ||
        !response.body
      )
        throw fail();
      reader = response.body.getReader();
      const length = response.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw fail();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        signal.throwIfAborted();
        const next = await untilAbort(reader.read(), signal);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BYTES) throw fail();
        chunks.push(next.value);
      }
      signal.throwIfAborted();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("RUNNER_CATALOG_UNAVAILABLE");
    } finally {
      // Stream cleanup is best effort and must not extend an authorization deadline.
      // Some injected/custom sources never settle their cancel promise.
      void reader?.cancel().catch(() => {});
    }
  }
}

function isModel(id: string): boolean {
  return id.length <= 256 && modelId.test(id) && !id.toLowerCase().startsWith("openrouter/");
}

function categoryMaximum<Key extends "cacheReadMicrosPerMillion" | "cacheWriteMicrosPerMillion">(
  values: (number | undefined)[],
  key: Key,
): Partial<Record<Key, number>> {
  if (values.some((value) => value === undefined)) return {};
  const known = values.filter((value): value is number => value !== undefined);
  return { [key]: Math.max(...known) } as Record<Key, number>;
}
