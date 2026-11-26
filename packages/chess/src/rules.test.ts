import { describe, expect, it } from "vitest";
import {
  archiveSchema,
  boardAt,
  createMatch,
  finishMatch,
  type MatchArchive,
  matchConfigSchema,
  plyLimit,
  type RulesV1,
  remarkTone,
  rulesSchema,
  serializeArchive,
  sideClockMs,
  submitMove,
  validateArchive,
} from "./index";
import { asCockpitV1 } from "./testing";

const player = { name: "Baseline", model: "random", protocol: "random" as const };
/** A cockpit-v1 archive exactly as the previous release wrote it. */
const v1Archive = (rules: Partial<RulesV1> = {}): MatchArchive =>
  JSON.parse(
    serializeArchive(asCockpitV1(createMatch({ white: player, black: player, rules: {} }), rules)),
  );

describe("versioned rules", () => {
  // 201 archived plies take a few seconds: each move re-checks the game's draw rules.
  it("keeps a cockpit-v2 game running past the old 200-ply cap", { timeout: 30_000 }, () => {
    // Fixed pseudo-random legal play; the first seed whose game is still going at 201.
    for (let seed = 1; ; seed++) {
      let state = seed;
      const match = createMatch({ white: player, black: player, rules: {} });
      const chess = boardAt(match);
      let plies = 0;
      while (match.status === "running" && plies < 201) {
        state = (state * 1103515245 + 12345) % 2147483648;
        const moves = chess.moves({ verbose: true });
        const move = moves[state % moves.length];
        if (!move) break;
        submitMove(match, chess, `${move.from}${move.to}${move.promotion ?? ""}`);
        plies += 1;
      }
      if (match.status !== "running") continue;
      expect(match.events.filter((event) => event.type === "attempt").length).toBe(201);
      expect(validateArchive(JSON.parse(serializeArchive(match)))).toEqual(match);
      break;
    }
  });
  it("re-parses a cockpit-v1 ruleset in the key order the previous release wrote", () => {
    // Exactly as cockpit-v1 serialized its defaults: the rules key hashes this text.
    const written =
      '{"version":"cockpit-v1","context":"fresh","opponentIdentity":"hidden",' +
      '"representation":"ascii","legalMoves":"tool","trashTalk":false,"moveFormat":"strict",' +
      '"tokenAccounting":"provider","engineEvaluation":"off","engineNodes":10000,' +
      '"engineCallsPerTurn":2,"maxAttempts":3,"maxPlies":200,"turnTimeoutMs":60000,' +
      '"maxDispatches":6,"maxOutputTokens":512,"tokenBudget":1000000,"timeBudgetMs":600000,' +
      '"costBudgetMicros":1000000}';
    expect(JSON.stringify(rulesSchema.parse(JSON.parse(written)))).toBe(written);
  });
  it("creates new matches under cockpit-v2 with no move cap, untimed, remarks off", () => {
    const match = createMatch({ white: player, black: player, rules: {} });
    expect(match.config.rules).toMatchObject({
      version: "cockpit-v2",
      remarks: "off",
      clock: null,
    });
    expect(match.config.rules).not.toHaveProperty("maxPlies");
    expect(plyLimit(match.config.rules)).toBeNull();
    expect(sideClockMs(match.config.rules, "w")).toBeNull();
    expect(remarkTone(match.config.rules)).toBe("off");
  });
  it("round-trips the remark tone and an uneven clock through the archive", () => {
    for (const remarks of ["off", "commentary", "trash-talk"] as const) {
      const match = createMatch({
        white: player,
        black: player,
        rules: { remarks, clock: { w: 900000, b: 300000 }, turnTimeoutMs: 60000 },
      });
      const read = validateArchive(JSON.parse(serializeArchive(match)));
      expect(read.config.rules).toEqual(match.config.rules);
      expect(remarkTone(read.config.rules)).toBe(remarks);
      expect(sideClockMs(read.config.rules, "w")).toBe(900000);
      expect(sideClockMs(read.config.rules, "b")).toBe(300000);
    }
  });
  it("refuses a cockpit-v1 ruleset, a move cap or an unknown tone for a new match", () => {
    const parse = (rules: unknown) =>
      matchConfigSchema.safeParse({ white: player, black: player, rules }).success;
    expect(parse({ version: "cockpit-v1" })).toBe(false);
    expect(parse({ maxPlies: 20 })).toBe(false);
    expect(parse({ trashTalk: true })).toBe(false);
    expect(parse({ timeBudgetMs: 600000 })).toBe(false);
    expect(parse({ remarks: "roast" })).toBe(false);
    expect(parse({ remarks: "trash-talk" })).toBe(true);
  });
  it("bounds each clock and keeps the per-move limit within the shorter clock", () => {
    const parse = (rules: unknown) => rulesSchema.safeParse(rules).success;
    expect(parse({ clock: { w: 29_999, b: 60_000 }, turnTimeoutMs: 1000 })).toBe(false);
    expect(parse({ clock: { w: 3_600_001, b: 60_000 }, turnTimeoutMs: 1000 })).toBe(false);
    expect(parse({ clock: { w: 300_000, b: 30_000 }, turnTimeoutMs: 30_000 })).toBe(true);
    expect(parse({ clock: { w: 300_000, b: 30_000 }, turnTimeoutMs: 30_001 })).toBe(false);
    expect(parse({ clock: { w: 300_000 } })).toBe(false);
  });
  it("still reads, validates and replays cockpit-v1 archives as they were played", () => {
    const legacy = v1Archive({ trashTalk: true, maxPlies: 2, timeBudgetMs: 120000 });
    expect(archiveSchema.parse(legacy).config.rules.version).toBe("cockpit-v1");
    expect(remarkTone(legacy.config.rules)).toBe("commentary");
    expect(sideClockMs(legacy.config.rules, "b")).toBe(120000);
    expect(plyLimit(legacy.config.rules)).toBe(2);
    const chess = boardAt(legacy);
    submitMove(legacy, chess, "e2e4", "Opening up.");
    submitMove(legacy, chess, "e7e5");
    expect(legacy).toMatchObject({ status: "completed", termination: "ply-limit" });
    expect(validateArchive(JSON.parse(serializeArchive(legacy)))).toEqual(legacy);
    expect(v1Archive().config.rules).toMatchObject({ trashTalk: false, maxPlies: 200 });
    expect(remarkTone(v1Archive().config.rules)).toBe("off");
  });
  it("rejects a ply-limit ending and a clock forfeit where the ruleset has neither", () => {
    const match = createMatch({ white: player, black: player, rules: {} });
    const chess = boardAt(match);
    submitMove(match, chess, "e2e4");
    submitMove(match, chess, "e7e5");
    finishMatch(match, "1/2-1/2", "ply-limit");
    expect(() => validateArchive(match)).toThrow("Invalid ply limit");
    finishMatch(match, "0-1", "timeout");
    expect(() => validateArchive(match)).toThrow("Clock forfeit in an untimed game");
    match.config.rules = rulesSchema.parse({ clock: { w: 60000, b: 60000 } });
    expect(validateArchive(match).termination).toBe("timeout");
  });
  it("keeps remarks only when the tone allows them", () => {
    const quiet = createMatch({ white: player, black: player, rules: {} });
    expect(submitMove(quiet, boardAt(quiet), "e2e4", "ignored").comment).toBe("");
    const loud = createMatch({ white: player, black: player, rules: { remarks: "trash-talk" } });
    submitMove(loud, boardAt(loud), "e2e4", "Your move, if you can find one.");
    const forged = structuredClone(loud);
    forged.config.rules = rulesSchema.parse({});
    expect(() => validateArchive(forged)).toThrow("Commentary violates ruleset");
  });
});
