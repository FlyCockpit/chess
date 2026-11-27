import { describe, expect, it } from "vitest";
import { endingSummary, matchEnding } from "./ending";
import {
  acceptHumanMove,
  beginTurn,
  boardAt,
  clearTurn,
  createMatch,
  finishMatch,
  type MatchArchive,
  parseArchive,
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
