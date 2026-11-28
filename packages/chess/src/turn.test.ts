import { describe, expect, it, vi } from "vitest";
import { endingSummary, matchEnding } from "./ending";
import {
  acceptHumanMove,
  beginHostedTurn,
  beginTurn,
  boardAt,
  clearTurn,
  clockLeftMs,
  createMatch,
  finishMatch,
  type MatchArchive,
  parseArchive,
  playHostedHumanTurn,
  serializeArchive,
  submitMove,
  type TurnState,
  turnStateSchema,
  validateArchive,
} from "./index";

const human = { name: "Human", model: "human", protocol: "human" as const };
const model = { name: "Model", model: "vendor/model", protocol: "openai-chat" as const };
const active = {
  turnId: "11111111-1111-4111-8111-111111111111",
  side: "w" as const,
  expectedSeq: 0,
  startedAt: "2026-11-27T00:00:00.000Z",
  deadline: "2026-11-27T00:01:00.000Z",
};
const waiting = { type: "human" as const, ...active };
const expectation = { turnId: active.turnId, expectedSeq: active.expectedSeq };
const game = () => createMatch({ white: human, black: model, rules: {} }, "hosted");

describe("durable human turn contract", () => {
  it("starts idle, parks without private ownership, accepts once and clears under the same expectation", () => {
    const idle = game().turn;
    expect(idle).toEqual({ type: "idle" });
    const parked = beginTurn(idle, waiting);
    const ready = acceptHumanMove(parked, expectation, "e2e4", "2026-11-27T00:00:01.000Z");
    expect(ready).toEqual({
      ...waiting,
      type: "human-move",
      pendingMove: {
        move: "e2e4",
        receivedAt: "2026-11-27T00:00:01.000Z",
      },
    });
    expect(() => acceptHumanMove(ready, expectation, "d2d4", "2026-11-27T00:00:02.000Z")).toThrow(
      "not awaiting",
    );
    expect(() => beginTurn(parked, waiting)).toThrow("already active");
    expect(clearTurn(ready, expectation)).toEqual(idle);
    expect(() => clearTurn(idle, expectation)).toThrow("Stale");
  });
  it.each([
    { ...expectation, expectedSeq: 1 },
    { ...expectation, turnId: "22222222-2222-4222-8222-222222222222" },
  ])("rejects stale sequence or turn ID without changing state: %j", (stale) => {
    expect(() => acceptHumanMove(waiting, stale, "e2e4", "2026-11-27T00:00:01.000Z")).toThrow(
      "Stale",
    );
    expect(() => clearTurn(waiting, stale)).toThrow("Stale");
    expect(waiting).toEqual({ type: "human", ...active });
  });
  it.each(["2026-11-26T23:59:59.999Z", active.deadline, "2026-11-27T00:01:00.001Z"])(
    "rejects receipt outside the half-open server deadline: %s",
    (at) => {
      expect(() => acceptHumanMove(waiting, expectation, "e2e4", at)).toThrow();
    },
  );
  it.each(["e2e4", "a7a8q", "a7a8r", "a7a8b", "a7a8n"])("bounds pending UCI input: %s", (move) => {
    expect(acceptHumanMove(waiting, expectation, move, active.startedAt).type).toBe("human-move");
  });
  it.each(["", "e4", "e2e4\n", "a7a8k", "x".repeat(256)])(
    "rejects non-UCI pending input: %s",
    (move) => {
      expect(() => acceptHumanMove(waiting, expectation, move, active.startedAt)).toThrow();
    },
  );
  it.each([
    { ...waiting, deadline: active.startedAt },
    { ...waiting, deadline: "2026-11-27T00:05:00.001Z" },
    { ...waiting, deadline: null },
    { ...waiting, expectedSeq: -1 },
    { ...waiting, expectedSeq: 2_147_483_648 },
    { ...waiting, turnId: "unbounded" },
    { ...waiting, side: "other" },
    { ...waiting, runToken: "private-claim" },
    { ...waiting, pendingMove: null },
    { ...waiting, type: "unknown" },
    { type: "idle", ...active },
    { ...waiting, type: "human-move", pendingMove: [] },
    {
      ...waiting,
      type: "human-move",
      pendingMove: { move: "e2e4", receivedAt: active.startedAt, extra: "text" },
    },
  ])("rejects partial, unknown or unbounded state: %j", (state) => {
    expect(turnStateSchema.safeParse(state).success).toBe(false);
  });
  it("never accepts a human input into a model claim", () => {
    const claim = beginTurn({ type: "idle" }, { ...active, type: "model" });
    expect(() => beginTurn(claim, { ...active, type: "model" })).toThrow("already active");
    expect(() => acceptHumanMove(claim, expectation, "e2e4", active.startedAt)).toThrow(
      "not awaiting",
    );
  });
});

