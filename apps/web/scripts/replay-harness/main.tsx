import { finishMatch } from "@cockpit-chess/chess";
import chessEn from "@locales/en-US/chess.json";
import commonEn from "@locales/en-US/common.json";
import i18next from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { fixtureGame } from "../../src/components/chess/fixture-game";
import { MatchReplay } from "../../src/components/chess/replay";
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
        <main className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain [scrollbar-gutter:stable]">
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

(window as unknown as { replay: unknown }).replay = { mount, centre, state };
document.title = "ready";
