import { createMatch } from "@cockpit-chess/chess";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { glyphOrigin } from "./board-canvas";
import { fixtureGame } from "./fixture-game";
import { BOARD, drawShareCard } from "./share-card";

let t: TFunction<"chess">;
beforeAll(async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en-US", resources: { "en-US": { chess: enChess } }, defaultNS: "chess" });
  t = i18n.getFixedT("en-US", "chess");
});

const PIECES = new Set(["♟", "♞", "♝", "♜", "♛", "♚"]);
/**
 * A fake 2D context that records text and rects. Its glyph ink box is
 * deliberately off-centre in the advance box (as real chess glyphs are), so a
 * naive `fillText(glyph, x + 4, y + 40)` would fail the centring assertions.
 */
function recordingContext() {
  const ink = {
    actualBoundingBoxLeft: -3,
    actualBoundingBoxRight: 31,
    actualBoundingBoxAscent: 33,
    actualBoundingBoxDescent: 2,
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
    strokeText() {},
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, fill: String(this.fillStyle) });
    },
    measureText(text: string) {
      return { width: text.length * 12, ...ink };
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, rects, ink };
}

describe("glyphOrigin", () => {
  it("centres the measured ink box on the point", () => {
    const metrics = {
      actualBoundingBoxLeft: 2,
      actualBoundingBoxRight: 20,
      actualBoundingBoxAscent: 30,
      actualBoundingBoxDescent: 4,
    };
    const { x, y } = glyphOrigin(metrics, 100, 200);
    expect((x - metrics.actualBoundingBoxLeft + x + metrics.actualBoundingBoxRight) / 2).toBe(100);
    expect((y - metrics.actualBoundingBoxAscent + y + metrics.actualBoundingBoxDescent) / 2).toBe(
      200,
    );
  });
});

describe("drawShareCard", () => {
  it("centres every piece, of both colours and all types, on its square", () => {
    const { ctx, texts, ink } = recordingContext();
    const match = createMatch({
      white: { name: "W", model: "w", protocol: "random" },
      black: { name: "B", model: "b", protocol: "random" },
      rules: {},
    });
    drawShareCard(ctx, match, t, null);
    const pieces = texts.filter((entry) => PIECES.has(entry.text));
    expect(pieces).toHaveLength(32);
    expect(new Set(pieces.map((entry) => entry.text)).size).toBe(6);
    expect(new Set(pieces.map((entry) => entry.fill)).size).toBe(2);
    for (const piece of pieces) {
      const centreX = piece.x + (ink.actualBoundingBoxRight - ink.actualBoundingBoxLeft) / 2;
      const centreY = piece.y + (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) / 2;
      const file = (centreX - BOARD.x - BOARD.square / 2) / BOARD.square;
      const rank = (centreY - BOARD.y - BOARD.square / 2) / BOARD.square;
      expect(Number.isInteger(file) && file >= 0 && file < 8).toBe(true);
      expect(Number.isInteger(rank) && [0, 1, 6, 7].includes(rank)).toBe(true);
    }
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
});
