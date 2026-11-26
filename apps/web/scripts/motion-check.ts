/**
 * Board motion check in headless Chromium, on the real MatchReplay with the struggling
 * fixture game (a lookup, an illegal attempt with a piece, one from an empty square, a
 * reply that is not a move, a long run of attempts):
 *   - a single step onto an illegal attempt slides the piece out, shakes it and brings
 *     it back, with red rings on both squares and a caption, all within about a second;
 *   - a legal step slides the piece; a jump snaps with no motion;
 *   - a reply that is not a move flashes the side's row and captions it;
 *   - with prefers-reduced-motion nothing moves, but the rings and caption stay up for
 *     the motion's full length;
 *   - a live game that receives several events at once plays them in order (lookup,
 *     illegal attempt, move) and ends on the latest position,
 * at 1280 and 390 px, light and dark. `--out <dir>` keeps a frame strip (PNG) of each.
 *
 *   pnpm -F web test:motion [-- --out <dir>]
 *
 * Needs a Chromium (see ./lib/chromium-harness.ts) and, for the strips, ffmpeg on PATH.
 * Not part of `pnpm test`: it drives a real browser.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { type HarnessPage, withHarness } from "./lib/chromium-harness";

const harness = path.resolve(import.meta.dirname, "replay-harness");
// `pnpm test:motion -- --out dir` passes the "--" through.
const { values: args } = parseArgs({
  options: { out: { type: "string" } },
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
});
const out = args.out ? path.resolve(args.out) : null;
if (out) mkdirSync(out, { recursive: true });

type Rect = { x: number; y: number; width: number; height: number };
type Motion = {
  layer: boolean;
  ghosts: Array<{ effect: string; transform: string; opacity: string; cx: number; cy: number }>;
  rings: number;
  caption: string | null;
  evaluation: string | null;
  graph: string | null;
  announced: string[];
  flash: number;
  hidden: number;
  counter: string;
  panel: Rect | null;
  board: Rect | null;
};

const failures: string[] = [];
function check(label: string, ok: boolean, detail: unknown = "") {
  if (!ok)
    failures.push(`${label}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const motion = (page: HarnessPage) => page.evaluate<Motion>("window.replay.motion()");
const moved = (transform: string) =>
  transform !== "none" && transform !== "matrix(1, 0, 0, 1, 0, 0)";

async function click(page: HarnessPage, label: string) {
  const point = await page.evaluate<{ x: number; y: number } | null>(
    `window.replay.centre(${JSON.stringify(`button[aria-label="${label}"]`)})`,
  );
  if (!point) throw new Error(`nothing to click: ${label}`);
  await page.click(point.x, point.y);
}

/** Goes to event `index` (0-based) by a jump, so the next step is a single one. */
async function goTo(page: HarnessPage, index: number) {
  await click(page, "Starting position");
  for (let i = -1; i < index; i++) {
    await click(page, "Next event");
    await sleep(1400);
  }
}

type Sample = Motion & { t: number };
const record = (page: HarnessPage, ms: number) =>
  page.evaluate<Sample[]>(`window.replay.record(${ms})`);
const between = (samples: Sample[], from: number, to: number) =>
  samples.filter((sample) => sample.t >= from && sample.t <= to);

/**
 * Screenshots of the board at the given times (ms) after `act` runs, joined into one
 * strip under `--out` (evidence only: a screenshot takes long enough to shift the next
 * one; the checks use in-page samples instead).
 */
async function strip(page: HarnessPage, name: string, times: number[], act: () => Promise<void>) {
  if (!out) return;
  const shots: string[] = [];
  // One clip for the whole strip (from the board before the step), so every shot has
  // the same size even if a scrollbar comes or goes meanwhile.
  const board = (await motion(page)).board;
  if (!board) return;
  const pad = 12;
  const clip = {
    x: Math.max(0, Math.round(board.x - pad)),
    y: Math.max(0, Math.round(board.y - pad - 64)),
    width: Math.round(board.width + pad * 2),
    height: Math.round(board.height + pad * 2 + 128),
  };
  const began = Date.now();
  await act();
  for (const [i, at] of times.entries()) {
    const wait = began + at - Date.now();
    if (wait > 0) await sleep(wait);
    const file = path.join(out, `${name}-${i}.png`);
    await page.screenshot(file, clip);
    shots.push(file);
  }
  if (shots.length > 1)
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      ...shots.flatMap((file) => ["-i", file]),
      "-filter_complex",
      `hstack=inputs=${shots.length}`,
      path.join(out, `${name}.png`),
    ]);
  for (const file of shots) rmSync(file);
}

