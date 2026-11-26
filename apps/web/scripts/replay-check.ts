/**
 * Interaction check of the game view in headless Chromium, with real mouse and keyboard
 * events on the real MatchReplay (fixture game with remarks on both sides):
 *   - the board never moves when the chat bubble appears, changes side or disappears;
 *   - the bubble sits on its speaker's side, and moves with the board when flipped;
 *   - clicking a chat entry seeks to that move;
 *   - the Chat / Moves tabs work from the keyboard (arrows wrap, Home, End, focus moves);
 *   - the result banner shows at the end of a finished game, and not after rewinding;
 *   - the bubble fades in, and does not animate with prefers-reduced-motion,
 * at phone and desktop widths.
 *
 *   pnpm -F web test:replay
 *
 * Needs a Chromium (see ./lib/chromium-harness.ts). Not part of `pnpm test`: it drives a
 * real browser.
 */
import path from "node:path";
import { type HarnessPage, withHarness } from "./lib/chromium-harness";

const harness = path.resolve(import.meta.dirname, "replay-harness");

type State = {
  boardTop: number | null;
  bubble: { slot: "top" | "bottom"; side: "w" | "b"; text: string; animation: string } | null;
  slotHeights: number[];
  counter: string;
  banner: string | null;
  bannerBottom: number | null;
  boardTopPage: number | null;
  clocks: Record<string, string>;
  focusedId: string;
  selectedTab: string;
  hiddenPanels: string[];
};

const failures: string[] = [];
function check(label: string, ok: boolean, detail: unknown = "") {
  if (!ok)
    failures.push(`${label}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

async function click(page: HarnessPage, selector: string, text?: string) {
  const point = await page.evaluate<{ x: number; y: number } | null>(
    `window.replay.centre(${JSON.stringify(selector)}, ${JSON.stringify(text)})`,
  );
  if (!point) throw new Error(`nothing to click: ${selector} ${text ?? ""}`);
  await page.click(point.x, point.y);
  await new Promise((resolve) => setTimeout(resolve, 60));
}
const state = (page: HarnessPage) => page.evaluate<State>("window.replay.state()");
const button = (label: string) => `button[aria-label="${label}"]`;

async function run(page: HarnessPage, width: number) {
  const label = `${width}px`;
  await page.viewport(width, 900);
  await page.media([]);
  await page.evaluate('window.replay.mount("plain")');

  // Step from the start (no remark yet) through every move: the board never moves.
  await click(page, button("Starting position"));
  const tops = new Set<number | null>();
  const seen = new Set<string>();
  for (let step = 0; step < 40 && !(await state(page)).counter.match(/^(\d+) \/ \1$/); step++) {
    const now = await state(page);
    tops.add(now.boardTop);
    seen.add(now.bubble ? `${now.bubble.side}:${now.bubble.slot}` : "none");
    for (const height of now.slotHeights) check(`${label} slot height`, height === 88, height);
    await click(page, button("Next event"));
  }
  {
    const last = await state(page);
    tops.add(last.boardTop);
    seen.add(last.bubble ? `${last.bubble.side}:${last.bubble.slot}` : "none");
  }
  check(`${label} board steady while bubbles come and go`, tops.size === 1, [...tops]);
  check(`${label} bubbles on both sides and none`, seen.size === 3, [...seen]);
  check(
    `${label} White speaks from below, Black from above`,
    seen.has("w:bottom") && seen.has("b:top"),
    [...seen],
  );

  // At the end Black spoke last: its bubble is above; flipping puts it below.
  await click(page, button("Latest position"));
  let now = await state(page);
  check(
    `${label} last remark is Black's, above`,
    now.bubble?.side === "b" && now.bubble.slot === "top",
    now.bubble,
  );
  await click(page, button("Flip board"));
  now = await state(page);
  check(
    `${label} flipped: Black's bubble below`,
    now.bubble?.side === "b" && now.bubble.slot === "bottom",
    now.bubble,
  );
  await click(page, button("Flip board"));

  // Clicking a chat entry seeks to its move.
  await click(page, ".cc-remark", "Move 1 · e4");
  now = await state(page);
  check(`${label} chat click seeks to move 1`, now.counter.startsWith("1 /"), now.counter);
  check(`${label} its bubble shows`, now.bubble?.text.includes("tin can") === true, now.bubble);

  // Tabs from the keyboard.
  await click(page, '[role="tab"]', "Chat");
  check(`${label} chat tab selected`, (await state(page)).selectedTab === "chat");
  await page.key("ArrowRight");
  now = await state(page);
  check(
    `${label} ArrowRight wraps to Moves`,
    now.selectedTab === "moves" && now.focusedId.endsWith("-tab-moves"),
    now,
  );
  check(`${label} chat panel hidden`, now.hiddenPanels.join() === "chat", now.hiddenPanels);
  await page.key("ArrowLeft");
  now = await state(page);
  check(
    `${label} ArrowLeft back to Chat`,
    now.selectedTab === "chat" && now.focusedId.endsWith("-tab-chat"),
    now,
  );
  await page.key("Home");
  check(`${label} Home selects Moves`, (await state(page)).selectedTab === "moves");
  await page.key("End");
  check(`${label} End selects Chat`, (await state(page)).selectedTab === "chat");

  // The result banner: at the end of a finished game only.
  await page.evaluate('window.replay.mount("finished")');
  now = await state(page);
  check(`${label} banner at the end`, now.banner?.includes("White resigned") === true, now.banner);
  const top = now.boardTop;
  await click(page, button("Previous event"));
  now = await state(page);
  check(`${label} no banner after rewinding`, now.banner === null, now.banner);
  await click(page, button("Latest position"));
  check(`${label} banner back at the end`, (await state(page)).banner !== null);
  now = await state(page);
  check(
    `${label} banner sits above the board, never over it`,
    now.bannerBottom !== null && now.boardTopPage !== null && now.bannerBottom <= now.boardTopPage,
    { banner: now.bannerBottom, board: now.boardTopPage, top },
  );

  // A live timed game: only the side to move counts down; rewinding freezes the clocks;
  // following live again resumes them.
  await page.evaluate('window.replay.mount("live")');
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const first = (await state(page)).clocks;
  await sleep(1300);
  const later = (await state(page)).clocks;
  check(`${label} White's clock runs while it thinks`, first.White !== later.White, {
    first,
    later,
  });
  check(`${label} Black's clock waits`, first.Black === "5:00" && later.Black === "5:00", later);
  check(`${label} White's turn started 5 s ago`, /^4:5[0-9]$/.test(later.White ?? ""), later);
  await click(page, button("Previous event"));
  const rewound = (await state(page)).clocks;
  await sleep(1300);
  check(
    `${label} rewinding freezes the clocks`,
    (await state(page)).clocks.White === rewound.White,
    rewound,
  );
  await click(page, button("Latest position"));
  const resumed = (await state(page)).clocks;
  await sleep(1300);
  check(
    `${label} following live resumes the clock`,
    (await state(page)).clocks.White !== resumed.White,
    resumed,
  );

  // The bubble's fade, and none with reduced motion.
  await page.evaluate('window.replay.mount("plain")');
  check(`${label} bubble fades in`, (await state(page)).bubble?.animation === "cc-bubble-in");
  await page.media([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.evaluate('window.replay.mount("plain")');
  check(
    `${label} no animation with reduced motion`,
    (await state(page)).bubble?.animation === "none",
  );
  console.log(`${label}: checked`);
}

await withHarness(harness, async (page) => {
  for (const width of [390, 1280]) await run(page, width);
});
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else console.log("\nall replay interaction checks passed");
