/**
 * Visual regression check of the landing page's hero board, in headless Chromium:
 * at phone, breakpoint, desktop, 1440p and 4K widths, light and dark, for a full back rank and a
 * middlegame, it measures the real HeroBoard with the real stylesheet and checks that
 *   - every piece's ink is centred in its square (within 8% of the square),
 *   - no corner label (a–h, 1–8) touches a piece's ink,
 *   - the caption never overlaps the tilted board, and stays on screen,
 *   - no ancestor clips the tilted board's corners (hit-tested, so clipping counts),
 *   - nothing overflows the page horizontally.
 *
 *   pnpm -F web test:hero      (screenshots: --shots <dir>)
 *
 * Needs a Chromium (see ./lib/chromium-harness.ts). Not part of `pnpm test`: it drives a
 * real browser.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { withHarness } from "./lib/chromium-harness";

const webRoot = path.resolve(import.meta.dirname, "..");
const harness = path.join(webRoot, "scripts/hero-board-harness");
const { values: args } = parseArgs({ options: { shots: { type: "string" } } });
/** Phone, both sides of each layout breakpoint (639/650/900 px), desktop, 1440p and 4K. */
const WIDTHS = [390, 639, 640, 650, 651, 900, 901, 1280, 2560, 3840];

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Measurement = {
  corners: Point[];
  /** Per corner: null when the board is painted there, else what is painted instead. */
  cornersVisible: Array<string | null>;
  captionPainted: boolean;
  caption: Rect;
  figure: Rect;
  viewport: { width: number; height: number };
  overflowX: boolean;
  squares: Array<{ square: Rect; size: number; piece: Rect | null; labels: Rect[] }>;
};

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Separating-axis test of a rectangle against the board's (tilted) quadrilateral. */
function rectHitsQuad(rect: Rect, quad: Point[]) {
  const rectPoints = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i] as Point;
    const b = quad[(i + 1) % quad.length] as Point;
    axes.push({ x: -(b.y - a.y), y: b.x - a.x });
  }
  for (const axis of axes) {
    const project = (points: Point[]) => points.map((p) => p.x * axis.x + p.y * axis.y);
    const r = project(rectPoints);
    const q = project(quad);
    if (Math.max(...r) <= Math.min(...q) || Math.max(...q) <= Math.min(...r)) return false;
  }
  return true;
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
}

function verify(label: string, m: Measurement) {
  check(`${label} overflow`, !m.overflowX);
  check(
    `${label} tilted corners painted (not clipped)`,
    m.cornersVisible.every((corner) => corner === null),
    m.cornersVisible.filter(Boolean).join("; "),
  );
  check(
    `${label} caption over board`,
    !rectHitsQuad(m.caption, m.corners),
    JSON.stringify(m.caption),
  );
  check(
    `${label} caption on screen`,
    m.caption.x >= 0 &&
      m.caption.x + m.caption.width <= m.viewport.width &&
      m.caption.y >= 0 &&
      m.caption.y + m.caption.height <= m.viewport.height,
    JSON.stringify(m.caption),
  );
  check(`${label} caption painted (not clipped)`, m.captionPainted);
  for (const [i, s] of m.squares.entries()) {
    if (!s.piece) continue;
    const dx = s.piece.x + s.piece.width / 2 - (s.square.x + s.square.width / 2);
    const dy = s.piece.y + s.piece.height / 2 - (s.square.y + s.square.height / 2);
    check(
      `${label} square ${i} piece centred`,
      Math.abs(dx) <= s.size * 0.08 && Math.abs(dy) <= s.size * 0.08,
      `dx=${dx.toFixed(1)} dy=${dy.toFixed(1)} size=${s.size}`,
    );
    for (const labelBox of s.labels)
      check(`${label} square ${i} label clear of piece`, !overlaps(labelBox, s.piece));
  }
}

async function main() {
  if (args.shots) await mkdir(args.shots, { recursive: true });
  await withHarness(harness, async (page) => {
    for (const width of WIDTHS)
      for (const dark of [false, true])
        for (const fen of ["start", "middlegame"]) {
          await page.viewport(width, Math.max(900, Math.round(width * 0.6)));
          const label = `${width}px ${dark ? "dark" : "light"} ${fen}`;
          const m = await page.evaluate<Measurement>(
            `window.heroBoard.measure(${JSON.stringify(fen)}, ${dark})`,
          );
          verify(label, m);
          if (args.shots && fen === "start")
            await page.screenshot(
              path.join(args.shots, `hero-${width}-${dark ? "dark" : "light"}.png`),
              {
                x: m.figure.x - 20,
                y: m.figure.y - 20,
                width: m.figure.width + 40,
                height: m.figure.height + 40,
              },
            );
          console.log(`${label}: checked ${m.squares.filter((s) => s.piece).length} pieces`);
        }
  });
}

await main();
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n${failures.slice(0, 40).join("\n")}`);
  process.exitCode = 1;
} else console.log("\nall hero board checks passed");
