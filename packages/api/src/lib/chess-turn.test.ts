import { type TurnState, turnStateSchema } from "@cockpit-chess/chess";
import { describe, expect, it } from "vitest";
import { chessTurnColumns, chessTurnFromColumns, chessTurnMetadata } from "./chess-turn";

const waiting = {
  type: "human" as const,
  turnId: "11111111-1111-4111-8111-111111111111",
  side: "w" as const,
  expectedSeq: 12,
  startedAt: "2026-11-27T00:00:00.000Z",
  deadline: "2026-11-27T00:01:00.000Z",
};
describe("chess turn persistence projection", () => {
  it.each<TurnState>([
    { type: "idle" },
    waiting,
    { ...waiting, type: "model" },
    {
      ...waiting,
      type: "human-move",
      pendingMove: { move: "a7a8q", receivedAt: waiting.startedAt },
    },
  ])("round-trips exactly the current $type state", (turn) => {
    const columns = chessTurnColumns(turn);
    expect(chessTurnFromColumns(columns)).toEqual(turn);
  });
  it("keeps pending input out of card metadata", () => {
    const turn = turnStateSchema.parse({
      ...waiting,
      type: "human-move",
      pendingMove: {
        move: "a7a8q",
        receivedAt: waiting.startedAt,
      },
    });
    expect(chessTurnMetadata(turn)).toEqual({ ...waiting, type: "human-move" });
    expect(chessTurnMetadata(waiting)).toEqual(waiting);
  });
  it("rejects corrupted idle and partial active columns", () => {
    expect(() =>
      chessTurnFromColumns({ ...chessTurnColumns({ type: "idle" }), turnId: waiting.turnId }),
    ).toThrow();
    expect(() =>
      chessTurnFromColumns({ ...chessTurnColumns(waiting), turnDeadline: null }),
    ).toThrow();
    expect(() => chessTurnFromColumns({ ...chessTurnColumns(waiting), pendingMove: [] })).toThrow();
    expect(() =>
      chessTurnFromColumns({ ...chessTurnColumns(waiting), turnType: "future" }),
    ).toThrow();
  });
});
