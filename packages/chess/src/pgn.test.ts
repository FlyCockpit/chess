import { describe, expect, it } from "vitest";
import { endingText, matchEnding } from "./ending";
import { boardAt, Chess, createMatch, finishMatch, type MatchArchive, submitMove } from "./index";
import { exportPgn, pgnCommentText, pgnTagValue, pgnTermination, rulesTags } from "./pgn";

const white = {
  name: "GPT-4.1 Nano",
  model: "openai/gpt-4.1-nano",
  protocol: "openai-chat" as const,
};
const black = {
  name: "GPT-4.1 Mini",
  model: "openai/gpt-4.1-mini",
  protocol: "openai-chat" as const,
};
const play = (match: MatchArchive, moves: Array<[string, string?]>) => {
  const chess = boardAt(match);
  for (const [move, comment] of moves) submitMove(match, chess, move, comment);
  return match;
};
/** Parses with chess.js and returns its view: tags, SAN moves and comments by position. */
const parse = (pgn: string) => {
  const chess = new Chess();
  chess.loadPgn(pgn);
  return {
    chess,
    headers: chess.getHeaders(),
    moves: chess.history(),
    comments: chess.getComments(),
  };
};

describe("PGN export", () => {
  it("round-trips tags, moves, remarks, rejected attempts and the ending through a parser", () => {
    const match = createMatch({
      title: "Simple Test",
      white,
      black,
      rules: { remarks: "trash-talk", clock: { w: 600000, b: 600000 } },
    });
    match.createdAt = "2026-11-25T21:14:00.000Z";
    play(match, [
      ["e2e4", "Center is mine. {Braces} } and\nnewlines"],
      ["c7c5", "Sicilian, obviously."],
      ["g1f3"],
      ["d7d6"],
      ["d2d4"],
      ["c5d4", "Thanks for the pawn."],
      ["f3d4"],
      ["e7e4"],
      ["e7e5", "Your knight looks lonely."],
      ["d2d4"],
      ["d2d3"],
      ["d2d4"],
    ]);
    expect(match.termination).toBe("illegal-forfeit");
    const pgn = exportPgn(match, { site: "https://chess.example" });
    const { headers, moves, comments } = parse(pgn);
    expect(headers).toMatchObject({
      Event: "Simple Test",
      Site: "https://chess.example",
      Date: "2026.11.25",
      Round: "-",
      White: "GPT-4.1 Nano",
      Black: "GPT-4.1 Mini",
      Result: "0-1",
      WhiteType: "program",
      BlackType: "program",
      TimeControl: "600",
      Termination: "rules infraction",
    });
    expect(headers).toMatchObject(Object.fromEntries(rulesTags(match.config.rules)));
    expect(headers).toMatchObject({
      CockpitVersion: "cockpit-v2",
      CockpitRemarks: "trash-talk",
      CockpitClock: "w:600000,b:600000",
      CockpitMaxAttempts: "3",
    });
    for (const line of pgn.split("\n")) expect(line.length).toBeLessThanOrEqual(255);
    expect(moves).toEqual(["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "e5"]);
    const byFen = new Map(comments.map((entry) => [entry.fen, entry.comment]));
    const after = (count: number) => {
      const chess = new Chess();
      for (const move of moves.slice(0, count)) chess.move(move);
      return chess.fen();
    };
    expect(byFen.get(after(1))).toBe("Center is mine. {Braces) ) and newlines");
    expect(byFen.get(after(6))).toBe("Thanks for the pawn.");
    expect(byFen.get(after(7))?.replace(/\s+/g, " ")).toBe("Black rejected: e7e4 (illegal)");
    const final = byFen.get(after(8)) ?? "";
    expect(final).toContain("Your knight looks lonely.");
    expect(final).not.toContain("White rejected");
    const flat = pgn.replace(/\s+/g, " ");
    expect(flat).toContain(
      "White forfeited: 3 illegal moves (d2d4, d2d3, d2d4; its d-pawn had already moved)",
    );
    expect(final.replace(/\s+/g, " ")).toBe(
      `Your knight looks lonely. · ${endingText(matchEnding(match))}`,
    );
    expect(flat).toMatch(
      /4\. Nxd4\s+\{Black rejected: e7e4 \(illegal\)\} 4\.\.\. e5\s+\{Your knight/,
    );
    expect(pgn.trimEnd().endsWith("0-1")).toBe(true);
    for (const line of pgn.split("\n")) expect(line.startsWith("%")).toBe(false);
  });
  it("defaults Site, marks humans and untimed or uneven clocks, records a custom start", () => {
    const fen = "4k3/8/8/8/8/8/4P3/4K3 b - - 0 12";
    const match = createMatch({
      white: { ...white, protocol: "human" },
      black,
      rules: {},
      initialFen: fen,
    });
    play(match, [["e8d7", "ignored: remarks are off"]]);
    const pgn = exportPgn(match);
    const { headers, moves, comments } = parse(pgn);
    expect(headers).toMatchObject({
      Site: "Cockpit Chess",
      WhiteType: "human",
      BlackType: "program",
      TimeControl: "-",
      Termination: "unterminated",
      SetUp: "1",
      FEN: fen,
      Result: "*",
    });
    expect(moves).toEqual(["Kd7"]);
    expect(comments).toEqual([]);
    expect(pgn).toContain("12... Kd7 *");
    const uneven = createMatch({ white, black, rules: { clock: { w: 900000, b: 300000 } } });
    expect(parse(exportPgn(uneven)).headers.TimeControl).toBe("?");
    finishMatch(uneven, "*", "cancelled", "stopped");
    const stopped = exportPgn(uneven, { describeEnding: () => "Parado por el operador" });
    expect(parse(stopped).headers.Termination).toBe("abandoned");
    expect(stopped).toContain("{Parado por el operador} *");
  });
  it("wraps long remarks inside their comments and never starts a line with %", () => {
    const long = `${"Your bishop is admiring the view from the wrong diagonal again. ".repeat(5)}${"%".repeat(130)} ${"x".repeat(100)}`;
    const match = createMatch({ white, black, rules: { remarks: "commentary" } });
    play(match, [
      ["e2e4", long.slice(0, 500)],
      ["e7e5", `${"%a ".repeat(60)}%end`],
    ]);
    const pgn = exportPgn(match);
    const movetext = pgn.split("\n\n")[1] ?? "";
    for (const line of movetext.trimEnd().split("\n")) {
      expect(line.length).toBeLessThan(80);
      expect(line.startsWith("%")).toBe(false);
    }
    const { moves, comments } = parse(pgn);
    expect(moves).toEqual(["e4", "e5"]);
    // Over-long words are split across lines, so compare without whitespace.
    expect(comments.map((entry) => entry.comment.replace(/\s+/g, ""))).toEqual([
      pgnCommentText(long.slice(0, 500)).replace(/\s+/g, ""),
      `${"%a".repeat(60)}%end`,
    ]);
  });
  it("keeps the remarks of rejected attempts, including a forfeit's", () => {
    const match = createMatch({ white, black, rules: { remarks: "trash-talk", maxAttempts: 2 } });
    const chess = boardAt(match);
    submitMove(match, chess, "e2e5", "Watch this.");
    submitMove(match, chess, "e2e4", "Fine, the normal way.");
    submitMove(match, chess, "e7e4", "Nice try.");
    submitMove(match, chess, "e7e3", "Sure, keep going.");
    expect(match.termination).toBe("illegal-forfeit");
    const flat = exportPgn(match).replace(/\s+/g, " ");
    expect(flat).toContain("{White rejected: e2e5 (illegal) — Watch this.} 1. e4");
    expect(parse(exportPgn(match)).moves).toEqual(["e4"]);
    expect(flat).toContain(
      "{Fine, the normal way. · Black rejected: e7e4 (illegal) — Nice try., e7e3 (illegal) — Sure, keep going. · Black forfeited",
    );
    const quiet = createMatch({ white, black, rules: { maxAttempts: 1 } });
    submitMove(quiet, boardAt(quiet), "e2e5", "psst: remarks are off");
    expect(exportPgn(quiet)).not.toContain("rejected");
    expect(exportPgn(quiet)).not.toContain("psst");
  });
  it("maps every termination to a standard PGN Termination value and escapes text", () => {
    const standard = new Set([
      "abandoned",
      "adjudication",
      "death",
      "emergency",
      "normal",
      "rules infraction",
      "time forfeit",
      "unterminated",
    ]);
    for (const termination of [
      "playing",
      "checkmate",
      "draw",
      "illegal-forfeit",
      "timeout",
      "move-timeout",
      "token-budget",
      "cost-budget",
      "ply-limit",
      "cancelled",
      "interrupted",
      "provider-error",
      "engine-error",
      "resignation",
      "event-limit",
    ] as const)
      expect(standard.has(pgnTermination(termination))).toBe(true);
    // The standard's tag escapes (chess.js 1.4 does not read \", so this is checked as text).
    expect(pgnTagValue('a "b" \\ c\nd')).toBe('a \\"b\\" \\\\ c d');
    // The whole `[Name "value"]` line stays within 255 characters.
    expect(pgnTagValue("é".repeat(300))).toBe("é".repeat(250));
    expect(pgnTagValue("é".repeat(300), "Event")).toBe("é".repeat(245));
    expect(pgnTagValue(`${"a".repeat(250)}"b`)).toBe("a".repeat(250));
    expect(pgnTagValue("😀".repeat(300))).toBe("😀".repeat(250));
    const heavy = exportPgn(
      createMatch({
        title: '"\\'.repeat(70),
        white: { ...white, name: '"'.repeat(80) },
        black,
        rules: {},
      }),
    );
    for (const line of heavy.split("\n")) expect([...line].length).toBeLessThanOrEqual(255);
    expect(heavy).toContain(`[White "${'\\"'.repeat(80)}"]`);
    const quoted = exportPgn(
      createMatch({ white: { ...white, name: 'Model "A"' }, black, rules: {} }),
    );
    expect(quoted).toContain('[White "Model \\"A\\""]');
    expect(pgnCommentText("x } y\r\n%z")).toBe("x ) y %z");
  });
});
