import {
  boardAt,
  createMatch,
  finishMatch,
  type MatchEvent,
  submitMove,
} from "@cockpit-chess/chess";
import { endingSummarySchema } from "@cockpit-chess/chess/ending";
import { describe, expect, it } from "vitest";
import { chessStatsColumns, chessUsageColumns } from "./chess-stats";

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
      terminalCause: "resignation",
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

describe("durable safe statistics", () => {
  it("persists running usage without claiming a terminal result", () => {
    const match = createMatch({ white: model, black: baseline, rules: {} });
    const columns = chessUsageColumns(match);
    expect(columns).toMatchObject({
      whiteModel: model.model,
      whiteProtocol: model.protocol,
      blackModel: "random",
      blackProtocol: "random",
      whiteIllegal: 0,
      whiteTruncated: 0,
      whiteCostMicros: 0n,
      blackCostMicros: 0n,
      moveFormat: "strict",
    });
    for (const field of ["result", "ending", "terminalCause", "status", "archive"])
      expect(columns).not.toHaveProperty(field);
    expect(chessStatsColumns(match)).toBeNull();
  });

  it("keeps unknown provider usage costs unknown while preserving known costs", () => {
    const match = createMatch({ white: model, black: baseline, rules: {} });
    const usage: Extract<MatchEvent, { type: "usage" }> = {
      type: "usage",
      seq: 0,
      at: new Date().toISOString(),
      side: "w",
      ply: 0,
      dispatch: 0,
      inputTokens: 10,
      outputTokens: 2,
      costMicros: null,
      resolvedModel: null,
      resolvedProvider: null,
    };
    match.events.push(usage);
    expect(chessUsageColumns(match)).toMatchObject({ whiteCostMicros: null, blackCostMicros: 0n });
    usage.costMicros = 123;
    expect(chessUsageColumns(match).whiteCostMicros).toBe(123n);
    finishMatch(match, "*", "interrupted", "error");
    expect(chessStatsColumns(match)).toMatchObject({
      terminalCause: "interrupted",
      whiteCostMicros: 123n,
    });
  });

  it("records cancelled termination as owner-stop", () => {
    const match = createMatch({ white: model, black: baseline, rules: {} });
    finishMatch(match, "*", "cancelled", "stopped");
    expect(chessStatsColumns(match)).toMatchObject({
      result: "*",
      terminalCause: "owner-stop",
      ending: { kind: "cancelled" },
    });
  });
});
