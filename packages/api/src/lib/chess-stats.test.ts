import { boardAt, createMatch, finishMatch, submitMove } from "@cockpit-chess/chess";
import { endingSummarySchema } from "@cockpit-chess/chess/ending";
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
    finishMatch(match, "0-1", "resignation");
    expect(chessStatsColumns(match)).toEqual({
      result: "0-1",
      whiteModel: "vendor/model",
      whiteProtocol: "anthropic",
      blackModel: "random",
      blackProtocol: "random",
      whiteIllegal: 0,
      blackIllegal: 0,
      whiteTruncated: 0,
      blackTruncated: 0,
      whiteCostMicros: 0n,
      blackCostMicros: 0n,
      moveFormat: "strict",
      ending: { kind: "resignation", side: "w" },
    });
  });
  it("stores the card's short ending, including the forfeit's attempt count", () => {
    const match = createMatch({ white: baseline, black: baseline, rules: { maxAttempts: 2 } });
    const chess = boardAt(match);
    submitMove(match, chess, "e2e5");
    submitMove(match, chess, "e2e6");
    expect(endingSummarySchema.parse(chessStatsColumns(match)?.ending)).toEqual({
      kind: "illegal-forfeit",
      side: "w",
      illegal: 2,
    });
  });
});
