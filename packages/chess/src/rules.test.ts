import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  boardAt,
  createMatch,
  finishMatch,
  illegalPolicy,
  type MatchArchive,
  matchConfigSchema,
  REPLY_CAP_MAX,
  REPLY_CAP_MIN,
  replyCap,
  rulesSchema,
  serializeArchive,
  sideClockMs,
  submitMove,
  validateArchive,
} from "./index";

const player = { name: "Baseline", model: "random", protocol: "random" as const };
describe("versioned rules", () => {
  // 201 archived plies take a few seconds: each move re-checks the game's draw rules.
  it("keeps a cockpit-v1 game running past the old 200-ply cap", { timeout: 30_000 }, () => {
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
  it("creates new matches under cockpit-v1 with no move cap, untimed, remarks off", () => {
    const match = createMatch({ white: player, black: player, rules: {} });
    expect(match.config.rules).toMatchObject({
      version: "cockpit-v1",
      remarks: "off",
      clock: null,
    });
    expect(match.config.rules).not.toHaveProperty("maxPlies");
    expect(sideClockMs(match.config.rules, "w")).toBeNull();
    expect(match.config.rules.remarks).toBe("off");
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
      expect(read.config.rules.remarks).toBe(remarks);
      expect(sideClockMs(read.config.rules, "w")).toBe(900000);
      expect(sideClockMs(read.config.rules, "b")).toBe(300000);
    }
  });
  it("accepts only the launch ruleset and refuses obsolete settings", () => {
    const parse = (rules: unknown) =>
      matchConfigSchema.safeParse({ white: player, black: player, rules }).success;
    expect(parse({ version: "cockpit-v1" })).toBe(true);
    expect(parse({ version: "cockpit-v2" })).toBe(false);
    expect(parse({ version: "cockpit-v3" })).toBe(false);
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
  it("fails old prerelease rulesets with a clear unsupported-ruleset message", () => {
    const match = createMatch({ white: player, black: player, rules: {} });
    for (const version of ["cockpit-v2", "cockpit-v3", "future-rules"]) {
      const archive = {
        ...match,
        config: { ...match.config, rules: { ...match.config.rules, version } },
      };
      expect(() => validateArchive(archive)).toThrow("Unsupported ruleset");
    }
    const legacy = {
      ...match,
      config: {
        ...match.config,
        rules: { version: "cockpit-v1", trashTalk: true, maxPlies: 200, timeBudgetMs: 600000 },
      },
    };
    expect(() => validateArchive(legacy)).toThrow("Unsupported ruleset");
  });
  it("rejects a clock forfeit in an untimed game", () => {
    const match = createMatch({ white: player, black: player, rules: {} });
    const chess = boardAt(match);
    submitMove(match, chess, "e2e4");
    submitMove(match, chess, "e7e5");
    finishMatch(match, "0-1", "timeout");
    expect(() => validateArchive(match)).toThrow("Clock forfeit in an untimed game");
    const timed = createMatch({
      white: player,
      black: player,
      rules: { clock: { w: 60000, b: 60000 } },
    });
    timed.events = structuredClone(match.events);
    finishMatch(timed, "0-1", "timeout");
    expect(validateArchive(timed).termination).toBe("timeout");
  });
  it("keeps remarks only when the tone allows them", () => {
    const quiet = createMatch({ white: player, black: player, rules: {} });
    expect(submitMove(quiet, boardAt(quiet), "e2e4", "ignored").comment).toBe("");
    const loud = createMatch({ white: player, black: player, rules: { remarks: "trash-talk" } });
    submitMove(loud, boardAt(loud), "e2e4", "Your move, if you can find one.");
    const forged = structuredClone(loud);
    forged.config.rules = rulesSchema.parse({});
    expect(() => validateArchive(forged)).toThrow("Unsupported");
    const quietWithComment = createMatch({ white: player, black: player, rules: {} });
    quietWithComment.events = structuredClone(loud.events);
    expect(() => validateArchive(quietWithComment)).toThrow("Commentary violates ruleset");
  });
});

describe("what repeated illegal moves do", () => {
  const illegal = (match: MatchArchive, count: number) => {
    const chess = boardAt(match);
    for (let index = 0; index < count && match.status === "running"; index += 1)
      submitMove(match, chess, "e2e5");
    return chess;
  };
  it("writes default rules by omission under one stable rules key", () => {
    // Default cockpit-v1 rules: no reply cap and no illegalPolicy key. The server's rules
    // key (first 16 hex of the SHA-256) is pinned so a change to the defaults is deliberate.
    const written =
      '{"version":"cockpit-v1","context":"fresh","opponentIdentity":"hidden",' +
      '"representation":"ascii","legalMoves":"tool","moveFormat":"strict",' +
      '"tokenAccounting":"provider","engineEvaluation":"off","engineNodes":10000,' +
      '"engineCallsPerTurn":2,"maxAttempts":3,"turnTimeoutMs":60000,"maxDispatches":6,' +
      '"tokenBudget":1000000,"costBudgetMicros":1000000,"remarks":"off","clock":null}';
    const key = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
    expect(key(written)).toBe("8bddcc60e9886ef5");
    expect(JSON.stringify(rulesSchema.parse(JSON.parse(written)))).toBe(written);
    expect(illegalPolicy(rulesSchema.parse(JSON.parse(written)))).toBe("forfeit");
    expect(replyCap(rulesSchema.parse(JSON.parse(written)))).toBeNull();
    for (const rules of [{}, { illegalPolicy: "forfeit" as const }])
      expect(
        JSON.stringify(createMatch({ white: player, black: player, rules }).config.rules),
      ).toBe(written);
  });
  it("keeps an optional reply cap in the rules (and so in the rules key)", () => {
    const capped = createMatch({ white: player, black: player, rules: { maxOutputTokens: 2048 } });
    expect(replyCap(capped.config.rules)).toBe(2048);
    expect(JSON.stringify(capped.config.rules)).toContain('"maxOutputTokens":2048');
    for (const maxOutputTokens of [REPLY_CAP_MIN - 1, REPLY_CAP_MAX + 1])
      expect(() =>
        createMatch({ white: player, black: player, rules: { maxOutputTokens } }),
      ).toThrow();
  });
  it("records the default by omission and keeps only retry", () => {
    const forfeit = createMatch({
      white: player,
      black: player,
      rules: { illegalPolicy: "forfeit" },
    });
    expect(forfeit.config.rules).not.toHaveProperty("illegalPolicy");
    const retry = createMatch({ white: player, black: player, rules: { illegalPolicy: "retry" } });
    expect(retry.config.rules).toMatchObject({ illegalPolicy: "retry" });
    expect(() =>
      matchConfigSchema.parse({ white: player, black: player, rules: { illegalPolicy: "never" } }),
    ).toThrow();
  });
  it("forfeits after maxAttempts by default and replays that archive", () => {
    const match = createMatch({ white: player, black: player, rules: { maxAttempts: 2 } });
    illegal(match, 2);
    expect(match).toMatchObject({ termination: "illegal-forfeit", result: "0-1" });
    expect(validateArchive(JSON.parse(serializeArchive(match)))).toEqual(match);
  });
  it("keeps trying: no forfeit however many rejections, and the archive replays", () => {
    const match = createMatch({
      white: player,
      black: player,
      rules: { maxAttempts: 1, illegalPolicy: "retry" },
    });
    const chess = illegal(match, 12);
    expect(match.status).toBe("running");
    submitMove(match, chess, "e2e4");
    expect(match.events.filter((event) => event.type === "attempt")).toHaveLength(13);
    expect(validateArchive(JSON.parse(serializeArchive(match)))).toEqual(match);
  });
  it("rejects a forfeit recorded under keep trying", () => {
    const match = createMatch({
      white: player,
      black: player,
      rules: { maxAttempts: 1, illegalPolicy: "retry" },
    });
    illegal(match, 3);
    finishMatch(match, "0-1", "illegal-forfeit");
    expect(() => validateArchive(JSON.parse(serializeArchive(match)))).toThrow("Invalid forfeit");
  });
});
