import {
  boardAt,
  finishMatch,
  legalMoves,
  type MatchArchive,
  submitMove,
} from "@cockpit-chess/chess";
import { gamePositions, type SpectatorEvaluations } from "@cockpit-chess/chess/spectator";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import esChess from "@cockpit-chess/locales/src/es-MX/chess.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { ChessBoard } from "./chess-board";
import { fixtureGame } from "./fixture-game";
import { MatchReplay } from "./replay";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, common: enCommon }, "es-MX": { chess: esChess } },
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
    // The rejected attempt's remark is tied to the move it came with, and marked
    // rejected; remarks with played moves are not.
    expect(html).toContain('Move 2 · a1a8 · <span class="cc-remark-rejected">rejected</span>');
    expect(html.match(/class="cc-remark-rejected"/g)).toHaveLength(1);
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
  it("shows each model's live spend against its budget", () => {
    const match = fixtureGame({ remarks: "off" });
    const base = () => ({
      seq: match.events.length,
      at: new Date().toISOString(),
      side: "w" as const,
    });
    const ply = match.events.filter((event) => event.type === "attempt" && event.accepted).length;
    // White is to move; a dispatch in flight counts as "at least".
    match.events.push({
      ...base(),
      ply,
      type: "reservation",
      dispatch: 0,
      tokens: 9000,
      costMicros: 90_000,
    });
    let html = render(match);
    expect(html).toContain("White · spent at least $0.00 of $1.00 (usage still settling)");
    expect(html).toContain("Black · spent $0.00 of $1.00");
    expect(html).toContain("at most 9000 tokens reserved for one request");
    // Once the game has ended, a missing report will never arrive: final wording.
    const ended = structuredClone(match);
    finishMatch(ended, "0-1", "move-timeout");
    const final = render(ended);
    expect(final).toContain(
      "White · spent at least $0.00 of $1.00 (one call&#x27;s usage was never reported)",
    );
    expect(final).not.toContain("still settling");
    match.events.push({
      ...base(),
      ply,
      type: "usage",
      dispatch: 0,
      inputTokens: 1000,
      outputTokens: 200,
      costMicros: 120_000,
    });
    html = render(match);
    expect(html).toContain("White · spent $0.12 of $1.00");
  });
  it("counts illegal attempts per side in the result banner and the stats", () => {
    const match = fixtureGame({ remarks: "off" });
    const chess = boardAt(match);
    submitMove(match, chess, "e2e5");
    submitMove(match, chess, "a1a5");
    finishMatch(match, "0-1", "cost-budget");
    const html = render(match);
    expect(html).toContain("<strong>White ran out of budget</strong>");
    expect(html).toContain(
      "<span>spent $0.00 of $1.00; not enough left for another request</span>",
    );
    // The fixture already holds one rejected Black move.
    expect(html).toContain("Illegal attempts: White 2 · Black 1");
    expect(html).toContain("<strong>2 / 1</strong>");
    expect(html).toContain("Rejected moves (White / Black)");
  });
  it("tells a cut-off reply apart and shows the recorded reply as escaped plain text", () => {
    const match = fixtureGame({ remarks: "off" });
    const chess = boardAt(match);
    submitMove(match, chess, "[truncated]", "", undefined, {
      text: 'Thinking <img src=x onerror="alert(1)"> about e4',
      stopReason: "output-truncated",
    });
    const html = render(match);
    expect(html).toContain("Rejected · ran out of space");
    expect(html).toContain(
      "Rejected: the reply ran out of space before giving a move. The board stays unchanged.",
    );
    expect(html).toContain("The model&#x27;s reply");
    expect(html).toContain("The reply was cut off at its output limit before it gave a move.");
    expect(html).toContain("Thinking &lt;img src=x onerror=&quot;alert(1)&quot;&gt; about e4");
    expect(html).not.toContain("<img src=x");
    finishMatch(match, "0-1", "cost-budget");
    expect(render(match)).toContain("Ran out of space: White 1 · Black 0");
    // A finished reply whose move was readable but not legal says so.
    const illegal = fixtureGame({ remarks: "off" });
    submitMove(illegal, boardAt(illegal), "e2e5", "", undefined, {
      text: '{"move":"e2e5"}',
      stopReason: "completed",
    });
    const illegalHtml = render(illegal);
    expect(illegalHtml).toContain("The reply finished; its move is not legal in this position.");
    expect(illegalHtml).not.toContain("without a readable move");
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
  it("paints the latest lookup on the board and names it in the timeline", () => {
    const match = fixtureGame({ evaluations: false, remarks: "off" });
    const lookup = (square: string | undefined) => {
      const chess = boardAt(match);
      match.events.push({
        type: "tool",
        name: "legal_moves",
        seq: match.events.length,
        at: new Date().toISOString(),
        side: chess.turn(),
        ply: 4,
        input: JSON.stringify({ square }),
        output: legalMoves(chess, square).join(" "),
      });
    };
    lookup(undefined);
    lookup("f3");
    // Bookkeeping after the lookup keeps the board marks and the caption.
    match.events.push({
      type: "timing",
      seq: match.events.length,
      at: new Date().toISOString(),
      side: "w",
      ply: 4,
      elapsedMs: 10,
    });
    const html = render(match);
    // White's knight on f3 (after 1.e4 e5 2.Nf3 Nc6): a ring on e5, dots elsewhere.
    expect(html.match(/class="cc-lookup-from"/g)).toHaveLength(1);
    expect(html.match(/class="cc-lookup-capture"/g)).toHaveLength(1);
    expect(html.match(/class="cc-lookup-target"/g)).toHaveLength(4);
    expect(html).toMatch(/aria-label="White knight on f3"[^>]*>(?:(?!<\/button>).)*cc-lookup-from/);
    expect(html).toMatch(
      /aria-label="Black pawn on e5"[^>]*>(?:(?!<\/button>).)*cc-lookup-capture/,
    );
    expect(html).toContain("Checked moves for the knight on f3: Nd4, Nxe5, Ng5, Nh4, Ng1");
    expect(html).toContain("Checked all legal moves (27 moves)");
    expect(html).toMatch(/class="cc-event-caption"[^>]*>Checked moves for the knight on f3: Nd4/);
    // Under the board too, whichever sidebar tab is open (a reserved line otherwise).
    expect(html).toMatch(
      /<p class="cc-lookup-note"[^>]*><span aria-hidden="true" class="cc-lookup-key"><\/span><span class="cc-lookup-text">White · Checked moves for the knight on f3: Nd4/,
    );
    expect(html).toMatch(
      /Selected tool input and result[\s\S]*\{&quot;square&quot;:&quot;f3&quot;\}/,
    );
    expect(
      html.match(/aria-hidden="true" class="cc-lookup-(?:from|target|capture)"/g),
    ).toHaveLength(6);
    // Spanish names the piece with its article.
    void i18n.changeLanguage("es-MX");
    expect(render(match)).toContain("Revisó las jugadas para el caballo en f3: Nd4, Nxe5");
    void i18n.changeLanguage("en-US");
    // The move ends it; so does the end of the game.
    const chess = boardAt(match);
    submitMove(match, chess, "f3e5", "");
    expect(render(match)).not.toContain('class="cc-lookup-from"');
    match.events.pop();
    finishMatch(match, "*", "cancelled", "stopped");
    expect(render(match)).not.toContain('class="cc-lookup-from"');
    expect(render(match)).toMatch(/<p class="cc-lookup-note"[^>]*><\/p>/);
    match.config.rules = { ...match.config.rules, legalMoves: "provided" };
    expect(render(match)).not.toContain("cc-lookup-note");
  });
  it("keeps naming a lookup without board marks over the bookkeeping after it", () => {
    const allMoves = (remarks: "commentary" | "off") => {
      const match = fixtureGame({ evaluations: false, remarks });
      const chess = boardAt(match);
      const base = { at: new Date().toISOString(), side: "w" as const, ply: 4 };
      match.events.push(
        {
          ...base,
          type: "tool",
          name: "legal_moves",
          seq: match.events.length,
          input: "{}",
          output: legalMoves(chess).join(" "),
        },
        {
          ...base,
          type: "usage",
          seq: match.events.length + 1,
          dispatch: 0,
          inputTokens: 1,
          outputTokens: 1,
          costMicros: 0,
        },
      );
      return match;
    };
    const match = allMoves("commentary");
    const html = render(match);
    expect(html).not.toContain('class="cc-lookup-from"');
    expect(html).not.toContain("cc-lookup-key");
    expect(html).toMatch(/class="cc-event-caption"[^>]*>Checked all legal moves \(27 moves\)/);
    // Chat is the open tab, so the note under the board is the one that announces.
    expect(html).toMatch(
      /<p class="cc-lookup-note" aria-live="polite"><span class="cc-lookup-text">White · Checked all legal moves \(27 moves\)/,
    );
    expect(render(allMoves("off"))).toContain('<p class="cc-lookup-note" aria-live="off">');
  });
  it("outlines the latest illegal attempt and captions it over the board until the next action", () => {
    const match = fixtureGame({ evaluations: false, remarks: "off" });
    const chess = boardAt(match);
    // After 1.e4 e5 2.Nf3 Nc6: White tries its f3 knight on e6.
    submitMove(match, chess, "f3e6");
    const html = render(match);
    expect(html.match(/class="cc-illegal-ring"/g)).toHaveLength(2);
    expect(html).toMatch(
      /aria-label="White knight on f3"[^>]*>(?:(?!<\/button>).)*cc-illegal-ring/,
    );
    expect(html).toMatch(/aria-label="Empty square e6"[^>]*>(?:(?!<\/button>).)*cc-illegal-ring/);
    expect(html).toContain('class="cc-illegal-caption ">White tried Nf3-e6: not a legal move</p>');
    // The board announces each rejected attempt as it plays; the Moves caption, which
    // follows the newest event, leaves rejected attempts to it.
    expect(html).toMatch(
      /<p class="sr-only" aria-live="polite"><span>White tried Nf3-e6: not a legal move<\/span><\/p>/,
    );
    expect(html).toContain('<div class="cc-event-caption" aria-live="off">');
    // Still: no motion on a first render.
    expect(html).not.toContain("cc-motion-layer");
    void i18n.changeLanguage("es-MX");
    expect(render(match)).toContain("Blanco intentó Cf3-e6: no es una jugada legal");
    void i18n.changeLanguage("en-US");
    // A reply that is not a move: the caption and a red flash on the side's row.
    submitMove(match, chess, "Knight to e6, obviously");
    const unreadable = render(match);
    expect(unreadable).not.toContain('class="cc-illegal-ring"');
    expect(unreadable).toContain(
      "White&#x27;s reply couldn&#x27;t be read as a move: “Knight to e6, obviously”",
    );
    expect(unreadable.match(/class="cc-player-flash"/g)).toHaveLength(1);
    // The accepted move ends it.
    submitMove(match, chess, "f3e5");
    const moved = render(match);
    expect(moved).not.toContain("cc-illegal");
    expect(moved).not.toContain("cc-player-flash");
  });
  it("keeps the caption off every outlined square", () => {
    const caption = (squares: Array<"g1" | "e5" | "a8" | "h1">, flipped = false) =>
      /class="cc-illegal-caption ?([a-z-]*)"/.exec(
        renderToStaticMarkup(
          <I18nextProvider i18n={i18n}>
            <ChessBoard
              fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
              flipped={flipped}
              illegal={{ index: 0, squares, caption: "x" }}
            />
          </I18nextProvider>,
        ),
      )?.[1];
    expect(caption(["e5"])).toBe("");
    // g1 is on the bottom edge: the caption goes to the top one.
    expect(caption(["g1", "e5"])).toBe("cc-illegal-caption-top");
    // Flipped, g1 is on top: the bottom edge is free.
    expect(caption(["g1", "e5"], true)).toBe("");
    expect(caption(["a8", "h1"])).toBe("cc-illegal-caption-middle");
  });
  it("announces the attempt from the board in the chat tab too", () => {
    const match = fixtureGame({ evaluations: false, remarks: "trash-talk" });
    submitMove(match, boardAt(match), "f3e6");
    expect(render(match)).toMatch(
      /<p class="sr-only" aria-live="polite"><span>White tried Nf3-e6: not a legal move<\/span><\/p>/,
    );
  });
  it("plays moves in the position to come while the board still shows an earlier one", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ChessBoard
          fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
          playFen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
          onMove={() => undefined}
        />
      </I18nextProvider>,
    );
    // The squares show the earlier position until the motion ends (or a click snaps it).
    expect(html).toContain('aria-label="White pawn on e2"');
    expect(html).toContain('aria-label="Empty square e4"');
  });
});
