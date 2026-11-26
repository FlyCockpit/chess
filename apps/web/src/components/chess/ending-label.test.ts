import {
  archiveSchema,
  boardAt,
  createMatch,
  finishMatch,
  type MatchArchive,
  rulesSchema,
  submitMove,
} from "@cockpit-chess/chess";
import {
  endingDetail,
  endingHeadline,
  endingSummary,
  endingText,
  matchEnding,
  timeControlText,
} from "@cockpit-chess/chess/ending";
import { asCockpitV1 } from "@cockpit-chess/chess/testing";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import esChess from "@cockpit-chess/locales/src/es-MX/chess.json";
import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import {
  endingHeadlineLabel,
  endingLabel,
  remarkToneLabel,
  timeControlLabel,
} from "./ending-label";

const i18n = createInstance();
let t: TFunction<"chess">;
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["chess"],
    defaultNS: "chess",
    resources: { "en-US": { chess: enChess }, "es-MX": { chess: esChess } },
    interpolation: { escapeValue: false },
  });
  t = i18n.getFixedT("en-US", "chess") as TFunction<"chess">;
});

const player = { name: "Baseline", model: "random", protocol: "random" as const };
const game = (rules: Record<string, unknown> = {}, initialFen?: string) =>
  createMatch({ white: player, black: player, rules, ...(initialFen ? { initialFen } : {}) });
const play = (match: MatchArchive, ...moves: string[]) => {
  const chess = boardAt(match);
  for (const move of moves) submitMove(match, chess, move);
  return match;
};
const ended = (
  match: MatchArchive,
  termination: MatchArchive["termination"],
  result: MatchArchive["result"],
  status: MatchArchive["status"] = "completed",
) => {
  finishMatch(match, result, termination, status);
  return match;
};
/** Black (to move) has a call in flight: reserved, never reported. */
const reserved = (match: MatchArchive) => {
  match.events.push({
    type: "reservation",
    seq: match.events.length,
    at: new Date().toISOString(),
    side: "b",
    ply: 1,
    dispatch: 0,
    tokens: 900,
    costMicros: 20_000,
  });
  return match;
};
/** Rejected replies cut off at their output limit, then the given moves. */
const cutOff = (match: MatchArchive, count: number, ...moves: string[]) => {
  const chess = boardAt(match);
  for (let index = 0; index < count; index += 1)
    submitMove(match, chess, "[truncated]", "", undefined, {
      text: "Let me think",
      stopReason: "output-truncated",
    });
  for (const move of moves) submitMove(match, chess, move);
  return match;
};
const sicilian = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "e7e5"];
const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
/** One match per termination (and every draw kind and illegal-move reason). */
const fixtures = (): Array<[string, MatchArchive]> => [
  ["playing", game()],
  ["checkmate", play(game(), "f2f3", "e7e5", "g2g4", "d8h4")],
  ["stalemate", game({}, "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")],
  ["insufficient material", game({}, "8/8/8/4k3/8/8/8/4K3 w - - 0 1")],
  ["fifty-move rule", play(game({}, "4k3/8/8/8/8/8/R7/4K3 w - - 99 60"), "a2a3")],
  ["threefold repetition", play(game(), ...shuffle, ...shuffle)],
  ["owner's forfeit", play(game(), ...sicilian, "d2d4", "d2d3", "d2d4")],
  [
    "mixed forfeit",
    play(game({ maxAttempts: 5 }), "g1f3", "e7e5", "g1h3", "e5e4", "a3a4", "f3f6", "hello"),
  ],
  ["single forfeit", play(game({ maxAttempts: 1 }), "e2e5")],
  ["cut-off forfeit", cutOff(game(), 3)],
  ["single cut-off forfeit", cutOff(game({ maxAttempts: 1 }), 1)],
  ["cut-off and illegal forfeit", cutOff(game(), 2, "e2e5")],
  ["clock", ended(game({ clock: { w: 600000, b: 600000 } }), "timeout", "0-1")],
  ["uneven clock", ended(play(game({ clock: { w: 900000, b: 90000 } }), "e2e4"), "timeout", "1-0")],
  ["move limit", ended(play(game(), "e2e4"), "move-timeout", "1-0")],
  ["tokens", ended(game({ tokenBudget: 12000 }), "token-budget", "0-1")],
  ["spend", ended(play(game(), "e2e4"), "cost-budget", "1-0")],
  ["small spend", ended(play(game({ costBudgetMicros: 1200 }), "e2e4"), "cost-budget", "1-0")],
  ["rounded spend", ended(play(game({ costBudgetMicros: 999_999 }), "e2e4"), "cost-budget", "1-0")],
  ["unsettled spend", ended(reserved(play(game(), "e2e4")), "cost-budget", "1-0")],
  [
    "pawn that changed file",
    play(game(), "f2f4", "e7e5", "f4e5", "g8f6", "e5e6", "f6g8", "e5e6", "e5e6", "e5e6"),
  ],
  ["v1 timeout", ended(asCockpitV1(play(game(), "e2e4")), "timeout", "1-0")],
  [
    "missing promotion piece",
    play(game({ maxAttempts: 2 }, "4k3/P7/8/8/8/8/4P3/4K3 w - - 0 1"), "a7a8", "e2e5"),
  ],
  ["resignation", ended(play(game(), "e2e4"), "resignation", "1-0")],
  ["ply limit", play(asCockpitV1(game(), { maxPlies: 2 }), "e2e4", "e7e5")],
  ["cancelled", ended(game(), "cancelled", "*", "stopped")],
  ["interrupted", ended(game(), "interrupted", "*", "error")],
  ["provider error", ended(play(game(), "e2e4"), "provider-error", "*", "error")],
  ["engine error", ended(game(), "engine-error", "*", "error")],
  ["event limit", ended(game(), "event-limit", "*", "error")],
];

