import { createMatch } from "@cockpit-chess/chess";
import { gamePositions } from "@cockpit-chess/chess/spectator";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { BOARD_COLORS } from "./board-canvas";
import { fixtureGame } from "./fixture-game";
import { recordPieces } from "./piece-recorder.test-support";
import { BOARD, drawShareCard, lastIllegalSquares } from "./share-card";

let t: TFunction<"chess">;
beforeAll(async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en-US", resources: { "en-US": { chess: enChess } }, defaultNS: "chess" });
  t = i18n.getFixedT("en-US", "chess");
});

/** A fake 2D context that records text and rects. */
function recordingContext() {
  const ink = {
    actualBoundingBoxLeft: 0,
    actualBoundingBoxRight: 10,
    actualBoundingBoxAscent: 10,
    actualBoundingBoxDescent: 0,
  };
  const texts: Array<{ text: string; x: number; y: number; fill: string }> = [];
  const rects: Array<{ x: number; y: number; w: number; h: number; fill: string }> = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, fill: String(this.fillStyle) });
    },
    strokeRect() {},
    stroke() {},
    fill() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, fill: String(this.fillStyle) });
    },
    measureText(text: string) {
      return { width: text.length * 12, ...ink };
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, rects };
}

describe("drawShareCard", () => {
  it("draws every piece from its outline, centred on its square, light for White and dark for Black", () => {
    const { ctx, texts } = recordingContext();
    const { spy, pieces } = recordPieces(ctx);
    const match = createMatch({
      white: { name: "W", model: "w", protocol: "random" },
      black: { name: "B", model: "b", protocol: "random" },
      rules: {},
    });
    drawShareCard(spy, match, t, null);
    expect(pieces).toHaveLength(32);
    expect(new Set(pieces.map((piece) => piece.type)).size).toBe(6);
    for (const piece of pieces) {
      expect(piece.width).toBe(BOARD.square);
      expect(piece.height).toBe(BOARD.square);
      const file = (piece.cx - BOARD.x - BOARD.square / 2) / BOARD.square;
      const rank = (piece.cy - BOARD.y - BOARD.square / 2) / BOARD.square;
      expect(Number.isInteger(file) && file >= 0 && file < 8).toBe(true);
      expect(Number.isInteger(rank) && [0, 1, 6, 7].includes(rank)).toBe(true);
      // Rows 6 and 7 (ranks 2 and 1) are White's, pawns included.
      expect(piece.fill).toBe(rank >= 6 ? BOARD_COLORS.whitePiece : BOARD_COLORS.ink);
    }
    // No piece comes from a font glyph, so no platform can swap in an emoji.
    expect(texts.some((entry) => /[\u2654-\u265F]/u.test(entry.text))).toBe(false);
  });
  it("says who played which colour, shows the id only when it differs, and draws the final eval", () => {
    const { ctx, texts, rects } = recordingContext();
    drawShareCard(ctx, fixtureGame(), t, "https://chess.example/?game=x");
    const lines = texts.map((entry) => entry.text);
    expect(lines).toContain("White · GPT-4.1 Nano");
    expect(lines).toContain("openai/gpt-4.1-nano");
    expect(lines).toContain("Black · openai/gpt-4.1-mini");
    expect(lines.filter((line) => line === "openai/gpt-4.1-mini")).toHaveLength(0);
    expect(lines).toContain("OpenAI Chat Completions / OpenAI Chat Completions");
    expect(lines).toContain("M2");
    // The bar's White fill spans the whole board height on a White mate.
    expect(rects).toContainEqual(
      expect.objectContaining({ x: BOARD.x - 30, y: BOARD.y, w: 18, h: BOARD.square * 8 }),
    );
  });
  it("draws no eval bar when only an earlier position was evaluated", () => {
    const { ctx, rects, texts } = recordingContext();
    const match = fixtureGame();
    // Drop the final position's own evaluation: the last one left is of the position before.
    match.events.pop();
    drawShareCard(ctx, match, t, null);
    expect(rects.some((rect) => rect.x === BOARD.x - 30)).toBe(false);
    expect(texts.map((entry) => entry.text)).not.toContain("+1.8");
  });
  it("draws no eval bar without evaluations", () => {
    const { ctx, rects } = recordingContext();
    drawShareCard(ctx, fixtureGame({ evaluations: false }), t, null);
    expect(rects.some((rect) => rect.x === BOARD.x - 30)).toBe(false);
  });
  it("draws the spectators' score of the final position, and never a stale one", () => {
    const match = fixtureGame({ evaluations: false });
    const positions = gamePositions(match);
    const final = positions.at(-1) as string;
    const score = (fen: string) => ({
      engine: "stockfish-19-lite-single" as const,
      fen,
      depth: 9,
      nodes: 10000,
      cp: 250,
      mate: null,
      bestMove: null,
    });
    const scored = recordingContext();
    drawShareCard(scored.ctx, match, t, null, { [String(positions.length - 1)]: score(final) });
    expect(scored.texts.map((entry) => entry.text)).toContain("+2.5");
    expect(scored.rects.some((rect) => rect.x === BOARD.x - 30)).toBe(true);
    // A spectator score of another position is not this one's.
    const stale = recordingContext();
    drawShareCard(stale.ctx, match, t, null, {
      [String(positions.length - 1)]: score("8/8/8/8/8/8/8/K6k w - - 0 1"),
    });
    expect(stale.rects.some((rect) => rect.x === BOARD.x - 30)).toBe(false);
    // Spectator scores win over the archive's own for the same position.
    const both = recordingContext();
    const evaluated = fixtureGame();
    const last = gamePositions(evaluated).length - 1;
    drawShareCard(both.ctx, evaluated, t, null, {
      [String(last)]: score(gamePositions(evaluated)[last] as string),
    });
    expect(both.texts.map((entry) => entry.text)).toContain("+2.5");
    expect(both.texts.map((entry) => entry.text)).not.toContain("M2");
  });
});

describe("lastIllegalSquares", () => {
  it("finds the game's last rejected attempt with squares, for the optional outline", () => {
    // The fixture's Black tried a1-a8 with no piece of its own on a1.
    expect(lastIllegalSquares(fixtureGame())).toEqual(["a1"]);
    expect(
      lastIllegalSquares(
        createMatch(
          {
            white: { name: "W", model: "w", protocol: "random" },
            black: { name: "B", model: "b", protocol: "random" },
            rules: {},
          },
          "hosted",
        ),
      ),
    ).toEqual([]);
  });
});
