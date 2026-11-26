import { Chess } from "@cockpit-chess/chess";

/**
 * The one canvas board renderer, used by the PNG share card and every MP4
 * frame. Fixed colours: it draws images, not themed UI. Works on an
 * OffscreenCanvas in a worker (no DOM access).
 */
export type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const BOARD_COLORS = {
  light: "#dfe4cd",
  dark: "#5a7d69",
  lastMove: "rgba(246, 214, 92, 0.5)",
  whitePiece: "#fffdf3",
  ink: "#182520",
} as const;
const GLYPHS = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" } as const;
const PIECE_FONT = "Georgia, 'DejaVu Sans', serif";
const COORD_FONT = "'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif";

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

/**
 * Draws the position from White's side at (x, y) with `square`-pixel squares.
 * `lastMove` (UCI) highlights its two squares; `coordinates` labels the edge
 * files and ranks.
 */
export function drawBoard(
  ctx: Canvas2D,
  fen: string,
  { x, y, square }: { x: number; y: number; square: number },
  {
    lastMove = null,
    coordinates = false,
  }: { lastMove?: string | null; coordinates?: boolean } = {},
) {
  const from = lastMove?.slice(0, 2);
  const to = lastMove?.slice(2, 4);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  new Chess(fen).board().forEach((row, rank) => {
    row.forEach((piece, file) => {
      const sx = x + file * square;
      const sy = y + rank * square;
      const dark = (rank + file) % 2 === 1;
      ctx.fillStyle = dark ? BOARD_COLORS.dark : BOARD_COLORS.light;
      ctx.fillRect(sx, sy, square, square);
      const name = `${"abcdefgh"[file]}${8 - rank}`;
      if (name === from || name === to) {
        ctx.fillStyle = BOARD_COLORS.lastMove;
        ctx.fillRect(sx, sy, square, square);
      }
      if (coordinates) {
        ctx.fillStyle = dark ? BOARD_COLORS.light : BOARD_COLORS.dark;
        ctx.font = `bold ${Math.round(square * 0.16)}px ${COORD_FONT}`;
        if (file === 0) ctx.fillText(String(8 - rank), sx + square * 0.06, sy + square * 0.22);
        if (rank === 7)
          ctx.fillText("abcdefgh"[file] as string, sx + square * 0.8, sy + square * 0.94);
      }
      if (!piece) return;
      const glyph = GLYPHS[piece.type];
      ctx.font = `${Math.round(square * 0.8)}px ${PIECE_FONT}`;
      const origin = glyphOrigin(ctx.measureText(glyph), sx + square / 2, sy + square / 2);
      ctx.fillStyle = piece.color === "w" ? BOARD_COLORS.whitePiece : BOARD_COLORS.ink;
      ctx.strokeStyle = BOARD_COLORS.ink;
      ctx.lineWidth = Math.max(1, square / 50);
      ctx.strokeText(glyph, origin.x, origin.y);
      ctx.fillText(glyph, origin.x, origin.y);
    });
  });
}
