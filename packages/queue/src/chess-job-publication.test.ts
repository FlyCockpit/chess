import type { RedisQueueBackend } from "bullmq";
import { addDelayedJob } from "bullmq/dist/esm/scripts/addDelayedJob-6.js";
import { addParentJob } from "bullmq/dist/esm/scripts/addParentJob-6.js";
import { addPrioritizedJob } from "bullmq/dist/esm/scripts/addPrioritizedJob-9.js";
import { addStandardJob } from "bullmq/dist/esm/scripts/addStandardJob-9.js";
import { reprocessJob } from "bullmq/dist/esm/scripts/reprocessJob-9.js";
import { updateData } from "bullmq/dist/esm/scripts/updateData-1.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  original: vi.fn(async () => "ordinary-result"),
  define: vi.fn(),
  run: vi.fn(async () => "guarded-result"),
}));
vi.mock("bullmq", () => ({
  createRedisBackend: () => ({ execCommand: fixture.original }),
}));

const {
  CHESS_PUBLICATION_GUARD,
  chessJobEpochKey,
  chessJobRegistryKey,
  createChessJobBackend,
  withChessPublication,
} = await import("./chess-job-publication");

// Minimal command-port test double: the factory must touch no other client API.
const client = { defineCommand: fixture.define, runCommand: fixture.run } as unknown as Parameters<
  RedisQueueBackend["execCommand"]
>[0];
const context = { matchId: "owned-match", epoch: "accepted-epoch", entry: "spectator|owned-job" };
const backend = () => createChessJobBackend("test", { connection: { host: "unused.invalid" } });

beforeEach(() => vi.clearAllMocks());

describe("atomic chess publication backend", () => {
  it.each([
    addDelayedJob,
    addParentJob,
    addPrioritizedJob,
    addStandardJob,
    reprocessJob,
    updateData,
  ])("guards the pinned $name script and preserves its original argument shape", async (script) => {
    const keys = Array.from({ length: script.keys }, (_, index) => `native-key-${index}`);
    const args = ["native-argument", Buffer.from("packed-payload"), 7];
    const values = [...keys, ...args];
    const originalValues = [...values];
    const result = await withChessPublication(context, async () =>
      backend().execCommand(client, script.name, values),
    );
    const guardedName = `cockpit-chess-retirement-v1:${script.name}`;
    expect(result).toBe("guarded-result");
    expect(fixture.original).not.toHaveBeenCalled();
    expect(fixture.define).toHaveBeenCalledExactlyOnceWith(guardedName, {
      numberOfKeys: script.keys + 2,
      lua: CHESS_PUBLICATION_GUARD + script.content,
    });
    expect(fixture.run).toHaveBeenCalledExactlyOnceWith(guardedName, [
      ...keys,
      chessJobEpochKey(context.matchId),
      chessJobRegistryKey(context.matchId),
      ...args,
      context.epoch,
      context.entry,
    ]);
    expect(values).toEqual(originalValues);
    // Metadata is removed before pinned Lua can index its original KEYS/ARGV.
    expect(CHESS_PUBLICATION_GUARD).toMatch(/local registry = table\.remove\(KEYS\)/);
    expect(CHESS_PUBLICATION_GUARD).toMatch(/local epochKey = table\.remove\(KEYS\)/);
    expect(CHESS_PUBLICATION_GUARD).toMatch(/local entry = table\.remove\(ARGV\)/);
    expect(CHESS_PUBLICATION_GUARD).toMatch(/local epoch = table\.remove\(ARGV\)/);
  });

  it("leaves scheduler and ordinary unregistered publication commands unchanged", async () => {
    const values = ["scheduler-key", "scheduler-data"];
    expect(await backend().execCommand(client, addStandardJob.name, values)).toBe(
      "ordinary-result",
    );
    expect(fixture.original).toHaveBeenCalledExactlyOnceWith(client, addStandardJob.name, values);
    expect(fixture.define).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("does not wrap read and cleanup commands inside an owned publication", async () => {
    const values = ["job-key"];
    await withChessPublication(context, async () =>
      backend().execCommand(client, "removeJob", values),
    );
    expect(fixture.original).toHaveBeenCalledExactlyOnceWith(client, "removeJob", values);
    expect(fixture.define).not.toHaveBeenCalled();
  });

  it("retains the exact publication context across asynchronous callbacks without leaking it", async () => {
    const queue = backend();
    await Promise.all([
      withChessPublication(context, async () => {
        await Promise.resolve();
        return queue.execCommand(client, updateData.name, ["key", "payload"]);
      }),
      queue.execCommand(client, updateData.name, ["other-key", "other-payload"]),
    ]);
    expect(fixture.run).toHaveBeenCalledOnce();
    expect(fixture.original).toHaveBeenCalledExactlyOnceWith(client, updateData.name, [
      "other-key",
      "other-payload",
    ]);
  });

  it("refuses batched mutations instead of silently bypassing the atomic guard", async () => {
    const batched = { runCommand: fixture.run } as unknown as Parameters<
      RedisQueueBackend["execCommand"]
    >[0];
    await expect(
      withChessPublication(context, async () =>
        backend().execCommand(batched, updateData.name, []),
      ),
    ).rejects.toThrow("does not support batched mutations");
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.original).not.toHaveBeenCalled();
  });

  it("requires an exact current epoch, including when Redis has lost the fence", () => {
    expect(CHESS_PUBLICATION_GUARD).toContain("redis.call('GET', epochKey) ~= epoch");
    expect(CHESS_PUBLICATION_GUARD.indexOf("Chess job publication retired")).toBeLessThan(
      CHESS_PUBLICATION_GUARD.indexOf("redis.call('SADD', registry, entry)"),
    );
    expect(CHESS_PUBLICATION_GUARD).toContain("redis.call('SCARD', registry) >= 4096");
    expect(chessJobEpochKey("owned-match")).not.toContain("owned-match");
    expect(chessJobEpochKey("owned-match")).not.toBe(chessJobEpochKey("other-match"));
  });
});
