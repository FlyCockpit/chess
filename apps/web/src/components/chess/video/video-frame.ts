import type { Color } from "@cockpit-chess/chess";
import {
  BOARD_COLORS,
  type Canvas2D,
  type CanvasGhost,
  drawBoard,
  MARK_COLORS,
} from "../board-canvas";
import { ghostPose } from "../board-motion";
import type { FrameState, SceneMotion, VideoAspect } from "./video-plan";

/**
 * Draws one video frame. The only drawing seam the encoder worker uses; it runs
 * on an OffscreenCanvas, so it must not touch the DOM. The board itself is the
 * shared renderer in ../board-canvas.ts (the same one as the PNG share card). Every string in
 * `state` is drawn with fillText, which never interprets markup.
 */

const BACKGROUND = "#101b1a";
const ACCENT = "#a2e5b4";
const PAPER = "#f2f1e8";
const MUTED = "#bbc9c1";
const INK = BOARD_COLORS.ink;
const SANS = "'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif";
const MONO = "'SFMono-Regular', Menlo, 'DejaVu Sans Mono', monospace";

type Rect = { x: number; y: number; width: number; height: number };
export type FrameLayout = {
  width: number;
  height: number;
  board: { x: number; y: number; square: number };
  bar: Rect;
  brand: { x: number; y: number };
  title: Rect & { size: number; lines: number };
  moveLabel: { x: number; y: number; size: number; align: CanvasTextAlign };
  players: Record<Color, Rect>;
  bubble: Rect & { size: number; lines: number };
};

export function frameLayout(aspect: VideoAspect): FrameLayout {
  if (aspect === "landscape") {
    const square = 112;
    const board = { x: 176, y: 92, square };
    return {
      width: 1920,
      height: 1080,
      board,
      bar: { x: 128, y: board.y, width: 32, height: square * 8 },
      brand: { x: 1140, y: 132 },
      title: { x: 1140, y: 196, width: 700, height: 128, size: 52, lines: 2 },
      moveLabel: { x: 1140, y: 560, size: 44, align: "left" },
      players: {
        b: { x: 1140, y: 340, width: 700, height: 64 },
        w: { x: 1140, y: 420, width: 700, height: 64 },
      },
      bubble: { x: 1140, y: 610, width: 700, height: 290, size: 34, lines: 6 },
    };
  }
  const square = 86;
  const board = { x: 220, y: 182, square };
  return {
    width: 1080,
    height: 1080,
    board,
    bar: { x: 174, y: board.y, width: 32, height: square * 8 },
    brand: { x: 48, y: 44 },
    title: { x: 48, y: 96, width: 700, height: 52, size: 44, lines: 1 },
    moveLabel: { x: 1032, y: 96, size: 36, align: "right" },
    players: {
      b: { x: 174, y: 116, width: 734, height: 56 },
      w: { x: 174, y: 882, width: 734, height: 56 },
    },
    bubble: { x: 48, y: 948, width: 984, height: 120, size: 28, lines: 2 },
  };
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** User-perceived characters, so a split never cuts an emoji or a combining mark. */
function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

/**
 * Greedy word wrap with an ellipsis on the last line; overlong words are split
 * between graphemes. Linear in the text length times the measure cost.
 */
export function wrapText(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter(Boolean)) {
    if (lines.length > maxLines) break;
    if (measure(word) > maxWidth) {
      if (line) lines.push(line);
      line = "";
      for (const grapheme of graphemes(word)) {
        // One grapheme can still be wider than the line (a long joined emoji
        // sequence that renders as several glyphs): it becomes an ellipsis.
        const piece = measure(grapheme) > maxWidth ? "…" : grapheme;
        if (line && measure(line + piece) > maxWidth) {
          lines.push(line);
          line = "";
          if (lines.length > maxLines) break;
        }
        line += piece;
      }
      continue;
    }
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= maxWidth) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = graphemes(kept[maxLines - 1] ?? "");
  while (last.length > 0 && measure(`${last.join("")}…`) > maxWidth) last.pop();
  kept[maxLines - 1] = `${last.join("").trimEnd()}…`;
  return kept;
}

function fitLine(ctx: Canvas2D, text: string, maxWidth: number): string {
  return wrapText((s) => ctx.measureText(s).width, text, maxWidth, 1)[0] ?? "";
}

