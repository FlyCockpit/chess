import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  configureEnginePool,
  defaultEnginePoolSize,
  enginePoolStats,
  evaluatePosition,
} from "./engine";
import { DEFAULT_POSITION } from "./index";

/**
 * A fake UCI engine: answers after a short delay, so many evaluations overlap.
 * A FEN whose full-move number is 77 crashes the process the first time it is seen
 * (a marker file remembers), 99 crashes every time, 88 never answers (timeout).
 */
const FAKE = `
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
const marker = process.argv[2];
const spectatorRelease = process.argv[3];
const lines = createInterface({ input: process.stdin });
let fen = "";
let hashCleared = false;
lines.on("line", (line) => {
  if (line === "uci") process.stdout.write("uciok\\n");
  else if (line === "setoption name Clear Hash") hashCleared = true;
  else if (line === "isready") process.stdout.write("readyok\\n");
  else if (line.startsWith("position fen ")) fen = line.slice(13);
  else if (line.startsWith("go ")) {
    if (!hashCleared) process.exit(3);
    hashCleared = false;
    const move = fen.split(" ")[5];
    if (move === "99") process.exit(2);
    if (move === "77" && !existsSync(marker)) { writeFileSync(marker, "x"); process.exit(2); }
    if (move === "88") return;
    const reply = () => process.stdout.write("info depth 1 nodes 10 score cp 7\\nbestmove e2e4\\n");
    if (spectatorRelease && Number(move) < 10) {
      const gate = setInterval(() => {
        if (!existsSync(spectatorRelease)) return;
        clearInterval(gate);
        reply();
      }, 5);
    } else setTimeout(reply, 15);
  }
});
`;
let dir: string;
let script: string;
let marker: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "engine-pool-"));
  script = path.join(dir, "fake-engine.mjs");
  marker = path.join(dir, "crashed-once");
  writeFileSync(script, FAKE);
});
afterAll(() => {
  configureEnginePool({ size: 2, engineFile: undefined });
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  configureEnginePool({ size: 2, engineFile: undefined });
});
const fen = (move: number) => `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 ${move}`;

describe("shared engine pool", () => {
  it("never runs more processes than its size under many concurrent games", async () => {
    // The fake engine reads its marker path from argv; pass it via a wrapper file.
    const wrapper = path.join(dir, "wrapper.mjs");
    writeFileSync(
      wrapper,
      `process.argv[2] = ${JSON.stringify(marker)};\nawait import(${JSON.stringify(script)});\n`,
    );
    configureEnginePool({ size: 4, engineFile: wrapper });
    const before = enginePoolStats().started;
    let maxBusy = 0;
    let maxWaiting = 0;
    const watcher = setInterval(() => {
      const stats = enginePoolStats();
      maxBusy = Math.max(maxBusy, stats.busy);
      maxWaiting = Math.max(maxWaiting, stats.waiting);
    }, 1);
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        evaluatePosition(fen(1 + (index % 50)), {
          lane: index % 2 ? "spectators" : "players",
        }),
      ),
    );
    clearInterval(watcher);
    expect(results).toHaveLength(200);
    expect(results.every((result) => result.cp === 7)).toBe(true);
    expect(maxBusy).toBeLessThanOrEqual(4);
    expect(maxWaiting).toBeGreaterThan(100);
    expect(enginePoolStats().started - before).toBeLessThanOrEqual(4);
    expect(enginePoolStats()).toMatchObject({ busy: 0, waiting: 0, total: 4 });
  });

  it("serves players ahead of spectators and keeps one process free of spectator work", async () => {
    const release = path.join(dir, "release-spectators");
    rmSync(release, { force: true });
    const wrapper = path.join(dir, "priority-wrapper.mjs");
    writeFileSync(
      wrapper,
      `process.argv[2] = ${JSON.stringify(marker)};\nprocess.argv[3] = ${JSON.stringify(release)};\nawait import(${JSON.stringify(script)});\n`,
    );
    configureEnginePool({ size: 2, engineFile: wrapper });
    const order: string[] = [];
    const spectators = Array.from({ length: 6 }, (_, index) =>
      evaluatePosition(fen(index + 1), { lane: "spectators" }).then(() => order.push("s")),
    );
    // Hold spectator answers explicitly. Starting a second cold process can
    // take longer than several spectator evaluations under suite load.
    try {
      expect(enginePoolStats()).toMatchObject({ busy: 1, waiting: 5 });
      await evaluatePosition(fen(30), { signal: AbortSignal.timeout(4_000) }).then(() =>
        order.push("p"),
      );
      expect(order).toEqual(["p"]);
      expect(enginePoolStats()).toMatchObject({ busy: 1, waiting: 5 });
    } finally {
      writeFileSync(release, "release");
      await Promise.all(spectators);
    }
    expect(order).toEqual(["p", ...Array<string>(6).fill("s")]);
    expect(enginePoolStats()).toMatchObject({ busy: 0, waiting: 0, total: 2 });
  });

  it("replaces a crashed process and retries that one evaluation once", async () => {
    const wrapper = path.join(dir, "wrapper.mjs");
    configureEnginePool({ size: 2, engineFile: wrapper });
    if (existsSync(marker)) rmSync(marker);
    const others = Array.from({ length: 5 }, (_, index) => evaluatePosition(fen(index + 1)));
    const crashedOnce = evaluatePosition(fen(77));
    await expect(crashedOnce).resolves.toMatchObject({ cp: 7 });
    await expect(Promise.all(others)).resolves.toHaveLength(5);
    // Crashing every time fails only that evaluation, after one retry; the
    // neighbours and the next evaluation run on replacement processes.
    const neighbours = Array.from({ length: 3 }, (_, index) => evaluatePosition(fen(index + 10)));
    await expect(evaluatePosition(fen(99))).rejects.toThrow(/exited/);
    await expect(Promise.all(neighbours)).resolves.toHaveLength(3);
    await expect(evaluatePosition(fen(5))).resolves.toMatchObject({ cp: 7 });
    expect(enginePoolStats()).toMatchObject({ busy: 0, waiting: 0 });
  });

  it("drops a job cancelled while it waits in the queue", async () => {
    const wrapper = path.join(dir, "wrapper.mjs");
    configureEnginePool({ size: 1, engineFile: wrapper });
    const first = evaluatePosition(fen(1));
    const controller = new AbortController();
    const queued = evaluatePosition(fen(2), { signal: controller.signal });
    expect(enginePoolStats().waiting).toBe(1);
    controller.abort();
    await expect(queued).rejects.toThrow("cancelled");
    expect(enginePoolStats().waiting).toBe(0);
    await expect(first).resolves.toMatchObject({ cp: 7 });
  });

  it("sizes the default pool from the CPU count", () => {
    expect(defaultEnginePoolSize(1)).toBe(2);
    expect(defaultEnginePoolSize(8)).toBe(4);
    expect(defaultEnginePoolSize(64)).toBe(16);
    expect(() => configureEnginePool({ size: 0 })).toThrow("pool size");
  });

  it("uses the real engine by default and keeps scores reproducible across games", async () => {
    configureEnginePool({ size: 1, engineFile: undefined });
    const position = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
    const first = await evaluatePosition(position);
    await evaluatePosition(DEFAULT_POSITION, { nodes: 50000 });
    expect(await evaluatePosition(position)).toEqual(first);
  });
});