describe("hosted human deadline and legality", () => {
  const at = (elapsed = 0) => new Date(Date.parse(active.startedAt) + elapsed);
  const hosted = (rules = {}) => createMatch({ white: human, black: model, rules }, "hosted");

  it("anchors the current board side and exact event tail, with a new turn for the model", () => {
    const match = hosted();
    beginHostedTurn(match, at(), active.turnId);
    expect(match.turn).toEqual(waiting);
    expect(validateArchive(match)).toEqual(match);
    const snapshot = structuredClone(match);
    expect(() => beginHostedTurn(match, at(1))).toThrow("already active");
    expect(match).toEqual(snapshot);

    const event = playHostedHumanTurn(match, at(1234), "e2e4");
    expect(event).toMatchObject({ accepted: true, side: "w", ply: 0, seq: 1, san: "e4" });
    expect(match.turn).toEqual({ type: "idle" });
    expect(
      match.events.map(({ type, at, seq, side, ply }) => ({ type, at, seq, side, ply })),
    ).toEqual([
      { type: "timing", at: at(1234).toISOString(), seq: 0, side: "w", ply: 0 },
      { type: "attempt", at: at(1234).toISOString(), seq: 1, side: "w", ply: 0 },
    ]);
    expect(match.events[0]).toMatchObject({ elapsedMs: 1234 });
    expect(validateArchive(match)).toEqual(match);
    const applied = structuredClone(match);
    expect(() => playHostedHumanTurn(match, at(1234), "e2e4")).toThrow("not awaiting");
    expect(match).toEqual(applied);
    beginHostedTurn(match, at(1234));
    expect(match.turn).toMatchObject({ type: "model", side: "b", expectedSeq: 2 });
    if (match.turn.type === "idle") throw new Error("Missing model turn");
    expect(match.turn.turnId).not.toBe(active.turnId);
    expect(validateArchive(match)).toEqual(match);
  });

  it("clears the durable turn before either event is appended", () => {
    const match = hosted();
    beginHostedTurn(match, at());
    const push = match.events.push.bind(match.events);
    const append = vi.spyOn(match.events, "push").mockImplementation((...events) => {
      expect(match.turn).toEqual({ type: "idle" });
      const length = push(...events);
      expect(validateArchive(match)).toEqual(match);
      return length;
    });
    try {
      expect(playHostedHumanTurn(match, at(1000), "e2e4")).toMatchObject({ accepted: true });
      expect(append).toHaveBeenCalledTimes(2);
    } finally {
      append.mockRestore();
    }
  });

  it.each([1000, 60_000, 300_000])("bounds untimed human expiry to %i ms", (turnTimeoutMs) => {
    const match = hosted({ turnTimeoutMs });
    beginHostedTurn(match, at());
    expect(match.turn).toMatchObject({ deadline: at(turnTimeoutMs).toISOString() });
    const snapshot = structuredClone(match);
    expect(playHostedHumanTurn(match, at(turnTimeoutMs - 1))).toBeNull();
    expect(match).toEqual(snapshot);
    expect(playHostedHumanTurn(match, at(turnTimeoutMs), "e2e4")).toBeNull();
    expect(match).toMatchObject({
      status: "completed",
      termination: "move-timeout",
      result: "0-1",
      turn: { type: "idle" },
    });
    expect(match.events).toEqual([
      expect.objectContaining({
        type: "timing",
        elapsedMs: turnTimeoutMs,
        at: at(turnTimeoutMs).toISOString(),
      }),
    ]);
    expect(validateArchive(match)).toEqual(match);
  });

  it.each([
    { spent: 0, turnTimeoutMs: 5000, deadlineMs: 5000, termination: "move-timeout" },
    { spent: 28_000, turnTimeoutMs: 5000, deadlineMs: 2000, termination: "timeout" },
    { spent: 25_000, turnTimeoutMs: 5000, deadlineMs: 5000, termination: "timeout" },
  ])(
    "uses the first exhausted limit, even on late delivery: $termination/$spent",
    ({ spent, turnTimeoutMs, deadlineMs, termination }) => {
      const match = hosted({ clock: { w: 30_000, b: 60_000 }, turnTimeoutMs });
      match.events.push({
        type: "timing",
        seq: 0,
        side: "w",
        ply: 0,
        at: at().toISOString(),
        elapsedMs: spent,
      });
      beginHostedTurn(match, at());
      expect(match.turn).toMatchObject({ expectedSeq: 1, deadline: at(deadlineMs).toISOString() });
      expect(validateArchive(match)).toEqual(match);
      expect(playHostedHumanTurn(match, at(40_000), "e2e4")).toBeNull();
      expect(match).toMatchObject({ termination, result: "0-1", turn: { type: "idle" } });
      expect(clockLeftMs(match, "b")).toBe(60_000);
      expect(validateArchive(match)).toEqual(match);
    },
  );

  it.each([human, model])(
    "settles an already exhausted side clock before starting $protocol",
    (white) => {
      const match = createMatch(
        { white, black: model, rules: { clock: { w: 30_000, b: 30_000 }, turnTimeoutMs: 5000 } },
        "hosted",
      );
      match.events.push({
        type: "timing",
        seq: 0,
        side: "w",
        ply: 0,
        at: at().toISOString(),
        elapsedMs: 30_000,
      });
      beginHostedTurn(match, at());
      expect(match).toMatchObject({
        status: "completed",
        termination: "timeout",
        result: "0-1",
        turn: { type: "idle" },
      });
      expect(match.events).toHaveLength(1);
      expect(validateArchive(match)).toEqual(match);
    },
  );

  it.each([undefined, "e2e4", "resign"])("expires at the deadline before applying %s", (move) => {
    const match = hosted({ clock: { w: 30_000, b: 30_000 }, turnTimeoutMs: 5000 });
    beginHostedTurn(match, at());
    const snapshot = structuredClone(match);
    expect(playHostedHumanTurn(match, at(4999))).toBeNull();
    expect(match).toEqual(snapshot);
    expect(playHostedHumanTurn(match, at(5000), move)).toBeNull();
    expect(match.termination).toBe("move-timeout");
    expect(validateArchive(match)).toEqual(match);
  });

  it.each(["forfeit", "retry"] as const)(
    "retains rejected attempts and the %s policy across fresh turns",
    (illegalPolicy) => {
      const match = hosted({ illegalPolicy, maxAttempts: 2 });
      for (const elapsed of [1000, 2000]) {
        beginHostedTurn(match, at(elapsed - 1000));
        expect(playHostedHumanTurn(match, at(elapsed), "e2e5")).toMatchObject({
          accepted: false,
          reason: "illegal",
          ply: 0,
        });
        expect(match.turn).toEqual({ type: "idle" });
        expect(validateArchive(match)).toEqual(match);
      }
      expect(match.events.map((event) => event.type)).toEqual([
        "timing",
        "attempt",
        "timing",
        "attempt",
      ]);
      if (illegalPolicy === "forfeit") {
        expect(match).toMatchObject({
          status: "completed",
          termination: "illegal-forfeit",
          result: "0-1",
        });
        expect(() => beginHostedTurn(match, at(2000))).toThrow("not accepting");
      } else {
        beginHostedTurn(match, at(2000));
        expect(playHostedHumanTurn(match, at(3000), "e2e4")).toMatchObject({
          accepted: true,
          ply: 0,
        });
        expect(match.status).toBe("running");
        expect(validateArchive(match)).toEqual(match);
      }
    },
  );

  it.each(["w", "b"] as const)(
    "resigns %s before expiry without recording an illegal attempt",
    (side) => {
      const match = createMatch(
        {
          white: human,
          black: human,
          rules: { clock: { w: 30_000, b: 30_000 }, turnTimeoutMs: 5000 },
        },
        "hosted",
      );
      beginHostedTurn(match, at());
      if (side === "b") {
        playHostedHumanTurn(match, at(1000), "e2e4");
        beginHostedTurn(match, at(1000));
      }
      expect(playHostedHumanTurn(match, at(2000), "resign")).toBeNull();
      expect(match).toMatchObject({
        status: "completed",
        termination: "resignation",
        result: side === "w" ? "0-1" : "1-0",
        turn: { type: "idle" },
      });
      expect(clockLeftMs(match, side)).toBe(side === "w" ? 28_000 : 29_000);
      expect(match.events.filter((event) => event.type === "attempt" && !event.accepted)).toEqual(
        [],
      );
      expect(validateArchive(match)).toEqual(match);
    },
  );

  it.each(["q", "r", "b", "n"])("requires explicit promotion and accepts %s", (piece) => {
    const match = createMatch(
      { white: human, black: model, rules: {}, initialFen: "7k/P7/8/8/8/8/8/7K w - - 0 1" },
      "hosted",
    );
    beginHostedTurn(match, at());
    expect(playHostedHumanTurn(match, at(1), "a7a8")).toMatchObject({
      accepted: false,
      reason: "illegal",
    });
    beginHostedTurn(match, at(1));
    expect(playHostedHumanTurn(match, at(2), `a7a8${piece}`)).toMatchObject({ accepted: true });
    expect(boardAt(match).get("a8")?.type).toBe(piece);
    expect(match.turn).toEqual({ type: "idle" });
    expect(validateArchive(match)).toEqual(match);
  });

  it.each(["sequence", "side", "protocol", "model", "pending", "idle", "terminal"])(
    "rejects stale or inactive %s state without mutation",
    (kind) => {
      const match = hosted();
      beginHostedTurn(match, at());
      if (match.turn.type !== "human") throw new Error("Missing human turn");
      if (kind === "sequence") match.turn.expectedSeq += 1;
      if (kind === "side") match.turn.side = "b";
      if (kind === "protocol") match.config.white.protocol = "random";
      if (kind === "model") match.turn = { ...match.turn, type: "model" };
      if (kind === "pending")
        match.turn = acceptHumanMove(match.turn, match.turn, "e2e4", active.startedAt);
      if (kind === "idle") match.turn = { type: "idle" };
      if (kind === "terminal") finishMatch(match, "*", "cancelled", "stopped");
      const snapshot = structuredClone(match);
      expect(() => playHostedHumanTurn(match, at(1), "e2e4")).toThrow();
      expect(match).toEqual(snapshot);
    },
  );

  it.each([new Date("invalid"), at(-1)])(
    "rejects invalid or backward server time without mutation: %s",
    (now) => {
      const match = hosted();
      beginHostedTurn(match, at());
      const snapshot = structuredClone(match);
      expect(() => playHostedHumanTurn(match, now, "e2e4")).toThrow();
      expect(match).toEqual(snapshot);
    },
  );
});

