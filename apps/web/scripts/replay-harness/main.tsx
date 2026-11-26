import { finishMatch, type MatchArchive } from "@cockpit-chess/chess";
import chessEn from "@locales/en-US/chess.json";
import commonEn from "@locales/en-US/common.json";
import i18next from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { fixtureGame } from "../../src/components/chess/fixture-game";
import { GameBoard } from "../../src/components/chess/game-board";
import { MatchReplay } from "../../src/components/chess/replay";
import { videoIllegalFixtureGame } from "../../src/components/chess/video/video-fixture";
import "../../src/index.css";

/**
 * Browser side of the replay interaction check (scripts/replay-check.ts): the real
 * MatchReplay (the fixture game: trash-talk remarks on both sides, a rejected attempt)
 * inside the hosted shell. The check drives it with real mouse and keyboard events;
 * this page only mounts it and reports what is on screen.
 */
const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  defaultNS: "chess",
  resources: { en: { chess: chessEn, common: commonEn } },
  interpolation: { escapeValue: false },
});
const root = createRoot(document.getElementById("root") as HTMLElement);
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function show(match: MatchArchive, live: boolean, key: string) {
  root.render(
    <I18nextProvider i18n={i18n}>
      <div className="cc-public-shell">
        <main className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain">
          <div className="cc-app">
            <MatchReplay key={key} match={match} live={live} />
          </div>
        </main>
      </div>
    </I18nextProvider>,
  );
}

/**
 * The motion check (scripts/motion-check.ts): the struggling fixture game (lookups,
 * illegal attempts, a reply that is not a move), whole or as a live game that has
 * reached event `upTo` so far; `grow(n)` delivers its next events like a poll.
 */
const struggle = videoIllegalFixtureGame();
/**
 * Other live games for the check: `repeat` tries the same illegal move twice with
 * bookkeeping between (both must be announced); `scored` is the fixture game with a
 * different evaluation after each move (the bar must follow the board while it catches up).
 */
function repeatGame(): MatchArchive {
  const [lookup, illegal, move] = struggle.events as [
    MatchArchive["events"][number],
    MatchArchive["events"][number],
    MatchArchive["events"][number],
  ];
  const timing = {
    type: "timing" as const,
    seq: 2,
    at: illegal.at,
    side: "w" as const,
    ply: 0,
    elapsedMs: 10,
  };
  const events = [lookup, illegal, timing, { ...illegal, seq: 3 }, { ...move, seq: 4 }];
  return { ...struggle, events };
}
const games = { struggle, repeat: repeatGame(), scored: fixtureGame() };
type GameName = keyof typeof games;
let liveGame: GameName = "struggle";
let liveRun = 0;
async function mountStruggle(upTo?: number, name: GameName = "struggle") {
  liveRun++;
  liveGame = name;
  const game = games[name];
  if (upTo === undefined) show(game, false, `${name}-${liveRun}`);
  else
    show(
      { ...game, status: "running", events: game.events.slice(0, upTo + 1) },
      true,
      `${name}-live-${liveRun}`,
    );
  await frame();
  // Count what the board's polite region announces from now on.
  announced.length = 0;
  const region = document.querySelector(".cc-board-wrap > p[aria-live]");
  observer.disconnect();
  if (region) observer.observe(region, { childList: true });
}
const announced: string[] = [];
const observer = new MutationObserver((records) => {
  for (const record of records)
    for (const node of record.addedNodes) announced.push(node.textContent ?? "");
});
async function grow(upTo: number, restart = true) {
  if (restart) mark = performance.now();
  const game = games[liveGame];
  show(
    { ...game, status: "running", events: game.events.slice(0, upTo + 1) },
    true,
    `${liveGame}-live-${liveRun}`,
  );
  await frame();
}

/**
 * The playable board (GameBoard) on the struggling game, as a local lab shows it: the
 * game so far up to event `upTo`; `growPlay(n)` delivers the model's next events; the
 * moves the board submits are kept for `played()`.
 */
const submitted: string[] = [];
function showPlay(upTo: number) {
  root.render(
    <I18nextProvider i18n={i18n}>
      <div className="cc-public-shell">
        <main className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain">
          <div className="cc-app">
            <section className="cc-board-panel">
              <GameBoard
                key={`play-${liveRun}`}
                match={{
                  ...struggle,
                  status: "running",
                  events: struggle.events.slice(0, upTo + 1),
                }}
                onMove={(move) => submitted.push(move)}
                disabled={false}
                lookups
              />
            </section>
          </div>
        </main>
      </div>
    </I18nextProvider>,
  );
}
async function mountPlay(upTo: number) {
  liveRun++;
  submitted.length = 0;
  showPlay(upTo);
  await frame();
}
async function growPlay(upTo: number) {
  mark = performance.now();
  showPlay(upTo);
  await frame();
}
const played = () => [...submitted];

/** What the board shows now: pieces in motion, red rings, the caption, a flashing row. */
function motion() {
  const ghosts = [...document.querySelectorAll<HTMLElement>(".cc-ghost")].map((ghost) => {
    const rect = ghost.getBoundingClientRect();
    return {
      effect: [...ghost.classList].find((name) => name.startsWith("cc-ghost-"))?.slice(9) ?? "",
      transform: getComputedStyle(ghost).transform,
      opacity: getComputedStyle(ghost).opacity,
      cx: rect.x + rect.width / 2,
      cy: rect.y + rect.height / 2,
    };
  });
  const panel = document.querySelector(".cc-board-panel")?.getBoundingClientRect();
  const board = document.querySelector(".cc-board")?.getBoundingClientRect();
  return {
    layer: !!document.querySelector(".cc-motion-layer"),
    ghosts,
    rings: document.querySelectorAll(".cc-illegal-ring").length,
    caption: document.querySelector(".cc-illegal-caption")?.textContent ?? null,
    evaluation: document.querySelector(".cc-eval-bar")?.getAttribute("aria-label") ?? null,
    graph:
      document
        .querySelector('input[aria-label="Evaluation over the game"]')
        ?.getAttribute("aria-valuetext") ?? null,
    announced: [...announced],
    flash: document.querySelectorAll(".cc-player-flash").length,
    hidden: document.querySelectorAll(".cc-piece-hidden").length,
    counter: document.querySelector(".cc-replay-counter")?.textContent ?? "",
    panel: panel && { x: panel.x, y: panel.y, width: panel.width, height: panel.height },
    board: board && { x: board.x, y: board.y, width: board.width, height: board.height },
  };
}

