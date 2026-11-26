import { createMatch, finishMatch } from "@cockpit-chess/chess";
import { gamePositions } from "@cockpit-chess/chess/spectator";
import { describe, expect, it } from "vitest";
import {
  evaluationSeries,
  graphCursor,
  graphSeries,
  moveNumber,
  pointAt,
  pointForPosition,
  replayRefetch,
  replayRefetchInterval,
  shortScore,
  whiteShare,
} from "./evaluation";
import { fixtureGame } from "./fixture-game";

const W = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const B = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
describe("whiteShare", () => {
  it("is even at 0, monotonic, and never maxes out on centipawns", () => {
    expect(whiteShare({ cp: 0, mate: null, fen: W })).toBe(0.5);
    expect(whiteShare({ cp: 100, mate: null, fen: W })).toBeGreaterThan(0.5);
    expect(whiteShare({ cp: -100, mate: null, fen: W })).toBeCloseTo(
      1 - whiteShare({ cp: 100, mate: null, fen: W }),
    );
    const ten = whiteShare({ cp: 1000, mate: null, fen: W });
    expect(ten).toBeGreaterThan(0.95);
    expect(ten).toBeLessThan(1);
    expect(whiteShare({ cp: 5000, mate: null, fen: W })).toBe(ten);
  });
  it("fills on mate, and mate 0 depends on who is checkmated", () => {
    expect(whiteShare({ cp: null, mate: 3, fen: W })).toBe(1);
    expect(whiteShare({ cp: null, mate: -1, fen: W })).toBe(0);
    expect(whiteShare({ cp: null, mate: 0, fen: W })).toBe(0);
    expect(whiteShare({ cp: null, mate: 0, fen: B })).toBe(1);
  });
});

describe("shortScore", () => {
  it("formats pawns and mates", () => {
    expect(shortScore({ cp: 125, mate: null })).toBe("+1.3");
    expect(shortScore({ cp: -40, mate: null })).toBe("−0.4");
    expect(shortScore({ cp: 1240, mate: null })).toBe("+12");
    expect(shortScore({ cp: -999, mate: null })).toBe("−10.0");
    expect(shortScore({ cp: 0, mate: null })).toBe("0.0");
    expect(shortScore({ cp: null, mate: 2 })).toBe("M2");
    expect(shortScore({ cp: null, mate: -3 })).toBe("−M3");
  });
});

describe("evaluationSeries", () => {
  it("has one point per post-move evaluation with move numbers", () => {
    const match = fixtureGame();
    const series = evaluationSeries(match);
    expect(series.map((point) => point.move)).toEqual([1, 1, 2, 2]);
    expect(series.map((point) => point.evaluation.cp)).toEqual([35, -20, 180, null]);
    expect(series.at(-1)?.share).toBe(1);
    expect(match.events[series[0]?.index ?? -1]?.type).toBe("evaluation");
  });
  it("follows the replay cursor", () => {
    const series = evaluationSeries(fixtureGame());
    expect(pointAt(series, -1)).toBeUndefined();
    expect(pointAt(series, 0)).toBeUndefined();
    const first = series[0];
    expect(first && pointAt(series, first.index)).toBe(first);
    expect(first && pointAt(series, first.index + 1)).toBe(first);
    expect(pointAt(series, 999)).toBe(series.at(-1));
  });
  it("resolves the bar against the exact position on the board", () => {
    const match = fixtureGame();
    const series = evaluationSeries(match);
    const first = series[0];
    if (!first) throw new Error("fixture has evaluations");
    // At the move itself (one event before its evaluation) nothing is known yet.
    expect(pointForPosition(series, first.index - 1, first.evaluation.fen)).toBeUndefined();
    expect(pointForPosition(series, first.index, first.evaluation.fen)).toBe(first);
    // A later cursor on a different position does not borrow this evaluation.
    expect(pointForPosition(series, first.index + 1, "8/8/8/8/8/8/8/8 w - - 0 1")).toBeUndefined();
  });
  it("includes the players' engine_eval tool results", () => {
    const match = fixtureGame({ evaluations: false });
    const fen = match.config.initialFen;
    match.events.unshift({
      type: "tool",
      seq: 0,
      at: new Date().toISOString(),
      side: "w",
      ply: 0,
      name: "engine_eval",
      input: "{}",
      output: JSON.stringify({
        engine: "stockfish-19-lite-single",
        fen,
        depth: 10,
        nodes: 10000,
        cp: 20,
        mate: null,
        bestMove: "e2e4",
      }),
    });
    match.events.push({ ...match.events[0], name: "engine_eval", output: "not json" } as never);
    const series = evaluationSeries(match);
    expect(series).toHaveLength(1);
    expect(series[0]?.evaluation.cp).toBe(20);
    expect(series[0]?.move).toBe(1);
  });
  it("keeps every evaluation for the bar and draws a re-evaluated position once", () => {
    const match = fixtureGame();
    const observer = evaluationSeries(match)[0];
    if (!observer) throw new Error("fixture has evaluations");
    // Black's own tool call on the same position, recorded after the observer's.
    match.events.splice(observer.index + 1, 0, {
      type: "tool",
      seq: 0,
      at: new Date().toISOString(),
      side: "b",
      ply: 1,
      name: "engine_eval",
      input: "{}",
      output: JSON.stringify({ ...observer.evaluation, cp: 41 }),
    });
    const series = evaluationSeries(match);
    expect(series).toHaveLength(5);
    // Scrubbing back to the observer event still finds its score.
    expect(pointForPosition(series, observer.index, observer.evaluation.fen)?.evaluation.cp).toBe(
      35,
    );
    expect(
      pointForPosition(series, observer.index + 1, observer.evaluation.fen)?.evaluation.cp,
    ).toBe(41);
    const graph = graphSeries(series);
    expect(graph).toHaveLength(4);
    expect(graph[0]?.evaluation.cp).toBe(41);
    // At the observer event the graph cursor sits on that position's drawn point.
    const exact = pointForPosition(series, observer.index, observer.evaluation.fen);
    expect(graphCursor(graph, exact, observer.index)).toBe(graph[0]);
    // Before any evaluation there is no cursor.
    expect(graphCursor(graph, undefined, -1)).toBeUndefined();
  });
  it("numbers moves from the start position's fullmove counter", () => {
    expect(moveNumber("8/8/8/8/8/8/8/K6k w - - 0 1", 0)).toBe(1);
    expect(moveNumber("8/8/8/8/8/8/8/K6k b - - 0 37", 0)).toBe(37);
    expect(moveNumber("8/8/8/8/8/8/8/K6k b - - 0 37", 1)).toBe(38);
    expect(moveNumber("8/8/8/8/8/8/8/K6k w - - 0 37", 1)).toBe(37);
    const late = createMatch({
      white: { name: "W", model: "w", protocol: "random" },
      black: { name: "B", model: "b", protocol: "random" },
      rules: {},
      initialFen: "4k3/8/8/8/8/8/4P3/4K3 b - - 3 37",
    });
    expect(moveNumber(late.config.initialFen, 0)).toBe(37);
  });
  it("is empty without evaluations", () => {
    expect(evaluationSeries(fixtureGame({ evaluations: false }))).toEqual([]);
  });
});

