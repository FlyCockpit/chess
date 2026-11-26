import type { PieceSymbol } from "@cockpit-chess/chess";
import { vi } from "vitest";
import type { Canvas2D } from "./board-canvas";
import { PIECE_PATHS, PIECE_VIEWBOX } from "./piece-paths";

/** A stand-in for Path2D (absent in Node): it keeps the outline it was built from. */
class RecordedPath {
  constructor(readonly d: string) {}
}
vi.stubGlobal("Path2D", RecordedPath);

const TYPE_OF = new Map(
  Object.entries(PIECE_PATHS).map(([type, d]) => [d, type as PieceSymbol] as const),
);

type DrawnPiece = {
  type: PieceSymbol;
  /** The fill the outline was painted with. */
  fill: string;
  /** Where the piece's 100-unit square is centred on the canvas, and its width and height. */
  cx: number;
  cy: number;
  width: number;
  height: number;
};

/**
 * Wraps a recording 2D context so each piece outline filled through it is recorded
 * with its colour and where its square lands, following translate/scale and
 * save/restore (the only transforms board-canvas.ts uses).
 */
export function recordPieces<Context extends Canvas2D>(ctx: Context) {
  const pieces: DrawnPiece[] = [];
  const identity = { x: 0, y: 0, kx: 1, ky: 1 };
  let transform = identity;
  const stack: (typeof transform)[] = [];
  const spy = new Proxy(ctx as object, {
    get(target, key: string) {
      if (key === "save") return () => stack.push({ ...transform });
      if (key === "restore") return () => (transform = stack.pop() ?? identity);
      if (key === "translate")
        return (x: number, y: number) => {
          transform = {
            ...transform,
            x: transform.x + x * transform.kx,
            y: transform.y + y * transform.ky,
          };
        };
      if (key === "scale")
        return (kx: number, ky: number) =>
          (transform = { ...transform, kx: transform.kx * kx, ky: transform.ky * ky });
      if (key === "fill")
        return (path?: unknown) => {
          const type = path instanceof RecordedPath ? TYPE_OF.get(path.d) : undefined;
          if (!type) return Reflect.get(target, key)?.call(target, path);
          const width = PIECE_VIEWBOX * transform.kx;
          const height = PIECE_VIEWBOX * transform.ky;
          pieces.push({
            type,
            fill: String(Reflect.get(target, "fillStyle")),
            cx: transform.x + width / 2,
            cy: transform.y + height / 2,
            width,
            height,
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, key, value) {
      return Reflect.set(target, key, value);
    },
  }) as Context;
  return { spy, pieces };
}
