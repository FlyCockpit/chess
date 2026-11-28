import { DEFAULT_POSITION, type EngineEvaluation } from "@cockpit-chess/chess";
import { evaluatePosition } from "@cockpit-chess/chess/engine";
import { isCompiledBinary } from "./chess-provider";

/** Probe the same local pool used by the common runner; bundled binaries cannot run it. */
export async function probeRunnerEngine(signal: AbortSignal): Promise<boolean> {
  if (isCompiledBinary()) return false;
  try {
    await evaluateRunnerPosition(DEFAULT_POSITION, 1000, signal);
    return !signal.aborted;
  } catch {
    return false;
  }
}

/** Background evaluations share the local pool without taking priority over players. */
export async function evaluateRunnerPosition(
  fen: string,
  nodes: number,
  signal: AbortSignal,
): Promise<EngineEvaluation> {
  if (!Number.isInteger(nodes) || nodes < 1000 || nodes > 100000)
    throw new Error("Invalid engine node allowance");
  signal.throwIfAborted();
  return evaluatePosition(fen, { nodes, signal, lane: "spectators" });
}
