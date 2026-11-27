import { z } from "zod";

/** Shared with the durable row: PostgreSQL sequences are signed 32-bit integers. */
const sequence = z.number().int().min(0).max(2_147_483_647);
const timestamp = z.string().datetime({ precision: 3 });
export const MAX_TURN_MS = 300_000;
const activeTurn = {
  turnId: z.string().uuid(),
  side: z.enum(["w", "b"]),
  expectedSeq: sequence,
  startedAt: timestamp,
  deadline: timestamp,
};
export const pendingHumanMoveSchema = z
  .object({
    move: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?(?![\s\S])/),
    receivedAt: timestamp,
  })
  .strict();
/**
 * idle: no durable turn. model: worker-owned claim (never safe to infer again on
 * restart). human: parked, no worker slot or runToken. human-move: one accepted
 * input awaiting authoritative replay/settlement, also without worker ownership.
 * No key, claim token or private inference context belongs in this public shape.
 */
export const turnStateSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("idle") }).strict(),
    z.object({ type: z.literal("model"), ...activeTurn }).strict(),
    z.object({ type: z.literal("human"), ...activeTurn }).strict(),
    z
      .object({
        type: z.literal("human-move"),
        ...activeTurn,
        pendingMove: pendingHumanMoveSchema,
      })
      .strict(),
  ])
  .superRefine((turn, context) => {
    if (turn.type === "idle") return;
    const start = Date.parse(turn.startedAt);
    const deadline = Date.parse(turn.deadline);
    if (deadline <= start || deadline - start > MAX_TURN_MS)
      context.addIssue({ code: "custom", message: "Invalid turn deadline" });
    if (turn.type === "human-move") {
      const received = Date.parse(turn.pendingMove.receivedAt);
      if (received < start || received >= deadline)
        context.addIssue({ code: "custom", message: "Move outside turn deadline" });
    }
  });
export type TurnState = z.infer<typeof turnStateSchema>;
export type ActiveTurn = Exclude<TurnState, { type: "idle" }>;
export type TurnExpectation = Pick<ActiveTurn, "turnId" | "expectedSeq">;

export function expectTurn(turn: TurnState, expected: TurnExpectation): ActiveTurn {
  if (
    turn.type === "idle" ||
    turn.turnId !== expected.turnId ||
    turn.expectedSeq !== expected.expectedSeq
  )
    throw new Error("Stale chess turn");
  return turn;
}

/**
 * Pure transition contract. Callers must commit under row status + turnId +
 * expectedSeq + type CAS; model writes also compare runToken. Never hold a
 * transaction while thinking or dispatching. Wake notifications are only hints.
 */
export function beginTurn(
  previous: TurnState,
  next: Extract<TurnState, { type: "human" | "model" }>,
): TurnState {
  if (previous.type !== "idle") throw new Error("Chess turn already active");
  return turnStateSchema.parse(next);
}

/** Receipt time is supplied by the server, never by a browser/runner clock. */
export function acceptHumanMove(
  previous: TurnState,
  expected: TurnExpectation,
  move: string,
  receivedAt: string,
): TurnState {
  const turn = expectTurn(previous, expected);
  if (turn.type !== "human") throw new Error("Chess turn is not awaiting a human");
  return turnStateSchema.parse({
    ...turn,
    type: "human-move",
    pendingMove: { move, receivedAt },
  });
}

/** Settled move/timeout/stop clears ownership in the same durable write. */
export function clearTurn(previous: TurnState, expected: TurnExpectation): TurnState {
  expectTurn(previous, expected);
  return { type: "idle" };
}
