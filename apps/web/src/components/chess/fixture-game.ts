import {
  Chess,
  createMatch,
  type MatchArchive,
  type RemarkTone,
  submitMove,
} from "@cockpit-chess/chess";

/**
 * A short fixture game for tests: commentary on, after-move evaluations, a
 * rejected attempt, and the remark/eval values the UI tests assert on.
 */
export function fixtureGame(options: { evaluations?: boolean; remarks?: RemarkTone } = {}) {
  const { evaluations = true, remarks = "trash-talk" } = options;
  const match: MatchArchive = createMatch(
    {
      title: "Fixture",
      white: { name: "GPT-4.1 Nano", model: "openai/gpt-4.1-nano", protocol: "openai-chat" },
      black: { name: "openai/gpt-4.1-mini", model: "openai/gpt-4.1-mini", protocol: "openai-chat" },
      rules: {
        remarks,
        engineEvaluation: evaluations ? "after-move" : "off",
      },
    },
    "hosted",
  );
  const chess = new Chess(match.config.initialFen);
  const scores = [35, -20, 180, null];
  const mates = [null, null, null, 2];
  const moves: Array<[string, string]> = [
    ["e2e4", "Your move, <b>tin can</b>."],
    ["e7e5", ""],
    ["g1f3", "Knight to the rescue"],
    ["b8c6", "[click](https://example.com)"],
  ];
  for (const [i, [move, comment]] of moves.entries()) {
    if (i === 3) submitMove(match, chess, "a1a8", "oops");
    submitMove(match, chess, move, comment);
    if (!evaluations) continue;
    match.events.push({
      type: "evaluation",
      purpose: "after-move",
      seq: match.events.length,
      at: new Date().toISOString(),
      side: chess.turn() === "w" ? "b" : "w",
      ply: i + 1,
      evaluation: {
        engine: "stockfish-19-lite-single",
        fen: chess.fen(),
        depth: 12,
        nodes: 10000,
        cp: scores[i] ?? null,
        mate: mates[i] ?? null,
        bestMove: null,
      },
    });
  }
  return match;
}
