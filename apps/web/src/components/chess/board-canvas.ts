import { Chess, type PieceSymbol } from "@cockpit-chess/chess";
import { PIECE_PATHS, PIECE_VIEWBOX } from "./piece-paths";

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
const COORD_FONT = "'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif";

/** Each piece's outline, parsed once per realm (page or worker) on first use. */
const piecePaths = new Map<PieceSymbol, Path2D>();
function piecePath(type: PieceSymbol) {
  let path = piecePaths.get(type);
  if (!path) {
    path = new Path2D(PIECE_PATHS[type]);
    piecePaths.set(type, path);
  }
  return path;
}

/**
 * Marks on the board, matching the DOM board's tokens (--cc-illegal-*, --cc-lookup-*
 * in globals.css): a rejected attempt's red ring, a lookup's dots. One palette, like
 * the squares.
 */
export const MARK_COLORS = {
  illegal: "#e7000b",
  halo: "rgba(250, 249, 240, 0.92)",
  lookup: "#22408f",
  lookupFill: "rgba(90, 140, 230, 0.5)",
} as const;

/** A piece drawn off its square: `file` 0–7 from a, `row` 0–7 from rank 8 (may be fractional). */
export type CanvasGhost = {
  piece: { type: PieceSymbol; color: "w" | "b" };
  file: number;
  row: number;
  alpha: number;
};

type BoardMarks = {
  lastMove?: string | null;
  coordinates?: boolean;
  /** Squares whose piece is not drawn (a ghost stands in for it). */
  hide?: readonly string[];
  /** A legal-move lookup: the looked-up square and its targets (rings for captures). */
  lookup?: { from: string; targets: readonly { square: string; capture: boolean }[] } | null;
  /** A rejected attempt's squares, ringed in red. */
  outline?: readonly string[];
  ghosts?: readonly CanvasGhost[];
};

/**
 * Draws a piece centred on (cx, cy) from the bundled outlines (piece-paths.ts), the
 * same ones the DOM board shows: the fill gives its colour, so no font or emoji
 * presentation can change it.
 */
function drawPiece(
  ctx: Canvas2D,
  piece: CanvasGhost["piece"],
  cx: number,
  cy: number,
  square: number,
) {
  const scale = square / PIECE_VIEWBOX;
  ctx.save();
  ctx.translate(cx - square / 2, cy - square / 2);
  ctx.scale(scale, scale);
  ctx.fillStyle = piece.color === "w" ? BOARD_COLORS.whitePiece : BOARD_COLORS.ink;
  ctx.strokeStyle = BOARD_COLORS.ink;
  ctx.lineJoin = "round";
  // The outline's width in board pixels, as before: a fiftieth of a square, at least 1.
  ctx.lineWidth = Math.max(1, square / 50) / scale;
  const path = piecePath(piece.type);
  ctx.stroke(path);
  ctx.fill(path);
  ctx.restore();
}

/** A square's top-left corner on a board drawn from White's side. */
function corner(name: string, x: number, y: number, square: number) {
  return {
    sx: x + (name.charCodeAt(0) - 97) * square,
    sy: y + (8 - Number(name[1])) * square,
  };
}

/**
 * Draws the position from White's side at (x, y) with `square`-pixel squares.
 * `lastMove` (UCI) highlights its two squares; `coordinates` labels the edge
 * files and ranks; the other marks are the lookup dots, the red rings of a rejected
 * attempt and the pieces in motion (board-motion.ts).
 */
export function drawBoard(
  ctx: Canvas2D,
  fen: string,
  { x, y, square }: { x: number; y: number; square: number },
  {
    lastMove = null,
    coordinates = false,
    hide = [],
    lookup = null,
    outline = [],
    ghosts = [],
  }: BoardMarks = {},
) {
  const from = lastMove?.slice(0, 2);
  const to = lastMove?.slice(2, 4);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  /** An edge square's file letter and rank number, in the square's opposite colour. */
  const label = (file: number, rank: number) => {
    const sx = x + file * square;
    const sy = y + rank * square;
    ctx.fillStyle = (rank + file) % 2 === 1 ? BOARD_COLORS.light : BOARD_COLORS.dark;
    ctx.font = `bold ${Math.round(square * 0.16)}px ${COORD_FONT}`;
    if (file === 0) ctx.fillText(String(8 - rank), sx + square * 0.06, sy + square * 0.22);
    if (rank === 7) ctx.fillText("abcdefgh"[file] as string, sx + square * 0.8, sy + square * 0.94);
  };
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
      if (lookup?.from === name) {
        ctx.fillStyle = MARK_COLORS.lookupFill;
        ctx.fillRect(sx, sy, square, square);
      }
      // A ringed square's label is drawn over its ring instead (below).
      if (coordinates && !outline.includes(name)) label(file, rank);
      if (!piece || hide.includes(name)) return;
      drawPiece(ctx, piece, sx + square / 2, sy + square / 2, square);
    });
  });
  const ring = (name: string, color: string, width: number) => {
    const { sx, sy } = corner(name, x, y, square);
    const halo = Math.max(2, square * 0.03);
    ctx.lineWidth = halo;
    ctx.strokeStyle = MARK_COLORS.halo;
    ctx.strokeRect(sx + halo / 2, sy + halo / 2, square - halo, square - halo);
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.strokeRect(
      sx + halo + width / 2,
      sy + halo + width / 2,
      square - 2 * halo - width,
      square - 2 * halo - width,
    );
  };
  if (lookup) {
    ring(lookup.from, MARK_COLORS.lookup, Math.max(2, square * 0.04));
    for (const target of lookup.targets) {
      const { sx, sy } = corner(target.square, x, y, square);
      ctx.beginPath();
      if (target.capture) {
        ctx.arc(sx + square / 2, sy + square / 2, square * 0.44, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(3, square * 0.07);
        ctx.strokeStyle = MARK_COLORS.halo;
        ctx.stroke();
        ctx.lineWidth = Math.max(2, square * 0.045);
        ctx.strokeStyle = MARK_COLORS.lookup;
        ctx.stroke();
      } else {
        ctx.arc(sx + square / 2, sy + square / 2, square * 0.14, 0, Math.PI * 2);
        ctx.fillStyle = MARK_COLORS.lookup;
        ctx.fill();
        ctx.lineWidth = Math.max(2, square * 0.03);
        ctx.strokeStyle = MARK_COLORS.halo;
        ctx.stroke();
      }
    }
  }
  for (const name of outline) ring(name, MARK_COLORS.illegal, Math.max(3, square * 0.065));
  // The red ring runs along the square's edge, where its coordinate sits: keep it readable.
  if (coordinates) for (const name of outline) label(name.charCodeAt(0) - 97, 8 - Number(name[1]));
  for (const ghost of ghosts) {
    ctx.globalAlpha = Math.min(1, Math.max(0, ghost.alpha));
    drawPiece(
      ctx,
      ghost.piece,
      x + (ghost.file + 0.5) * square,
      y + (ghost.row + 0.5) * square,
      square,
    );
    ctx.globalAlpha = 1;
  }
}
