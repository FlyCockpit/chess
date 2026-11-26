import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import {
  budgetStops,
  type CatalogModel,
  type CreateMatchValues,
  createMatchSchema,
  DEFAULT_VALUES,
  defaultValuesFor,
  FIELD_SECTION,
  maxBudgetUsd,
  resolveProtocol,
  searchModels,
  summaryParts,
  toMatchConfig,
} from "./create-match-form";
import { applyPreset, selectedPreset, timeControlErrors } from "./time-control";

let t: TFunction<"chess">;
beforeAll(async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en-US", resources: { "en-US": { chess: enChess } }, defaultNS: "chess" });
  t = i18n.getFixedT("en-US", "chess");
});
const catalog: CatalogModel[] = [
  {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    provider: "OpenAI",
    contextLength: 1047576,
    maxOutputTokens: 32768,
    promptPerMillion: 0.1,
    completionPerMillion: 0.4,
    tools: true,
    protocol: "openai-chat",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    provider: "Anthropic",
    contextLength: 200000,
    maxOutputTokens: null,
    promptPerMillion: 1,
    completionPerMillion: 5,
    tools: true,
    protocol: "anthropic",
  },
];
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});
/** The server's defaults (CHESS_MAX_COST_USD=25, CHESS_MAX_TOKENS=10000000). */
const limits = { maxCostMicros: 25_000_000, maxTokens: 10_000_000 };
const issuesFor = (value: Partial<CreateMatchValues>, server = limits) => {
  const result = createMatchSchema(t, server).safeParse({ ...DEFAULT_VALUES, ...value });
  return result.success ? [] : result.error.issues;
};
const errorsFor = (value: Partial<CreateMatchValues>, server = limits) =>
  issuesFor(value, server).map((issue) => String(issue.path[0]));

/** An uneven clock: White minutes, Black minutes, optional Black seconds. */
const uneven = (white: string, black: string, blackSeconds = "0") => ({
  timed: true,
  uneven: true,
  white: { minutes: white, seconds: "0" },
  black: { minutes: black, seconds: blackSeconds },
});

describe("time control", () => {
  it("maps presets, custom and uneven times onto rules.clock and a derived move limit", () => {
    const at = (time: CreateMatchValues["time"], moveLimit = "") => {
      const config = toMatchConfig({ ...DEFAULT_VALUES, time, moveLimit }, undefined, t);
      if (!config.success) throw new Error("expected a valid config");
      return config.data.rules;
    };
    expect(at(DEFAULT_VALUES.time)).toMatchObject({ clock: null, turnTimeoutMs: 60000 });
    for (const minutes of [5, 10, 30])
      expect(at(applyPreset(DEFAULT_VALUES.time, minutes))).toMatchObject({
        clock: { w: minutes * 60000, b: minutes * 60000 },
        turnTimeoutMs: 60000,
      });
    expect(at(uneven("15", "5"))).toMatchObject({ clock: { w: 900000, b: 300000 } });
    // Black's clock does not follow White's while times are even.
    const even = { ...applyPreset(DEFAULT_VALUES.time, 5), black: { minutes: "1", seconds: "0" } };
    expect(at(even).clock).toEqual({ w: 300000, b: 300000 });
    // The automatic move limit never outlasts the shorter clock; a typed one is kept.
    expect(at(uneven("2", "0", "45")).turnTimeoutMs).toBe(45000);
    expect(at(uneven("2", "1"), "20").turnTimeoutMs).toBe(20000);
    expect(selectedPreset(applyPreset(DEFAULT_VALUES.time, 10))).toBe(10);
    expect(selectedPreset(uneven("10", "10"))).toBe(10);
    expect(selectedPreset(uneven("15", "5"))).toBe("custom");
    expect(selectedPreset(DEFAULT_VALUES.time)).toBe("untimed");
    expect(selectedPreset(applyPreset(uneven("15", "5"), "untimed"))).toBe("untimed");
  });
  it("names the server's limits in its errors", () => {
    expect(timeControlErrors(t, uneven("0", "0", "20"))).toEqual({
      white: "Each clock must be between 30 s and 60 min.",
      black: "Each clock must be between 30 s and 60 min.",
    });
    expect(timeControlErrors(t, DEFAULT_VALUES.time)).toEqual({});
  });
});

