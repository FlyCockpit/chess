import { createMatch, type TurnState } from "@cockpit-chess/chess";
import type prismaInstance from "@cockpit-chess/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockReset } from "vitest-mock-extended";
import { DbNull } from "../../../db/prisma/generated/internal/prismaNamespace";
import { chessTurnFromColumns } from "./chess-turn";

vi.mock("@cockpit-chess/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<typeof prismaInstance>() };
});
const { default: prisma } = await import("@cockpit-chess/db");
const db = prisma as DeepMockProxy<typeof prismaInstance>;
const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@cockpit-chess/queue", () => ({ chessRunQueue: {}, ensureRunnableJob: enqueue }));
vi.mock("@cockpit-chess/queue/chess-job-registry", () => ({
  publishRegisteredChessJob: (
    _matchId: string,
    _surface: string,
    name: string,
    data: unknown,
    jobId: string,
  ) => enqueue({}, name, data, jobId),
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 3 } }));
const { chessRunJobId, chessTurnData, wakeHostedMatch } = await import("./chess-human");
const baseline = { name: "Random", model: "random", protocol: "random" as const };
const match = () => createMatch({ white: baseline, black: baseline, rules: {} }, "hosted");

beforeEach(() => {
  enqueue.mockReset().mockResolvedValue({});
  mockReset(db);
  db.chessMatch.findUnique.mockResolvedValue({ ownerId: "owner" } as never);
  db.chessMatch.findFirst.mockResolvedValue({ ownerId: "owner", slug: "game" } as never);
  db.user.findUnique.mockResolvedValue({ deletionRequestedAt: null, banned: false } as never);
  db.$transaction.mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected publication transaction");
    return run(db);
  });
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

  it("refuses runner archives and forged hosted snapshots before queueing hosted work", async () => {
    const local = createMatch({ white: baseline, black: baseline, rules: {} }, "local");
    await wakeHostedMatch("id", local);
    expect(db.chessMatch.findUnique).not.toHaveBeenCalled();
    for (const current of [
      null,
      { source: "runner", status: "queued" },
      { source: "local", status: "queued" },
      { source: "hosted", status: "stopped" },
    ]) {
      db.chessMatch.findUnique.mockResolvedValue(current as never);
      // The projected transaction query returns no row unless the current
      // source/status still satisfy its hosted+queued predicate.
      db.chessMatch.findFirst.mockResolvedValue(null);
      await wakeHostedMatch("id", match());
    }
    expect(enqueue).not.toHaveBeenCalled();
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
