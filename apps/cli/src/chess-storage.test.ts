import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  archiveByteLength,
  createMatch,
  finishMatch,
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  type MatchEvent,
  serializeArchive,
} from "@cockpit-chess/chess";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({ failRename: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (fsMocks.failRename) throw new Error("rename failed");
      return actual.rename(from, to);
    }),
  };
});
const { readGame, writeGame } = await import("./chess-storage");

const player = { name: "Random", model: "random", protocol: "random" as const };
const model = { name: "Model", model: "vendor/model", protocol: "openai-chat" as const };
/** A stopped archive padded with replay-valid tool events to exactly `target` canonical bytes. */
function archiveOfSize(target: number): MatchArchive {
  const match = createMatch({ white: model, black: player, rules: {} });
  finishMatch(match, "*", "cancelled", "stopped");
  const filler = (output: string): Extract<MatchEvent, { type: "tool" }> => ({
    type: "tool",
    seq: match.events.length,
    at: "2026-11-12T00:00:00.000Z",
    side: "w",
    ply: 0,
    name: "board",
    input: "{}",
    output,
  });
  // Bulk-fill from one probe of the per-event overhead, then fine-tune exactly; measuring
  // the 2 MB archive per event would make this quadratic.
  const start = archiveByteLength(match);
  match.events.push(filler(""));
  const overhead = archiveByteLength(match) - start;
  match.events.pop();
  const bulk = Math.floor((target - start) / (15_000 + overhead + 16)) - 1;
  for (let i = 0; i < bulk; i += 1) match.events.push(filler("x".repeat(15_000)));
  for (;;) {
    const remaining = target - archiveByteLength(match);
    if (remaining === 0) break;
    if (remaining < 0) throw new Error("archive already larger than the target");
    const roomy = match.events.find(
      (event) => event.type === "tool" && event.output.length + remaining <= 16_000,
    );
    if (roomy?.type === "tool") {
      roomy.output += "x".repeat(remaining);
      continue;
    }
    const event = filler("");
    match.events.push(event);
    const room = target - archiveByteLength(match);
    if (room < 0) throw new Error("no room to pad to the exact target");
    event.output = "x".repeat(Math.min(room, 15_000));
  }
  return match;
}
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cockpit-chess-storage-"));
});
afterEach(async () => {
  fsMocks.failRename = false;
  await rm(dir, { recursive: true, force: true });
});
describe("chess storage", () => {
  it("round-trips an archive without leaving temporary files", async () => {
    const match = createMatch({ white: player, black: player, rules: {} });
    const file = path.join(dir, "game.json");
    await writeGame(file, match);
    expect((await readGame(file)).id).toBe(match.id);
    expect(await readdir(dir)).toEqual(["game.json"]);
  });
  it("removes the temporary file when the rename fails", async () => {
    fsMocks.failRename = true;
    const match = createMatch({ white: player, black: player, rules: {} });
    await expect(writeGame(path.join(dir, "game.json"), match)).rejects.toThrow("rename failed");
    expect(await readdir(dir)).toEqual([]);
  });
  it("writes the canonical form, and accepts an archive of exactly the shared limit", async () => {
    const match = archiveOfSize(MAX_ARCHIVE_BYTES);
    const file = path.join(dir, "limit.json");
    await writeGame(file, match);
    expect((await stat(file)).size).toBe(MAX_ARCHIVE_BYTES);
    expect(await readFile(file, "utf8")).toBe(serializeArchive(match));
    expect(await readGame(file)).toEqual(match);
  });
  it("rejects an archive one byte over the shared limit with a clear error", async () => {
    const file = path.join(dir, "over.json");
    await writeGame(file, archiveOfSize(MAX_ARCHIVE_BYTES + 1));
    await expect(readGame(file)).rejects.toThrow("Game archive exceeds 2 MB");
  });
  it("rejects oversized archives before reading them", async () => {
    const file = path.join(dir, "big.json");
    await writeFile(file, " ".repeat(MAX_ARCHIVE_BYTES + 1));
    await expect(readGame(file)).rejects.toThrow();
  });
});
