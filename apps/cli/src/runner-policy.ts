import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { ProviderCredentials } from "@cockpit-chess/chess/runner";
import { runnerOperatingLimitsSchema } from "@cockpit-chess/chess/runner-protocol";
import { z } from "zod";
import { t } from "./chess-i18n";
import { resolveApiKey } from "./chess-provider";
import { configDir } from "./paths";
import { RunnerCatalog, type RunnerRouteQuote } from "./runner-catalog";
import {
  openRunnerSpend,
  type RunnerSpend,
  RunnerSpendError,
  spendingAuthorityId,
} from "./runner-spend";

const micros = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const concurrent = z.number().int().min(1).max(1024);
const limitsSchema = z.strictObject({
  matchMicros: micros,
  dayMicros: micros,
  concurrency: concurrent,
});
type Limits = z.infer<typeof limitsSchema>;
const DEFAULT_HARD: Readonly<Limits> = Object.freeze({
  matchMicros: 25_000_000,
  dayMicros: 100_000_000,
  concurrency: 8,
});
const DEFAULT_OPERATING: Readonly<Limits> = Object.freeze({
  matchMicros: 1_000_000,
  dayMicros: 10_000_000,
  concurrency: 2,
});
const localOptionsSchema = z.strictObject({
  baseUrl: z.string().max(2048).optional(),
  allowModels: z.array(z.string().min(1).max(200)).min(1).max(10_000).optional(),
  maxMatchUsd: z.string().optional(),
  maxDayUsd: z.string().optional(),
  maxConcurrent: concurrent.optional(),
});
type LocalRunnerOptions = z.infer<typeof localOptionsSchema>;
const playerSchema = z.strictObject({
  model: z.string().min(1).max(200),
  protocol: z.enum(["openai-chat", "openai-responses", "anthropic"]),
});
type Player = z.infer<typeof playerSchema>;
type ActualRequest = {
  url: string;
  method: string;
  body: string;
  signal: AbortSignal;
};

/** Fixed safe copy: never surface provider errors, URLs, headers, paths or keys. */
export class RunnerPolicyError extends Error {
  constructor(readonly code: "config" | "model" | "request" | "limits" | "offline" | "storage") {
    super(t(`cli:runner${code[0]?.toUpperCase()}${code.slice(1)}`));
    this.name = "RunnerPolicyError";
  }
}

function usd(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,10}(?:\.\d{1,6})?$/.test(value)) throw new RunnerPolicyError("config");
  const [whole = "0", fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new RunnerPolicyError("config");
  return Number(amount);
}

/** Only startup callers read this file; there is no wire field for these options. */
export async function readLocalRunnerOptions(
  flags: LocalRunnerOptions = {},
  file = join(configDir(), "runner-policy.json"),
): Promise<LocalRunnerOptions> {
  let config: unknown = {};
  try {
    const data = await readFile(file, "utf8");
    if (Buffer.byteLength(data) > 16_384) throw new RunnerPolicyError("config");
    config = JSON.parse(data);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new RunnerPolicyError("config");
  }
  const parsed = localOptionsSchema.safeParse(config);
  const overrides = localOptionsSchema.safeParse(flags);
  if (!parsed.success || !overrides.success) throw new RunnerPolicyError("config");
  return { ...parsed.data, ...overrides.data };
}

function endpoint(input = "https://openrouter.ai/api/v1") {
  try {
    const url = new URL(input);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (!local && url.href.replace(/\/$/, "") !== "https://openrouter.ai/api/v1") ||
      (local && !["http:", "https:"].includes(url.protocol))
    )
      throw new Error();
    return { url: url.href.replace(/\/$/, ""), local };
  } catch {
    throw new RunnerPolicyError("config");
  }
}

