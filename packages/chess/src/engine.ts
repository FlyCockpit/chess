import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface, type Interface } from "node:readline";
import { Chess, type EngineEvaluation, evaluationSchema } from "./index";

const ENGINE_ID = "stockfish-19-lite-single" as const;
const ANALYSIS_TIMEOUT_MS = 5000;
const OUTPUT_LIMIT_BYTES = 262144;

/**
 * A bounded pool of long-lived UCI processes, shared by every game in the host
 * process, so analyses skip the ~250 ms node + WASM start-up and engine work never
 * scales with the number of matches: 512 concurrent games still mean at most
 * `size` Stockfish processes, with everything else waiting in a FIFO queue.
 *
 * Each process is isolated from the parent: it runs with an empty environment
 * (UCI analysis needs no provider keys or other credentials), one thread and an
 * 8 MiB hash. Processes are reused across games, so every evaluation starts with
 * `ucinewgame`, `setoption name Clear Hash` and `isready`, and the search starts
 * only after `readyok`: a score never depends on what the process evaluated
 * before (results stay reproducible). Any error, timeout or cancellation kills
 * that one process so a hung search can never poison the next request; a crash or
 * timeout is retried once (on another or a new process) before that evaluation
 * fails, and no other game is affected.
 */
interface EngineProcess {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  alive: boolean;
  initialized: boolean;
  diagnostic: string;
  /** Handlers of the request in progress; unset while idle. */
  onLine?: (line: string) => void;
  onOutput?: (bytes: number) => void;
  onFailure?: (error: Error) => void;
}
/**
 * Two priorities on the one pool: the players' engine (tool calls, player-facing
 * after-move evaluations) is served ahead of the spectators' background evaluation,
 * and spectator work may hold at most `size - 1` processes (at least one), so with
 * two or more processes a player evaluation never waits behind spectators alone.
 */
export type EngineLane = "players" | "spectators";
/** The default when the host never configures the pool (the CLI): today's two processes. */
const DEFAULT_POOL_SIZE = 2;
/** Upper bound of `configureEnginePool`, matching CHESS_ENGINE_POOL_SIZE. */
const MAX_POOL_SIZE = 256;
interface EngineJob {
  lane: EngineLane;
  chess: Chess;
  nodes: number;
  signal?: AbortSignal;
  retried: boolean;
  resolve: (value: EngineEvaluation) => void;
  reject: (error: Error) => void;
}
const pool: {
  size: number;
  engineFile?: string;
  idle: EngineProcess[];
  busy: number;
  busySpectators: number;
  started: number;
  queues: Record<EngineLane, EngineJob[]>;
} = {
  size: DEFAULT_POOL_SIZE,
  idle: [],
  busy: 0,
  busySpectators: 0,
  started: 0,
  queues: { players: [], spectators: [] },
};
const spectatorCap = () => Math.max(1, pool.size - 1);

/**
 * Sets the pool's size (the worker: CHESS_ENGINE_POOL_SIZE or the CPU count).
 * Shrinking stops idle processes beyond the new size; busy ones finish first.
 * `engineFile` replaces the Stockfish script (tests only).
 */
export function configureEnginePool(options: { size?: number; engineFile?: string }) {
  if (options.size !== undefined) {
    if (!Number.isInteger(options.size) || options.size < 1 || options.size > MAX_POOL_SIZE)
      throw new Error("Invalid engine pool size");
    pool.size = options.size;
  }
  if ("engineFile" in options) {
    pool.engineFile = options.engineFile;
    // Processes of the previous script are not reused.
    for (const engine of pool.idle.splice(0)) stopEngine(engine);
  }
  while (pool.idle.length + pool.busy > pool.size && pool.idle.length) {
    const engine = pool.idle.pop();
    if (engine) stopEngine(engine);
  }
  dispatch();
}

/** The default pool size for a host with `cpus` cores: half of them, at least 2, at most 16. */
export function defaultEnginePoolSize(cpus: number) {
  return Math.min(16, Math.max(2, Math.floor(cpus / 2)));
}

