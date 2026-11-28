import { describe, expect, it } from "vitest";
import { classifyFinancialInput, type FinancialContext } from "./runner-pricing";

type UsageContext = Extract<FinancialContext, { kind: "usage" }>;
const settlementMicros = (
  raw: unknown,
  protocol: UsageContext["protocol"],
  tariff: UsageContext["tariff"],
) => classifyFinancialInput(raw, { kind: "usage", protocol, tariff });
const tariff = {
  model: "test/model",
  exactPrices: {
    promptMicrosPerMillion: 1_000_000,
    completionMicrosPerMillion: 2_000_000,
    cacheReadMicrosPerMillion: 100_000,
    cacheWriteMicrosPerMillion: 3_000_000,
    requestMicros: 7,
  },
};
const counts = {
  prompt_tokens: 10,
  completion_tokens: 2,
  prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
};
describe("original local settlement arithmetic", () => {
  it.each([
    ["0.0000001", 1],
    ["1e-6", 1],
    ["0.000010", 10],
    [0, 0],
  ])("reported charge %s rounds conservatively to %s", (cost, expected) => {
    expect(settlementMicros({ cost }, "openai-chat", tariff)).toBe(expected);
  });
  it.each(["-1", "NaN", "1e200", "9007199254740992", null, {}])(
    "invalid reported charge %s never falls through to category refund",
    (cost) => {
      expect(settlementMicros({ ...counts, cost }, "openai-chat", tariff)).toBeUndefined();
    },
  );
  it("preserves ordinary/cache category arithmetic and request charge", () => {
    expect(settlementMicros(counts, "openai-chat", tariff)).toBe(22);
    expect(
      settlementMicros(
        {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
        "anthropic",
        tariff,
      ),
    ).toBe(25);
  });
  it("missing categories and unknown category prices retain uncertainty", () => {
    expect(
      settlementMicros({ prompt_tokens: 10, completion_tokens: 2 }, "openai-chat", tariff),
    ).toBeUndefined();
    expect(settlementMicros(counts, "openai-chat", { model: "test/model" })).toBeUndefined();
    expect(
      settlementMicros(counts, "openai-chat", {
        ...tariff,
        exactPrices: { promptMicrosPerMillion: 1, completionMicrosPerMillion: 1, requestMicros: 0 },
      }),
    ).toBeUndefined();
  });
  it("Gemini overlap and reasoning ambiguity still require a complete cost", () => {
    expect(
      settlementMicros(counts, "openai-chat", { ...tariff, model: "google/gemini-test" }),
    ).toBeUndefined();
    const reasoning = {
      ...tariff,
      exactPrices: { ...tariff.exactPrices, reasoningMicrosPerMillion: 5 },
    };
    expect(settlementMicros(counts, "openai-responses", reasoning)).toBeUndefined();
    expect(
      settlementMicros(
        { ...counts, completion_tokens_details: { reasoning_tokens: 0 } },
        "openai-responses",
        reasoning,
      ),
    ).toBe(22);
  });
  it("free and numeric adapters retain their explicit distinct contexts", () => {
    expect(classifyFinancialInput({ cost: "100" }, { kind: "free" })).toBe(0);
    expect(classifyFinancialInput({ micros: 10 }, { kind: "numeric" })).toBe(10);
    expect(classifyFinancialInput({}, { kind: "numeric" })).toBeUndefined();
  });
});
