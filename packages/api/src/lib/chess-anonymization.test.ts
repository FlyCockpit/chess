import { randomUUID } from "node:crypto";
import {
  boardAt,
  createMatch,
  finishMatch,
  matchStats,
  submitMove,
  validateArchive,
} from "@cockpit-chess/chess";
import { exportPgn } from "@cockpit-chess/chess/pgn";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-chess/db", () => ({ Prisma: { DbNull: null }, default: {} }));

import {
  anonymizePublishedReplayBatch,
  anonymizeReplay,
  anonymizeSpectatorEvaluations,
  neutralArchiveId,
  neutralReplayIdentity,
} from "./chess-anonymization";

function fixture() {
  const archive = createMatch({
    title: "PRIVATE-person@example.test",
    white: { name: "PRIVATE White", model: "vendor/model", protocol: "openai-chat" },
    black: { name: "PRIVATE Black", model: "PRIVATE-person@example.test", protocol: "human" },
    rules: { remarks: "commentary" },
  });
  archive.events.push({
    seq: 0,
    at: archive.createdAt,
    side: "w",
    ply: 0,
    type: "tool",
    name: "board",
    input: "PRIVATE input",
    output: "PRIVATE output",
  });
  const attempt = submitMove(archive, boardAt(archive), "e2e4", "PRIVATE remark");
  attempt.normalizedFrom = "PRIVATE normalized";
  archive.events.push({
    seq: archive.events.length,
    at: archive.createdAt,
    side: "b",
    ply: 1,
    type: "reservation",
    dispatch: 0,
    tokens: 100,
    costMicros: 9,
  });
  archive.events.push({
    seq: archive.events.length,
    at: archive.createdAt,
    side: "b",
    ply: 1,
    type: "usage",
    dispatch: 0,
    inputTokens: 2,
    outputTokens: 1,
    costMicros: 7,
    resolvedModel: "PRIVATE model",
    resolvedProvider: "PRIVATE provider",
  });
  const rejected = submitMove(
    archive,
    boardAt(archive),
    "PRIVATE reply",
    "PRIVATE rejected remark",
  );
  rejected.reply = "PRIVATE raw reply";
  finishMatch(archive, "*", "cancelled", "stopped");
  return archive;
}

describe("published replay anonymization", () => {
  it("drops spectator text or unrelated positions without removing genuine numerical scores", () => {
    const archive = fixture();
    const evaluation = {
      engine: "stockfish-19-lite-single",
      fen: boardAt(archive).fen(),
      depth: 1,
      nodes: 1000,
      cp: 42,
      mate: null,
      bestMove: null,
    };
    expect(
      anonymizeSpectatorEvaluations(archive, {
        1: evaluation,
        0: { ...evaluation, fen: "PRIVATE FEN" },
      }),
    ).toEqual({ 1: evaluation });
    expect(anonymizeSpectatorEvaluations(archive, null)).toBeNull();
  });
  it("whitelists board, catalog identities, settings, pinned prompt and numeric results for all exports", () => {
    const original = fixture();
    const identity = neutralReplayIdentity();
    const output = anonymizeReplay(original, identity.archiveId, new Set(["vendor/model"]));
    expect(validateArchive(output)).toEqual(output);
    expect(boardAt(output).fen()).toEqual(boardAt(original).fen());
    expect(output.id).not.toEqual(original.id);
    expect(neutralArchiveId(identity.slug)).toEqual(output.id);
    expect(output.config.white.model).toBe("vendor/model");
    expect(output.config.black).toEqual({
      name: "Deleted user",
      model: "human",
      protocol: "human",
    });
    expect(output.config.rules).toEqual(original.config.rules);
    expect(output.config.prompt).toEqual(original.config.prompt);
    expect(output.result).toBe(original.result);
    expect(matchStats(output).costMicros).toBe(matchStats(original).costMicros);
    expect(matchStats(output).illegalAttempts).toBe(1);
    const allExports = JSON.stringify(output) + exportPgn(output);
    expect(allExports).not.toContain("PRIVATE");
    expect(allExports).not.toContain(original.id);
    expect(output.events.some((event) => event.type === "tool" || event.type === "reply")).toBe(
      false,
    );
  });

  it("strips untrusted imported model identities and refuses forged legal moves", () => {
    const archive = fixture();
    const output = anonymizeReplay(archive, randomUUID());
    expect(output.config.white.model).toBe("Unknown model");
    const attempt = archive.events.find((event) => event.type === "attempt" && event.accepted);
    if (attempt?.type !== "attempt") throw new Error("missing fixture attempt");
    attempt.move = "e2e5";
    expect(() => anonymizeReplay(archive, randomUUID())).toThrow();
  });

  it("replaces a live turn with terminal cancellation without retaining its ids or input", () => {
    const archive = createMatch({
      white: { name: "PRIVATE", model: "human", protocol: "human" },
      black: { name: "Random", model: "random", protocol: "random" },
      rules: {},
    });
    archive.turn = {
      type: "human",
      turnId: randomUUID(),
      side: "w",
      expectedSeq: 0,
      startedAt: archive.createdAt,
      deadline: new Date(Date.parse(archive.createdAt) + 1000).toISOString(),
    };
    const output = anonymizeReplay(archive, randomUUID());
    expect(output).toMatchObject({
      status: "stopped",
      termination: "cancelled",
      turn: { type: "idle" },
    });
    expect(JSON.stringify(output)).not.toContain(archive.turn.turnId);
    expect(neutralArchiveId("private-title-1234")).toBeNull();
  });

  it("processes one bounded keyset page and never changes published/moderation flags", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      chessMatch: {
        findMany: vi.fn().mockResolvedValue([{ id: "b", archive: fixture() }]),
        updateMany,
      },
    };
    const result = await anonymizePublishedReplayBatch(
      tx as never,
      "user",
      "a",
      new Set(["vendor/model"]),
    );
    expect(tx.chessMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: "user", published: true, id: { gt: "a" } },
        orderBy: { id: "asc" },
        take: 50,
      }),
    );
    expect(result).toEqual({ cursor: "b", done: true });
    const args = updateMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({ id: "b", ownerId: "user", published: true });
    expect(args.data).toMatchObject({
      ownerId: null,
      title: "Deleted user",
      turnType: "idle",
      runToken: null,
    });
    expect(args.data).not.toHaveProperty("published");
    expect(args.data).not.toHaveProperty("moderationStatus");
    expect(args.data.slug).toMatch(/^replay-[0-9a-f]{32}$/);
    expect(args.data.archive.id).not.toBe(fixture().id);
  });
});
