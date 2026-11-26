import {
  type AttemptEvent,
  Chess,
  createMatch,
  type MatchArchive,
  submitMove,
} from "@cockpit-chess/chess";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import esChess from "@cockpit-chess/locales/src/es-MX/chess.json";
import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import {
  boardIllegal,
  ghostPose,
  ILLEGAL_MS,
  ILLEGAL_PHASES,
  illegalCaption,
  illegalMark,
  illegalMotion,
  illegalNotation,
  MOVE_MS,
  markSquares,
  moreAttemptsCaption,
  moveMotion,
  rejectedAt,
  stepMotion,
  UNREADABLE_MS,
} from "./board-motion";
import { gameSource } from "./use-board-playback";

let en: TFunction<"chess">;
let es: TFunction<"chess">;
beforeAll(async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess }, "es-MX": { chess: esChess } },
    defaultNS: "chess",
  });
  en = i18n.getFixedT("en-US", "chess");
  es = i18n.getFixedT("es-MX", "chess");
});

const START = new Chess().fen();

function attempt(move: string, side: "w" | "b" = "w", accepted = false): AttemptEvent {
  return {
    type: "attempt",
    seq: 0,
    at: new Date(0).toISOString(),
    side,
    ply: 0,
    move,
    accepted,
    before: START,
    fen: START,
    san: null,
    reason: accepted
      ? null
      : /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)
        ? "illegal"
        : "unparseable",
    comment: "",
  };
}

function game(): MatchArchive {
  return createMatch(
    {
      title: "Motion",
      white: { name: "W", model: "w", protocol: "random" },
      black: { name: "B", model: "b", protocol: "random" },
      rules: { maxAttempts: 10 },
    },
    "hosted",
  );
}

describe("legal moves", () => {
  it("slides the piece and hides it on its target until the slide ends", () => {
    expect(moveMotion(START, "e2e4", 3)).toEqual({
      index: 3,
      kind: "move",
      ms: MOVE_MS,
      ghosts: [{ piece: { type: "p", color: "w" }, from: "e2", to: "e4", effect: "slide" }],
      hide: ["e4"],
    });
  });

  it("fades a captured piece out under the capturing one", () => {
    const fen = "4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1";
    const motion = moveMotion(fen, "e4d5", 0);
    expect(motion?.ghosts).toEqual([
      { piece: { type: "p", color: "b" }, from: "d5", to: "d5", effect: "fade" },
      { piece: { type: "p", color: "w" }, from: "e4", to: "d5", effect: "slide" },
    ]);
  });

  it("moves the rook too when castling, on either side", () => {
    const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    expect(moveMotion(fen, "e1g1", 0)?.ghosts).toEqual([
      { piece: { type: "k", color: "w" }, from: "e1", to: "g1", effect: "slide" },
      { piece: { type: "r", color: "w" }, from: "h1", to: "f1", effect: "slide" },
    ]);
    expect(moveMotion(fen, "e1g1", 0)?.hide).toEqual(["g1", "f1"]);
    const black = "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1";
    expect(moveMotion(black, "e8c8", 0)?.ghosts[1]).toEqual({
      piece: { type: "r", color: "b" },
      from: "a8",
      to: "d8",
      effect: "slide",
    });
  });

  it("removes the right pawn en passant", () => {
    const fen = "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1";
    const motion = moveMotion(fen, "e5d6", 0);
    expect(motion?.ghosts[0]).toEqual({
      piece: { type: "p", color: "b" },
      from: "d5",
      to: "d5",
      effect: "fade",
    });
    expect(motion?.ghosts[1]).toMatchObject({ from: "e5", to: "d6", effect: "slide" });
  });

  it("slides the pawn of a promotion and swaps in the new piece at the end", () => {
    const fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    const motion = moveMotion(fen, "a7a8q", 0);
    expect(motion?.ghosts).toEqual([
      { piece: { type: "p", color: "w" }, from: "a7", to: "a8", effect: "slide" },
    ]);
    // The real queen on a8 shows once the pawn arrives.
    expect(motion?.hide).toEqual(["a8"]);
  });

  it("plays a step back in reverse: the pawn slides back, the captured piece returns", () => {
    const fen = "1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    const motion = moveMotion(fen, "a7b8n", 4, "back");
    // The promoted knight turns back into the pawn at once; the pawn slides home.
    expect(motion?.ghosts).toEqual([
      { piece: { type: "r", color: "b" }, from: "b8", to: "b8", effect: "appear" },
      { piece: { type: "p", color: "w" }, from: "b8", to: "a7", effect: "slide" },
    ]);
    expect(motion?.hide).toEqual(["a7", "b8"]);
  });

  it("has no motion for a move that does not replay or is not a move", () => {
    expect(moveMotion(START, "e2e5", 0)).toBeNull();
    expect(moveMotion(START, "castle", 0)).toBeNull();
    expect(
      stepMotion(START, { ...attempt("e2e4"), type: "attempt", accepted: true }, 0)?.kind,
    ).toBe("move");
    expect(
      stepMotion(
        START,
        {
          type: "tool",
          seq: 0,
          at: new Date(0).toISOString(),
          side: "w",
          ply: 0,
          name: "legal_moves",
          input: "{}",
          output: "",
        },
        0,
      ),
    ).toBeNull();
  });
});