describe("one current archive shape", () => {
  it.each<TurnState>([
    { type: "idle" },
    waiting,
    acceptHumanMove(waiting, expectation, "e2e4", active.startedAt),
  ])("round-trips a human snapshot through shape and replay readers: $type", (turn) => {
    const match = game();
    match.turn = turn;
    const encoded = JSON.parse(serializeArchive(match));
    expect(parseArchive(encoded)).toEqual(match);
    expect(validateArchive(encoded)).toEqual(match);
    expect(matchEnding(match)).toEqual({ kind: "playing" });
  });
  it("supports an explicit model claim with its anchored sequence", () => {
    const match = createMatch({ white: model, black: human, rules: {} }, "hosted");
    match.turn = { ...active, type: "model" };
    expect(validateArchive(match)).toEqual(match);
  });
  it("rejects a model anchor belonging to the opponent's previous turn", () => {
    const match = game();
    submitMove(match, boardAt(match), "e2e4");
    match.turn = { ...active, type: "model", side: "b", expectedSeq: 0 };
    expect(() => validateArchive(match)).toThrow("Invalid model turn anchor");
    match.turn.expectedSeq = 1;
    expect(validateArchive(match)).toEqual(match);
  });
  it("rejects a model anchor spanning completed turns even when the final side matches", () => {
    const match = createMatch({ white: model, black: model, rules: {} });
    const board = boardAt(match);
    submitMove(match, board, "e2e4");
    submitMove(match, board, "e7e5");
    match.turn = { ...active, type: "model" };
    expect(() => validateArchive(match)).toThrow("spans a completed turn");
    match.turn.expectedSeq = 2;
    expect(validateArchive(match)).toEqual(match);
  });
  it("rejects old snapshots with no turn instead of silently upgrading them", () => {
    const { turn: _turn, ...old } = game();
    expect(() => parseArchive(old)).toThrow("Unsupported archive");
    expect(() => validateArchive(old)).toThrow("Unsupported archive");
  });
  it.each([
    { ...waiting, expectedSeq: 1 },
    { ...waiting, type: "model" },
    { ...waiting, deadline: "2026-11-27T00:02:00.000Z" },
  ])("rejects a turn contradictory to archive configuration: %j", (turn) => {
    expect(() => parseArchive({ ...game(), turn })).toThrow("Unsupported archive");
  });
  it("replays the board to refuse a turn for the wrong side", () => {
    const match = createMatch({ white: human, black: human, rules: {} });
    match.turn = { ...waiting, side: "b" };
    expect(() => validateArchive(match)).toThrow("side to move");
  });
  it("requires a human wait at the exact event tail", () => {
    const match = game();
    submitMove(match, boardAt(match), "e2e5");
    match.turn = waiting;
    expect(() => parseArchive(match)).toThrow("Unsupported archive");
  });
  it.each(["cancelled", "interrupted", "credential-revoked", "move-timeout"] as const)(
    "clears turn state on %s and rejects a terminal snapshot retaining the wait",
    (termination) => {
      const match = game();
      match.turn = waiting;
      const status: MatchArchive["status"] =
        termination === "cancelled"
          ? "stopped"
          : termination === "move-timeout"
            ? "completed"
            : "error";
      finishMatch(match, termination === "move-timeout" ? "0-1" : "*", termination, status);
      expect(match.turn).toEqual({ type: "idle" });
      expect(validateArchive(match)).toEqual(match);
      expect(() => parseArchive({ ...match, turn: waiting })).toThrow("Unsupported archive");
      if (termination === "move-timeout")
        expect(endingSummary(matchEnding(match))).toEqual({ kind: "move-timeout", side: "w" });
    },
  );
});
