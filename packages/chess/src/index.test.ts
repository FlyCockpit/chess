import { describe, expect, it } from "vitest";
import {
  applyUci,
  boardAt,
  createMatch,
  DEFAULT_POSITION,
  exportPgn,
  finishMatch,
  legalMoves,
  type MatchEvent,
  matchConfigSchema,
  matchStats,
  submitMove,
  validateArchive,
} from "./index";

const player = { name: "Baseline", model: "random", protocol: "random" as const };
const game = (rules = {}) => createMatch({ white: player, black: player, rules });
describe("authoritative chess and portable archives", () => {
  it("settles terminal starting positions and rejects contradictory imported outcomes", () => {
    const terminal = createMatch({
      white: player,
      black: player,
      rules: {},
      initialFen: "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1",
    });
    expect(terminal).toMatchObject({
      status: "completed",
      termination: "checkmate",
      result: "1-0",
    });
    expect(validateArchive(terminal)).toEqual(terminal);
    const match = game();
    finishMatch(match, "1-0", "cancelled", "stopped");
    expect(() => validateArchive(match)).toThrow("Invalid terminal status");
    finishMatch(match, "1-0", "timeout");
    expect(() => validateArchive(match)).toThrow("Invalid side-to-move forfeit");
  });
  it("accepts interruption only as an unscored error", () => {
    const match = game();
    finishMatch(match, "*", "interrupted", "error");
    expect(validateArchive(match)).toEqual(match);
    for (const status of ["running", "completed", "stopped"] as const) {
      expect(() => validateArchive({ ...match, status })).toThrow();
    }
    expect(() => validateArchive({ ...match, result: "1-0" })).toThrow("Invalid terminal status");
  });
  it("records rejection without advancing board or side, then accepts correction", () => {
    const match = game();
    const chess = boardAt(match);
    expect(submitMove(match, chess, "e2e5")).toMatchObject({
      accepted: false,
      reason: "illegal",
      before: DEFAULT_POSITION,
      fen: DEFAULT_POSITION,
      ply: 0,
    });
    expect(chess.turn()).toBe("w");
    expect(submitMove(match, chess, "e2e4")).toMatchObject({
      accepted: true,
      san: "e4",
      side: "w",
      ply: 0,
    });
    expect(chess.turn()).toBe("b");
    expect(matchStats(match).illegalAttempts).toBe(1);
    expect(validateArchive(JSON.parse(JSON.stringify(match)))).toEqual(match);
  });
  it("forfeits only after configured attempts and never accepts null moves", () => {
    const match = game({ maxAttempts: 2 });
    const chess = boardAt(match);
    submitMove(match, chess, "0000");
    expect(match.status).toBe("running");
    submitMove(match, chess, "e2e5");
    expect(match).toMatchObject({
      status: "completed",
      result: "0-1",
      termination: "illegal-forfeit",
    });
    expect(validateArchive(match)).toEqual(match);
    expect(chess.fen()).toBe(DEFAULT_POSITION);
    expect(() => submitMove(match, chess, "e2e4")).toThrow();
  });
  it("recognizes checkmate and exports a replayable PGN", () => {
    const match = game();
    const chess = boardAt(match);
    for (const move of ["f2f3", "e7e5", "g2g4", "d8h4"]) submitMove(match, chess, move);
    expect(match).toMatchObject({ result: "0-1", termination: "checkmate" });
    expect(validateArchive(match)).toEqual(match);
    expect(exportPgn(match)).toContain("Qh4#");
    expect(boardAt(match, 0).history()).toEqual(["f3"]);
  });
  it("handles underpromotion, castling, and en passant", () => {
    const match = createMatch({
      white: player,
      black: player,
      rules: {},
      initialFen: "7k/P7/8/8/8/8/8/7K w - - 0 1",
    });
    const promotion = boardAt(match);
    expect(submitMove(match, promotion, "a7a8n").san).toBe("a8=N");
    const chess = boardAt(game());
    for (const move of ["e2e4", "a7a6", "e4e5", "d7d5"]) applyUci(chess, move);
    expect(applyUci(chess, "e5d6").isEnPassant()).toBe(true);
    const castle = createMatch({
      white: player,
      black: player,
      rules: {},
      initialFen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
    });
    expect(submitMove(castle, boardAt(castle), "e1g1").san).toBe("O-O");
  });
  it("rejects fabricated boards, accepted illegal moves, extra credential fields, and events after terminal", () => {
    const match = game();
    submitMove(match, boardAt(match), "e2e5");
    const tampered = structuredClone(match);
    const event = tampered.events[0];
    if (event?.type !== "attempt") throw new Error("Fixture missing");
    event.accepted = true;
    expect(() => validateArchive(tampered)).toThrow();
    expect(() => validateArchive({ ...match, apiKey: "not-an-archive-field" })).toThrow();
    event.accepted = false;
    event.fen = "invented";
    expect(() => validateArchive(tampered)).toThrow();
  });
  it("supports anonymous commentary and provides piece-specific legal moves", () => {
    const anonymous = game({ opponentIdentity: "hidden", trashTalk: true });
    expect(
      submitMove(anonymous, boardAt(anonymous), "e2e4", "Your king looks nervous.").comment,
    ).toBe("Your king looks nervous.");
    expect(validateArchive(anonymous)).toEqual(anonymous);
    expect(legalMoves(boardAt(game()), "e2")).toEqual(["e2e3", "e2e4"]);
    expect(legalMoves(boardAt(game()), "invalid")).toEqual([]);
    expect(() =>
      createMatch({ white: player, black: player, rules: {}, initialFen: "invalid" }),
    ).toThrow();
    expect(
      matchConfigSchema.safeParse({ white: player, black: player, rules: {}, initialFen: "8/8 w" })
        .success,
    ).toBe(false);
    expect(
      matchConfigSchema.safeParse({
        white: player,
        black: player,
        rules: {},
        initialFen: "7k/8/8/8/8/8/8/7K w - - 0 1",
      }).success,
    ).toBe(true);
  });
  it("settles reservations to reported usage and keeps unreported dispatches reserved", () => {
    const match = game();
    const base = { at: new Date().toISOString(), side: "w" as const, ply: 0 };
    type Body<T> = T extends MatchEvent ? Omit<T, "seq" | "at" | "side" | "ply"> : never;
    const push = (event: Body<MatchEvent>) =>
      match.events.push({ ...base, seq: match.events.length, ...event } as MatchEvent);
    push({ type: "reservation", dispatch: 0, tokens: 1000, costMicros: 50 });
    push({
      type: "usage",
      dispatch: 0,
      inputTokens: 100,
      outputTokens: 20,
      costMicros: 3,
    });
    push({ type: "reservation", dispatch: 1, tokens: 900, costMicros: 40 });
    expect(matchStats(match)).toMatchObject({
      reservedTokens: 1900,
      reservedCostMicros: 90,
      committedTokens: 120 + 900,
      committedCostMicros: 3 + 40,
      costMicros: null,
    });
    expect(validateArchive(match)).toEqual(match);
    push({
      type: "usage",
      dispatch: 1,
      inputTokens: 10,
      outputTokens: 5,
      costMicros: 1,
    });
    expect(matchStats(match)).toMatchObject({
      committedTokens: 135,
      committedCostMicros: 4,
      costMicros: 4,
    });
    const orphan = structuredClone(match);
    const usage = orphan.events.at(-1);
    if (usage?.type !== "usage") throw new Error("Fixture missing");
    usage.dispatch = 5;
    expect(() => validateArchive(orphan)).toThrow("reservation");
    const reordered = structuredClone(match);
    const reservation = reordered.events[2];
    if (reservation?.type !== "reservation") throw new Error("Fixture missing");
    reservation.dispatch = 0;
    expect(() => validateArchive(reordered)).toThrow("dispatch");
  });
  it("validates timing records and accounts them independently of reservations", () => {
    const match = game();
    const base = { at: new Date().toISOString(), side: "w" as const, ply: 0 };
    match.events.push(
      { ...base, seq: 0, type: "reservation", dispatch: 0, tokens: 1000, costMicros: 50 },
      { ...base, seq: 1, type: "timing", elapsedMs: 700 },
    );
    expect(matchStats(match, "w")).toMatchObject({
      elapsedMs: 700,
      committedTokens: 1000,
      committedCostMicros: 50,
      costMicros: null,
    });
    const chess = boardAt(match);
    submitMove(match, chess, "e2e4");
    expect(boardAt(validateArchive(JSON.parse(JSON.stringify(match)))).fen()).toBe(chess.fen());
    expect(exportPgn(match)).toContain("e4");
    const invalid = structuredClone(match);
    const timing = invalid.events[1];
    if (timing?.type !== "timing") throw new Error("Fixture missing");
    timing.elapsedMs = -1;
    expect(() => validateArchive(invalid)).toThrow();
  });
  it("accepts event-limit only as an unscored error ending", () => {
    const match = game();
    finishMatch(match, "*", "event-limit", "error");
    expect(validateArchive(match)).toEqual(match);
    finishMatch(match, "1-0", "event-limit", "completed");
    expect(() => validateArchive(match)).toThrow("Invalid terminal status");
  });
});
describe("move format transparency", () => {
  it("accepts normalizedFrom only in lenient archives", () => {
    const lenient = game({ moveFormat: "lenient" });
    submitMove(lenient, boardAt(lenient), "e2e4", "", "e4");
    expect(lenient.events[0]).toMatchObject({ move: "e2e4", normalizedFrom: "e4" });
    expect(validateArchive(lenient)).toEqual(lenient);
    const strict = game();
    submitMove(strict, boardAt(strict), "e2e4", "", "e4");
    expect(strict.events[0]).not.toHaveProperty("normalizedFrom");
    const forged = structuredClone(strict);
    const [attempt] = forged.events;
    if (attempt?.type === "attempt") attempt.normalizedFrom = "e4";
    expect(() => validateArchive(forged)).toThrow("Move normalization violates ruleset");
  });
});
