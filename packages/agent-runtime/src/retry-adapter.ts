import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";

import type { ModelAdapter } from "./adapters";
import { AgentRuntimeError } from "./errors";
import { runErrorTruncationReason } from "./finish-reason";
import {
  classifyModelError,
  computeBackoffMs,
  DEFAULT_MAX_ATTEMPTS_PER_MODEL,
  DEFAULT_MAX_WAIT_MS,
  MAX_FAILOVER_CANDIDATES,
  sleepWithAbort,
  toModelRuntimeError,
} from "./retry";

const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  (error.name === "AbortError" || error.name === "APIUserAbortError");

/**
 * `iterator.next()`, raced against `signal`. A provider stream that is stuck waiting on
 * the network would otherwise hold the dispatch open past a cancel or the wall-clock
 * deadline, because nothing downstream regains control until the next chunk arrives.
 * The losing `next()` promise is still observed, so its eventual rejection is handled.
 */
const nextOrAbort = <T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> => {
  if (!signal) return iterator.next();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

/**
 * A RUN_ERROR that arrives before any content: the request failed (HTTP 4xx/5xx,
 * connection error) and the adapter reported it as a chunk instead of throwing.
 * Truncation and abort RUN_ERRORs are not failures of this kind and pass through.
 */
const isPreContentFailure = (chunk: StreamChunk): boolean => {
  if (chunk.type !== "RUN_ERROR") return false;
  if (chunk.code === "aborted") return false;
  return runErrorTruncationReason(chunk) === undefined;
};

type RetryFailoverCandidate = ModelAdapter & { modelId: string };

export type RetryFailoverOptions = {
  candidates: RetryFailoverCandidate[];
  abortSignal?: AbortSignal;
  maxAttemptsPerModel?: number;
  maxWaitMs?: number;
  baseDelayMs?: number;
  /** Called when a successful dispatch used a non-primary model. */
  onFailover?: (servingModelId: string, primaryModelId: string) => void;
  /** Test seam: override delay scheduling (receives ms). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam: fixed random for deterministic backoff. */
  random?: () => number;
};

/**
 * Wrap one or more model adapters so each `chatStream` call retries on transient
 * failures, then fails over to the next candidate (cap {@link MAX_FAILOVER_CANDIDATES}).
 *
 * CHUNKS ARE FORWARDED AS THEY ARRIVE, and the retry window closes with the
 * first content chunk (a bare `RUN_STARTED` is held back, not committed; a
 * `RUN_ERROR` arriving before content is treated exactly like a thrown error). That pairing is the whole design, so it is worth stating plainly:
 *
 *   • A dispatch that fails BEFORE emitting anything is retried and failed over
 *     freely. This is the overwhelming majority of transient failures — 429s,
 *     5xx, connection resets — because they happen while establishing the
 *     request, before a single token exists.
 *   • Once a chunk has been yielded, the attempt is COMMITTED. A retry would
 *     replay the answer from the top on top of text the consumer has already
 *     rendered and published, so a mid-stream failure is surfaced as an error
 *     instead. The worker turns that into a recoverable ERROR the user can
 *     retry deliberately, which is the honest outcome: only the user knows
 *     whether a half-written answer is worth paying for twice.
 *
 * The alternative — buffering the whole stream and yielding it only on success —
 * makes every failure retryable, and it is what this adapter used to do. It is
 * not worth it: it silently defeats streaming for EVERY successful response, the
 * common case. `onChunk` cannot fire until the model has finished, so a durable
 * SSE stream publishes nothing for the length of the answer and the UI sits
 * frozen until it arrives whole. Buying a rarer retry with the feature's entire
 * reason for existing is the wrong trade.
 */
export const createRetryFailoverAdapter = (
  options: RetryFailoverOptions,
): {
  adapter: AnyTextAdapter;
  modelOptions?: Record<string, unknown>;
  getServingModelId: () => string;
} => {
  const candidates = options.candidates.slice(0, MAX_FAILOVER_CANDIDATES);
  if (candidates.length === 0) {
    throw new Error("createRetryFailoverAdapter requires at least one candidate");
  }
  const primary = candidates[0]!;
  const maxAttempts = options.maxAttemptsPerModel ?? DEFAULT_MAX_ATTEMPTS_PER_MODEL;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const sleep = options.sleep ?? sleepWithAbort;
  let servingModelId = primary.modelId;

  const chatStream = async function* (
    streamOptions: Parameters<AnyTextAdapter["chatStream"]>[0],
  ): AsyncIterable<StreamChunk> {
    const signal = options.abortSignal;
    let lastError: unknown;
    let modelsTried = 0;
    let attemptsTotal = 0;
    // Has any chunk been handed to the consumer? Once true, no retry and no
    // failover can happen — see the note on this module's export.
    let committed = false;

    const commit = (candidate: RetryFailoverCandidate) => {
      // The model is answering, so record the serving id and announce a failover
      // BEFORE any of it is handed on. A consumer must never see text attributed to
      // the wrong model, and there is no later point to correct it from.
      committed = true;
      servingModelId = candidate.modelId;
      if (candidate.modelId !== primary.modelId) {
        options.onFailover?.(candidate.modelId, primary.modelId);
      }
    };

    for (const candidate of candidates) {
      modelsTried += 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        attemptsTotal += 1;
        if (signal?.aborted) throw abortError();
        // chat() builds `streamOptions` for the primary: its model id and model options
        // (output ceiling, provider extras). A fallback must request ITS model with ITS
        // options, or the "failover" silently re-requests the primary.
        const candidateOptions =
          candidate === primary
            ? streamOptions
            : { ...streamOptions, model: candidate.modelId, modelOptions: candidate.modelOptions };
        const iterator = candidate.adapter.chatStream(candidateOptions)[Symbol.asyncIterator]();
        let iteratorDone = false;
        let abandoned = false;
        // RUN_STARTED carries no content, and the installed adapters emit it right
        // before a RUN_ERROR when the HTTP request itself failed. Holding it until the
        // next chunk shows whether this attempt is answering keeps that failure inside
        // the retry window. Held chunks of a failed attempt are dropped, never replayed.
        const held: StreamChunk[] = [];
        const closeIterator = async () => {
          if (iteratorDone) return;
          iteratorDone = true;
          // Close the provider stream (and its HTTP request). After an abort the
          // inner `next()` may still be pending, and `return()` on a running async
          // generator queues behind it — so do not wait for it then.
          const closing = Promise.resolve(iterator.return?.()).catch(() => undefined);
          if (!abandoned) await closing;
        };
        try {
          while (true) {
            let result: IteratorResult<StreamChunk>;
            try {
              result = await nextOrAbort(iterator, signal);
            } catch (error) {
              if (signal?.aborted) abandoned = true;
              throw error;
            }
            if (result.done) {
              iteratorDone = true;
              break;
            }
            const chunk = result.value;
            if (!committed) {
              if (chunk.type === "RUN_STARTED") {
                held.push(chunk);
                continue;
              }
              if (isPreContentFailure(chunk)) {
                // The provider rejected the request before answering. Surface it as a
                // thrown error so the catch below decides retry / failover exactly as
                // it does for an SDK that throws.
                throw toModelRuntimeError(chunk);
              }
              commit(candidate);
              for (const start of held.splice(0)) yield start;
            }
            yield chunk;
          }
          // A stream that completed without emitting content is still a success — an
          // empty completion is a legitimate model response, and the caller decides
          // what it means.
          if (!committed) {
            commit(candidate);
            for (const start of held.splice(0)) yield start;
          }
          return;
        } catch (error) {
          lastError = error;
          if (isAbortError(error) || signal?.aborted) {
            throw error;
          }
          // COMMITTED: chunks are already downstream, rendered and very likely
          // published. Restarting would replay the answer from the top on top of
          // them. Transient or not, this one is over.
          if (committed) {
            throw error;
          }
          const classification = classifyModelError(error);
          if (!classification.retryable) {
            throw error;
          }
          const isLastAttemptOnModel = attempt >= maxAttempts - 1;
          if (isLastAttemptOnModel) {
            // Fail over to the next candidate (or give up) without sleeping.
            break;
          }
          const delay = computeBackoffMs(attempt, {
            baseDelayMs: options.baseDelayMs,
            maxWaitMs,
            retryAfterMs: classification.retryAfterMs,
            random: options.random,
          });
          // Release the failed attempt's stream before waiting out the backoff.
          await closeIterator();
          await sleep(delay, signal);
        } finally {
          await closeIterator();
        }
      }
    }

    const message =
      `Model dispatch failed after ${attemptsTotal} attempt(s) across ${modelsTried} model(s)` +
      (lastError instanceof Error ? `: ${lastError.message}` : "");
    const last = classifyModelError(lastError);
    throw new AgentRuntimeError(message, {
      retryable: true,
      status: last.status,
      code: last.code,
      cause: lastError,
    });
  };

  const adapter = {
    ...primary.adapter,
    model: primary.adapter.model,
    chatStream,
  } as AnyTextAdapter;

  return {
    adapter,
    modelOptions: primary.modelOptions,
    getServingModelId: () => servingModelId,
  };
};
