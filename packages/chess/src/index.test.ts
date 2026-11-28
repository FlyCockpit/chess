import { describe, expect, it } from "vitest";
import {
  applyUci,
  boardAt,
  boundReply,
  catalogOutputLimits,
  clockLeftMs,
  createMatch,
  DEFAULT_POSITION,
  finishMatch,
  legalMoves,
  MAX_REPLY_BYTES,
  type MatchEvent,
  matchConfigSchema,
  matchStats,
  playHumanTurn,
  submitMove,
  utf8ByteLength,
  validateArchive,
} from "./index";
import { exportPgn } from "./pgn";

const player = { name: "Baseline", model: "random", protocol: "random" as const };
const game = (rules = {}) => createMatch({ white: player, black: player, rules });
describe("local companion human semantics", () => {
  const human = { name: "Human", model: "human", protocol: "human" as const };
  const local = (rules = {}) => createMatch({ white: human, black: player, rules });

  it("lets untimed humans think beyond the inference limit without durable turns", () => {
    const match = local({ turnTimeoutMs: 1000 });
    expect(playHumanTurn(match, boardAt(match), 400_000, "e2e4")).toMatchObject({ accepted: true });
    expect(match.events.map((event) => event.type)).toEqual(["attempt"]);
    expect(match.turn).toEqual({ type: "idle" });
    expect(validateArchive(match)).toEqual(match);
    const untimed = local();
    expect(() => playHumanTurn(untimed, boardAt(untimed), 400_000)).toThrow("cannot expire");
    expect(untimed.events).toEqual([]);
  });

  it("charges only the side clock and keeps cumulative think time across illegal attempts", () => {
    const match = local({ clock: { w: 30_000, b: 30_000 }, turnTimeoutMs: 1000 });
    const chess = boardAt(match);
    expect(playHumanTurn(match, chess, 20_000, "e2e5")).toMatchObject({ accepted: false });
    expect(clockLeftMs(match, "w")).toBe(10_000);
    expect(playHumanTurn(match, chess, 5000, "e2e4")).toMatchObject({ accepted: true });
    expect(clockLeftMs(match, "w")).toBe(5000);
    expect(clockLeftMs(match, "b")).toBe(30_000);
    expect(match.turn).toEqual({ type: "idle" });
    expect(validateArchive(match)).toEqual(match);
  });

  it("rejects a move at clock expiry and supports a clock-only expiry notification", () => {
    for (const move of ["e2e4", undefined]) {
      const match = local({ clock: { w: 30_000, b: 30_000 }, turnTimeoutMs: 1000 });
      expect(playHumanTurn(match, boardAt(match), 30_000, move)).toBeNull();
      expect(match).toMatchObject({ termination: "timeout", result: "0-1" });
      expect(match.events).toEqual([
        expect.objectContaining({ type: "timing", elapsedMs: 30_000 }),
      ]);
      expect(validateArchive(match)).toEqual(match);
    }
  });

  it("resigns without consuming an illegal attempt", () => {
    const match = local();
    expect(playHumanTurn(match, boardAt(match), 1, "resign")).toBeNull();
    expect(match).toMatchObject({ termination: "resignation", result: "0-1" });
    expect(match.events).toEqual([]);
    expect(validateArchive(match)).toEqual(match);
  });
});