function drawEvalBar(ctx: Canvas2D, bar: Rect, evaluation: FrameState["evaluation"]) {
  if (!evaluation) {
    // Unknown, not even: a neutral grey bar with no fill and no number.
    ctx.fillStyle = "#4a524f";
    ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
    return;
  }
  ctx.fillStyle = "#2b2f2e";
  ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
  const white = Math.round(bar.height * evaluation.share);
  ctx.fillStyle = PAPER;
  ctx.fillRect(bar.x, bar.y + bar.height - white, bar.width, white);
  const whiteAhead = evaluation.share >= 0.5;
  ctx.font = `bold 13px ${SANS}`;
  ctx.textAlign = "center";
  ctx.fillStyle = whiteAhead ? INK : PAPER;
  ctx.fillText(
    evaluation.label,
    bar.x + bar.width / 2,
    whiteAhead ? bar.y + bar.height - 8 : bar.y + 18,
    bar.width - 2,
  );
  ctx.textAlign = "left";
}

function drawPlayer(ctx: Canvas2D, rect: Rect, side: Color, state: FrameState) {
  const line = state.players[side];
  const active = state.toMove === side;
  const mid = rect.y + rect.height / 2;
  if (active) {
    ctx.fillStyle = "rgba(162, 229, 180, 0.14)";
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.fillStyle = ACCENT;
    ctx.fillRect(rect.x, rect.y, 6, rect.height);
  }
  if (state.illegal?.flash === side) {
    // A reply that could not be read as a move: the side's row in red.
    ctx.fillStyle = "rgba(231, 0, 11, 0.22)";
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = MARK_COLORS.illegal;
    ctx.lineWidth = 4;
    ctx.strokeRect(rect.x + 2, rect.y + 2, rect.width - 4, rect.height - 4);
  }
  const swatch = Math.round(rect.height * 0.46);
  ctx.fillStyle = side === "w" ? PAPER : INK;
  ctx.strokeStyle = side === "w" ? INK : MUTED;
  ctx.lineWidth = 2;
  ctx.fillRect(rect.x + 18, mid - swatch / 2, swatch, swatch);
  ctx.strokeRect(rect.x + 18, mid - swatch / 2, swatch, swatch);
  ctx.textBaseline = "middle";
  let clockWidth = 0;
  if (line.clock) {
    ctx.font = `bold ${Math.round(rect.height * 0.5)}px ${MONO}`;
    ctx.textAlign = "right";
    ctx.fillStyle = active ? ACCENT : MUTED;
    ctx.fillText(line.clock, rect.x + rect.width - 16, mid);
    clockWidth = ctx.measureText(line.clock).width + 32;
    ctx.textAlign = "left";
  }
  ctx.font = `bold ${Math.round(rect.height * 0.46)}px ${SANS}`;
  ctx.fillStyle = PAPER;
  const textX = rect.x + 18 + swatch + 16;
  ctx.fillText(fitLine(ctx, line.label, rect.x + rect.width - clockWidth - textX), textX, mid);
  ctx.textBaseline = "alphabetic";
}

/** Draws inside `rect` only, so no text can spill out of its box. */
function clipped(ctx: Canvas2D, rect: Rect, draw: () => void) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  draw();
  ctx.restore();
}

function roundRect(ctx: Canvas2D, rect: Rect, radius: number) {
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
}

function drawRemark(ctx: Canvas2D, layout: FrameLayout, remark: NonNullable<FrameState["remark"]>) {
  const { bubble } = layout;
  const pad = 22;
  const headerSize = Math.round(bubble.size * 0.62);
  const lineHeight = bubble.size * 1.2;
  const top = bubble.y + 12 + headerSize * 1.3;
  ctx.font = `${bubble.size}px ${SANS}`;
  const room = Math.max(1, Math.floor((bubble.y + bubble.height - 12 - top) / lineHeight));
  const lines = wrapText(
    (s) => ctx.measureText(s).width,
    `“${remark.text}”`,
    bubble.width - pad * 2,
    Math.min(bubble.lines, room),
  );
  // The bubble fits its text, up to the layout's box.
  const height = Math.min(bubble.height, top - bubble.y + lines.length * lineHeight + 12);
  ctx.fillStyle = remark.side === "w" ? PAPER : "#22302c";
  roundRect(ctx, { ...bubble, height }, 18);
  ctx.fill();
  ctx.strokeStyle = remark.side === "w" ? INK : MUTED;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.textBaseline = "top";
  ctx.font = `bold ${headerSize}px ${SANS}`;
  ctx.fillStyle = remark.side === "w" ? "#3e5a4b" : ACCENT;
  ctx.fillText(fitLine(ctx, remark.speaker, bubble.width - pad * 2), bubble.x + pad, bubble.y + 12);
  ctx.font = `${bubble.size}px ${SANS}`;
  ctx.fillStyle = remark.side === "w" ? INK : PAPER;
  clipped(ctx, { ...bubble, height }, () => {
    lines.forEach((text, i) => {
      ctx.fillText(text, bubble.x + pad, top + i * lineHeight);
    });
  });
  ctx.textBaseline = "alphabetic";
}

