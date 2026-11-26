import { describe, expect, it } from "vitest";
import { boardAt, createMatch, submitMove } from "./index";
import { gamePositions, missingSpectatorPlies, storedSpectatorEvaluations } from "./spectator";

const player = { name: "Baseline", model: "random", protocol: "random" as const };
const score = (fen: string, cp: number | null, mate: number | null) => ({
  engine: "stockfish-19-lite-single" as const,
  fen,
  depth: 9,
  nodes: 10000,
  cp,
  mate,
  bestMove: null,
});

describe("stored spectator scores", () => {
  it("lists every position of the game by ply", () => {
    const match = createMatch({ white: player, black: player, rules: {} });
    submitMove(match, boardAt(match), "e2e4");
    const positions = gamePositions(match);
    expect(positions).toHaveLength(2);
    expect(positions[1]).toBe(boardAt(match).fen());
  });
  it("reads only well-formed entries with exactly one score, so the rest get backfilled", () => {
    const match = createMatch({ white: player, black: player, rules: {} });
    const [start] = gamePositions(match);
    const stored = storedSpectatorEvaluations.parse({
      "0": score(start as string, null, null), // no score at all: not an evaluation
      "1": score("x", 10, 2), // two scores
      bogus: score(start as string, 5, null),
    });
    expect(stored).toEqual({});
    expect(missingSpectatorPlies(match, stored)).toEqual([0]);
    expect(storedSpectatorEvaluations.parse({ "0": score(start as string, 0, null) })).toEqual({
      "0": score(start as string, 0, null),
    });
    expect(storedSpectatorEvaluations.parse([1, 2])).toBeNull();
    expect(storedSpectatorEvaluations.parse(null)).toBeNull();
  });
});