describe("replayRefetchInterval", () => {
  const scoredAll = (match: ReturnType<typeof fixtureGame>) =>
    Object.fromEntries(
      gamePositions(match).map((fen, ply) => [
        String(ply),
        {
          engine: "stockfish-19-lite-single" as const,
          fen,
          depth: 1,
          nodes: 1000,
          cp: 0,
          mate: null,
          bestMove: null,
        },
      ]),
    );
  it("polls fast while running, slowly and boundedly while a finished game lacks scores", () => {
    const running = fixtureGame();
    expect(replayRefetchInterval({ archive: running, spectatorEvaluations: null }, 500)).toBe(2000);
    const done = fixtureGame();
    finishMatch(done, "*", "cancelled", "stopped");
    expect(replayRefetchInterval({ archive: done, spectatorEvaluations: null }, 1)).toBe(10_000);
    expect(replayRefetchInterval({ archive: done, spectatorEvaluations: null }, 36)).toBe(false);
    expect(replayRefetchInterval({ archive: done, spectatorEvaluations: scoredAll(done) }, 1)).toBe(
      false,
    );
    expect(replayRefetchInterval(undefined, 0)).toBe(false);
  });
});

describe("spectator and archive scores together", () => {
  it("prefers the spectators' score per position and keeps archive scores elsewhere", () => {
    const match = fixtureGame(); // after-move evaluations of every position after a move
    const start = gamePositions(match)[0] as string;
    const sparse = {
      "0": {
        engine: "stockfish-19-lite-single" as const,
        fen: start,
        depth: 1,
        nodes: 1000,
        cp: 7,
        mate: null,
        bestMove: null,
      },
    };
    const series = evaluationSeries(match, sparse);
    expect(series[0]?.evaluation.cp).toBe(7);
    // The archive's later scores are still there.
    expect(series.length).toBe(evaluationSeries(match).length + 1);
    expect(series.map((point) => point.index)).toEqual(
      [...series.map((point) => point.index)].sort((a, b) => a - b),
    );
  });
  it("counts the polling allowance from when the game was first seen finished", () => {
    const match = fixtureGame();
    const query = {
      state: { data: { archive: match, spectatorEvaluations: null }, dataUpdateCount: 400 },
    };
    expect(replayRefetch(query)).toBe(2000);
    finishMatch(match, "*", "cancelled", "stopped");
    query.state.dataUpdateCount = 401;
    expect(replayRefetch(query)).toBe(10_000);
    query.state.dataUpdateCount = 436;
    expect(replayRefetch(query)).toBe(10_000);
    query.state.dataUpdateCount = 437;
    expect(replayRefetch(query)).toBe(false);
  });
});
