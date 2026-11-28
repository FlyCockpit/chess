import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { DEFAULT_POSITION, type EngineEvaluation } from "@cockpit-chess/chess";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRunnerPosition, probeRunnerEngine } from "./runner-engine";

const { evaluatePosition, isCompiledBinary, spawn } = vi.hoisted(() => ({
  evaluatePosition: vi.fn<typeof import("@cockpit-chess/chess/engine").evaluatePosition>(),
  isCompiledBinary: vi.fn(() => false),
  spawn: vi.fn(),
}));
vi.mock("@cockpit-chess/chess/engine", () => ({ evaluatePosition }));
vi.mock("./chess-provider", () => ({ isCompiledBinary }));
vi.mock("node:child_process", () => ({ spawn }));

const evaluation: EngineEvaluation = {
  engine: "stockfish-19-lite-single",
  fen: DEFAULT_POSITION,
  depth: 1,
  nodes: 1000,
  cp: 7,
  mate: null,
  bestMove: "e2e4",
};

beforeEach(() => {
  evaluatePosition.mockReset().mockResolvedValue(evaluation);
  isCompiledBinary.mockReset().mockReturnValue(false);
  spawn.mockReset();
});

describe("runner local engine adapter", () => {
  it("probes the initial position with 1000 nodes on the shared spectator lane", async () => {
    const signal = new AbortController().signal;
    await expect(probeRunnerEngine(signal)).resolves.toBe(true);
    expect(evaluatePosition).toHaveBeenCalledExactlyOnceWith(DEFAULT_POSITION, {
      nodes: 1000,
      signal,
      lane: "spectators",
    });
  });

  it("refuses compiled Bun binaries before calling the engine", async () => {
    isCompiledBinary.mockReturnValue(true);
    await expect(probeRunnerEngine(new AbortController().signal)).resolves.toBe(false);
    expect(evaluatePosition).not.toHaveBeenCalled();
  });

  it("reports an unavailable engine without exposing its failure", async () => {
    evaluatePosition.mockRejectedValueOnce(new Error("Engine could not start"));
    await expect(probeRunnerEngine(new AbortController().signal)).resolves.toBe(false);
    expect(evaluatePosition).toHaveBeenCalledTimes(1);
  });

  it.each([1000, 10000, 100000])(
    "passes a finite %i-node budget and the result through",
    async (nodes) => {
      const signal = new AbortController().signal;
      const fen = "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1";
      await expect(evaluateRunnerPosition(fen, nodes, signal)).resolves.toBe(evaluation);
      expect(evaluatePosition).toHaveBeenCalledExactlyOnceWith(fen, {
        nodes,
        signal,
        lane: "spectators",
      });
    },
  );

  it.each([Number.NaN, Infinity, -Infinity, 0, 999, 100001, 1000.5])(
    "rejects an invalid node budget (%s) before calling the engine",
    async (nodes) => {
      await expect(
        evaluateRunnerPosition(DEFAULT_POSITION, nodes, new AbortController().signal),
      ).rejects.toThrow("Invalid engine node allowance");
      expect(evaluatePosition).not.toHaveBeenCalled();
    },
  );

  it("propagates evaluation failures without retrying or falling back", async () => {
    const error = new Error("Engine could not start");
    evaluatePosition.mockRejectedValueOnce(error);
    await expect(
      evaluateRunnerPosition(DEFAULT_POSITION, 1000, new AbortController().signal),
    ).rejects.toBe(error);
    expect(evaluatePosition).toHaveBeenCalledTimes(1);
  });

  it("skips pre-cancelled work and advertises no capability", async () => {
    const signal = AbortSignal.abort();
    await expect(probeRunnerEngine(signal)).resolves.toBe(false);
    await expect(evaluateRunnerPosition(DEFAULT_POSITION, 1000, signal)).rejects.toBe(
      signal.reason,
    );
    expect(evaluatePosition).not.toHaveBeenCalled();
  });

  it.each(["probe", "evaluate"])("forwards in-flight cancellation for %s", async (operation) => {
    const controller = new AbortController();
    const cancelled = new Error("Engine analysis cancelled");
    evaluatePosition.mockImplementationOnce(
      (_fen, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(cancelled), { once: true });
        }),
    );
    const pending =
      operation === "probe"
        ? probeRunnerEngine(controller.signal)
        : evaluateRunnerPosition(DEFAULT_POSITION, 1000, controller.signal);
    controller.abort();
    if (operation === "probe") await expect(pending).resolves.toBe(false);
    else await expect(pending).rejects.toBe(cancelled);
    expect(evaluatePosition).toHaveBeenCalledTimes(1);
    expect(evaluatePosition.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});

it("keeps the shared engine's exact lite script, empty environment, single thread and 8 MiB hash", async () => {
  // Exercise the real pool with in-memory UCI streams: never spawn or run Stockfish.
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: vi.fn(),
    kill: vi.fn(() => true),
  });
  const commands: string[] = [];
  child.stdin.on("data", (chunk: Buffer) => {
    const command = chunk.toString();
    commands.push(command);
    queueMicrotask(() => {
      if (command === "uci\n") child.stdout.write("uciok\n");
      else if (command.includes("isready\n")) child.stdout.write("readyok\n");
      else if (command.includes("go nodes "))
        child.stdout.write("info depth 1 nodes 1000 score cp 7\nbestmove e2e4\n");
    });
  });
  spawn.mockReturnValue(child);
  const engine = await vi.importActual<typeof import("@cockpit-chess/chess/engine")>(
    "@cockpit-chess/chess/engine",
  );
  try {
    const result = await engine.evaluatePosition(DEFAULT_POSITION, {
      nodes: 1000,
      lane: "spectators",
    });
    expect(result).toEqual(evaluation);
    const file = createRequire(
      new URL("../../../packages/chess/src/engine.ts", import.meta.url),
    ).resolve("stockfish/bin/stockfish-19-lite-single.js");
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      ["--max-old-space-size=128", file],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: {} },
    );
    expect(commands).toEqual([
      "uci\n",
      "setoption name Threads value 1\nsetoption name Hash value 8\nucinewgame\nsetoption name Clear Hash\nisready\n",
      `position fen ${DEFAULT_POSITION}\ngo nodes 1000\n`,
    ]);
  } finally {
    engine.configureEnginePool({ engineFile: undefined });
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