/** Runs `act` after `setup`, samples the board for `ms`; then again for the strip. */
async function scenario(
  page: HarnessPage,
  name: string,
  setup: () => Promise<void>,
  act: () => Promise<void>,
  ms: number,
  shots: number[],
) {
  await setup();
  await act();
  const raw = await record(page, ms + 800);
  // Times from the motion's own start (the first sample with pieces in motion): the
  // click and the render before it take a while on a busy machine.
  const start = raw.find((sample) => sample.layer)?.t ?? 0;
  const samples = raw
    .map((sample) => ({ ...sample, t: sample.t - start }))
    .filter((sample) => sample.t >= 0 && sample.t <= ms);
  if (out) {
    await setup();
    await strip(page, name, shots, act);
  }
  return samples;
}

async function run(page: HarnessPage, width: number, dark: boolean) {
  const label = `${width}px ${dark ? "dark" : "light"}`;
  const slug = `${width}-${dark ? "dark" : "light"}`;
  await page.viewport(width, 1000);
  await page.media([]);
  await page.evaluate(`window.replay.theme(${dark})`);
  await page.evaluate("window.replay.mountStruggle()");
  check(`${label} no motion on the first render`, !(await motion(page)).layer);
  const next = () => click(page, "Next event");

  // Event 1: White's knight tries g1-e5. Out, shake, back; rings and caption throughout.
  const illegal = await scenario(
    page,
    `illegal-${slug}`,
    () => goTo(page, 0),
    next,
    1500,
    [40, 160, 320, 480, 640, 860, 1400],
  );
  const during = between(illegal, 40, 1000);
  check(
    `${label} the knight leaves g1, shakes and comes back`,
    during.some((s) => s.ghosts.some((g) => g.effect === "illegal" && moved(g.transform))),
    during.map((s) => [s.t, s.ghosts]),
  );
  check(
    `${label} its square stays empty while it moves`,
    during.length > 0 && during.every((s) => s.hidden === 1),
    during.map((s) => [s.t, s.hidden]),
  );
  check(
    `${label} both squares ringed and captioned throughout`,
    illegal.length > 0 &&
      illegal.every((s) => s.rings === 2 && s.caption === "White tried Ng1-e5: not a legal move"),
    illegal.map((s) => [s.t, s.rings, s.caption]),
  );
  check(
    `${label} still after about a second`,
    between(illegal, 1250, 1500).every((s) => !s.layer) && illegal.some((s) => s.t >= 1250),
    illegal.map((s) => [s.t, s.layer]),
  );

  // Event 2: the legal Nf3 slides, and clears the rings.
  const legal = await scenario(
    page,
    `legal-${slug}`,
    () => goTo(page, 1),
    next,
    600,
    [20, 80, 140, 200, 500],
  );
  check(
    `${label} a legal move slides`,
    between(legal, 0, 240).some((s) =>
      s.ghosts.some((g) => g.effect === "slide" && moved(g.transform)),
    ),
    legal.map((s) => [s.t, s.ghosts]),
  );
  check(
    `${label} the slide is over in about 240 ms`,
    between(legal, 400, 600).every((s) => !s.layer && s.rings === 0),
    legal.map((s) => [s.t, s.layer, s.rings]),
  );

  // Event 3: Black tries f6-e4 with no piece on f6: one ring, nothing moves.
  const empty = await scenario(
    page,
    `no-piece-${slug}`,
    () => goTo(page, 2),
    next,
    800,
    [100, 600],
  );
  check(
    `${label} an empty from-square: one ring, nothing moves`,
    empty.length > 0 && empty.every((s) => s.rings === 1 && s.ghosts.length === 0),
    empty.map((s) => [s.t, s.rings, s.ghosts.length]),
  );

  // Event 5: a reply that is not a move: the row flashes, a caption, no rings.
  const unreadable = await scenario(
    page,
    `unreadable-${slug}`,
    () => goTo(page, 4),
    next,
    1000,
    [100, 450, 900],
  );
  check(
    `${label} an unreadable reply flashes White's row and says so`,
    unreadable.length > 0 &&
      unreadable.every(
        (s) =>
          s.flash === 1 &&
          s.rings === 0 &&
          s.caption === "White's reply couldn't be read as a move: “Knight takes e5!!”",
      ),
    unreadable.slice(0, 3),
  );

  // A jump snaps.
  await click(page, "Latest position");
  check(`${label} a jump snaps`, !(await motion(page)).layer);

  // Reduced motion: nothing moves, the rings and caption stay up as long.
  await page.media([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const still = await scenario(
    page,
    `reduced-${slug}`,
    () => goTo(page, 0),
    next,
    1500,
    [80, 500, 900, 1450],
  );
  check(
    `${label} reduced motion: nothing moves`,
    still.every((s) => s.ghosts.every((g) => !moved(g.transform))),
    still.map((s) => [s.t, s.ghosts]),
  );
  check(
    `${label} reduced motion: rings and caption for the motion's length`,
    between(still, 0, 950).every((s) => s.layer && s.rings === 2 && s.caption !== null) &&
      between(still, 1250, 1500).every((s) => !s.layer && s.rings === 2),
    still.map((s) => [s.t, s.layer, s.rings]),
  );
  await page.media([]);

  // A live game: three events arrive at once (lookup, illegal attempt, move).
  const live = await scenario(
    page,
    `live-${slug}`,
    () => page.evaluate("window.replay.mountStruggle(-1)"),
    () => page.evaluate("window.replay.grow(2)"),
    2600,
    [60, 500, 800, 1100, 1450, 1650, 2400],
  );
  const order: string[] = [];
  for (const s of live) {
    const kind = s.layer ? (s.ghosts[0]?.effect ?? "hold") : "still";
    if (order.at(-1) !== kind) order.push(kind);
  }
  check(
    `${label} live: lookup, attempt, then move, then still`,
    order.join(" ") === "hold illegal slide still",
    order,
  );

  // Asking for the latest event mid catch-up shows it at once.
  await page.evaluate("window.replay.mountStruggle(-1)");
  await page.evaluate("window.replay.grow(6)");
  await sleep(150);
  const before = await motion(page);
  await click(page, "Latest position");
  await sleep(60);
  const latest = await motion(page);
  check(
    `${label} Latest interrupts a catch-up`,
    before.layer && !latest.layer && latest.flash === 0,
    { before: before.layer, after: latest.layer },
  );

  // Two identical attempts with bookkeeping between: both are announced.
  await page.evaluate('window.replay.mountStruggle(-1, "repeat")');
  const repeat = await record(page, 1);
  await page.evaluate("window.replay.grow(4)");
  await sleep(3200);
  const heard = (await motion(page)).announced;
  check(
    `${label} a repeated attempt is announced again`,
    heard.length === 2 && heard.every((text) => text === "White tried Ng1-e5: not a legal move"),
    { heard, repeat: repeat.length },
  );

  // The evaluation bar follows the position on the board while it catches up: Nf3
  // (+1.8), Black's rejected a1-a8, then Nc6 (White mates in 2) arrive together.
  await page.evaluate('window.replay.mountStruggle(3, "scored")');
  const scores = await scenario(
    page,
    `eval-${slug}`,
    async () => undefined,
    () => page.evaluate("window.replay.grow(8)"),
    2400,
    [],
  );
  // The bar and the graph cursor, each time they change.
  const changes = (read: (s: Sample) => string | null) => {
    const seen: string[] = [];
    for (const s of scores) {
      const value = read(s);
      if (value && seen.at(-1) !== value) seen.push(value);
    }
    return seen;
  };
  const follows = (seen: string[]) =>
    seen.some((text) => text.includes("+1.8")) &&
    seen.at(-1)?.includes("mates in 2") === true &&
    seen.findIndex((text) => text.includes("+1.8")) <
      seen.findIndex((text) => text.includes("mates in 2"));
  const bar = changes((s) => s.evaluation);
  const graph = changes((s) => s.graph);
  check(`${label} the bar follows the board: +1.8 while catching up, then mate`, follows(bar), bar);
  check(`${label} so does the graph cursor`, follows(graph), graph);

  // Flipped: pieces still head for the squares as displayed (out to e5, along to f3,
  // and back to g1 on a step back).
  await page.evaluate("window.replay.mountStruggle()");
  await click(page, "Flip board");
  const at = (name: string) =>
    page.evaluate<{ cx: number; cy: number; size: number } | null>(
      `window.replay.square(${JSON.stringify(name)})`,
    );
  const nearest = async (samples: Sample[], effect: string, name: string) => {
    const target = await at(name);
    if (!target) return Number.POSITIVE_INFINITY;
    let best = Number.POSITIVE_INFINITY;
    for (const s of samples)
      for (const g of s.ghosts)
        if (g.effect === effect)
          best = Math.min(best, Math.hypot(g.cx - target.cx, g.cy - target.cy) / target.size);
    return best;
  };
  const flippedOut = await scenario(
    page,
    `flipped-illegal-${slug}`,
    () => goTo(page, 0),
    next,
    1300,
    [],
  );
  const flippedAlong = await scenario(
    page,
    `flipped-legal-${slug}`,
    () => goTo(page, 1),
    next,
    500,
    [],
  );
  const flippedBack = await scenario(
    page,
    `flipped-back-${slug}`,
    () => goTo(page, 2),
    () => click(page, "Previous event"),
    500,
    [],
  );
  const reach = {
    out: await nearest(flippedOut, "illegal", "e5"),
    along: await nearest(flippedAlong, "slide", "f3"),
    back: await nearest(flippedBack, "slide", "g1"),
  };
  check(
    `${label} flipped: pieces reach the displayed squares`,
    reach.out < 0.25 && reach.along < 0.25 && reach.back < 0.25,
    reach,
  );
  await click(page, "Flip board");

  // Events arriving mid-motion, twice: the attempt plays, then the rest catch up in
  // order and the board ends on the latest event, with motion and with reduced motion.
  for (const reduced of [false, true]) {
    await page.media(reduced ? [{ name: "prefers-reduced-motion", value: "reduce" }] : []);
    await page.evaluate("window.replay.mountStruggle(0)");
    const arrivals = await page.evaluate<Sample[]>(
      "window.replay.scripted([{ at: 0, upTo: 1 }, { at: 300, upTo: 2 }, { at: 700, upTo: 4 }, { at: 1100, upTo: 6 }], 5000)",
    );
    const last = arrivals.at(-1);
    check(
      `${label} ${reduced ? "reduced motion: " : ""}arrivals mid-motion play in order and finish`,
      last?.layer === false &&
        last.counter === "7 / 7" &&
        arrivals.some((s) => s.layer && s.caption === "White tried Ng1-e5: not a legal move") &&
        arrivals.some((s) => s.layer && s.caption === "Black tried f6-e4: no Black piece on f6") &&
        arrivals.some((s) => s.layer && s.flash === 1),
      { samples: arrivals.length, last: last && { layer: last.layer, counter: last.counter } },
    );
  }
  await page.media([]);

  // The playable board: White has played Nf3; Black's attempt from an empty f6 and its
  // move e5 arrive together. Clicking White's d-pawn mid catch-up snaps the board and
  // plays d2-d4 in the position to come (White to move), never the one on screen.
  await page.evaluate("window.replay.mountPlay(2)");
  await page.evaluate("window.replay.growPlay(4)");
  await sleep(120);
  const catching = await motion(page);
  check(`${label} play: catching up when the click comes`, catching.layer, catching);
  await click(page, "White pawn on d2");
  await sleep(80);
  check(`${label} play: the click ends the motion`, !(await motion(page)).layer);
  await click(page, "Empty square d4");
  await sleep(80);
  const submitted = await page.evaluate<string[]>("window.replay.played()");
  check(
    `${label} play: the move is played in the latest position`,
    submitted.join() === "d2d4",
    submitted,
  );
  console.log(`${label}: checked`);
}

await withHarness(harness, async (page) => {
  for (const width of [1280, 390]) for (const dark of [false, true]) await run(page, width, dark);
});
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else console.log(`\nall board motion checks passed${out ? `; strips in ${out}` : ""}`);