describe("authoritative chess and portable archives", () => {
  it("round-trips optional cache counts and derives the weighted input-token share", () => {
    const match = game();
    for (const [dispatch, inputTokens, cachedInputTokens, cacheCreationInputTokens] of [
      [0, 1000, 0, 900],
      [1, 3000, 2400, 100],
    ] as const) {
      const base = { at: match.createdAt, side: "w" as const, ply: 0 };
      match.events.push({
        ...base,
        seq: match.events.length,
        type: "reservation",
        dispatch,
        tokens: 5000,
        costMicros: 10,
      });
      match.events.push({
        ...base,
        seq: match.events.length,
        type: "usage",
        resolvedModel: null,
        resolvedProvider: null,
        dispatch,
        inputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        outputTokens: 10,
        costMicros: 1,
      });
    }
    expect(validateArchive(JSON.parse(JSON.stringify(match)))).toEqual(match);
    expect(matchStats(match)).toMatchObject({
      cachedInputTokens: 2400,
      cacheCreationInputTokens: 1000,
      cacheReadShare: 0.6,
    });
    const first = match.events[1];
    if (first?.type !== "usage") throw new Error("Missing fixture usage");
    delete first.cachedInputTokens;
    delete first.cacheCreationInputTokens;
    expect(validateArchive(match)).toEqual(match);
    expect(matchStats(match).cacheReadShare).toBe(0.6);
    expect(matchStats(game()).cacheReadShare).toBeNull();
    // A Gemini cache creation can also read the prefix during that same request.
    first.cachedInputTokens = 900;
    first.cacheCreationInputTokens = 900;
    expect(validateArchive(match)).toEqual(match);
    first.cachedInputTokens = 1001;
    expect(() => validateArchive(match)).toThrow("Cache usage exceeds input tokens");
    first.cachedInputTokens = 0;
    first.cacheCreationInputTokens = 1001;
    expect(() => validateArchive(match)).toThrow("Cache usage exceeds input tokens");
  });
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
    finishMatch(match, "1-0", "move-timeout");
    expect(() => validateArchive(match)).toThrow("Invalid side-to-move forfeit");
    finishMatch(match, "0-1", "timeout");
    expect(() => validateArchive(match)).toThrow("Clock forfeit in an untimed game");
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
    const anonymous = game({ opponentIdentity: "hidden", remarks: "trash-talk" });
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
      resolvedModel: null,
      resolvedProvider: null,
      dispatch: 0,
      inputTokens: 100,
      outputTokens: 20,
      costMicros: 3,
    });
    push({ type: "reservation", dispatch: 1, tokens: 900, costMicros: 40 });
    expect(matchStats(match)).toMatchObject({
      reservedTokens: 1900,
      reservedCostMicros: 90,
      // One request at a time: the most ever reserved is the largest single reservation.
      peakReservedTokens: 1000,
      unsettledDispatches: 1,
      uncostedReports: 0,
      committedTokens: 120 + 900,
      committedCostMicros: 3 + 40,
      costMicros: null,
    });
    expect(validateArchive(match)).toEqual(match);
    push({
      type: "usage",
      resolvedModel: null,
      resolvedProvider: null,
      dispatch: 1,
      inputTokens: 10,
      outputTokens: 5,
      costMicros: 1,
    });
    expect(matchStats(match)).toMatchObject({
      committedTokens: 135,
      committedCostMicros: 4,
      costMicros: 4,
      unsettledDispatches: 0,
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

describe("recorded rejected replies", () => {
  it("keeps a reply whole when it fits, else its end after an ellipsis, within the byte bound", () => {
    expect(boundReply("short")).toBe("short");
    const long = `${"a".repeat(3000)}THE END`;
    const bounded = boundReply(long);
    expect(bounded.startsWith("…")).toBe(true);
    expect(bounded.endsWith("THE END")).toBe(true);
    expect(utf8ByteLength(JSON.stringify(bounded)) - 2).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    // Escapes count at their recorded size: control characters take six bytes each.
    const escaped = boundReply("\u0001".repeat(2000));
    expect(utf8ByteLength(JSON.stringify(escaped)) - 2).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    // Never splits a surrogate pair.
    expect(boundReply("😀".repeat(1000)).slice(1)).toMatch(/^(?:😀)+$/u);
  });
  it("records reply and stop reason only on rejected attempts, and validates them", () => {
    const match = game({ maxAttempts: 3 });
    const chess = boardAt(match);
    submitMove(match, chess, "[truncated]", "", undefined, {
      text: "thinking…",
      stopReason: "output-truncated",
    });
    submitMove(match, chess, "e2e4", "", undefined, {
      text: '{"move":"e2e4"}',
      stopReason: "completed",
    });
    expect(match.events[0]).toMatchObject({ reason: "truncated", reply: "thinking…" });
    expect(match.events[1]).not.toHaveProperty("reply");
    expect(validateArchive(JSON.parse(JSON.stringify(match)))).toEqual(match);
    const forge = (edit: (events: MatchEvent[]) => void) => {
      const copy = JSON.parse(JSON.stringify(match));
      edit(copy.events);
      return () => validateArchive(copy);
    };
    // A truncated reason needs the cut-off stop; a cut-off reply is never "unparseable".
    expect(
      forge((events) => {
        const first = events[0];
        if (first?.type === "attempt") delete first.stopReason;
      }),
    ).toThrow("Attempt reason mismatch");
    expect(
      forge((events) => {
        const first = events[0];
        if (first?.type === "attempt") first.reason = "unparseable";
      }),
    ).toThrow("Attempt reason mismatch");
    expect(
      forge((events) => {
        const played = events[1];
        if (played?.type === "attempt") played.reply = "x";
      }),
    ).toThrow("Reply record on an accepted move");
    expect(
      forge((events) => {
        const first = events[0];
        if (first?.type === "attempt") first.reply = "x".repeat(MAX_REPLY_BYTES + 1);
      }),
    ).toThrow();
  });
  it("never plays a cut-off reply, even when its move is legal, and validates the record", () => {
    const match = game();
    const chess = boardAt(match);
    const before = chess.fen();
    const event = submitMove(match, chess, "e2e4", "", undefined, {
      text: '{"move":"e2e4"',
      stopReason: "output-truncated",
    });
    expect(event).toMatchObject({ accepted: false, san: null, reason: "truncated", fen: before });
    expect(chess.fen()).toBe(before);
    expect(validateArchive(JSON.parse(JSON.stringify(match)))).toEqual(match);
    // A forged record that plays it is refused.
    const forged = JSON.parse(JSON.stringify(match));
    Object.assign(forged.events[0], { accepted: true, san: "e4", reason: null });
    expect(() => validateArchive(forged)).toThrow();
  });
  it("reads a model's output limits from an OpenRouter catalog entry", () => {
    expect(
      catalogOutputLimits({
        context_length: 163840,
        top_provider: { max_completion_tokens: 65536 },
      }),
    ).toEqual({ maxOutputTokens: 65536, contextLength: 163840 });
    expect(catalogOutputLimits({ top_provider: { max_completion_tokens: null } })).toEqual({
      maxOutputTokens: null,
      contextLength: null,
    });
    expect(catalogOutputLimits(null)).toEqual({ maxOutputTokens: null, contextLength: null });
    expect(catalogOutputLimits({ context_length: -1, top_provider: "x" })).toEqual({
      maxOutputTokens: null,
      contextLength: null,
    });
  });
});
