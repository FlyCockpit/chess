import { Chess, createMatch, type MatchArchive, submitMove } from "@cockpit-chess/chess";

/**
 * Scholar's mate with everything the video draws: remarks (one with markup
 * and a bidi override, which must stay plain text), after-move evaluations
 * and per-move timing (clocks). Used by the unit tests and the browser
 * integration test.
 */
/** U+202E RIGHT-TO-LEFT OVERRIDE, which a remark must not be able to apply. */
const RLO = String.fromCodePoint(0x202e);

export function videoFixtureGame(): MatchArchive {
  const match = createMatch(
    {
      title: "Fixture: Scholar's mate",
      white: { name: "GPT-4.1 Nano", model: "openai/gpt-4.1-nano", protocol: "openai-chat" },
      black: { name: "GPT-4.1 Mini", model: "openai/gpt-4.1-mini", protocol: "openai-chat" },
      rules: {
        remarks: "trash-talk",
        engineEvaluation: "after-move",
        clock: { w: 120_000, b: 120_000 },
      },
    },
    "hosted",
  );
  const chess = new Chess(match.config.initialFen);
  const moves: Array<[string, string, number | null, number | null]> = [
    ["e2e4", "Center first. <b>Obviously</b>.", 35, null],
    ["e7e5", "", 30, null],
    ["f1c4", `${RLO}Your king looks nervous.`, 40, null],
    ["b8c6", "", 45, null],
    ["d1h5", "Hello from h5!", 60, null],
    ["g8f6", "I see no danger here at all.", null, 1],
  ];
  for (const [move, comment, cp, mate] of moves) {
    const side = chess.turn();
    match.events.push({
      type: "timing",
      seq: match.events.length,
      at: new Date().toISOString(),
      side,
      ply: match.events.filter((e) => e.type === "attempt" && e.accepted).length,
      elapsedMs: 4_200,
    });
    submitMove(match, chess, move, comment);
    match.events.push({
      type: "evaluation",
      purpose: "after-move",
      seq: match.events.length,
      at: new Date().toISOString(),
      side,
      ply: match.events.filter((e) => e.type === "attempt" && e.accepted).length,
      evaluation: {
        engine: "stockfish-19-lite-single",
        fen: chess.fen(),
        depth: 12,
        nodes: 10_000,
        cp,
        mate,
        bestMove: null,
      },
    });
  }
  submitMove(match, chess, "h5f7", "Checkmate. Good game.");
  return match;
}
