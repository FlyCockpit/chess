import { describe, expect, it } from "vitest";
import {
  endingHeadline,
  endingSummary,
  endingText,
  formatDuration,
  formatUsd,
  illegalWhyText,
  matchEnding,
  timeControlText,
} from "./ending";
import {
  archiveSchema,
  boardAt,
  createMatch,
  finishMatch,
  type MatchArchive,
  rulesSchema,
  submitMove,
  validateArchive,
} from "./index";
import { asCockpitV1 } from "./testing";

const player = { name: "Baseline", model: "random", protocol: "random" as const };
const game = (rules: Record<string, unknown> = {}, initialFen?: string) =>
  createMatch({ white: player, black: player, rules, ...(initialFen ? { initialFen } : {}) });
const play = (match: MatchArchive, ...moves: string[]) => {
  const chess = boardAt(match);
  for (const move of moves) submitMove(match, chess, move);
  return match;
};
const describeMatch = (match: MatchArchive) => {
  validateArchive(JSON.parse(JSON.stringify(match)));
  return { ending: matchEnding(match), text: endingText(matchEnding(match)) };
};
/** 1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4: White's d-pawn has gone. */
const sicilian = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6"];

describe("how a match ended, in plain words", () => {
  it("names the owner's forfeit: three illegal d-pawn moves after the pawn already moved", () => {
    const match = play(game(), ...sicilian, "d2d4", "d2d3", "d2d4");
    expect(match.termination).toBe("illegal-forfeit");
    const { ending, text } = describeMatch(match);
    expect(ending).toEqual({
      kind: "illegal-forfeit",
      loser: "w",
      attempts: ["d2d4", "d2d3", "d2d4"].map((move) => ({
        move,
        why: { code: "pawn-moved", file: "d", square: "d2" },
      })),
    });
    expect(text).toBe(
      "White forfeited: 3 illegal moves (d2d4, d2d3, d2d4; its d-pawn had already moved)",
    );
  });
  it("tells cut-off replies apart from illegal and unreadable ones", () => {
    const cutOff = { text: "Let me think", stopReason: "output-truncated" as const };
    const all = game();
    for (let index = 0; index < 3; index += 1)
      submitMove(all, boardAt(all), "[truncated]", "", undefined, cutOff);
    const { ending, text } = describeMatch(all);
    expect(endingSummary(ending)).toEqual({
      kind: "illegal-forfeit",
      side: "w",
      illegal: 3,
      truncated: 3,
    });
    expect(text).toBe(
      "White forfeited: 3 replies ran out of space ([truncated], [truncated], [truncated]; ran out of space before giving a move)",
    );
    const mixed = game();
    submitMove(mixed, boardAt(mixed), "[truncated]", "", undefined, cutOff);
    submitMove(mixed, boardAt(mixed), "e2e5");
    // A cut-off reply is never played, even when its placeholder were a legal move.
    submitMove(mixed, boardAt(mixed), "e2e4", "", undefined, cutOff);
    expect(mixed.events.map((event) => event.type === "attempt" && event.reason)).toEqual([
      "truncated",
      "illegal",
      "truncated",
    ]);
    expect(endingHeadline(endingSummary(describeMatch(mixed).ending))).toBe(
      "White forfeited: 3 rejected moves (2 ran out of space)",
    );
  });
  it("explains each kind of illegal attempt, listing reasons per move when they differ", () => {
    const match = play(game({ maxAttempts: 5 }), "g1f3", "e7e5", "g1h3", "e5e4", "a3a4", "f3f6");
    submitMove(match, boardAt(match), "hello");
    const { ending, text } = describeMatch(match);
    if (ending.kind !== "illegal-forfeit") throw new Error("expected a forfeit");
    expect(ending.attempts.map((attempt) => attempt.why)).toEqual([
      { code: "piece-moved", piece: "knight", square: "g1" },
      { code: "opponent-piece", square: "e5" },
      { code: "empty", square: "a3" },
      { code: "cannot-move", piece: "knight", from: "f3", to: "f6" },
      { code: "unparseable" },
    ]);
    expect(text).toBe(
      "White forfeited: 5 illegal moves (g1h3: its knight had already left g1; e5e4: e5 holds an opposing piece; a3a4: there is no piece on a3; f3f6: its knight on f3 cannot legally move to f6; hello: not a move in UCI notation)",
    );
    const single = play(game({ maxAttempts: 1 }), "e2e5");
    expect(describeMatch(single).text).toBe(
      "White forfeited: 1 illegal move (e2e5; its pawn on e2 cannot legally move to e5)",
    );
  });
  it("covers checkmate, every draw kind and resignation", () => {
    expect(describeMatch(play(game(), "f2f3", "e7e5", "g2g4", "d8h4")).text).toBe(
      "Checkmate: Black wins",
    );
    expect(describeMatch(game({}, "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")).text).toBe("Draw: stalemate");
    expect(describeMatch(game({}, "8/8/8/4k3/8/8/8/4K3 w - - 0 1")).text).toBe(
      "Draw: insufficient material",
    );
    expect(describeMatch(play(game({}, "4k3/8/8/8/8/8/R7/4K3 w - - 99 60"), "a2a3")).text).toBe(
      "Draw: fifty-move rule",
    );
    const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
    expect(describeMatch(play(game(), ...shuffle, ...shuffle)).text).toBe(
      "Draw: threefold repetition",
    );
    const resigned = play(game(), "e2e4");
    finishMatch(resigned, "1-0", "resignation");
    expect(describeMatch(resigned).text).toBe("Black resigned");
  });
  it("covers clock, move-limit, token and spend exhaustion with the limit that ran out", () => {
    const timed = game({ clock: { w: 600000, b: 600000 } });
    finishMatch(timed, "0-1", "timeout");
    expect(describeMatch(timed)).toEqual({
      ending: { kind: "timeout", loser: "w", clockMs: 600000 },
      text: "White ran out of time (10 min clock)",
    });
    const slow = play(game(), "e2e4");
    finishMatch(slow, "1-0", "move-timeout");
    expect(describeMatch(slow).text).toBe(
      "Black ran out of time for one move (1 min per-move limit)",
    );
    const tokens = game({ tokenBudget: 12000 });
    finishMatch(tokens, "0-1", "token-budget");
    expect(describeMatch(tokens).text).toBe(
      "White ran out of tokens (12,000 token budget; not enough left for another request)",
    );
    const spend = play(game(), "e2e4");
    finishMatch(spend, "1-0", "cost-budget");
    expect(describeMatch(spend).text).toBe(
      "Black ran out of budget (spent $0.00 of $1.00; not enough left for another request)",
    );
    const spent = play(game(), "e2e4");
    const turn = () => ({ seq: spent.events.length, at: new Date().toISOString(), side, ply: 1 });
    const side = "b" as const;
    spent.events.push({
      ...turn(),
      type: "reservation",
      dispatch: 0,
      tokens: 900,
      costMicros: 20_000,
    });
    spent.events.push({
      ...turn(),
      type: "usage",
      dispatch: 0,
      inputTokens: 500,
      outputTokens: 100,
      costMicros: 980_000,
    });
    finishMatch(spent, "1-0", "cost-budget");
    expect(describeMatch(spent)).toMatchObject({
      ending: {
        kind: "cost-budget",
        loser: "b",
        budgetMicros: 1_000_000,
        spentMicros: 980_000,
        settled: true,
      },
      text: "Black ran out of budget (spent $0.98 of $1.00; not enough left for another request)",
    });
    // A later call that never reported its cost: the spend is a lower bound.
    const pending = play(game(), "e2e4");
    pending.events.push({
      seq: 1,
      at: new Date().toISOString(),
      side: "b",
      ply: 1,
      type: "reservation",
      dispatch: 0,
      tokens: 900,
      costMicros: 20_000,
    });
    finishMatch(pending, "1-0", "cost-budget");
    expect(describeMatch(pending)).toMatchObject({
      ending: { spentMicros: 0, settled: false },
      text: "Black ran out of budget (spent at least $0.00 of $1.00; not enough left for another request)",
    });
  });
  it("names no clock for a cockpit-v1 timeout, which also covered the per-move limit", () => {
    const legacy = asCockpitV1(play(game(), "e2e4"));
    finishMatch(legacy, "1-0", "timeout");
    expect(describeMatch(legacy)).toEqual({
      ending: { kind: "timeout", loser: "b", clockMs: null },
      text: "Black ran out of time",
    });
  });
  it("explains a missing promotion piece instead of calling the move impossible", () => {
    const fen = "4k3/P7/8/8/8/8/4P3/4K3 w - - 0 1";
    const missing = play(game({ maxAttempts: 1 }, fen), "a7a8");
    expect(describeMatch(missing).text).toBe(
      "White forfeited: 1 illegal move (a7a8; its pawn on a7 must name a promotion piece (q, r, b or n))",
    );
    // chess.js ignores a needless suffix (e2e4q plays e4), so only a missing one is rejected.
    expect(play(game({}, fen), "e2e4q").events[0]).toMatchObject({ accepted: true, san: "e4" });
  });
  it("names a pawn's file only when it left its own starting square", () => {
    // 1. f4 e5 2. fxe5 Nf6 3. e6 Ng8: White's f-pawn stands on e6, the e-pawn on e2.
    const match = play(
      game(),
      "f2f4",
      "e7e5",
      "f4e5",
      "g8f6",
      "e5e6",
      "f6g8",
      "e5e6",
      "e5e6",
      "e5e6",
    );
    const { ending, text } = describeMatch(match);
    if (ending.kind !== "illegal-forfeit") throw new Error("expected a forfeit");
    expect(ending.attempts[0]?.why).toEqual({ code: "piece-moved", piece: "pawn", square: "e5" });
    expect(text).toBe(
      "White forfeited: 3 illegal moves (e5e6, e5e6, e5e6; its pawn had already left e5)",
    );
  });
  it("names no side for a provider failure, which may be either model's setup", () => {
    // White is a baseline; Black's model had no price, so the worker failed before play.
    const match = createMatch({
      white: player,
      black: { name: "Missing", model: "vendor/unknown", protocol: "openai-chat" },
      rules: {},
    });
    finishMatch(match, "*", "provider-error", "error");
    const { ending, text } = describeMatch(match);
    expect(ending).toEqual({ kind: "provider-error" });
    expect(endingSummary(ending)).toEqual({ kind: "provider-error" });
    expect(text).toBe("A model provider failed (unscored)");
  });
  it("covers the cockpit-v1 ply limit and every unscored ending", () => {
    const legacy = asCockpitV1(game(), { maxPlies: 2 });
    play(legacy, "e2e4", "e7e5");
    expect(describeMatch(legacy).text).toBe("Draw: move limit reached (2 plies)");
    const unscored: Array<[MatchArchive["termination"], MatchArchive["status"], string]> = [
      ["cancelled", "stopped", "Stopped by the operator (unscored)"],
      ["interrupted", "error", "Interrupted by the server (unscored)"],
      ["provider-error", "error", "A model provider failed (unscored)"],
      ["engine-error", "error", "The chess engine failed (unscored)"],
      ["event-limit", "error", "The game record reached its size limit (unscored)"],
    ];
    for (const [termination, status, text] of unscored) {
      const match = game();
      finishMatch(match, "*", termination, status);
      expect(describeMatch(match).text).toBe(text);
    }
    expect(describeMatch(game()).text).toBe("In progress");
  });
  it("maps every termination the archive format allows to its own ending and text", () => {
    const texts = new Set<string>();
    for (const termination of archiveSchema.shape.termination.options) {
      const match = game();
      match.termination = termination;
      const ending = matchEnding(match);
      expect(ending.kind).toBe(termination);
      const text = endingText(ending);
      expect(text.length).toBeGreaterThan(0);
      texts.add(text);
    }
    expect(texts.size).toBe(archiveSchema.shape.termination.options.length);
  });
  it("degrades a backfilled card summary to a plainer headline, never a wrong one", () => {
    expect(endingHeadline({ kind: "illegal-forfeit", side: "w", illegal: 3 })).toBe(
      "White forfeited: 3 illegal moves",
    );
    expect(endingHeadline({ kind: "illegal-forfeit", side: "b" })).toBe(
      "Black forfeited: illegal moves",
    );
    expect(endingHeadline({ kind: "illegal-forfeit" })).toBe("Forfeit after illegal moves");
    expect(endingHeadline({ kind: "checkmate", side: "w" })).toBe("Checkmate: Black wins");
    expect(endingHeadline({ kind: "checkmate" })).toBe("Checkmate");
    expect(endingHeadline({ kind: "draw" })).toBe("Draw");
    expect(endingHeadline({ kind: "provider-error" })).toBe("A model provider failed");
    expect(endingHeadline({ kind: "cost-budget", side: "b" })).toBe("Black ran out of budget");
    const match = play(game(), ...sicilian, "d2d4", "d2d3", "d2d4");
    expect(endingHeadline(endingSummary(matchEnding(match)))).toBe(
      "White forfeited: 3 illegal moves",
    );
  });
  it("formats budgets, durations, the time control and untrusted move text", () => {
    expect(formatUsd(1_000_000)).toBe("$1.00");
    expect(formatUsd(50_000)).toBe("$0.05");
    expect(formatUsd(1_200)).toBe("$0.0012");
    expect(formatUsd(999_999)).toBe("$1");
    expect(formatUsd(10_000_001)).toBe("$10");
    expect(formatUsd(1_000_500)).toBe("$1.0005");
    expect(formatDuration(90_000)).toBe("1 min 30 s");
    expect(formatDuration(45_000)).toBe("45 s");
    expect(timeControlText(rulesSchema.parse({}))).toBe("Untimed");
    expect(timeControlText(rulesSchema.parse({ clock: { w: 600000, b: 600000 } }))).toBe(
      "10 min each",
    );
    expect(timeControlText(rulesSchema.parse({ clock: { w: 900000, b: 300000 } }))).toBe(
      "White 15 min · Black 5 min",
    );
    expect(illegalWhyText({ code: "empty", square: "h8" })).toBe("there is no piece on h8");
  });
});
