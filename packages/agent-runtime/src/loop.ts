import { isDeadlineAbort } from "./deadline";
import { AgentRuntimeError, FatalToolError } from "./errors";
import { toModelRuntimeError } from "./retry";
import { executeTanstackLoop } from "./tanstack-loop";
import type { AgentLoopOptions, AgentLoopResult, AgentStopReason, AgentUsage } from "./types";

/**
 * A run that stopped without a usable final result. `usage` is whatever the
 * dispatches that did run reported — tokens billed before an abort or deadline are
 * real and must reach the caller's accounting, never be replaced by zeros.
 */
const emptyResult = (
  options: AgentLoopOptions,
  stopReason: Extract<AgentStopReason, "aborted" | "vetoed" | "timeout">,
  usage: AgentUsage,
  vetoReason?: string,
): AgentLoopResult => ({
  messages: options.messages,
  usage: { ...usage },
  stopReason,
  ...(vetoReason !== undefined ? { vetoReason } : {}),
});

const isAbortError = (error: unknown): boolean =>
  (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError");

export const runAgentLoop = async (options: AgentLoopOptions): Promise<AgentLoopResult> => {
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
  if (options.abortSignal?.aborted) return emptyResult(options, "aborted", usage);

  const abortController = new AbortController();
  const abort = () => abortController.abort(options.abortSignal?.reason);
  options.abortSignal?.addEventListener("abort", abort, { once: true });

  try {
    const result = await executeTanstackLoop(options, abortController, usage);
    if (result.vetoed) {
      return {
        messages: result.messages,
        usage: result.usage,
        stopReason: "vetoed",
        vetoReason: result.vetoReason,
      };
    }
    // Precedence: a wall-clock stop, a cancel, and a truncated final turn are all more
    // actionable than "ran out of iterations", and none of them is a success.
    const stopReason: AgentStopReason = result.timedOut
      ? "timeout"
      : result.aborted
        ? "aborted"
        : result.outputTruncated
          ? "output-truncated"
          : result.hitIterationLimit
            ? "max-iterations"
            : "completed";
    return {
      messages: result.messages,
      usage: result.usage,
      stopReason,
      ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
    };
  } catch (error) {
    if (error instanceof FatalToolError) throw error;
    // A deadline abort must not be reported as a caller-requested cancel: the run was
    // not cancelled, it ran out of wall-clock time with work still outstanding.
    if (abortController.signal.aborted && isDeadlineAbort(abortController.signal.reason))
      return emptyResult(options, "timeout", usage);
    if (abortController.signal.aborted || isAbortError(error))
      return emptyResult(options, "aborted", usage);
    if (error instanceof AgentRuntimeError) throw error;
    throw toModelRuntimeError(error);
  } finally {
    options.abortSignal?.removeEventListener("abort", abort);
  }
};