/** Live counts for the admin capacity view and tests. */
export function enginePoolStats() {
  return {
    busy: pool.busy,
    total: pool.size,
    waiting: pool.queues.players.length + pool.queues.spectators.length,
    /** Processes started since boot (replacements included). */
    started: pool.started,
  };
}

/** The process must never keep its host alive; an in-flight request's timer does that. */
function unref(handle: unknown) {
  (handle as { unref?: () => void }).unref?.();
}
function stopEngine(target: EngineProcess) {
  if (!target.alive) return;
  target.alive = false;
  const index = pool.idle.indexOf(target);
  if (index !== -1) pool.idle.splice(index, 1);
  target.lines.close();
  target.child.kill("SIGKILL");
}
function startEngine(): EngineProcess {
  const file =
    pool.engineFile ??
    createRequire(import.meta.url).resolve("stockfish/bin/stockfish-19-lite-single.js");
  pool.started += 1;
  const child = spawn(process.execPath, ["--max-old-space-size=128", file], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {},
  });
  const started: EngineProcess = {
    child,
    lines: createInterface({ input: child.stdout }),
    alive: true,
    initialized: false,
    diagnostic: "",
  };
  const fail = (error: Error) => {
    if (!started.alive) return;
    const onFailure = started.onFailure;
    stopEngine(started);
    onFailure?.(error);
  };
  child.on("error", () => fail(new Error("Engine could not start")));
  child.on("close", (code) =>
    fail(new Error(`Engine exited before analysis (${code})`, { cause: started.diagnostic })),
  );
  child.stdin.on("error", () => fail(new Error("Engine input closed")));
  child.stderr.on("data", (chunk: Buffer) => {
    started.diagnostic = (started.diagnostic + chunk.toString()).slice(-1024);
    started.onOutput?.(chunk.length);
  });
  started.lines.on("line", (line) => {
    started.onOutput?.(Buffer.byteLength(line));
    started.onLine?.(line);
  });
  child.unref();
  unref(child.stdin);
  unref(child.stdout);
  unref(child.stderr);
  return started;
}

/** Sent before every search: no state of an earlier game or position carries over. */
const RESET = "ucinewgame\nsetoption name Clear Hash\nisready\n";

/** Why an analysis failed: only crashes and timeouts are worth one retry. */
class EngineFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EngineFailure";
  }
}

/** One analysis on `current`; the caller owns the process and returns or discards it. */
function analyse(
  current: EngineProcess,
  chess: Chess,
  nodes: number,
  signal?: AbortSignal,
): Promise<EngineEvaluation> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EngineFailure("Engine analysis cancelled", false));
      return;
    }
    const result: EngineEvaluation = {
      engine: ENGINE_ID,
      fen: chess.fen(),
      depth: 0,
      nodes: 0,
      cp: chess.isDraw() ? 0 : null,
      mate: chess.isCheckmate() ? 0 : null,
      bestMove: null,
    };
    let settled = false;
    let searching = false;
    let outputBytes = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      current.onLine = undefined;
      current.onOutput = undefined;
      current.onFailure = undefined;
      if (error) {
        stopEngine(current);
        reject(error);
        return;
      }
      try {
        resolve(evaluationSchema.parse(result));
      } catch {
        stopEngine(current);
        reject(new EngineFailure("Invalid engine evaluation", true));
      }
    };
    const abort = () => finish(new EngineFailure("Engine analysis cancelled", false));
    // Covers start-up (when respawning) plus search, from when a process took the job:
    // time spent waiting in the pool's queue does not count.
    const timer = setTimeout(
      () => finish(new EngineFailure("Engine analysis timed out", true)),
      ANALYSIS_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", abort, { once: true });
    current.onFailure = (error) =>
      finish(new EngineFailure(error.message, true, { cause: error.cause }));
    current.onOutput = (bytes) => {
      outputBytes += bytes;
      if (outputBytes > OUTPUT_LIMIT_BYTES)
        finish(new EngineFailure("Engine output limit exceeded", true));
    };
    current.onLine = (line) => {
      if (line === "uciok") {
        current.child.stdin.write(
          `setoption name Threads value 1\nsetoption name Hash value 8\n${RESET}`,
        );
      } else if (line === "readyok" && !searching) {
        searching = true;
        current.child.stdin.write(`position fen ${chess.fen()}\ngo nodes ${nodes}\n`);
      } else if (line.startsWith("info ") && !/\b(?:lowerbound|upperbound)\b/.test(line)) {
        const depth = /\bdepth (\d+)/.exec(line);
        const searched = /\bnodes (\d+)/.exec(line);
        const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
        if (depth?.[1]) result.depth = Number(depth[1]);
        if (searched?.[1]) result.nodes = Number(searched[1]);
        if (score?.[2]) {
          const value = Number(score[2]) * (chess.turn() === "w" ? 1 : -1) || 0;
          result.cp = score[1] === "cp" ? value : null;
          result.mate = score[1] === "mate" ? value : null;
        }
      } else if (line.startsWith("bestmove ")) {
        const move = line.split(" ")[1];
        result.bestMove = move && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move) ? move : null;
        if (result.cp === null && result.mate === null)
          finish(new EngineFailure("Engine returned no score", true));
        else finish();
      }
    };
    if (current.initialized) current.child.stdin.write(RESET);
    else {
      current.initialized = true;
      current.child.stdin.write("uci\n");
    }
  });
}

