import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type CatalogModel,
  type CreateMatchValues,
  createMatchSchema,
  DEFAULT_VALUES,
  FIELD_SECTION,
  resolveProtocol,
  searchModels,
  summaryParts,
  toMatchConfig,
} from "./create-match-form";

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
const errorsFor = (value: Partial<CreateMatchValues>) => {
  const result = createMatchSchema(t).safeParse({ ...DEFAULT_VALUES, ...value });
  return result.success ? [] : result.error.issues.map((issue) => String(issue.path[0]));
};

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
      trashTalk: false,
      tokenAccounting: "provider",
      tokenBudget: 1000000,
      costBudgetMicros: 100000,
      maxPlies: 80,
    });
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
      "Fresh context · Legal-move tool · Strict format · $0.10 budget · 80 plies",
    );
    expect(
      summaryParts({ ...DEFAULT_VALUES, trashTalk: true, engineEvaluation: "after-move" }, t, usd),
    ).toEqual(expect.arrayContaining(["Evaluation after each move", "Commentary on"]));
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
    [{ maxPlies: "1" }, "maxPlies"],
    [{ maxPlies: "201" }, "maxPlies"],
    [{ maxPlies: "20.5" }, "maxPlies"],
    [{ budget: "0.001" }, "budget"],
    [{ budget: "1.01" }, "budget"],
    [{ budget: "" }, "budget"],
    // The old input's step: whole cents only.
    [{ budget: "0.015" }, "budget"],
    [{ tokenBudget: "1000.5" }, "tokenBudget"],
    [{ maxPlies: "abc" }, "maxPlies"],
    [{ tokenBudget: "255" }, "tokenBudget"],
    [{ tokenBudget: "1000001" }, "tokenBudget"],
    [{ white: "  " }, "white"],
    [{ black: "x".repeat(161) }, "black"],
    [{ title: "t".repeat(141) }, "title"],
  ] as const)("%o is rejected on %s", (value, field) => {
    expect(errorsFor(value)).toEqual([field]);
  });
  it.each([
    { maxPlies: "2" },
    { maxPlies: "200" },
    { budget: "0.01" },
    { budget: "1" },
    { tokenBudget: "256" },
    { title: "t".repeat(140) },
    { budget: "0.07" },
    { budget: ".5" },
    // Number-input notation the browser accepts.
    { tokenBudget: "1e3" },
  ])("%o is accepted", (value) => {
    expect(errorsFor(value)).toEqual([]);
    expect(toMatchConfig({ ...DEFAULT_VALUES, ...value }, undefined, t).success).toBe(true);
  });
  it("maps every advanced field to its section", () => {
    expect(FIELD_SECTION.whiteProtocol).toBe("players");
    expect(FIELD_SECTION.identity).toBe("players");
    expect(FIELD_SECTION.trashTalk).toBe("rules");
    expect(FIELD_SECTION.maxPlies).toBe("limits");
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
