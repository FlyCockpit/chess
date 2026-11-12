import { createMatch, finishMatch } from "@cockpit-chess/chess";
import { describe, expect, it } from "vitest";
import { chessStatsColumns } from "./chess-stats";

const model = { name: "Model", model: "vendor/model", protocol: "anthropic" as const };
const baseline = { name: "Baseline", model: "random", protocol: "random" as const };

describe("chessStatsColumns", () => {
  it("derives nothing while a match is still running", () => {
    expect(chessStatsColumns(createMatch({ white: model, black: baseline, rules: {} }))).toBeNull();
  });
  it("derives per-side typed columns, with cost as integer micros", () => {
    const match = createMatch({ white: model, black: baseline, rules: {} });
    finishMatch(match, "1-0", "resignation");
    expect(chessStatsColumns(match)).toEqual({
      result: "1-0",
      whiteModel: "vendor/model",
      whiteProtocol: "anthropic",
      blackModel: "random",
      blackProtocol: "random",
      whiteIllegal: 0,
      blackIllegal: 0,
      whiteCostMicros: 0n,
      blackCostMicros: 0n,
      moveFormat: "strict",
    });
  });
});
