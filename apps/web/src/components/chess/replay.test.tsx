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
const render = (match: ReturnType<typeof fixtureGame>) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <MatchReplay match={match} />
    </I18nextProvider>,
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
  it("explains a game that enabled evaluation but recorded none", () => {
    const match = fixtureGame();
    match.events = [];
    const html = render(match);
    expect(html).not.toContain("cc-eval-bar");
    expect(html).toContain("No engine evaluations were recorded for this game yet.");
  });
  it("hides the bar and says why when the game has no evaluations", () => {
    const html = render(fixtureGame({ evaluations: false }));
    expect(html).not.toContain("cc-eval-bar");
    expect(html).not.toContain("cc-eval-graph");
    expect(html).toContain("No evaluation bar: Stockfish evaluation after each move was off");
  });
  it("lists remarks with their moves as plain text, never markup or links", () => {
    const html = render(fixtureGame());
    expect(html).toContain("Table talk");
    expect(html).toContain("Trash talk");
    expect(html).toContain("Move 1 · e4");
    expect(html).toContain("Your move, &lt;b&gt;tin can&lt;/b&gt;.");
    expect(html).not.toContain("<b>tin can</b>");
    expect(html).toContain("[click](https://example.com)");
    expect(html).not.toContain('href="https://example.com"');
    // The rejected attempt's remark is tied to the move it came with.
    expect(html).toContain("Move 2 · a1a8");
  });
  it("says remarks were off in the header when the tone was off", () => {
    const html = render(fixtureGame({ remarks: "off" }));
    expect(html).toContain("No remarks");
    expect(html).not.toContain("Table talk");
  });
  it("shows a model id under the name only when it differs", () => {
    const html = render(fixtureGame());
    expect(html).toContain("<strong>GPT-4.1 Nano</strong><span>openai/gpt-4.1-nano</span>");
    expect(html).toContain("<strong>openai/gpt-4.1-mini</strong></div>");
    expect(html.match(/openai\/gpt-4\.1-mini/g)).toHaveLength(1);
  });
});