function requestBody(
  request: ActualRequest,
  player: Player,
  baseUrl: string,
): Record<string, unknown> {
  const suffix = {
    "openai-chat": "/chat/completions",
    "openai-responses": "/responses",
    anthropic: "/messages",
  }[player.protocol];
  // Anthropic's SDK adds /v1 even when the selected prefix already has it.
  const destination =
    player.protocol === "anthropic"
      ? `${baseUrl.replace(/\/v1$/, "")}/v1${suffix}`
      : `${baseUrl}${suffix}`;
  if (
    request.method !== "POST" ||
    (request.url !== destination &&
      !(player.protocol === "anthropic" && request.url === `${destination}?beta=true`)) ||
    Buffer.byteLength(request.body) > 2_000_000
  )
    throw new RunnerPolicyError("request");
  let body: unknown;
  try {
    body = JSON.parse(request.body);
  } catch {
    throw new RunnerPolicyError("request");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new RunnerPolicyError("request");
  const record: Record<string, unknown> = { ...body };
  if (record.model !== player.model) throw new RunnerPolicyError("model");
  // These activate external work, model fallbacks, dynamic tariffs or opaque stored context.
  const forbidden = [
    "models",
    "route",
    "plugins",
    "transforms",
    "service_tier",
    "modalities",
    "audio",
    "image",
    "images",
    "web_search_options",
    "previous_response_id",
    "conversation",
    "prompt",
    "background",
    "prediction",
    "extra_body",
  ];
  if (forbidden.some((key) => key in record)) throw new RunnerPolicyError("request");
  if ("store" in record && record.store !== false) throw new RunnerPolicyError("request");
  if ("n" in record && record.n !== 1) throw new RunnerPolicyError("request");
  // Only text messages and local function tools are billable inputs in this seam.
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 32) throw new RunnerPolicyError("request");
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const item: Record<string, unknown> = { ...value };
    if (
      typeof item.type === "string" &&
      /image|audio|file|search|computer|code_interpreter|mcp/.test(item.type)
    )
      throw new RunnerPolicyError("request");
    for (const nested of Object.values(item)) inspect(nested, depth + 1);
  };
  inspect(record);
  return record;
}

function outputTokens(body: Record<string, unknown>, protocol: Player["protocol"]): number {
  const key = {
    "openai-chat": "max_completion_tokens",
    "openai-responses": "max_output_tokens",
    anthropic: "max_tokens",
  }[protocol];
  const cap = body[key];
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1)
    throw new RunnerPolicyError("request");
  return cap;
}

function reserveMicros(quote: RunnerRouteQuote, output: number): number {
  if (output > quote.outputTokenLimit) throw new RunnerPolicyError("limits");
  const total =
    (BigInt(quote.inputTokenLimit) * BigInt(quote.inputMicrosPerMillion) +
      BigInt(output) * BigInt(quote.outputMicrosPerMillion) +
      999_999n) /
      1_000_000n +
    BigInt(quote.requestMicros);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RunnerPolicyError("limits");
  return Number(total);
}

const usageRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined;
const usageCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** A reported complete charge wins; incomplete category counts never imply zero cost. */
function settlementMicros(
  raw: unknown,
  protocol: Player["protocol"],
  quote: RunnerRouteQuote,
): number | undefined {
  const usage = usageRecord(raw);
  if (!usage) return undefined;
  if ("cost" in usage) {
    const value = usage.cost;
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const text = String(value);
    if (text.length > 64) return undefined;
    const parts = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
    if (!parts) return undefined;
    const fraction = parts[2] ?? "";
    const shift = 6 + Number(parts[3] ?? 0) - fraction.length;
    if (Math.abs(shift) > 100) return undefined;
    const digits = BigInt(`${parts[1]}${fraction}`);
    const amount =
      shift >= 0
        ? digits * 10n ** BigInt(shift)
        : (digits + 10n ** BigInt(-shift) - 1n) / 10n ** BigInt(-shift);
    return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : undefined;
  }
  const price = quote.exactPrices;
  if (!price) return undefined;
  const anthropic = protocol === "anthropic";
  const details = usageRecord(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const input = usageCount(
    anthropic ? usage.input_tokens : (usage.prompt_tokens ?? usage.input_tokens),
  );
  const output = usageCount(
    anthropic ? usage.output_tokens : (usage.completion_tokens ?? usage.output_tokens),
  );
  const read = usageCount(anthropic ? usage.cache_read_input_tokens : details?.cached_tokens);
  const write = usageCount(
    anthropic ? usage.cache_creation_input_tokens : details?.cache_write_tokens,
  );
  if (input === undefined || output === undefined || read === undefined || write === undefined)
    return undefined;
  if (
    (read > 0 && price.cacheReadMicrosPerMillion === undefined) ||
    (write > 0 && price.cacheWriteMicrosPerMillion === undefined)
  )
    return undefined;
  // Gemini cache reads and writes may overlap. Only its reported complete cost can
  // prove the bill; subtracting those categories would invent an uncached count.
  if (!anthropic && quote.model.startsWith("google/gemini-") && write > 0) return undefined;
  const uncached = anthropic ? input : input - read - write;
  if (!Number.isSafeInteger(uncached) || uncached < 0) return undefined;
  if ((price.reasoningMicrosPerMillion ?? 0) > 0) {
    const reasoning = usageCount(
      usageRecord(usage.completion_tokens_details ?? usage.output_tokens_details)?.reasoning_tokens,
    );
    // A separate nonzero reasoning tariff has route-specific additive/replacement
    // semantics. Require provider-reported cost unless explicitly zero reasoning.
    if (reasoning !== 0) return undefined;
  }
  const sum =
    BigInt(uncached) * BigInt(price.promptMicrosPerMillion) +
    BigInt(read) * BigInt(price.cacheReadMicrosPerMillion ?? 0) +
    BigInt(write) * BigInt(price.cacheWriteMicrosPerMillion ?? 0) +
    BigInt(output) * BigInt(price.completionMicrosPerMillion);
  const amount = (sum + 999_999n) / 1_000_000n + BigInt(price.requestMicros);
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : undefined;
}

/** Local capabilities are frozen at startup; remote operating updates have a separate bounded seam. */
export class RunnerPolicy {
  private operating: Readonly<Limits>;
  private revision = 0;
  private stopped = false;
  private readonly matches = new Map<string, RunnerMatchAuthority>();
  private readonly finished = new Set<string>();
  private readonly allowed: ReadonlySet<string>;

  private constructor(
    private readonly startup: { baseUrl: string; local: boolean; apiKey: string },
    private readonly hard: Readonly<Limits>,
    models: readonly string[],
    private readonly catalog: RunnerCatalog,
    private readonly spend: RunnerSpend,
    private readonly now: () => number,
    private readonly monotonicNow: () => number,
  ) {
    this.allowed = new Set(models);
    this.operating = Object.freeze({
      matchMicros: Math.min(DEFAULT_OPERATING.matchMicros, hard.matchMicros),
      dayMicros: Math.min(DEFAULT_OPERATING.dayMicros, hard.dayMicros),
      concurrency: Math.min(DEFAULT_OPERATING.concurrency, hard.concurrency),
    });
  }

  static async open(
    localOptions: LocalRunnerOptions = {},
    io: {
      env?: Record<string, string | undefined>;
      catalog?: RunnerCatalog;
      spend?: RunnerSpend;
      signal?: AbortSignal;
      now?: () => number;
      monotonicNow?: () => number;
    } = {},
  ): Promise<RunnerPolicy> {
    const parsed = localOptionsSchema.safeParse(localOptions);
    if (!parsed.success) throw new RunnerPolicyError("config");
    const options = parsed.data;
    const selected = endpoint(options.baseUrl);
    const apiKey =
      resolveApiKey(new URL(selected.url), "openai-chat", io.env) ??
      (selected.local ? "local-inference" : undefined);
    if (!apiKey) throw new RunnerPolicyError("config");
    const hard = Object.freeze({
      matchMicros: usd(options.maxMatchUsd, DEFAULT_HARD.matchMicros),
      dayMicros: usd(options.maxDayUsd, DEFAULT_HARD.dayMicros),
      concurrency: options.maxConcurrent ?? DEFAULT_HARD.concurrency,
    });
    const catalog = io.catalog ?? new RunnerCatalog({ allowModels: options.allowModels });
    let models: readonly string[] | undefined;
    try {
      models = selected.local ? options.allowModels : await catalog.models(io.signal);
    } catch {
      throw new RunnerPolicyError("model");
    }
    if (!models?.length) throw new RunnerPolicyError("model");
    // Local model identities still come from the operator, never the website.
    const allowed = options.allowModels
      ? models.filter((model) => options.allowModels?.includes(model))
      : models;
    if (!allowed.length) throw new RunnerPolicyError("model");
    let spend: RunnerSpend;
    try {
      spend = io.spend ?? (await openRunnerSpend({ authorityId: spendingAuthorityId(apiKey) }));
    } catch {
      throw new RunnerPolicyError("storage");
    }
    return new RunnerPolicy(
      { baseUrl: selected.url, local: selected.local, apiKey },
      hard,
      allowed,
      catalog,
      spend,
      io.now ?? Date.now,
      io.monotonicNow ?? (() => performance.now()),
    );
  }

  /** Safe to advertise: no endpoint, credential, fingerprint, filesystem or environment. */
  capabilities() {
    return {
      models: [...this.allowed],
      hard: { ...this.hard },
      operating: { ...this.operating },
      revision: this.revision,
    };
  }

  startupNotice(): string {
    return t("cli:runnerPolicy", {
      match: (this.hard.matchMicros / 1_000_000).toFixed(2),
      day: (this.hard.dayMicros / 1_000_000).toFixed(2),
      concurrency: this.hard.concurrency,
      operatingMatch: (this.operating.matchMicros / 1_000_000).toFixed(2),
      operatingDay: (this.operating.dayMicros / 1_000_000).toFixed(2),
      operatingConcurrency: this.operating.concurrency,
    });
  }

  /** E3S supplies step-up/revision handling; even a compromised server cannot change hard authority. */
  applyOperatingLimits(input: unknown, revision: number): void {
    const parsed = limitsSchema.safeParse(input);
    if (
      this.stopped ||
      !Number.isSafeInteger(revision) ||
      revision !== this.revision + 1 ||
      !parsed.success
    )
      throw new RunnerPolicyError("limits");
    const limits = parsed.data;
    if (
      limits.matchMicros > this.hard.matchMicros ||
      limits.dayMicros > this.hard.dayMicros ||
      limits.concurrency > this.hard.concurrency
    )
      throw new RunnerPolicyError("limits");
    if (
      limits.matchMicros < this.operating.matchMicros ||
      limits.dayMicros < this.operating.dayMicros ||
      limits.concurrency < this.operating.concurrency
    ) {
      // Stop active authorities before a lowered limit races an awaited reservation.
      for (const match of this.matches.values()) match.stop();
    }
    this.operating = Object.freeze(limits);
    this.revision = revision;
  }

  /** Only the private local revision store calls this before any match is started. */
  restoreOperatingLimits(input: unknown): void {
    const parsed = runnerOperatingLimitsSchema.safeParse(input);
    if (
      this.stopped ||
      this.revision !== 0 ||
      this.matches.size > 0 ||
      this.finished.size > 0 ||
      !parsed.success ||
      parsed.data.matchMicros > this.hard.matchMicros ||
      parsed.data.dayMicros > this.hard.dayMicros ||
      parsed.data.concurrency > this.hard.concurrency
    )
      throw new RunnerPolicyError("limits");
    const { revision, ...limits } = parsed.data;
    this.operating = Object.freeze(limits);
    this.revision = revision;
  }

  /** A local stop cannot be undone by a website command or a later connection. */
  stopOperatingLimits(): void {
    this.stopped = true;
    for (const match of this.matches.values()) match.stop();
  }

  /** Bind the validated E2 session signal: its local 60s liveness timer aborts it on loss. */
  beginMatch(matchId: string, connectionSignal: AbortSignal): RunnerMatchAuthority {
    if (this.stopped || connectionSignal.aborted) throw new RunnerPolicyError("offline");
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(matchId) ||
      this.matches.has(matchId) ||
      this.finished.has(matchId)
    )
      throw new RunnerPolicyError("request");
    if (this.matches.size >= Math.min(this.hard.concurrency, this.operating.concurrency))
      throw new RunnerPolicyError("limits");
    const authority = new RunnerMatchAuthority(this, matchId, connectionSignal);
    this.matches.set(matchId, authority);
    return authority;
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const match of this.matches.values()) match.stop();
    await this.spend.close();
  }

  async credentials(authority: RunnerMatchAuthority, input: unknown): Promise<ProviderCredentials> {
    authority.assertLive();
    const parsed = playerSchema.safeParse(input);
    if (!parsed.success || !this.allowed.has(parsed.data.model))
      throw new RunnerPolicyError("model");
    const player = parsed.data;
    const initial = this.startup.local
      ? undefined
      : await this.quote(player.model, authority.signal);
    authority.assertLive();
    return {
      apiKey: this.startup.apiKey,
      baseUrl: this.startup.baseUrl,
      anthropicAuth: this.startup.local ? "api-key" : "bearer",
      inputMicrosPerMillion: initial?.inputMicrosPerMillion ?? 0,
      outputMicrosPerMillion: initial?.outputMicrosPerMillion ?? 0,
      maxOutputTokens: initial?.outputTokenLimit ?? 16_384,
      contextLength: initial?.inputTokenLimit,
      ...(this.startup.local ? {} : { dataCollection: "deny" as const }),
      beforeDispatch: () => authority.assertLive(),
      authorizeRequest: async (request: ActualRequest) => {
        const beganAt = this.monotonicNow();
        authority.assertLive();
        request.signal.throwIfAborted();
        const body = requestBody(request, player, this.startup.baseUrl);
        const output = outputTokens(body, player.protocol);
        const quote = initial
          ? await this.quote(
              player.model,
              AbortSignal.any([request.signal, authority.signal]),
              initial.providerSlug,
            )
          : undefined;
        const deadline = Math.min(
          beganAt + 15_000,
          this.monotonicNow() + (quote ? quote.expiresAt - this.now() : 15_000),
        );
        const assertFresh = () => {
          authority.assertLive();
          if (this.monotonicNow() >= deadline || (quote && this.now() >= quote.expiresAt))
            throw new RunnerPolicyError("model");
        };
        assertFresh();
        authority.assertLive();
        request.signal.throwIfAborted();
        if (quote) body.provider = { ...usageRecord(body.provider), ...quote.providerRouting };
        const checkCache = (value: unknown): void => {
          if (Array.isArray(value)) {
            for (const item of value) checkCache(item);
            return;
          }
          if (typeof value !== "object" || value === null) return;
          const item: Record<string, unknown> = { ...value };
          if ("cache_control" in item) {
            const cache = z
              .strictObject({ type: z.literal("ephemeral"), ttl: z.literal("5m").optional() })
              .safeParse(item.cache_control);
            if (!cache.success) throw new RunnerPolicyError("request");
            // Explicit Gemini caching adds independently priced storage. Routes
            // without a quoted write rate also cannot authorize that feature.
            // Removing only the marker preserves all prefix bytes and session keys.
            if (quote && (player.model.startsWith("google/gemini-") || !quote.cacheWriteKnown))
              Reflect.deleteProperty(value, "cache_control");
          }
          for (const nested of Object.values(item)) checkCache(nested);
        };
        checkCache(body);
        // Fixed whole-context input bounds include provider framing; never subtract guessed cache discounts.
        const implicitOnly = quote && player.model.startsWith("google/gemini-");
        const priced = implicitOnly
          ? {
              ...quote,
              inputMicrosPerMillion: quote.implicitInputMicrosPerMillion,
            }
          : quote;
        const amount = priced ? reserveMicros(priced, output) : 0;
        const requestId = randomUUID();
        try {
          await this.spend.reserve({
            matchId: authority.matchId,
            requestId,
            micros: amount,
            matchLimitMicros: Math.min(this.hard.matchMicros, this.operating.matchMicros),
            dayLimitMicros: Math.min(this.hard.dayMicros, this.operating.dayMicros),
          });
        } catch (error) {
          if (
            error instanceof RunnerSpendError &&
            ["MATCH_LIMIT", "DAY_LIMIT"].includes(error.code)
          )
            throw new RunnerPolicyError("limits");
          throw new RunnerPolicyError("storage");
        }
        // A reduction or disconnect while fsync was pending cannot authorize the wire.
        assertFresh();
        request.signal.throwIfAborted();
        if (quote) {
          // A delayed durable write cannot use an earlier auxiliary tariff snapshot.
          // There is no upstream atomic tariff token; recheck every price dimension,
          // not only the prompt/completion/request fields supported by max_price.
          const final = await this.quote(
            player.model,
            AbortSignal.any([request.signal, authority.signal]),
            quote.providerSlug,
          );
          assertFresh();
          if (
            this.now() >= final.expiresAt ||
            final.inputTokenLimit !== quote.inputTokenLimit ||
            final.outputTokenLimit !== quote.outputTokenLimit ||
            final.inputMicrosPerMillion !== quote.inputMicrosPerMillion ||
            final.implicitInputMicrosPerMillion !== quote.implicitInputMicrosPerMillion ||
            final.outputMicrosPerMillion !== quote.outputMicrosPerMillion ||
            final.requestMicros !== quote.requestMicros ||
            final.cacheWriteKnown !== quote.cacheWriteKnown ||
            JSON.stringify(final.prices) !== JSON.stringify(quote.prices) ||
            JSON.stringify(final.exactPrices) !== JSON.stringify(quote.exactPrices) ||
            JSON.stringify(final.providerRouting) !== JSON.stringify(quote.providerRouting)
          )
            throw new RunnerPolicyError("model");
        }
        return {
          body: JSON.stringify(body),
          beforeSend: assertFresh,
          onUsage: async (usage: unknown) => {
            const actual = quote ? settlementMicros(usage, player.protocol, quote) : 0;
            if (actual === undefined) return;
            try {
              await this.spend.settle({ requestId, micros: actual });
            } catch {
              // An inconsistent bill or uncertain persistence invalidates local authority.
              this.stopped = true;
              for (const match of this.matches.values()) match.stop();
              throw new RunnerPolicyError("storage");
            }
          },
        };
      },
    };
  }

  assertAuthority(authority: RunnerMatchAuthority): void {
    if (this.stopped || this.matches.get(authority.matchId) !== authority)
      throw new RunnerPolicyError("offline");
  }

  private async quote(
    model: string,
    signal: AbortSignal,
    providerSlug?: string,
  ): Promise<RunnerRouteQuote> {
    try {
      return await this.catalog.quote(model, signal, providerSlug);
    } catch {
      if (signal.aborted) throw new RunnerPolicyError("offline");
      throw new RunnerPolicyError("model");
    }
  }

  release(authority: RunnerMatchAuthority): void {
    if (this.matches.get(authority.matchId) === authority) {
      this.matches.delete(authority.matchId);
      this.finished.add(authority.matchId);
    }
  }
}

