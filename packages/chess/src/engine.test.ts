import { describe, expect, it } from "vitest";
import { evaluatePosition } from "./engine";
import { Chess, DEFAULT_POSITION } from "./index";

describe("bounded real Stockfish UCI process", () => {
  it("returns an actual legal principal move and a scored node-limited analysis", async () => {
    const result = await evaluatePosition(DEFAULT_POSITION);
    expect(result.engine).toBe("stockfish-19-lite-single");
    expect(result.depth).toBeGreaterThan(0);
    expect(result.nodes).toBeGreaterThan(0);
    expect(result.nodes).toBeLessThan(12000);
    expect(result.bestMove).not.toBeNull();
    expect(() =>
      new Chess(DEFAULT_POSITION).move({
        from: result.bestMove?.slice(0, 2) ?? "",
        to: result.bestMove?.slice(2, 4) ?? "",
      }),
    ).not.toThrow();
    expect(result.cp).not.toBeNull();
  });
  it("normalizes Black-to-move scores to White's perspective", async () => {
    const result = await evaluatePosition(
      "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
    );
    expect(result.cp).toBeGreaterThan(500);
  });
  it("scores a terminal checkmate without inventing a best move", async () => {
    const value = await evaluatePosition("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
    expect(value).toMatchObject({ mate: 0, cp: null, bestMove: null });
  });
  it("cancels an in-flight engine and rejects out-of-bounds search requests", async () => {
    const controller = new AbortController();
    const pending = evaluatePosition(DEFAULT_POSITION, {
      nodes: 100000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    await expect(evaluatePosition(DEFAULT_POSITION, { nodes: 100001 })).rejects.toThrow(
      "allowance",
    );
  });
  it("serves serialized, deterministic analyses and recovers after a cancelled search", async () => {
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
    const [first, second] = await Promise.all([
      evaluatePosition(fen),
      evaluatePosition(DEFAULT_POSITION),
    ]);
    expect(first.fen).toBe(fen);
    expect(second.fen).toBe(DEFAULT_POSITION);
    const controller = new AbortController();
    const cancelled = evaluatePosition(DEFAULT_POSITION, {
      nodes: 100000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(cancelled).rejects.toThrow("cancelled");
    expect(await evaluatePosition(fen)).toEqual(first);
  });
});