/** When the last click (or delivered live update) happened, page time. */
let mark = performance.now();
document.addEventListener(
  "click",
  () => {
    mark = performance.now();
  },
  true,
);

/** The board every animation frame for `ms` after the last click or update. */
async function record(ms: number) {
  const samples: Array<ReturnType<typeof motion> & { t: number }> = [];
  for (let t = performance.now() - mark; t < ms; t = performance.now() - mark) {
    samples.push({ ...motion(), t: Math.round(t), panel: undefined, board: undefined });
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return samples;
}

/** The centre of a square's button as displayed (flipped or not), and the square's size. */
function square(name: string) {
  const button = [...document.querySelectorAll<HTMLElement>(".cc-square")].find((element) =>
    element.getAttribute("aria-label")?.endsWith(` ${name}`),
  );
  const rect = button?.getBoundingClientRect();
  return rect
    ? { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, size: rect.width }
    : null;
}

/** Delivers live updates at the given times (ms) and samples the board meanwhile. */
async function scripted(steps: Array<{ at: number; upTo: number }>, ms: number) {
  mark = performance.now();
  for (const step of steps) setTimeout(() => void grow(step.upTo, false), step.at);
  const samples: Array<ReturnType<typeof motion> & { t: number }> = [];
  for (let t = 0; t < ms; t = performance.now() - mark) {
    samples.push({ ...motion(), t: Math.round(t), panel: undefined, board: undefined });
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return samples;
}

function theme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
}

async function mount(kind: "plain" | "finished" | "live") {
  const match = fixtureGame(kind === "live" ? { clock: { w: 300_000, b: 300_000 } } : {});
  // White is to move after the fixture's four moves: White resigns.
  if (kind === "finished") finishMatch(match, "0-1", "resignation");
  if (kind === "live")
    // White's next attempt started 5 s ago (its reservation): its clock is running.
    match.events.push({
      type: "reservation",
      seq: match.events.length,
      at: new Date(Date.now() - 5000).toISOString(),
      side: "w",
      ply: 4,
      dispatch: 0,
      tokens: 100,
      costMicros: 1,
    });
  root.render(
    <I18nextProvider i18n={i18n}>
      <div className="cc-public-shell">
        <main className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain">
          <div className="cc-app">
            <MatchReplay key={`${match.id}-${kind}`} match={match} live={kind === "live"} />
          </div>
        </main>
      </div>
    </I18nextProvider>,
  );
  await frame();
}

/** The centre of the first element matching `selector` (scrolled into view), or null. */
async function centre(selector: string, text?: string) {
  const element = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (candidate) => text === undefined || candidate.textContent?.includes(text),
  );
  if (!element) return null;
  element.scrollIntoView({ block: "center" });
  await frame();
  const rect = element.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function state() {
  const board = document.querySelector(".cc-board-cell")?.getBoundingClientRect();
  const panel = document.querySelector(".cc-board-panel")?.getBoundingClientRect();
  const bubble = document.querySelector<HTMLElement>(".cc-remark-bubble");
  const slot = bubble?.closest(".cc-bubble-slot");
  const focused = document.activeElement;
  return {
    /** The board's offset inside its panel: a layout jump changes it. */
    boardTop: board && panel ? Math.round((board.y - panel.y) * 100) / 100 : null,
    bubble: bubble
      ? {
          slot: slot?.classList.contains("cc-bubble-slot-top") ? "top" : "bottom",
          side: bubble.classList.contains("cc-remark-w") ? "w" : "b",
          text: bubble.querySelector(".cc-remark-text")?.textContent ?? "",
          animation: getComputedStyle(bubble).animationName,
        }
      : null,
    slotHeights: [...document.querySelectorAll<HTMLElement>(".cc-bubble-slot")].map(
      (element) => element.getBoundingClientRect().height,
    ),
    counter: document.querySelector(".cc-replay-counter")?.textContent ?? "",
    /** The banner's bottom and the board's top, page coordinates (null without banner). */
    bannerBottom:
      document.querySelector(".cc-result-banner")?.getBoundingClientRect().bottom ?? null,
    boardTopPage: board?.y ?? null,
    clocks: Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>(".cc-clock")].map((clock) => [
        clock.getAttribute("aria-label")?.split(" ")[0] ?? "",
        clock.textContent ?? "",
      ]),
    ),
    banner: document.querySelector(".cc-result-banner")?.textContent ?? null,
    focusedId: focused?.id ?? "",
    selectedTab:
      document.querySelector('[role="tab"][aria-selected="true"]')?.id.split("-tab-")[1] ?? "",
    hiddenPanels: [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
      .filter((panelElement) => panelElement.hidden)
      .map((panelElement) => panelElement.id.split("-panel-")[1]),
  };
}

(window as unknown as { replay: unknown }).replay = {
  mount,
  centre,
  state,
  mountStruggle,
  grow,
  motion,
  record,
  theme,
  mountPlay,
  growPlay,
  played,
  square,
  scripted,
};
document.title = "ready";
