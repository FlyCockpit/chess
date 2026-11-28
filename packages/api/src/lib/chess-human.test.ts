import { createMatch, type TurnState } from "@cockpit-chess/chess";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DbNull } from "../../../db/prisma/generated/internal/prismaNamespace";
import { chessTurnFromColumns } from "./chess-turn";

const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@cockpit-chess/queue", () => ({ chessRunQueue: {}, ensureRunnableJob: enqueue }));
const { chessRunJobId, chessTurnData, wakeHostedMatch } = await import("./chess-human");
const baseline = { name: "Random", model: "random", protocol: "random" as const };
const match = () => createMatch({ white: baseline, black: baseline, rules: {} }, "hosted");

beforeEach(() => {
  enqueue.mockReset().mockResolvedValue({});
});

describe("hosted human persistence helpers", () => {
  it("uses a deterministic job per durable event tail, preserving the initial job ID", () => {
    const archive = match();
    expect(chessRunJobId("id", archive)).toBe("chess-id");
    archive.events.push({
      type: "timing",
      seq: 0,
      at: archive.createdAt,
      side: "w",
      ply: 0,
      elapsedMs: 1,
    });
    expect(chessRunJobId("id", archive)).toBe("chess-id-turn-1");
    expect(chessRunJobId("id", archive)).toBe("chess-id-turn-1");
  });

  it("writes SQL NULL for idle and active turns without pending input", () => {
    const active = {
      turnId: "e3064e50-0147-4c7e-971c-d4d1bf3ffdd5",
      side: "w",
      expectedSeq: 0,
      startedAt: "2026-11-27T12:00:00.000Z",
      deadline: "2026-11-27T12:01:00.000Z",
    } as const;
    for (const turn of [
      { type: "idle" },
      { type: "human", ...active },
      { type: "model", ...active },
    ] satisfies TurnState[]) {
      const data = chessTurnData(turn);
      expect(data.pendingMove).toBe(DbNull);
      expect(chessTurnFromColumns({ ...data, pendingMove: null })).toEqual(turn);
    }
    expect(chessTurnData({ type: "idle" })).toEqual({
      turnType: "idle",
      turnId: null,
      turnSide: null,
      turnExpectedSeq: null,
      turnStartedAt: null,
      turnDeadline: null,
      pendingMove: DbNull,
    });
    const pending = { move: "e2e4", receivedAt: "2026-11-27T12:00:01.000Z" };
    expect(
      chessTurnData({ type: "human-move", ...active, pendingMove: pending }).pendingMove,
    ).toEqual(pending);
  });

  it("bounds wake logging to fixed metadata and preserves an accepted write on hint loss", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      enqueue.mockRejectedValue(new Error("sensitive provider payload"));
      await expect(wakeHostedMatch("id", match())).resolves.toBeUndefined();
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(
        {},
        "chess-run",
        { matchId: "id" },
        "chess-id",
      );
      expect(log).toHaveBeenCalledExactlyOnceWith("[chess] Hosted wake unavailable", {
        matchId: "id",
        jobId: "chess-id",
      });
    } finally {
      log.mockRestore();
    }
  });
});
