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

/**
 * A game that shows where models struggle: a legal-move lookup, an illegal attempt
 * with a piece (slide, shake, back), one from an empty square, a reply that is not a
 * move, and a turn of 16 rejected attempts (the "keep trying" rule, `illegalPolicy:
 * "retry"`, allows any number), which the video compresses. Built event by event.
 */
export function videoIllegalFixtureGame(): MatchArchive {
  const match = createMatch(
    {
      title: "Fixture: where models struggle",
      white: { name: "GPT-4.1 Nano", model: "openai/gpt-4.1-nano", protocol: "openai-chat" },
      black: { name: "GPT-4.1 Mini", model: "openai/gpt-4.1-mini", protocol: "openai-chat" },
      rules: { legalMoves: "tool", illegalPolicy: "retry" },
    },
    "hosted",
  );
  const chess = new Chess(match.config.initialFen);
  const ply = () => match.events.filter((e) => e.type === "attempt" && e.accepted).length;
  const reject = (move: string) => {
    match.events.push({
      type: "attempt",
      seq: match.events.length,
      at: new Date(0).toISOString(),
      side: chess.turn(),
      ply: ply(),
      move,
      accepted: false,
      before: chess.fen(),
      fen: chess.fen(),
      san: null,
      reason: /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move) ? "illegal" : "unparseable",
      comment: "",
    });
  };
  const lookup = (square: string) => {
    match.events.push({
      type: "tool",
      seq: match.events.length,
      at: new Date(0).toISOString(),
      side: chess.turn(),
      ply: ply(),
      name: "legal_moves",
      input: JSON.stringify({ square }),
      output: "",
    });
  };
  const play = (move: string) => {
    match.status = "running";
    submitMove(match, chess, move);
  };
  lookup("g1");
  reject("g1e5");
  play("g1f3");
  reject("f6e4");
  play("e7e5");
  reject("Knight takes e5!!");
  play("f3e5");
  // Straight lines through their own pawns, or a knight moving like a rook: all illegal.
  for (const from of ["a8", "h8", "e8", "c8", "b8", "g8", "d8", "f8"]) {
    reject(`${from}${from[0]}5`);
    reject(`${from}${from[0]}3`);
  }
  play("d7d6");
  return match;
}

/** A promotion, for the encoded check that the new piece shows once the pawn lands. */
export function videoPromotionFixtureGame(): MatchArchive {
  const match = createMatch(
    {
      title: "Fixture: promotion",
      initialFen: "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
      white: { name: "GPT-4.1 Nano", model: "openai/gpt-4.1-nano", protocol: "openai-chat" },
      black: { name: "GPT-4.1 Mini", model: "openai/gpt-4.1-mini", protocol: "openai-chat" },
      rules: {},
    },
    "hosted",
  );
  const chess = new Chess(match.config.initialFen);
  submitMove(match, chess, "a7a8q");
  submitMove(match, chess, "e8d7");
  return match;
}