describe("ending labels", () => {
  it("covers every termination the archive format allows", () => {
    const kinds = new Set(fixtures().map(([, match]) => match.termination));
    expect([...kinds].sort()).toEqual([...archiveSchema.shape.termination.options].sort());
  });
  it.each(fixtures())("renders %s exactly as the shared English mapping", (_name, match) => {
    const ending = matchEnding(match);
    expect(endingLabel(t, "en-US", ending)).toBe(endingText(ending));
    expect(endingHeadlineLabel(t, endingSummary(ending))).toBe(
      endingHeadline(endingSummary(ending)),
    );
    expect(endingDetail(ending) === null).toBe(!endingLabel(t, "en-US", ending).includes("("));
  });
  it("names the owner's game in plain words, in the banner and on the card", () => {
    const match = play(game(), ...sicilian, "d2d4", "d2d3", "d2d4");
    const ending = matchEnding(match);
    expect(endingLabel(t, "en-US", ending)).toBe(
      "White forfeited: 3 illegal moves (d2d4, d2d3, d2d4; its d-pawn had already moved)",
    );
    expect(endingHeadlineLabel(t, endingSummary(ending))).toBe("White forfeited: 3 illegal moves");
    // A row backfilled before the summary carried details still reads correctly.
    expect(endingHeadlineLabel(t, { kind: "illegal-forfeit", side: "w", illegal: 3 })).toBe(
      "White forfeited: 3 illegal moves",
    );
    expect(endingHeadlineLabel(t, { kind: "draw" })).toBe("Draw");
    expect(endingHeadlineLabel(t, { kind: "provider-error" })).toBe("A model provider failed");
  });
  it("says a side spent at least its reported cost while a call never reported", () => {
    const ending = matchEnding(ended(reserved(play(game(), "e2e4")), "cost-budget", "1-0"));
    expect(endingLabel(t, "en-US", ending)).toBe(
      "Black ran out of budget (spent at least $0.00 of $1.00)",
    );
  });
  it("renders Spanish from its own keys, with plurals", () => {
    const es = i18n.getFixedT("es-MX", "chess") as TFunction<"chess">;
    const match = play(game(), ...sicilian, "d2d4", "d2d3", "d2d4");
    expect(endingLabel(es, "es-MX", matchEnding(match))).toBe(
      "Blanco perdió por 3 jugadas ilegales (d2d4, d2d3, d2d4; su peón de la columna d ya se había movido)",
    );
    expect(endingHeadlineLabel(es, { kind: "illegal-forfeit", side: "b", illegal: 1 })).toBe(
      "Negro perdió por 1 jugada ilegal",
    );
  });
  it("labels the time control and the remark tone", () => {
    for (const rules of [
      {},
      { clock: { w: 600000, b: 600000 } },
      { clock: { w: 900000, b: 300000 } },
      { clock: { w: 90000, b: 45000 }, turnTimeoutMs: 30000 },
    ]) {
      const parsed = rulesSchema.parse(rules);
      expect(timeControlLabel(t, parsed)).toBe(timeControlText(parsed));
    }
    expect(timeControlLabel(t, rulesSchema.parse({ clock: { w: 900000, b: 300000 } }))).toBe(
      "White 15 min · Black 5 min",
    );
    expect(remarkToneLabel(t, "trash-talk")).toBe("Trash talk");
    expect(remarkToneLabel(t, "commentary")).toBe("Commentary");
    expect(remarkToneLabel(t, "off")).toBe("No remarks");
  });
});