/** A rejected attempt's caption, in the remark area: who tried it, and what. */
function drawIllegal(
  ctx: Canvas2D,
  layout: FrameLayout,
  illegal: NonNullable<FrameState["illegal"]>,
) {
  const { bubble } = layout;
  const pad = 22;
  const headerSize = Math.round(bubble.size * 0.62);
  const lineHeight = bubble.size * 1.2;
  const top = bubble.y + 12 + headerSize * 1.3;
  ctx.font = `bold ${bubble.size}px ${SANS}`;
  const room = Math.max(1, Math.floor((bubble.y + bubble.height - 12 - top) / lineHeight));
  const lines = wrapText(
    (s) => ctx.measureText(s).width,
    illegal.caption,
    bubble.width - pad * 2,
    Math.min(bubble.lines, room),
  );
  const height = Math.min(bubble.height, top - bubble.y + lines.length * lineHeight + 12);
  ctx.fillStyle = "#3a0d10";
  roundRect(ctx, { ...bubble, height }, 18);
  ctx.fill();
  ctx.strokeStyle = MARK_COLORS.illegal;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.textBaseline = "top";
  ctx.font = `bold ${headerSize}px ${SANS}`;
  ctx.fillStyle = "#ff9b93";
  ctx.fillText(
    fitLine(ctx, illegal.speaker, bubble.width - pad * 2),
    bubble.x + pad,
    bubble.y + 12,
  );
  ctx.font = `bold ${bubble.size}px ${SANS}`;
  ctx.fillStyle = PAPER;
  clipped(ctx, { ...bubble, height }, () => {
    lines.forEach((text, i) => {
      ctx.fillText(text, bubble.x + pad, top + i * lineHeight);
    });
  });
  ctx.textBaseline = "alphabetic";
}

/** The pieces in motion `frame` frames into a scene (0-based), from the plan alone. */
export function motionGhosts(motion: SceneMotion, frame: number): CanvasGhost[] {
  // The last motion frame lands exactly on the end pose.
  const progress = Math.min(1, (frame + 1) / motion.frames);
  return motion.ghosts.map((ghost) => {
    const pose = ghostPose(ghost, progress);
    return {
      piece: ghost.piece,
      file: ghost.from.charCodeAt(0) - 97 + pose.dx,
      row: 8 - Number(ghost.from[1]) + pose.dy,
      alpha: pose.alpha,
    };
  });
}

/** The result, in the remark area, so the final position stays fully visible. */
function drawBanner(ctx: Canvas2D, layout: FrameLayout, banner: NonNullable<FrameState["banner"]>) {
  const rect = layout.bubble;
  const pad = 22;
  const headlineSize = Math.round(rect.size * 1.4);
  const detailSize = Math.round(rect.size * 0.85);
  const width = rect.width - pad * 2;
  const measure = (s: string) => ctx.measureText(s).width;
  ctx.font = `bold ${headlineSize}px ${SANS}`;
  let headline = wrapText(measure, banner.headline, width, 2);
  ctx.font = `${detailSize}px ${SANS}`;
  let detail = wrapText(measure, banner.detail, width, 2);
  const height = () =>
    headline.length * headlineSize * 1.15 + 8 + detail.length * detailSize * 1.25;
  const room = rect.height - 24;
  if (height() > room) {
    ctx.font = `${detailSize}px ${SANS}`;
    detail = wrapText(measure, banner.detail, width, 1);
  }
  if (height() > room) {
    ctx.font = `bold ${headlineSize}px ${SANS}`;
    headline = wrapText(measure, banner.headline, width, 1);
  }
  const box = { ...rect, height: Math.min(rect.height, height() + 24) };
  ctx.fillStyle = "#16302a";
  roundRect(ctx, box, 18);
  ctx.fill();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.textBaseline = "top";
  clipped(ctx, box, () => {
    let y = box.y + 12;
    ctx.font = `bold ${headlineSize}px ${SANS}`;
    ctx.fillStyle = ACCENT;
    for (const text of headline) {
      ctx.fillText(text, box.x + pad, y);
      y += headlineSize * 1.15;
    }
    y += 8;
    ctx.font = `${detailSize}px ${SANS}`;
    ctx.fillStyle = PAPER;
    for (const text of detail) {
      ctx.fillText(text, box.x + pad, y);
      y += detailSize * 1.25;
    }
  });
  ctx.textBaseline = "alphabetic";
}

