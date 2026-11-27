import { type TurnState, turnStateSchema } from "@cockpit-chess/chess";
import type { Prisma } from "@cockpit-chess/db";

export const chessTurnSelect = {
  turnType: true,
  turnId: true,
  turnSide: true,
  turnExpectedSeq: true,
  turnStartedAt: true,
  turnDeadline: true,
  pendingMove: true,
} satisfies Prisma.ChessMatchSelect;
export type ChessTurnColumns = Prisma.ChessMatchGetPayload<{ select: typeof chessTurnSelect }>;

/** A malformed current row fails closed; missing fields are never upgraded. */
export function chessTurnFromColumns(row: ChessTurnColumns): TurnState {
  if (row.turnType === "idle") {
    if (
      row.turnId !== null ||
      row.turnSide !== null ||
      row.turnExpectedSeq !== null ||
      row.turnStartedAt !== null ||
      row.turnDeadline !== null ||
      row.pendingMove !== null
    )
      throw new Error("Invalid idle chess turn");
    return { type: "idle" };
  }
  return turnStateSchema.parse({
    type: row.turnType,
    turnId: row.turnId,
    side: row.turnSide,
    expectedSeq: row.turnExpectedSeq,
    startedAt: row.turnStartedAt?.toISOString(),
    deadline: row.turnDeadline?.toISOString(),
    ...(row.pendingMove !== null ? { pendingMove: row.pendingMove } : {}),
  });
}

/** Cards expose turn identity/timing without the full archive's bounded input. */
export function chessTurnMetadata(turn: TurnState) {
  if (turn.type !== "human-move") return turn;
  const { pendingMove: _pendingMove, ...metadata } = turn;
  return metadata;
}

/**
 * Null JSON must be persisted with Prisma.DbNull by the caller, not JSON null.
 * A model transition sets runToken; a human/ready/idle transition clears it.
 * C1b commits these columns and archive.turn atomically under the turn/claim CAS.
 */
export function chessTurnColumns(input: TurnState) {
  const turn = turnStateSchema.parse(input);
  return {
    turnType: turn.type,
    turnId: turn.type === "idle" ? null : turn.turnId,
    turnSide: turn.type === "idle" ? null : turn.side,
    turnExpectedSeq: turn.type === "idle" ? null : turn.expectedSeq,
    turnStartedAt: turn.type === "idle" ? null : new Date(turn.startedAt),
    turnDeadline: turn.type === "idle" ? null : new Date(turn.deadline),
    pendingMove: turn.type === "human-move" ? turn.pendingMove : null,
  };
}
