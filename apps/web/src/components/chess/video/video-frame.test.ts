import chessEn from "@locales/en-US/chess.json";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import type { Canvas2D } from "../board-canvas";
import { moveMotion } from "../board-motion";
import { videoFixtureGame, videoIllegalFixtureGame } from "./video-fixture";
import { drawFrame, frameLayout, motionGhosts, wrapText } from "./video-frame";
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

describe("motion frames", () => {
  const struggle = buildVideoPlan(
    videoIllegalFixtureGame(),
    defaultVideoOptions(videoIllegalFixtureGame()),
    t,
  );
  const attempt = struggle.scenes[3];
  const motion = attempt?.motion as NonNullable<NonNullable<typeof attempt>["motion"]>;

  it("poses the pieces from the frame number alone, landing on the last motion frame", () => {
    expect(motionGhosts(motion, 0)).toEqual(motionGhosts(motion, 0));
    const first = motionGhosts(motion, 0)[0];
    // g1 is file 6, row 7; the knight leaves it towards e5 (file 4, row 3).
    expect(first?.file).toBeLessThanOrEqual(6);
    expect(first?.file).toBeGreaterThan(5.5);
    const out = motionGhosts(motion, Math.round(motion.frames * 0.22) - 1)[0];
    expect(out?.file).toBeCloseTo(4, 0);
    expect(out?.row).toBeCloseTo(3, 0);
    expect(motionGhosts(motion, motion.frames - 1)[0]).toMatchObject({ file: 6, row: 7, alpha: 1 });
  });

  it("draws the red rings, the caption with the model, and hides the piece in motion", () => {
    const { ctx, texts } = recordingContext();
    const strokes: string[] = [];
    const spy = new Proxy(ctx as object, {
      get(target, key: string) {
        if (key === "strokeRect")
          return () => strokes.push(String(Reflect.get(target, "strokeStyle")));
        return Reflect.get(target, key);
      },
      set(target, key, value) {
        return Reflect.set(target, key, value);
      },
    }) as Canvas2D;
    drawFrame(spy, frameLayout("square"), attempt?.state as FrameState, motion, 3);
    expect(texts).toContain("White tried Ng1-e5: not a legal move");
    expect(texts).toContain("White · GPT-4.1 Nano");
    // Both squares ringed in red.
    expect(strokes.filter((style) => style === "#e7000b")).toHaveLength(2);
    // 32 pieces: the knight is drawn once, as the ghost, not also on g1.
    expect(texts.filter((text) => "♟♞♝♜♛♚".includes(text) && text.length === 1)).toHaveLength(32);
    const still = recordingContext();
    drawFrame(still.ctx, frameLayout("square"), attempt?.state as FrameState);
    expect(still.texts.filter((text) => "♟♞♝♜♛♚".includes(text) && text.length === 1)).toHaveLength(
      32,
    );
  });

  it("draws a lookup's dots and a counter for a long run", () => {
    const { ctx } = recordingContext();
    const arcs: number[] = [];
    const spy = new Proxy(ctx as object, {
      get(target, key: string) {
        if (key === "arc") return (_x: number, _y: number, r: number) => arcs.push(r);
        return Reflect.get(target, key);
      },
      set(target, key, value) {
        return Reflect.set(target, key, value);
      },
    }) as Canvas2D;
    drawFrame(spy, frameLayout("square"), struggle.scenes[2]?.state as FrameState);
    expect(arcs).toHaveLength(2);
    const burst = struggle.scenes.find((s) => s.state.illegal?.caption.startsWith("+13"));
    const counter = recordingContext();
    drawFrame(counter.ctx, frameLayout("landscape"), burst?.state as FrameState);
    expect(counter.texts).toContain("+13 more illegal attempts");
  });
});