function drawTitleCard(ctx: Canvas2D, layout: FrameLayout, state: FrameState) {
  const card = state.titleCard;
  if (!card) return;
  const cx = layout.width / 2;
  const maxWidth = layout.width - 160;
  ctx.save();
  ctx.beginPath();
  ctx.rect(80, 0, maxWidth, layout.height);
  ctx.clip();
  ctx.textAlign = "center";
  ctx.fillStyle = ACCENT;
  ctx.font = `bold 30px ${SANS}`;
  ctx.fillText(state.brand, cx, layout.height * 0.24);
  ctx.fillStyle = PAPER;
  ctx.font = `bold 72px ${SANS}`;
  const title = wrapText((s) => ctx.measureText(s).width, state.title, maxWidth, 3);
  let y = layout.height * 0.36;
  for (const text of title) {
    ctx.fillText(text, cx, y);
    y += 84;
  }
  y += 40;
  ctx.font = `bold 44px ${SANS}`;
  ctx.fillText(fitLine(ctx, card.white, maxWidth), cx, y);
  ctx.fillStyle = MUTED;
  ctx.font = `32px ${SANS}`;
  ctx.fillText(card.versus, cx, y + 60);
  ctx.fillStyle = PAPER;
  ctx.font = `bold 44px ${SANS}`;
  ctx.fillText(fitLine(ctx, card.black, maxWidth), cx, y + 124);
  ctx.fillStyle = MUTED;
  ctx.font = `26px ${SANS}`;
  ctx.fillText(fitLine(ctx, card.rules, maxWidth), cx, y + 190);
  ctx.textAlign = "left";
  ctx.restore();
}

/**
 * One frame. `motion` and `frame` draw a scene's pieces in motion (frame < motion.frames);
 * without them the scene's still picture.
 */
export function drawFrame(
  ctx: Canvas2D,
  layout: FrameLayout,
  state: FrameState,
  motion?: SceneMotion,
  frame = 0,
) {
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, 0, layout.width, 8);
  if (state.kind === "title") {
    drawTitleCard(ctx, layout, state);
    return;
  }
  ctx.font = `bold 22px ${SANS}`;
  ctx.fillStyle = ACCENT;
  ctx.fillText(state.brand, layout.brand.x, layout.brand.y);
  const { title } = layout;
  ctx.font = `bold ${title.size}px ${SANS}`;
  ctx.fillStyle = PAPER;
  const titleLines = wrapText(
    (s) => ctx.measureText(s).width,
    state.title,
    title.width,
    title.lines,
  );
  const titleBox = {
    x: title.x,
    y: title.y - title.size * 1.1,
    width: title.width,
    height: title.size * (1.15 * title.lines + 0.35),
  };
  clipped(ctx, titleBox, () => {
    titleLines.forEach((text, i) => {
      ctx.fillText(text, title.x, title.y + i * title.size * 1.15);
    });
  });
  if (state.moveLabel) {
    const { moveLabel } = layout;
    ctx.font = `bold ${moveLabel.size}px ${MONO}`;
    ctx.fillStyle = ACCENT;
    ctx.textAlign = moveLabel.align;
    ctx.fillText(state.moveLabel, moveLabel.x, moveLabel.y);
    ctx.textAlign = "left";
  }
  drawPlayer(ctx, layout.players.b, "b", state);
  drawPlayer(ctx, layout.players.w, "w", state);
  if (state.showEvalBar) drawEvalBar(ctx, layout.bar, state.evaluation);
  const moving = motion && frame < motion.frames;
  drawBoard(ctx, state.fen, layout.board, {
    lastMove: state.lastMove,
    coordinates: true,
    lookup: state.lookup,
    outline: state.illegal?.squares ?? [],
    hide: moving ? motion.hide : [],
    ghosts: moving ? motionGhosts(motion, frame) : [],
  });
  if (state.remark) drawRemark(ctx, layout, state.remark);
  if (state.illegal) drawIllegal(ctx, layout, state.illegal);
  if (state.banner) drawBanner(ctx, layout, state.banner);
}
