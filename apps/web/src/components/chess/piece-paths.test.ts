import { describe, expect, it } from "vitest";
import { PIECE_PATHS, PIECE_VIEWBOX } from "./piece-paths";

type Point = [number, number];

/**
 * The outline as closed polygons (quadratic curves flattened), from the absolute
 * commands the set uses.
 */
function polygons(d: string): Point[][] {
  const tokens = d.match(/[MLHVQZ]|-?\d*\.?\d+/g) ?? [];
  const rings: Point[][] = [];
  let ring: Point[] = [];
  let at: Point = [0, 0];
  let i = 0;
  const num = () => Number(tokens[i++]);
  let last = "";
  while (i < tokens.length) {
    // A number where a command letter would be repeats the last command (after M, L).
    const token = tokens[i] as string;
    const repeated = !/[A-Z]/.test(token);
    const command = repeated ? (last === "M" ? "L" : last) : token;
    if (!repeated) i++;
    last = command;
    if (command === "M") {
      if (ring.length) rings.push(ring);
      at = [num(), num()];
      ring = [at];
    } else if (command === "L") {
      at = [num(), num()];
      ring.push(at);
    } else if (command === "H") {
      at = [num(), at[1]];
      ring.push(at);
    } else if (command === "V") {
      at = [at[0], num()];
      ring.push(at);
    } else if (command === "Q") {
      const control: Point = [num(), num()];
      const end: Point = [num(), num()];
      for (let step = 1; step <= 8; step++) {
        const s = step / 8;
        ring.push([
          (1 - s) ** 2 * at[0] + 2 * (1 - s) * s * control[0] + s ** 2 * end[0],
          (1 - s) ** 2 * at[1] + 2 * (1 - s) * s * control[1] + s ** 2 * end[1],
        ]);
      }
      at = end;
    } else if (command === "Z") {
      if (ring.length) rings.push(ring);
      ring = [];
    } else throw new Error(`unexpected path command ${command}`);
  }
  if (ring.length) rings.push(ring);
  return rings;
}

/** Non-zero winding, as Canvas fill() and SVG's default fill-rule paint it. */
function inside(rings: Point[][], [x, y]: Point) {
  let winding = 0;
  for (const ring of rings)
    for (let k = 0; k < ring.length; k++) {
      const [x0, y0] = ring[k] as Point;
      const [x1, y1] = ring[(k + 1) % ring.length] as Point;
      if (y0 <= y && y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) winding++;
      else if (y0 > y && y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) winding--;
    }
  return winding !== 0;
}

/** Rasterises the outline on a 1-unit grid: the filled cells, their box and centroid. */
function raster(d: string) {
  const rings = polygons(d);
  let count = 0;
  let sx = 0;
  let sy = 0;
  let box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (let y = 0; y < PIECE_VIEWBOX; y++)
    for (let x = 0; x < PIECE_VIEWBOX; x++) {
      if (!inside(rings, [x + 0.5, y + 0.5])) continue;
      count++;
      sx += x + 0.5;
      sy += y + 0.5;
      box = {
        left: Math.min(box.left, x),
        top: Math.min(box.top, y),
        right: Math.max(box.right, x + 1),
        bottom: Math.max(box.bottom, y + 1),
      };
    }
  return { count, centroid: [sx / count, sy / count] as Point, box, rings };
}

describe("piece outlines", () => {
  const types = ["k", "q", "r", "b", "n", "p"] as const;

  it.each(types)("%s: its ink box is centred in the square and fits it", (type) => {
    const { box } = raster(PIECE_PATHS[type]);
    expect(Math.abs((box.left + box.right) / 2 - 50)).toBeLessThanOrEqual(1);
    expect(Math.abs((box.top + box.bottom) / 2 - 50)).toBeLessThanOrEqual(1);
    // The old glyphs: about 58 % of a square tall, never touching its edges.
    expect(box.bottom - box.top).toBeGreaterThan(55);
    expect(box.bottom - box.top).toBeLessThan(62);
    expect(box.left).toBeGreaterThan(10);
    expect(box.right).toBeLessThan(90);
  });

  it.each(types)("%s: is a solid shape the fill colours, not a hairline", (type) => {
    const { count } = raster(PIECE_PATHS[type]);
    // A filled piece covers a good share of its ink box, so its colour comes from the
    // fill (light for White, dark for Black), as the DOM board and canvas paint it.
    expect(count).toBeGreaterThan(900);
  });

  it("fills the pawn's body, head and base, where an emoji pawn's colour used to show", () => {
    const { rings, centroid } = raster(PIECE_PATHS.p);
    for (const point of [
      [50, 26],
      [50, 50],
      [50, 75],
      [32, 77],
      [68, 77],
    ] as Point[])
      expect(inside(rings, point)).toBe(true);
    // Its weight sits low and in the middle, like a pawn's.
    expect(Math.abs(centroid[0] - 50)).toBeLessThan(1);
    expect(centroid[1]).toBeGreaterThan(50);
  });
});