describe("defaults", () => {
  it("start the same match the old form did, with a derived title and names", () => {
    const config = toMatchConfig(DEFAULT_VALUES, undefined, t);
    expect(config.success).toBe(true);
    if (!config.success) return;
    expect(config.data.white).toEqual({
      name: "openai/gpt-4.1-nano",
      model: "openai/gpt-4.1-nano",
      protocol: "openai-chat",
    });
    expect(config.data.black.protocol).toBe("openai-chat");
    expect(config.data.title).toBe("openai/gpt-4.1-nano vs openai/gpt-4.1-mini");
    expect(config.data.rules).toMatchObject({
      context: "fresh",
      opponentIdentity: "hidden",
      legalMoves: "tool",
      moveFormat: "strict",
      engineEvaluation: "off",
      remarks: "off",
      tokenAccounting: "provider",
      tokenBudget: 1000000,
      costBudgetMicros: 1_000_000,
      maxAttempts: 3,
      clock: null,
      turnTimeoutMs: 60000,
    });
    expect(config.data.rules).not.toHaveProperty("maxPlies");
    expect(config.data.rules).not.toHaveProperty("illegalPolicy");
  });
  it("keep a typed title and translate the derived one", () => {
    const typed = toMatchConfig({ ...DEFAULT_VALUES, title: "  Grudge match " }, undefined, t);
    expect(typed.success && typed.data.title).toBe("Grudge match");
  });
  it("use the catalog's display name when the model is listed", () => {
    const config = toMatchConfig(DEFAULT_VALUES, catalog, t);
    expect(config.success && config.data.white.name).toBe("GPT-4.1 Nano");
    expect(config.success && config.data.title).toBe("GPT-4.1 Nano vs openai/gpt-4.1-mini");
  });
  it("summarise in one line", () => {
    expect(summaryParts(DEFAULT_VALUES, t, usd).join(" · ")).toBe(
      "Untimed · Fresh context · Legal-move tool · Strict format · $1.00 budget",
    );
    expect(summaryParts({ ...DEFAULT_VALUES, illegalPolicy: "retry" }, t, usd).at(-1)).toBe(
      "Keeps trying on illegal moves",
    );
    expect(summaryParts({ ...DEFAULT_VALUES, maxAttempts: 1 }, t, usd).at(-1)).toBe(
      "Forfeits after 1 illegal move",
    );
    expect(
      summaryParts(
        { ...DEFAULT_VALUES, remarks: "trash-talk", engineEvaluation: "after-move" },
        t,
        usd,
      ),
    ).toEqual(expect.arrayContaining(["Evaluation after each move", "Trash talk"]));
    expect(
      summaryParts({ ...DEFAULT_VALUES, time: applyPreset(DEFAULT_VALUES.time, 10) }, t, usd)[0],
    ).toBe("10 min each");
    expect(summaryParts({ ...DEFAULT_VALUES, time: uneven("15", "5") }, t, usd)[0]).toBe(
      "White 15 min · Black 5 min",
    );
  });
  it("are valid", () => {
    expect(errorsFor({})).toEqual([]);
  });
});

describe("protocol", () => {
  it("is derived from the model unless overridden", () => {
    expect(resolveProtocol("auto", "anthropic/claude-haiku-4.5", catalog)).toBe("anthropic");
    expect(resolveProtocol("auto", "anthropic/some-new-model", undefined)).toBe("anthropic");
    expect(resolveProtocol("auto", "google/gemini-2.5-flash", undefined)).toBe("openai-chat");
    expect(resolveProtocol("openai-responses", "anthropic/claude-haiku-4.5", catalog)).toBe(
      "openai-responses",
    );
    const config = toMatchConfig(
      { ...DEFAULT_VALUES, black: "anthropic/claude-haiku-4.5" },
      catalog,
      t,
    );
    expect(config.success && config.data.black.protocol).toBe("anthropic");
  });
});