/** Hands queued jobs to free processes, players first, within the pool's bounds. */
function dispatch() {
  for (;;) {
    const lane: EngineLane | undefined = pool.queues.players.length
      ? "players"
      : pool.queues.spectators.length && pool.busySpectators < spectatorCap()
        ? "spectators"
        : undefined;
    if (!lane) return;
    let engine = pool.idle.pop();
    if (!engine) {
      if (pool.busy >= pool.size) return;
      engine = startEngine();
    }
    const job = pool.queues[lane].shift() as EngineJob;
    run(engine, job);
  }
}

/** Back to the idle list, unless it died or the pool shrank meanwhile. */
function release(engine: EngineProcess) {
  if (!engine.alive) return;
  // `busy` still counts this job, so the sum is the pool's size after release.
  if (pool.idle.length + pool.busy <= pool.size) pool.idle.push(engine);
  else stopEngine(engine);
}

function run(engine: EngineProcess, job: EngineJob) {
  pool.busy += 1;
  if (job.lane === "spectators") pool.busySpectators += 1;
  analyse(engine, job.chess, job.nodes, job.signal)
    .then(
      (evaluation) => {
        release(engine);
        job.resolve(evaluation);
      },
      (error: unknown) => {
        // analyse killed the process on every failure; a job cancelled before it
        // started left it untouched. A crash or timeout gets one more try.
        release(engine);
        if (
          error instanceof EngineFailure &&
          error.retryable &&
          !job.retried &&
          !job.signal?.aborted
        ) {
          job.retried = true;
          pool.queues[job.lane].unshift(job);
        } else job.reject(error instanceof Error ? error : new Error("Engine analysis failed"));
      },
    )
    .finally(() => {
      pool.busy -= 1;
      if (job.lane === "spectators") pool.busySpectators -= 1;
      dispatch();
    });
}

/** Bounded nodes and a 5 s allowance per analysis, on the shared engine pool. */
export async function evaluatePosition(
  fen: string,
  options: { nodes?: number; signal?: AbortSignal; lane?: EngineLane } = {},
): Promise<EngineEvaluation> {
  const chess = new Chess(fen);
  const nodes = options.nodes ?? 10000;
  if (!Number.isInteger(nodes) || nodes < 1000 || nodes > 100000)
    throw new Error("Invalid engine node allowance");
  const { signal } = options;
  signal?.throwIfAborted();
  const lane = options.lane ?? "players";
  return new Promise((resolve, reject) => {
    const job: EngineJob = {
      lane,
      chess,
      nodes,
      signal,
      retried: false,
      resolve: (value) => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    };
    // A request cancelled while queued leaves the queue and rejects at once; one that
    // is running is cancelled by analyse (which also kills its process).
    const abort = () => {
      const queue = pool.queues[lane];
      const index = queue.indexOf(job);
      if (index === -1) return;
      queue.splice(index, 1);
      job.reject(new Error("Engine analysis cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    pool.queues[lane].push(job);
    dispatch();
  });
}
