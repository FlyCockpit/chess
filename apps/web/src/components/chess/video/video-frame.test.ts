import chessEn from "@locales/en-US/chess.json";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import type { Canvas2D } from "../board-canvas";
import { videoFixtureGame } from "./video-fixture";
import { drawFrame, frameLayout, wrapText } from "./video-frame";
import { buildVideoPlan, defaultVideoOptions, type FrameState } from "./video-plan";

const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { chess: chessEn } },
  interpolation: { escapeValue: false },
});
const t = i18n.getFixedT("en", "chess") as unknown as (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** Records fillText calls; measures 10 px per character. */
function recordingContext() {
  const texts: string[] = [];
  const rects: Array<[number, number, number, number, string]> = [];
  const state: Record<string, unknown> = { fillStyle: "" };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key === "fillText") return (text: string) => texts.push(text);
      if (key === "fillRect")
        return (x: number, y: number, w: number, h: number) =>
          rects.push([x, y, w, h, String(target.fillStyle)]);
      if (key === "measureText")
        return (text: string) => ({
          width: text.length * 10,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: 10,
          actualBoundingBoxAscent: 10,
          actualBoundingBoxDescent: 0,
        });
      if (key in target) return target[key];
      return () => undefined;
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as Canvas2D;
  return { ctx, texts, rects };
}

const plan = buildVideoPlan(videoFixtureGame(), defaultVideoOptions(videoFixtureGame()), t);
const scene = (i: number) => plan.scenes[i]?.state as FrameState;

describe("drawFrame", () => {
  it("clips every wrapped text block to its box", () => {
    const { ctx } = recordingContext();
    const calls: string[] = [];
    const spy = new Proxy(ctx as object, {
      get(target, key: string) {
        if (key === "clip" || key === "save" || key === "restore") return () => calls.push(key);
        return Reflect.get(target, key);
      },
      set(target, key, value) {
        return Reflect.set(target, key, value);
      },
    }) as Canvas2D;
    drawFrame(spy, frameLayout("square"), scene(2));
    // Title and remark; each clip sits between a save and a restore.
    expect(calls).toEqual(["save", "clip", "restore", "save", "clip", "restore"]);
    calls.length = 0;
    drawFrame(spy, frameLayout("square"), scene(plan.scenes.length - 1));
    expect(calls).toEqual(["save", "clip", "restore", "save", "clip", "restore"]);
    calls.length = 0;
    drawFrame(spy, frameLayout("square"), scene(0));
    expect(calls).toEqual(["save", "clip", "restore"]);
  });

  it("draws the title, both players with clocks, the move and the remark as plain text", () => {
    const { ctx, texts } = recordingContext();
    drawFrame(ctx, frameLayout("landscape"), scene(2));
    expect(texts).toContain("Fixture: Scholar's mate");
    expect(texts).toContain("White · GPT-4.1 Nano");
    expect(texts).toContain("Black · GPT-4.1 Mini");
    expect(texts).toContain("1:56");
    expect(texts).toContain("1. e4");
    expect(texts.join(" ")).toContain("“Center first. <b>Obviously</b>.”");
    expect(texts).toContain("+0.3");
  });

  it("draws all 32 pieces centred on their squares", () => {
    const { ctx, texts } = recordingContext();
    drawFrame(ctx, frameLayout("square"), scene(1));
    expect(texts.filter((text) => "♟♞♝♜♛♚".includes(text) && text.length === 1)).toHaveLength(32);
  });

  it("highlights the last move's squares", () => {
    const { ctx, rects } = recordingContext();
    drawFrame(ctx, frameLayout("square"), scene(2));
    const { x, y, square } = frameLayout("square").board;
    const highlighted = rects.filter((r) => r[4].startsWith("rgba(246"));
    // e2 and e4: file e = 4, ranks 2 and 4 → rows 6 and 4.
    expect(highlighted.map((r) => [r[0], r[1]])).toEqual([
      [x + 4 * square, y + 4 * square],
      [x + 4 * square, y + 6 * square],
    ]);
  });

  it("ends with the result banner and no remark", () => {
    const { ctx, texts } = recordingContext();
    drawFrame(ctx, frameLayout("square"), scene(plan.scenes.length - 1));
    expect(texts).toContain("Checkmate: White wins");
    expect(texts.join(" ")).not.toContain("Good game");
  });

  it("draws the title card", () => {
    const { ctx, texts } = recordingContext();
    drawFrame(ctx, frameLayout("square"), scene(0));
    expect(texts).toEqual(
      expect.arrayContaining([
        "COCKPIT CHESS",
        "White · GPT-4.1 Nano",
        "vs",
        "Black · GPT-4.1 Mini",
      ]),
    );
  });
});

describe("text helpers", () => {
  const measure = (text: string) => text.length * 10;
  it("wraps words and ellipsizes the last allowed line", () => {
    expect(wrapText(measure, "aa bb cc dd", 50, 3)).toEqual(["aa bb", "cc dd"]);
    expect(wrapText(measure, "aa bb cc dd ee ff", 50, 2)).toEqual(["aa bb", "cc d…"]);
  });
  it("splits a word longer than the line", () => {
    expect(wrapText(measure, "abcdefghij", 40, 5)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("never splits an emoji or a joined sequence", () => {
    const coder = "\u{1F469}\u200d\u{1F4BB}";
    const perGrapheme = (text: string) => [...new Intl.Segmenter().segment(text)].length * 10;
    expect(wrapText(perGrapheme, coder.repeat(5), 20, 5)).toEqual([
      coder.repeat(2),
      coder.repeat(2),
      coder,
    ]);
    expect(wrapText(perGrapheme, `${coder.repeat(3)} x`, 20, 1)).toEqual([`${coder}…`]);
  });
  it("replaces a single grapheme wider than the line with an ellipsis", () => {
    const family = ["\u{1F468}", "\u{1F469}", "\u{1F467}", "\u{1F466}"].join("\u200d");
    // Measured as 4 glyphs wide each, wider than the 30 px line.
    const wide = (text: string) =>
      [...new Intl.Segmenter().segment(text)].reduce(
        (n, g) => n + (g.segment === family ? 40 : 10),
        0,
      );
    expect(wrapText(wide, `${family}${family} ok`, 30, 3)).toEqual(["……", "ok"]);
    for (const line of wrapText(wide, family.repeat(6), 30, 2)) {
      expect(wide(line)).toBeLessThanOrEqual(30);
    }
  });
  it("stays bounded on a 500-character word", () => {
    const lines = wrapText(measure, "x".repeat(500), 50, 2);
    expect(lines).toEqual(["xxxxx", "xxxx…"]);
  });
});