describe("illegal attempts", () => {
  it("slides the piece out, shakes it and slides it back, outlining both squares", () => {
    const mark = illegalMark(START, attempt("g1e5"), 7);
    expect(mark).toEqual({
      kind: "illegal",
      index: 7,
      side: "w",
      from: "g1",
      to: "e5",
      piece: { type: "n", color: "w" },
      promotion: null,
    });
    expect(markSquares(mark)).toEqual(["g1", "e5"]);
    expect(illegalMotion(mark as NonNullable<typeof mark>)).toEqual({
      index: 7,
      kind: "illegal",
      ms: ILLEGAL_MS,
      ghosts: [{ piece: { type: "n", color: "w" }, from: "g1", to: "e5", effect: "illegal" }],
      hide: ["g1"],
    });
    expect(ILLEGAL_MS).toBeGreaterThanOrEqual(900);
    expect(ILLEGAL_MS).toBeLessThanOrEqual(1200);
    expect(illegalCaption(en, mark as NonNullable<typeof mark>)).toBe(
      "White tried Ng1-e5: not a legal move",
    );
    // Spanish captions use Spanish piece letters (C for caballo).
    expect(illegalCaption(es, mark as NonNullable<typeof mark>)).toBe(
      "Blanco intentó Cg1-e5: no es una jugada legal",
    );
  });

  it("outlines only the from-square when the side has no piece there, without a slide", () => {
    for (const move of ["e5e6", "e7e5"]) {
      const mark = illegalMark(START, attempt(move), 0);
      expect(mark).toMatchObject({ kind: "illegal", piece: null });
      expect(markSquares(mark)).toEqual([move.slice(0, 2)]);
      const motion = illegalMotion(mark as NonNullable<typeof mark>);
      expect(motion.ghosts).toEqual([]);
      expect(motion.hide).toEqual([]);
    }
    const mark = illegalMark(START, attempt("e7e5"), 0) as NonNullable<
      ReturnType<typeof illegalMark>
    >;
    expect(illegalCaption(en, mark)).toBe("White tried e7-e5: no White piece on e7");
    expect(illegalCaption(es, mark)).toBe("Blanco intentó e7-e5: no tiene ninguna pieza en e7");
  });

  it("names a promotion piece in the attempt", () => {
    const mark = illegalMark(START, attempt("e2e4q", "w"), 0);
    expect(mark).toMatchObject({ promotion: "q" });
    const illegal = mark as Extract<NonNullable<typeof mark>, { kind: "illegal" }>;
    expect(illegalNotation(en, illegal)).toBe("e2-e4=Q");
    expect(illegalNotation(es, illegal)).toBe("e2-e4=D");
    expect(illegalNotation(es, { ...illegal, piece: { type: "k", color: "w" } })).toBe("Re2-e4=D");
  });

  it("captions a reply that is not a move, as plain one-line text, without a slide", () => {
    const rlo = String.fromCodePoint(0x202e);
    const mark = illegalMark(START, attempt(`Knight\nto ${rlo}f3!! ${"x".repeat(80)}`, "b"), 2);
    expect(mark).toMatchObject({ kind: "unreadable", side: "b" });
    expect(markSquares(mark)).toEqual([]);
    const caption = illegalCaption(en, mark as NonNullable<typeof mark>);
    expect(caption).toMatch(/^Black's reply couldn't be read as a move: “Knight to f3!! x+…”$/);
    expect(caption).not.toContain(rlo);
    expect(illegalMotion(mark as NonNullable<typeof mark>)).toMatchObject({
      kind: "unreadable",
      ms: UNREADABLE_MS,
      ghosts: [],
    });
    const empty = illegalMark(START, attempt("   ", "w"), 0) as NonNullable<
      ReturnType<typeof illegalMark>
    >;
    expect(illegalCaption(en, empty)).toBe("White's reply couldn't be read as a move");
  });

  it("captions a cut-off reply as out of space, and an unreadable one by its recorded end", () => {
    const cut: AttemptEvent = {
      ...attempt("[truncated]", "w"),
      reason: "truncated",
      reply: "Let me think about e2e4 and",
      stopReason: "output-truncated",
    };
    const mark = illegalMark(START, cut, 1);
    expect(mark).toMatchObject({ kind: "unreadable", cutOff: true });
    expect(illegalCaption(en, mark as NonNullable<typeof mark>)).toBe(
      "White's reply ran out of space before giving a move",
    );
    expect(illegalCaption(es, mark as NonNullable<typeof mark>)).toBe(
      "La respuesta de Blanco se quedó sin espacio antes de dar una jugada",
    );
    expect(illegalMotion(mark as NonNullable<typeof mark>)).toMatchObject({ kind: "unreadable" });
    // A finished reply that named no move: the caption quotes the end of what it said.
    const prose: AttemptEvent = {
      ...attempt("[unparseable]", "b"),
      reply: `…${"x".repeat(100)} so I play the knight`,
      stopReason: "completed",
    };
    const proseMark = illegalMark(START, prose, 2) as NonNullable<ReturnType<typeof illegalMark>>;
    expect(illegalCaption(en, proseMark)).toMatch(
      /^Black's reply couldn't be read as a move: “…x+ so I play the knight”$/,
    );
  });

  it("counts the attempts a long run leaves out", () => {
    expect(moreAttemptsCaption(en, 12)).toBe("+12 more illegal attempts");
    expect(moreAttemptsCaption(en, 1)).toBe("+1 more illegal attempt");
    expect(moreAttemptsCaption(es, 12)).toBe("+12 intentos ilegales más");
  });

  it("stays on the board until the side's next attempt or accepted move", () => {
    const match = game();
    const chess = new Chess();
    submitMove(match, chess, "g1e5");
    match.events.push({
      type: "timing",
      seq: match.events.length,
      at: new Date(0).toISOString(),
      side: "w",
      ply: 0,
      elapsedMs: 10,
    });
    match.events.push({
      type: "tool",
      seq: match.events.length,
      at: new Date(0).toISOString(),
      side: "w",
      ply: 0,
      name: "legal_moves",
      input: JSON.stringify({ square: "g1" }),
      output: "f3 h3",
    });
    submitMove(match, chess, "Nf3 please");
    submitMove(match, chess, "g1f3");
    const source = gameSource(match);
    expect(rejectedAt(match.events, source.fenAt, 0)).toMatchObject({ kind: "illegal", index: 0 });
    // Bookkeeping after it keeps it, and so does the side's next lookup.
    expect(rejectedAt(match.events, source.fenAt, 1)).toMatchObject({ index: 0 });
    expect(rejectedAt(match.events, source.fenAt, 2)).toMatchObject({ index: 0 });
    // The next attempt replaces it.
    expect(rejectedAt(match.events, source.fenAt, 3)).toMatchObject({
      kind: "unreadable",
      index: 3,
    });
    // The accepted move ends it.
    expect(rejectedAt(match.events, source.fenAt, 4)).toBeUndefined();
    expect(rejectedAt(match.events, source.fenAt, -1)).toBeUndefined();
    const mark = rejectedAt(match.events, source.fenAt, 0) as NonNullable<
      ReturnType<typeof rejectedAt>
    >;
    expect(boardIllegal(en, mark)).toEqual({
      index: 0,
      squares: ["g1", "e5"],
      caption: "White tried Ng1-e5: not a legal move",
    });
  });
});

