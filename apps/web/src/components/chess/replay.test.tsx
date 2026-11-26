import { finishMatch, type MatchArchive } from "@cockpit-chess/chess";
import { gamePositions, type SpectatorEvaluations } from "@cockpit-chess/chess/spectator";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureGame } from "./fixture-game";
import { MatchReplay } from "./replay";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, common: enCommon } },
    defaultNS: "chess",
    react: { useSuspense: false },
  });
});
const render = (
  match: MatchArchive,
  spectator?: { evaluations: SpectatorEvaluations | null; available?: boolean },
) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <MatchReplay match={match} spectator={spectator} />
    </I18nextProvider>,
  );
/** A spectator score of every position of the game, White ahead by `cp` centipawns. */
const scored = (match: MatchArchive, cp: number): SpectatorEvaluations =>
  Object.fromEntries(
    gamePositions(match).map((fen, ply) => [
      String(ply),
      {
        engine: "stockfish-19-lite-single" as const,
        fen,
        depth: 10,
        nodes: 10000,
        cp,
        mate: null,
        bestMove: null,
      },
    ]),
  );

describe("MatchReplay", () => {
  it("draws the evaluation bar at the latest evaluation and the game graph", () => {
    const html = render(fixtureGame());
    expect(html).toContain('class="cc-eval-bar"');
    expect(html).toContain('aria-label="Evaluation: White mates in 2"');
    expect(html).toContain('data-share="1.000"');
    expect(html).toContain('aria-label="Evaluation over the game"');
    expect(html).toContain('aria-valuetext="Move 2: White mates in 2"');
    expect(html).not.toContain("Stockfish evaluation after each move was off");
  });
  it("shows no invented score when the board's position has no evaluation", () => {
    const match = fixtureGame();
    // The last accepted move's own evaluation is not recorded yet (live game).
    match.events.pop();
    const html = render(match);
    expect(html).toContain('aria-label="No engine evaluation for this position."');
    expect(html).toContain("cc-eval-none");
  });
  it("draws the bar from the spectators' evaluation, never shown to the players", () => {
    const match = fixtureGame({ evaluations: false });
    const html = render(match, { evaluations: scored(match, 250) });
    expect(html).toContain('class="cc-eval-bar"');
    expect(html).toContain('aria-label="Evaluation: +2.5"');
    expect(html).toContain("Evaluation: spectators only");
    expect(html).not.toContain("Evaluation: shown to players");
    // A spectator score of another position is never shown for this one.
    const stale = scored(match, 250);
    for (const value of Object.values(stale)) value.fen = "8/8/8/8/8/8/8/K6k w - - 0 1";
    expect(render(match, { evaluations: stale })).not.toContain('class="cc-eval-bar"');
    expect(render(fixtureGame())).toContain("Evaluation: shown to players");
  });
  it("hides the bar with the reason when there is no evaluation", () => {
    const running = fixtureGame({ evaluations: false });
    let html = render(running, { evaluations: null });
    expect(html).not.toContain("cc-eval-bar");
    expect(html).not.toContain("cc-eval-graph");
    expect(html).toContain("The evaluation bar appears once the first positions are scored.");
    finishMatch(running, "*", "cancelled", "stopped");
    html = render(running, { evaluations: {} });
    expect(html).toContain("spectator scores are being computed in the background");
    html = render(running, { evaluations: {}, available: false });
    expect(html).toContain("this companion has no chess engine");
  });
  it("lists remarks in the chat log with their moves as plain text, never markup or links", () => {
    const html = render(fixtureGame());
    // Chat is the selected tab (roving tabindex); both panels stay mounted.
    expect(html).toMatch(/id="[^"]+-tab-chat"[^>]*aria-selected="true" tabindex="0"/);
    expect(html).toMatch(/id="[^"]+-tab-moves"[^>]*aria-selected="false" tabindex="-1"/);
    expect(html).toMatch(/role="tabpanel" id="[^"]+-panel-moves"[^>]*hidden=""/);
    expect(html).not.toMatch(/id="[^"]+-panel-chat"[^>]*hidden=""/);
    expect(html).toContain(">Chat (4)<");
    expect(html).toContain("Trash talk");
    expect(html).toContain("Move 1 · e4");
    expect(html).toContain("Your move, &lt;b&gt;tin can&lt;/b&gt;.");
    expect(html).not.toContain("<b>tin can</b>");
    expect(html).toContain("[click](https://example.com)");
    expect(html).not.toContain('href="https://example.com"');
    // The rejected attempt's remark is tied to the move it came with.
    expect(html).toContain("Move 2 · a1a8");
  });
  it("shows the latest remark as a bubble on its speaker's side of the board", () => {
    const match = fixtureGame();
    const html = render(match);
    // Black spoke last; Black sits at the top, so its bubble is in the top slot.
    const top = html.slice(html.indexOf("cc-bubble-slot-top"), html.indexOf("cc-board-row"));
    expect(top).toContain("cc-remark-bubble cc-remark-b");
    expect(top).toContain("[click](https://example.com)");
    const bottom = html.slice(html.indexOf("cc-bubble-slot-bottom"));
    expect(bottom.slice(0, bottom.indexOf("</div>"))).not.toContain("cc-remark-bubble");
    // Only one bubble at a time: the other side's slot is empty.
    expect(html.match(/cc-remark-bubble/g)).toHaveLength(1);
  });
  it("names the ending in a result banner at the end of a finished game", () => {
    const match = fixtureGame({ remarks: "off" });
    finishMatch(match, "0-1", "move-timeout");
    const html = render(match);
    expect(html).toContain('class="cc-result-banner cc-result-b" role="status"');
    expect(html).toContain("<strong>White ran out of time for one move</strong>");
    expect(html).toContain("<span>1 min per-move limit</span>");
    expect(render(fixtureGame())).not.toContain("cc-result-banner");
  });
  it("shows each side's clock in timed games and none in untimed ones", () => {
    const match = fixtureGame({ clock: { w: 600000, b: 300000 } });
    match.events.push({
      type: "timing",
      seq: match.events.length,
      at: new Date().toISOString(),
      side: "w",
      ply: 4,
      elapsedMs: 75500,
    });
    const html = render(match);
    expect(html).toContain('aria-label="White clock: 8:44"');
    expect(html).toContain('aria-label="Black clock: 5:00"');
    expect(html).toContain("White 10 min · Black 5 min");
    expect(render(fixtureGame())).not.toContain("cc-clock");
  });
  it("says remarks were off in the header when the tone was off", () => {
    const html = render(fixtureGame({ remarks: "off" }));
    expect(html).toContain("No remarks");
    expect(html).not.toContain("cc-tabs");
    expect(html).not.toContain("cc-bubble-slot");
  });
  it("shows a model id under the name only when it differs", () => {
    const html = render(fixtureGame());
    expect(html).toContain("<strong>GPT-4.1 Nano</strong><span>openai/gpt-4.1-nano</span>");
    expect(html).toContain("<strong>openai/gpt-4.1-mini</strong></div>");
    expect(html.match(/openai\/gpt-4\.1-mini/g)).toHaveLength(1);
  });
});
