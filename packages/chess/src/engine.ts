import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface, type Interface } from "node:readline";
import { Chess, type EngineEvaluation, evaluationSchema } from "./index";

const ENGINE_ID = "stockfish-19-lite-single" as const;
const ANALYSIS_TIMEOUT_MS = 5000;
const OUTPUT_LIMIT_BYTES = 262144;

/**
 * One long-lived UCI process per host process, so analyses skip the ~250 ms
 * node + WASM start-up. It is still isolated from the parent: it runs with an
 * empty environment (UCI analysis needs no provider keys or other credentials),
 * one thread and an 8 MiB hash. Requests are serialized, each starts with
 * `ucinewgame` so no hash state carries between positions (results stay
 * deterministic), and any error, timeout or cancellation kills the process so a
 * hung search can never poison the next request; the next request respawns it.
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
let engine: EngineProcess | undefined;
let queue: Promise<void> = Promise.resolve();

/** The process must never keep its host alive; an in-flight request's timer does that. */
function unref(handle: unknown) {
  (handle as { unref?: () => void }).unref?.();
}
function stopEngine(target: EngineProcess) {
  if (!target.alive) return;
  target.alive = false;
  if (engine === target) engine = undefined;
  target.lines.close();
  target.child.kill("SIGKILL");
}
function startEngine(): EngineProcess {
  const file = createRequire(import.meta.url).resolve("stockfish/bin/stockfish-19-lite-single.js");
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

function analyse(chess: Chess, nodes: number, signal?: AbortSignal): Promise<EngineEvaluation> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Engine analysis cancelled"));
      return;
    }
    const current = engine?.alive ? engine : startEngine();
    engine = current;
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
        reject(new Error("Invalid engine evaluation"));
      }
    };
    const abort = () => finish(new Error("Engine analysis cancelled"));
    // Covers start-up (when respawning) plus search, as the per-process engine did.
    const timer = setTimeout(
      () => finish(new Error("Engine analysis timed out")),
      ANALYSIS_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", abort, { once: true });
    current.onFailure = (error) => finish(error);
    current.onOutput = (bytes) => {
      outputBytes += bytes;
      if (outputBytes > OUTPUT_LIMIT_BYTES) finish(new Error("Engine output limit exceeded"));
    };
    current.onLine = (line) => {
      if (line === "uciok") {
        current.child.stdin.write(
          "setoption name Threads value 1\nsetoption name Hash value 8\nucinewgame\nisready\n",
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
          finish(new Error("Engine returned no score"));
        else finish();
      }
    };
    if (current.initialized) current.child.stdin.write("ucinewgame\nisready\n");
    else {
      current.initialized = true;
      current.child.stdin.write("uci\n");
    }
  });
}

/** Bounded nodes and a 5 s allowance per analysis, on the shared serialized engine. */
export async function evaluatePosition(
  fen: string,
  options: { nodes?: number; signal?: AbortSignal } = {},
): Promise<EngineEvaluation> {
  const chess = new Chess(fen);
  const nodes = options.nodes ?? 10000;
  if (!Number.isInteger(nodes) || nodes < 1000 || nodes > 100000)
    throw new Error("Invalid engine node allowance");
  const { signal } = options;
  signal?.throwIfAborted();
  const run = queue.then(() => analyse(chess, nodes, signal));
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  // A request cancelled while queued rejects at once; its turn is then skipped.
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Engine analysis cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    run.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}