describe("ghostPose", () => {
  const slide = {
    piece: { type: "p" as const, color: "w" as const },
    from: "e2" as const,
    to: "e4" as const,
    effect: "slide" as const,
  };
  it("eases a slide from its square to the target (up the board is negative y)", () => {
    expect(ghostPose(slide, 0)).toEqual({ dx: 0, dy: 0, alpha: 1 });
    expect(ghostPose(slide, 1)).toEqual({ dx: 0, dy: -2, alpha: 1 });
    expect(ghostPose(slide, 0.5).dy).toBeCloseTo(-1);
    // Ease-in: slow start.
    expect(Math.abs(ghostPose(slide, 0.1).dy)).toBeLessThan(0.2);
  });
  it("takes an illegal ghost out, shakes it on the target and brings it back", () => {
    const ghost = { ...slide, from: "g1" as const, to: "e5" as const, effect: "illegal" as const };
    expect(ghostPose(ghost, 0)).toEqual({ dx: 0, dy: 0, alpha: 1 });
    expect(ghostPose(ghost, ILLEGAL_PHASES.out)).toEqual({ dx: -2, dy: -4, alpha: 1 });
    const shaking = [0.35, 0.4, 0.45, 0.5, 0.55].map((p) => ghostPose(ghost, p).dx + 2);
    expect(Math.max(...shaking.map(Math.abs))).toBeGreaterThan(0.03);
    expect(ghostPose(ghost, ILLEGAL_PHASES.back).dy).toBe(-4);
    expect(ghostPose(ghost, 1)).toEqual({ dx: 0, dy: 0, alpha: 1 });
  });
  it("fades a captured piece out and a returning one in", () => {
    expect(ghostPose({ ...slide, effect: "fade" }, 1).alpha).toBe(0);
    expect(ghostPose({ ...slide, effect: "appear" }, 0).alpha).toBe(0);
    expect(ghostPose({ ...slide, effect: "appear" }, 1).alpha).toBe(1);
  });
});
