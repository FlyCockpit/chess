import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import {
  LAB_DEFAULTS,
  LAB_FIELD_SECTION,
  labMatchConfig,
  labSummary,
  sectionsWithErrors,
  tokenBudgetValid,
} from "./lab-form";

let t: TFunction<"chess">;
beforeAll(async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess } },
    defaultNS: "chess",
  });
  t = i18n.getFixedT("en-US", "chess");
});

describe("labMatchConfig", () => {
  it("plays you (White) against the model by default, with the old defaults", () => {
    const config = labMatchConfig(LAB_DEFAULTS, t);
    expect(config?.white).toEqual({ name: "You", model: "human", protocol: "human" });
    expect(config?.black).toEqual({
      name: "openai/gpt-4.1-nano",
      model: "openai/gpt-4.1-nano",
      protocol: "openai-chat",
    });
    expect(config?.rules).toMatchObject({
      context: "fresh",
      opponentIdentity: "hidden",
      clock: null,
      tokenBudget: 1_000_000,
      tokenAccounting: "provider",
      engineEvaluation: "off",
      remarks: "off",
      moveFormat: "strict",
      costBudgetMicros: 100000,
    });
  });
  it("converts the token allowance text to a whole number and refuses anything out of bounds", () => {
    expect(labMatchConfig({ ...LAB_DEFAULTS, tokenBudget: " 4096 " }, t)?.rules.tokenBudget).toBe(
      4096,
    );
    for (const bad of ["", "255", "1000001", "12.5", "abc"]) {
      expect(tokenBudgetValid(bad)).toBe(false);
      expect(labMatchConfig({ ...LAB_DEFAULTS, tokenBudget: bad }, t)).toBeNull();
    }
    expect(tokenBudgetValid("256")).toBe(true);
    expect(tokenBudgetValid("1000000")).toBe(true);
  });
  it("derives the wire protocol from the model id unless overridden", () => {
    const anthropic = { ...LAB_DEFAULTS, model: "anthropic/claude-haiku-4.5" };
    expect(labMatchConfig(anthropic, t)?.black.protocol).toBe("anthropic");
    expect(labMatchConfig({ ...anthropic, protocol: "openai-responses" }, t)?.black.protocol).toBe(
      "openai-responses",
    );
  });
  it("lets the model play both sides in a simulation, trimming the id", () => {
    const config = labMatchConfig(
      { ...LAB_DEFAULTS, mode: "simulate", model: "  fake/trash ", remarks: "trash-talk" },
      t,
    );
    expect(config?.white).toEqual(config?.black);
    expect(config?.white.model).toBe("fake/trash");
    expect(config?.rules.remarks).toBe("trash-talk");
  });
  it("refuses an invalid time control", () => {
    expect(
      labMatchConfig(
        {
          ...LAB_DEFAULTS,
          time: { ...LAB_DEFAULTS.time, timed: true, white: { minutes: "0", seconds: "0" } },
        },
        t,
      ),
    ).toBeNull();
  });
});

describe("lab form layout data", () => {
  it("summarises the quick path and maps every Advanced field to its section", () => {
    expect(labSummary(LAB_DEFAULTS, t)).toBe(
      "You versus model · Untimed · Fresh context · No remarks",
    );
    expect(LAB_FIELD_SECTION.tokenBudget).toBe("limits");
    expect(LAB_FIELD_SECTION.protocol).toBe("connection");
    expect(LAB_FIELD_SECTION.context).toBe("rules");
    for (const quick of ["mode", "model", "time", "remarks"] as const)
      expect(LAB_FIELD_SECTION[quick]).toBeUndefined();
  });
});

describe("sectionsWithErrors", () => {
  it("opens the closed section that holds a failing field, once, and nothing for clean fields", () => {
    expect(
      sectionsWithErrors({
        tokenBudget: { errors: ["Enter a whole number from 256 to 1000000."] },
        tokenAccounting: { errors: ["x"] },
        context: { errors: [] },
        model: { errors: ["Choose a model."] },
        mode: undefined,
      }),
    ).toEqual(["limits"]);
    expect(sectionsWithErrors({ tokenBudget: { errors: [] } })).toEqual([]);
  });
});
