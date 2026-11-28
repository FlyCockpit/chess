import { z } from "zod";

const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const settlementContextSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("numeric") }),
  z.strictObject({ kind: z.literal("free") }),
  z.strictObject({
    kind: z.literal("usage"),
    protocol: z.enum(["openai-chat", "openai-responses", "anthropic"]),
    tariff: z.strictObject({
      model: z.string().min(1).max(200),
      exactPrices: z
        .strictObject({
          promptMicrosPerMillion: money,
          completionMicrosPerMillion: money,
          requestMicros: money,
          cacheReadMicrosPerMillion: money.optional(),
          cacheWriteMicrosPerMillion: money.optional(),
          reasoningMicrosPerMillion: money.optional(),
        })
        .optional(),
    }),
  }),
]);
export type FinancialContext = z.infer<typeof settlementContextSchema>;
type SettlementContext = Extract<FinancialContext, { kind: "usage" }>;
const usageRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined;
const usageCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Called only on captured evidence by the local spend authority. */
export function classifyFinancialInput(
  raw: unknown,
  context: FinancialContext,
): number | undefined {
  if (context.kind === "free") return 0;
  if (context.kind === "numeric") return usageCount(usageRecord(raw)?.micros);
  return settlementMicros(raw, context.protocol, context.tariff);
}

/** A reported complete charge wins; incomplete category counts never imply zero cost. */
function settlementMicros(
  raw: unknown,
  protocol: SettlementContext["protocol"],
  quote: SettlementContext["tariff"],
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
