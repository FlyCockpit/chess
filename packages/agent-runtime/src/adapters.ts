import { HTTPClient } from "@openrouter/sdk";
import type { AnyTextAdapter } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { createOpenaiChat, createOpenaiChatCompletions } from "@tanstack/ai-openai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";

import { createAnthropicCacheHttpClient } from "./openrouter-cache";
import type { AgentModel } from "./types";

type OpenAIModel = Parameters<typeof createOpenaiChat>[0];
type AnthropicModel = Parameters<typeof createAnthropicChat>[0];
type OpenRouterModel = Parameters<typeof createOpenRouterText>[0];
type OpenRouterConfig = NonNullable<Parameters<typeof createOpenRouterText>[2]>;

/**
 * Anthropic prompt caching (`cache_control` breakpoints) is only supported for
 * Anthropic models routed through OpenRouter; the SDK slug is `anthropic/<model>`.
 */
const isAnthropicModel = (model: string): boolean => model.startsWith("anthropic/");

// The adapter emits nullable optional fields that the Messages gateway rejects.
// Normalize ordinary function definitions while preserving actual cache controls.
const anthropicGatewayFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body !== "string") return globalThis.fetch(input, init);
  const body: unknown = JSON.parse(init.body);
  if (typeof body !== "object" || body === null || !("tools" in body) || !Array.isArray(body.tools))
    return globalThis.fetch(input, init);
  const tools = body.tools.map((tool: unknown) => {
    if (
      typeof tool !== "object" ||
      tool === null ||
      ((!("type" in tool) || tool.type !== "custom") && !("input_schema" in tool))
    )
      return tool;
    const definition: Record<string, unknown> = { ...tool };
    if (definition.type === "custom") delete definition.type;
    if (definition.cache_control === null) delete definition.cache_control;
    if (typeof definition.input_schema === "object" && definition.input_schema !== null) {
      const schema: Record<string, unknown> = { ...definition.input_schema };
      if (schema.required === null) delete schema.required;
      if (schema.properties === null) schema.properties = {};
      definition.input_schema = schema;
    }
    return definition;
  });
  return globalThis.fetch(input, { ...init, body: JSON.stringify({ ...body, tools }) });
};

/**
 * Explicit per-turn output ceiling, forwarded through native `modelOptions`:
 * Chat Completions uses `max_completion_tokens`, Responses uses
 * `max_output_tokens`, and Anthropic Messages uses `max_tokens`.
 *
 * Why it exists: without it the *provider* default governs the ceiling, and several
 * defaults are as low as 4096 — small enough that a single long structured tool call
 * gets cut off mid-JSON. That is exactly the failure the `"output-truncated"` stop
 * reason exists to catch, and the cheapest way to stop hitting it is to not sit on an
 * unknown default.
 *
 * Why this size: the worst realistic single emission is a tool call carrying a list of
 * 100-200 records. Each record serializes as roughly `{"name":"...","url":"https://..."}`
 * ≈ 30-50 tokens, so 200 records is ~10k tokens, plus tool-call framing and any preceding
 * prose. 16384 leaves ~1.6x headroom over that worst case while staying at or under the
 * per-response output cap of most models (a value above a model's own cap is rejected by
 * some providers), and an unused ceiling costs nothing — only emitted tokens are billed.
 * Raise it per-loop via `maxOutputTokens` if your tool schemas emit more than that.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/**
 * Resolve the per-turn output ceiling: an explicit override wins, `null` means "leave it
 * to the provider default" (debug escape hatch), and `undefined` gets the default above.
 */
export const resolveMaxOutputTokens = (override?: number | null): number | undefined => {
  if (override === null) return undefined;
  if (override === undefined) return DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isFinite(override) || override < 1) return DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.trunc(override);
};

/** Prompt-caching wiring the caller wants attached to the adapter for this loop. */
export interface AdapterCacheOptions {
  /** Whether caching wiring should be attached at all (debug off-switch). */
  enabled: boolean;
  /** Stable prefix-cache key for providers that accept one (OpenAI `prompt_cache_key`). */
  cacheKey?: string;
}