/** This object is local execution authority, never a server-deserialized object. */
export class RunnerMatchAuthority {
  private readonly controller = new AbortController();
  private sessionSignal: AbortSignal;
  constructor(
    private readonly policy: RunnerPolicy,
    readonly matchId: string,
    connectionSignal: AbortSignal,
  ) {
    this.sessionSignal = AbortSignal.any([connectionSignal, this.controller.signal]);
  }
  get signal(): AbortSignal {
    return this.sessionSignal;
  }
  /** Local executor only: reconcile/settle the prior loop before resuming a known turn. */
  resumeConnection(connectionSignal: AbortSignal): void {
    this.policy.assertAuthority(this);
    if (this.controller.signal.aborted || !this.sessionSignal.aborted || connectionSignal.aborted)
      throw new RunnerPolicyError("offline");
    this.sessionSignal = AbortSignal.any([connectionSignal, this.controller.signal]);
  }
  credentials(player: unknown): Promise<ProviderCredentials> {
    return this.policy.credentials(this, player);
  }
  assertLive(): void {
    if (this.signal.aborted) throw new RunnerPolicyError("offline");
    this.policy.assertAuthority(this);
  }
  /** Caller waits for its loop to settle before freeing concurrency; reservations remain durable. */
  finish(): void {
    this.stop();
    this.policy.release(this);
  }
  stop(): void {
    this.controller.abort();
  }
}
