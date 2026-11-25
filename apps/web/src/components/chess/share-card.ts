import { boardAt, type MatchArchive, matchStats } from "@cockpit-chess/chess";
import type { TFunction } from "i18next";
import { evaluationSeries, pointForPosition, shortScore } from "./evaluation";

/** The share graphic: 1200×675, fixed colours (it is an image, not themed UI). */
export const SHARE_WIDTH = 1200;
export const SHARE_HEIGHT = 675;
export const BOARD = { x: 735, y: 150, square: 50 } as const;
const GLYPHS = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" } as const;
const INK = "#182520";
const PAPER = "#f2f1e8";

type GlyphMetrics = Pick<
  TextMetrics,
  | "actualBoundingBoxLeft"
  | "actualBoundingBoxRight"
  | "actualBoundingBoxAscent"
  | "actualBoundingBoxDescent"
>;

/**
 * Where to draw a glyph (textAlign "left", textBaseline "alphabetic") so its
 * ink box is centred on (cx, cy). Chess glyphs sit off-centre in their advance
 * box and differ by font, so the measured ink box is the only reliable centre.
 */
export function glyphOrigin(metrics: GlyphMetrics, cx: number, cy: number) {
  return {
    x: cx - (metrics.actualBoundingBoxRight - metrics.actualBoundingBoxLeft) / 2,
    y: cy + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2,
  };
}

const PROTOCOLS = new Set(["openai-chat", "openai-responses", "anthropic"]);

/** Draws the whole card. `replayUrl` is null for a private draft. */
export function drawShareCard(
  ctx: CanvasRenderingContext2D,
  match: MatchArchive,
  t: TFunction<"chess">,
  replayUrl: string | null,
) {
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#101b1a";
  ctx.fillRect(0, 0, SHARE_WIDTH, SHARE_HEIGHT);
  ctx.fillStyle = "#a2e5b4";
  ctx.fillRect(0, 0, SHARE_WIDTH, 8);
  ctx.font = "bold 22px sans-serif";
  ctx.fillText(t("brand").toUpperCase(), 56, 65);
  ctx.fillStyle = PAPER;
  ctx.font = "bold 44px sans-serif";
  let titleLine = "";
  let titleY = 130;
  for (const word of match.config.title.split(/\s+/)) {
    if (ctx.measureText(`${titleLine} ${word}`).width > 620 && titleLine) {
      ctx.fillText(titleLine, 56, titleY, 620);
      titleY += 48;
      titleLine = "";
      if (titleY > 178) break;
    }
    titleLine = titleLine ? `${titleLine} ${word}` : word;
  }
  if (titleY <= 178) ctx.fillText(titleLine, 56, titleY, 620);

  // Who played which colour: a swatch, the colour, the name, and the id when it differs.
  const players = [
    { side: "w" as const, player: match.config.white, y: 226 },
    { side: "b" as const, player: match.config.black, y: 282 },
  ];
  for (const { side, player, y } of players) {
    ctx.fillStyle = side === "w" ? PAPER : INK;
    ctx.strokeStyle = side === "w" ? INK : "#bbc9c1";
    ctx.lineWidth = 2;
    ctx.fillRect(56, y - 20, 22, 22);
    ctx.strokeRect(56, y - 20, 22, 22);
    ctx.fillStyle = PAPER;
    ctx.font = "bold 24px sans-serif";
    const label = `${t(`colors.${side}`)} · ${player.name}`;
    ctx.fillText(label, 90, y, 586);
    if (player.model && player.model !== player.name) {
      ctx.fillStyle = "#bbc9c1";
      ctx.font = "16px sans-serif";
      ctx.fillText(player.model, 90, y + 22, 586);
    }
  }

  ctx.font = "bold 100px monospace";
  ctx.fillStyle = "#a2e5b4";
  ctx.fillText(match.result, 56, 408);
  const stats = matchStats(match);
  ctx.fillStyle = "#bbc9c1";
  ctx.font = "20px sans-serif";
  ctx.fillText(
    `${stats.moves} ${t("stats.plies")} · ${stats.illegalAttempts} ${t("stats.rejected")}`,
    56,
    446,
    620,
  );
  ctx.fillText(
    `${t(`context.${match.config.rules.context}`)} · ${t(`identity.${match.config.rules.opponentIdentity}`)}`,
    56,
    476,
    620,
  );
  ctx.fillText(t(`termination.${match.termination}`), 56, 506, 620);
  ctx.font = "16px sans-serif";
  ctx.fillText(
    `${t("studio.noSamples")} · ${match.source} · ${match.config.rules.version}`,
    56,
    548,
    620,
  );
  const protocol = (value: string) =>
    PROTOCOLS.has(value) ? t(`create.protocols.${value}`) : value;
  ctx.fillText(
    `${protocol(match.config.white.protocol)} / ${protocol(match.config.black.protocol)}`,
    56,
    574,
    620,
  );
  ctx.fillText(
    `${t(`accounting.${match.config.rules.tokenAccounting}`)} · ${t(`engineModes.${match.config.rules.engineEvaluation}`)}`,
    56,
    600,
    620,
  );
  ctx.fillText(replayUrl ?? t("studio.privateGraphic"), 56, 628, 1080);

  const size = BOARD.square;
  const board = boardAt(match);
  board.board().forEach((row, rank) => {
    row.forEach((piece, file) => {
      const x = BOARD.x + file * size;
      const y = BOARD.y + rank * size;
      ctx.fillStyle = (rank + file) % 2 ? "#5a7d69" : "#dfe4cd";
      ctx.fillRect(x, y, size, size);
      if (!piece) return;
      const glyph = GLYPHS[piece.type];
      ctx.font = "40px Georgia, 'DejaVu Sans', serif";
      const origin = glyphOrigin(ctx.measureText(glyph), x + size / 2, y + size / 2);
      ctx.fillStyle = piece.color === "w" ? "#fffdf3" : INK;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.strokeText(glyph, origin.x, origin.y);
      ctx.fillText(glyph, origin.x, origin.y);
    });
  });

  // The evaluation of exactly the exported position, when one was recorded:
  // White fills from the bottom.
  const final = pointForPosition(evaluationSeries(match), Number.POSITIVE_INFINITY, board.fen());
  if (final) {
    const barX = BOARD.x - 30;
    const height = size * 8;
    ctx.fillStyle = "#2b2f2e";
    ctx.fillRect(barX, BOARD.y, 18, height);
    const white = Math.round(height * final.share);
    ctx.fillStyle = PAPER;
    ctx.fillRect(barX, BOARD.y + height - white, 18, white);
    ctx.fillStyle = "#bbc9c1";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(shortScore(final.evaluation), barX + 9, BOARD.y + height + 22);
    ctx.textAlign = "left";
  }
}