/**
 * A provider adapter plus the provider options to forward to `chat({ modelOptions })`.
 * Keeping `modelOptions` here lets `tanstack-loop.ts` stay provider-agnostic — it only
 * forwards whatever this module produced.
 */
export interface ModelAdapter {
  adapter: AnyTextAdapter;
  modelOptions?: Record<string, unknown>;
}

export const createModelAdapter = (
  model: AgentModel,
  cache?: AdapterCacheOptions,
): ModelAdapter => {
  if (model.provider === "openrouter") {
    // Prompt caching for Anthropic-via-OpenRouter needs `cache_control: { type: "ephemeral" }`
    // breakpoints on the system + tool-schema content blocks. The installed
    // @tanstack/ai-openrouter serializes the request through the @openrouter/sdk,
    // whose outbound zod schema strips unknown fields, so the breakpoints can't be attached
    // through the public `chat()` surface. Instead we intercept the SDK's HTTPClient
    // `beforeRequest` hook — the one place the fully-serialized JSON body is still mutable —
    // and rewrite it there. Applied only for Anthropic models and only when caching is on
    // (default); a silent no-op otherwise (non-Anthropic models get no hook; other providers
    // ignore the field). See ./openrouter-cache.ts.
    const cachingEnabled = cache?.enabled ?? true;
    // One retry layer: the runtime's retry/failover adapter owns retries.
    const config: OpenRouterConfig = { retryConfig: { strategy: "none" } };
    if (model.baseUrl) config.serverURL = model.baseUrl;
    if (cachingEnabled && isAnthropicModel(model.model)) {
      config.httpClient = createAnthropicCacheHttpClient(HTTPClient);
    }
    const adapter = createOpenRouterText(model.model as OpenRouterModel, model.apiKey, config);
    return { adapter };
  }

  if (model.provider === "anthropic") {
    const adapter = createAnthropicChat(model.model as AnthropicModel, model.apiKey, {
      auth: model.anthropicAuth ?? "api-key",
      // One retry layer: the runtime's retry/failover adapter owns retries.
      maxRetries: 0,
      // Anthropic SDK appends /v1/messages; accept a shared /v1 API prefix.
      ...(model.baseUrl ? { baseURL: model.baseUrl.replace(/\/v1\/?$/, "") } : {}),
      ...(model.baseUrl && new URL(model.baseUrl).hostname === "openrouter.ai"
        ? { fetch: anthropicGatewayFetch }
        : {}),
    });
    return { adapter };
  }

  // The two OpenAI wire protocols are distinct: createOpenaiChat uses Responses,
  // while compatible chat-only providers need createOpenaiChatCompletions.
  const factory = model.provider === "openai-chat" ? createOpenaiChatCompletions : createOpenaiChat;
  // `maxRetries: 0` — one retry layer: the runtime's retry/failover adapter owns retries.
  const adapter = factory(model.model as OpenAIModel, model.apiKey, {
    maxRetries: 0,
    ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
  });
  // OpenAI-compatible providers cache the request prefix automatically; a stable
  // `prompt_cache_key` routes sibling requests to the same cached prefix. It is a no-op
  // for providers that ignore the field.
  const modelOptions =
    (cache?.enabled ?? true) && cache?.cacheKey ? { prompt_cache_key: cache.cacheKey } : undefined;
  return { adapter, modelOptions };
};

/** The installed adapters read output ceilings from native modelOptions. */
export const outputTokenOptions = (
  model: AgentModel,
  ceiling: number | undefined,
): Record<string, unknown> | undefined => {
  if (ceiling === undefined) return undefined;
  switch (model.provider) {
    case "openrouter":
      return { maxCompletionTokens: ceiling };
    case "openai-chat":
      return { max_completion_tokens: ceiling };
    case "anthropic":
      return { max_tokens: ceiling };
    case "openai-responses":
      return { max_output_tokens: ceiling };
  }
};