describe("validation keeps the hosted bounds", () => {
  it.each([
    [{ moveLimit: "0" }, "moveLimit"],
    [{ moveLimit: "301" }, "moveLimit"],
    [{ moveLimit: "20.5" }, "moveLimit"],
    // The per-move limit may not outlast the shorter clock (here Black's 45 s).
    [{ time: uneven("2", "0", "45"), moveLimit: "46" }, "moveLimit"],
    [{ time: uneven("10", "0", "20") }, "time"],
    [{ time: uneven("61", "5") }, "time"],
    [
      { time: { ...applyPreset(DEFAULT_VALUES.time, 5), white: { minutes: "4", seconds: "60" } } },
      "time",
    ],
    [{ budget: 0.001 }, "budget"],
    [{ budget: 25.01 }, "budget"],
    [{ budget: Number.NaN }, "budget"],
    // Whole cents only.
    [{ budget: 0.015 }, "budget"],
    [{ tokenBudget: 1000.5 }, "tokenBudget"],
    [{ moveLimit: "abc" }, "moveLimit"],
    [{ tokenBudget: 255 }, "tokenBudget"],
    [{ tokenBudget: 10_000_001 }, "tokenBudget"],
    [{ maxAttempts: 0 }, "maxAttempts"],
    [{ maxAttempts: 11 }, "maxAttempts"],
    [{ white: "  " }, "white"],
    [{ black: "x".repeat(161) }, "black"],
    [{ title: "t".repeat(141) }, "title"],
  ] as const)("%o is rejected on %s", (value, field) => {
    expect(errorsFor(value)).toEqual([field]);
  });
  it.each([
    { moveLimit: "1" },
    { moveLimit: "300" },
    { time: applyPreset(DEFAULT_VALUES.time, 30), moveLimit: "300" },
    { time: uneven("1", "0", "30") },
    { time: uneven("60", "0", "30"), moveLimit: "30" },
    { budget: 0.01 },
    { budget: 1 },
    { budget: 25 },
    { budget: 0.07 },
    { tokenBudget: 256 },
    { tokenBudget: 10_000_000 },
    { title: "t".repeat(140) },
    { maxAttempts: 1 },
    { maxAttempts: 10 },
    { illegalPolicy: "retry" as const },
  ])("%o is accepted", (value) => {
    expect(errorsFor(value)).toEqual([]);
    expect(toMatchConfig({ ...DEFAULT_VALUES, ...value }, undefined, t).success).toBe(true);
  });
  it("follows the server's limits and names them when a value is over", () => {
    const small = { maxCostMicros: 2_500_000, maxTokens: 50_000 };
    expect(errorsFor({ budget: 2.5, tokenBudget: 50_000 }, small)).toEqual([]);
    expect(issuesFor({ budget: 2.51, tokenBudget: 50_001 }, small).map((i) => i.message)).toEqual([
      "This server allows at most 50000 tokens per player.",
      "This server allows a budget of at most 2.5 US dollars per player.",
    ]);
    expect(maxBudgetUsd({ maxCostMicros: 25_000_000, maxTokens: 1 })).toBe(25);
    // A cap below the defaults starts the form at the cap, so it opens valid.
    const tight = defaultValuesFor({ maxCostMicros: 500_000, maxTokens: 20_000 });
    expect(tight).toMatchObject({ budget: 0.5, tokenBudget: 20_000 });
    expect(errorsFor(tight, { maxCostMicros: 500_000, maxTokens: 20_000 })).toEqual([]);
    expect(defaultValuesFor(limits)).toEqual(DEFAULT_VALUES);
  });
  it("offers log-spaced budget stops that end at the server's cap", () => {
    expect(budgetStops(0.01, 25)).toEqual([0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25]);
    expect(budgetStops(0.01, 1)).toEqual([0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]);
  });
  it("records keep trying as a rule and forfeit-after-N as the attempt count", () => {
    const retry = toMatchConfig({ ...DEFAULT_VALUES, illegalPolicy: "retry" }, undefined, t);
    expect(retry.success && retry.data.rules.illegalPolicy).toBe("retry");
    const strict = toMatchConfig({ ...DEFAULT_VALUES, maxAttempts: 1 }, undefined, t);
    expect(strict.success && strict.data.rules).toMatchObject({ maxAttempts: 1 });
    expect(strict.success && strict.data.rules).not.toHaveProperty("illegalPolicy");
  });
  it("records no reply cap by default and an optional cap within its bounds", () => {
    const open = toMatchConfig(DEFAULT_VALUES, undefined, t);
    expect(open.success && open.data.rules).not.toHaveProperty("maxOutputTokens");
    const capped = toMatchConfig({ ...DEFAULT_VALUES, replyCap: " 2048 " }, undefined, t);
    expect(capped.success && capped.data.rules.maxOutputTokens).toBe(2048);
    expect(summaryParts({ ...DEFAULT_VALUES, replyCap: "2048" }, t, usd)).toContain(
      "Reply cap 2048 tokens",
    );
    expect(summaryParts(DEFAULT_VALUES, t, usd).join(" · ")).not.toContain("Reply cap");
    const schema = createMatchSchema(t);
    for (const replyCap of ["63", "131073", "1.5", "lots"]) {
      expect(toMatchConfig({ ...DEFAULT_VALUES, replyCap }, undefined, t).success).toBe(false);
      expect(schema.safeParse({ ...DEFAULT_VALUES, replyCap }).success).toBe(false);
    }
    expect(schema.safeParse({ ...DEFAULT_VALUES, replyCap: "64" }).success).toBe(true);
  });
  it("maps every advanced field to its section", () => {
    expect(FIELD_SECTION.illegalPolicy).toBe("rules");
    expect(FIELD_SECTION.maxAttempts).toBe("rules");
    expect(FIELD_SECTION.whiteProtocol).toBe("players");
    expect(FIELD_SECTION.identity).toBe("players");
    expect(FIELD_SECTION.context).toBe("rules");
    // The remark tone is on the quick path, next to the time control.
    expect(FIELD_SECTION.remarks).toBeUndefined();
    expect(FIELD_SECTION.moveLimit).toBe("limits");
    expect(FIELD_SECTION.time).toBeUndefined();
    expect(FIELD_SECTION.white).toBeUndefined();
  });
});

describe("searchModels", () => {
  it("matches name, id and provider, every word", () => {
    expect(searchModels(catalog, "anthropic").map((model) => model.id)).toEqual([
      "anthropic/claude-haiku-4.5",
    ]);
    expect(searchModels(catalog, "openai nano")).toHaveLength(1);
    expect(searchModels(catalog, "HAIKU")).toHaveLength(1);
    expect(searchModels(catalog, "")).toHaveLength(2);
    expect(searchModels(catalog, "mistral")).toEqual([]);
  });
});