describe("motion positions", () => {
  /** Records each glyph drawn with where its centre lands. */
  function glyphContext() {
    const glyphs: Array<{ text: string; cx: number; cy: number }> = [];
    const { ctx } = recordingContext();
    const spy = new Proxy(ctx as object, {
      get(target, key: string) {
        // The recording context measures every glyph as a 10×10 ink box from its origin.
        if (key === "fillText")
          return (text: string, x: number, y: number) => {
            if ("♟♞♝♜♛♚".includes(text) && text.length === 1)
              glyphs.push({ text, cx: x + 5, cy: y - 5 });
          };
        return Reflect.get(target, key);
      },
      set(target, key, value) {
        return Reflect.set(target, key, value);
      },
    }) as Canvas2D;
    return { spy, glyphs };
  }
  const layout = frameLayout("square");
  const centre = (square: string) => ({
    cx: layout.board.x + (square.charCodeAt(0) - 97 + 0.5) * layout.board.square,
    cy: layout.board.y + (8 - Number(square[1]) + 0.5) * layout.board.square,
  });

  it("slides the pawn of a promotion along its path and shows the new piece once it lands", () => {
    const before = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    const after = "Q3k3/8/8/8/8/8/8/4K3 b - - 0 1";
    const slide = moveMotion(before, "a7a8q", 0) as NonNullable<ReturnType<typeof moveMotion>>;
    const motion = { frames: 7, ghosts: slide.ghosts, hide: slide.hide };
    const state = { ...scene(2), fen: after, lastMove: "a7a8q", remark: null };
    const path = [0, 3, 6].map((frame) => {
      const { spy, glyphs } = glyphContext();
      drawFrame(spy, layout, state, motion, frame);
      return glyphs;
    });
    for (const glyphs of path) {
      // The pawn is in motion; the queen on a8 waits; the kings stay put.
      expect(glyphs.map((g) => g.text).sort()).toEqual(["♚", "♚", "♟"]);
    }
    const pawn = path.map(
      (glyphs) => glyphs.find((g) => g.text === "♟") as { cx: number; cy: number },
    );
    const a7 = centre("a7");
    const a8 = centre("a8");
    expect(pawn[0]?.cx).toBeCloseTo(a7.cx);
    expect(pawn[0]?.cy).toBeLessThan(a7.cy);
    expect(pawn[0]?.cy).toBeGreaterThan(pawn[1]?.cy ?? 0);
    expect(pawn[2]).toMatchObject({ cx: expect.closeTo(a8.cx), cy: expect.closeTo(a8.cy) });
    // The still frame: the queen on a8, no pawn.
    const { spy, glyphs } = glyphContext();
    drawFrame(spy, layout, state);
    expect(glyphs.find((g) => g.text === "♛")).toMatchObject({
      cx: expect.closeTo(a8.cx),
      cy: expect.closeTo(a8.cy),
    });
    expect(glyphs.some((g) => g.text === "♟")).toBe(false);
  });

  it("takes an illegal knight to the square it tried and back to its own", () => {
    const struggle = buildVideoPlan(
      videoIllegalFixtureGame(),
      defaultVideoOptions(videoIllegalFixtureGame()),
      t,
    );
    const attempt = struggle.scenes[3] as NonNullable<(typeof struggle.scenes)[number]>;
    const motion = attempt.motion as NonNullable<typeof attempt.motion>;
    const knightAt = (frame: number) => {
      const { spy, glyphs } = glyphContext();
      drawFrame(spy, layout, attempt.state, motion, frame);
      // The ghost is drawn last, over the board.
      return glyphs.at(-1);
    };
    const out = knightAt(Math.round(motion.frames * 0.26));
    expect(out).toMatchObject({ text: "♞" });
    expect(Math.abs((out?.cx ?? 0) - centre("e5").cx)).toBeLessThan(layout.board.square * 0.12);
    expect(out?.cy).toBeCloseTo(centre("e5").cy);
    expect(knightAt(motion.frames - 1)).toMatchObject({
      cx: expect.closeTo(centre("g1").cx),
      cy: expect.closeTo(centre("g1").cy),
    });
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
