import { AgentRuntimeError } from "./errors";

/** Defaults for model-dispatch retry (per candidate model). */
export const DEFAULT_MAX_ATTEMPTS_PER_MODEL = 3;
export const DEFAULT_MAX_WAIT_MS = 15_000;
const DEFAULT_BASE_DELAY_MS = 500;
/** Primary + up to 3 fallbacks. */
export const MAX_FAILOVER_CANDIDATES = 4;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/** An HTTP status from a number or a 3-digit string; anything else is not a status. */
const asStatus = (value: unknown): number | undefined => {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{3}$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
};

/**
 * The provider's structured error body, when present: an adapter-attached `rawEvent`
 * (RUN_ERROR chunks, OpenRouter mid-stream errors) or the SDK `APIError.error` body.
 */
const providerBody = (source: Record<string, unknown>): Record<string, unknown> | undefined =>
  asRecord(source.rawEvent) ?? asRecord(source.error);

/**
 * HTTP status of a model failure: `status`, then `statusCode` (OpenRouter SDK), then a
 * 3-digit `code` (TanStack RUN_ERROR chunks carry the status there when the provider
 * gave no code), then the same fields on the provider error body.
 */
const getErrorStatus = (error: unknown): number | undefined => {
  const source = asRecord(error);
  if (!source) return undefined;
  const body = providerBody(source);
  return (
    asStatus(source.status) ??
    asStatus(source.statusCode) ??
    asStatus(source.code) ??
    (body ? (asStatus(body.status) ?? asStatus(body.statusCode) ?? asStatus(body.code)) : undefined)
  );
};

/**
 * TanStack AI 1.0 `chat()` moves every non-AG-UI field of a RUN_ERROR (`errorType`,
 * `retryAfterMs`, `requestId`, ...) under `metadata.tanstack` before the chunk reaches
 * the consumer. Adapter-level chunks (what the retry adapter sees) still carry them at
 * the top level, so both places are read.
 */
const tanstackMetadata = (source: Record<string, unknown>): Record<string, unknown> | undefined =>
  asRecord(asRecord(source.metadata)?.tanstack);

/** Non-numeric provider error codes, most specific first. */
const getErrorCodes = (error: unknown): string[] => {
  const source = asRecord(error);
  if (!source) return [];
  const body = providerBody(source);
  const tanstack = tanstackMetadata(source);
  // A stream chunk's own `type` (e.g. "RUN_ERROR") names the event, not a provider code.
  const ownType = source.type === "RUN_ERROR" ? undefined : source.type;
  // 1.0 RUN_ERRORs carry the provider's error type (`overloaded_error`,
  // `authentication_error`, ...) as `errorType`, separate from `code`.
  const candidates = [
    source.code,
    source.errorType,
    tanstack?.errorType,
    body?.code,
    body?.type,
    ownType,
  ];
  return candidates.filter(
    (value): value is string =>
      typeof value === "string" && value.length > 0 && asStatus(value) === undefined,
  );
};

/**
 * Provider error codes that no retry or failover can fix: bad credentials, exhausted
 * billing, a request the provider will always reject (context overflow, unknown model).
 * Codes arrive with their HTTP status stripped — TanStack's RUN_ERROR `code` prefers the
 * provider's code over the status — so these must be recognised on their own.
 */
const PERMANENT_ERROR_CODES = new Set([
  // Credentials / access
  "invalid_api_key",
  "authentication_error",
  "permission_error",
  "permission_denied",
  "account_deactivated",
  "unsupported_country_region_territory",
  // Billing — a 429 in OpenAI's API, but waiting does not refill the account.
  "insufficient_quota",
  "billing_hard_limit_reached",
  // Request shape the provider will reject every time.
  "context_length_exceeded",
  "context_overflow",
  "invalid_request_error",
  "model_not_found",
  "not_found_error",
]);

/** Statuses worth retrying: request timeout, rate limit, and every 5xx. */
const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

export interface ModelErrorClassification {
  /** Worth retrying / failing over to another model / re-queueing. */
  retryable: boolean;
  status?: number;
  /** First non-numeric provider code, when one was reported. */
  code?: string;
  /** Provider-requested wait before retrying, when it said. */
  retryAfterMs?: number;
}

/**
 * THE classifier for model-dispatch failures — thrown SDK errors, TanStack RUN_ERROR
 * chunks, and {@link AgentRuntimeError}s alike. Every retry decision in the runtime
 * (retry adapter, loop error mapping, RUN_ERROR handling) goes through this one
 * function so they cannot disagree.
 *
 * Order:
 *   1. An `AgentRuntimeError` already carries its decision.
 *   2. A non-transient 4xx status (auth, validation) is permanent.
 *   3. A known permanent provider code is permanent, even under a transient status
 *      (`insufficient_quota` is a 429).
 *   4. Everything else — 408/429/5xx, network failures, unknown shapes — is transient.
 *
 * Aborts are not classified here: callers check the abort signal first.
 */
export const classifyModelError = (error: unknown): ModelErrorClassification => {
  if (error instanceof AgentRuntimeError) {
    return {
      retryable: error.retryable,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  const status = getErrorStatus(error);
  const codes = getErrorCodes(error);
  const code = codes[0];
  const record = asRecord(error);
  const explicitWait =
    record?.retryAfterMs ?? (record ? tanstackMetadata(record)?.retryAfterMs : undefined);
  const retryAfterMs =
    typeof explicitWait === "number" && Number.isFinite(explicitWait) && explicitWait >= 0
      ? explicitWait
      : parseRetryAfterMs(error);
  const permanent =
    (status !== undefined && status >= 400 && status < 500 && !isTransientStatus(status)) ||
    codes.some((candidate) => PERMANENT_ERROR_CODES.has(candidate.toLowerCase()));
  return {
    retryable: !permanent,
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
};

/** Whether a model-dispatch failure is worth retrying / failing over. */
export const isTransientModelError = (error: unknown): boolean =>
  classifyModelError(error).retryable;

/**
 * Normalize any model failure (thrown error or RUN_ERROR chunk) into an
 * {@link AgentRuntimeError} carrying the shared classification.
 */
export const toModelRuntimeError = (
  error: unknown,
  fallbackMessage = "Agent model request failed",
): AgentRuntimeError => {
  if (error instanceof AgentRuntimeError) return error;
  const { retryable, status, code, retryAfterMs } = classifyModelError(error);
  const rawMessage = asRecord(error)?.message;
  const message =
    typeof rawMessage === "string" && rawMessage.length > 0 ? rawMessage : fallbackMessage;
  return new AgentRuntimeError(message, { retryable, status, code, retryAfterMs, cause: error });
};

/**
 * Parse a Retry-After header value (seconds or HTTP-date) into a delay in ms.
 * Returns undefined when missing/unparseable.
 */
export const parseRetryAfterMs = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const headers =
    "headers" in error && error.headers && typeof error.headers === "object"
      ? (error.headers as Record<string, unknown>)
      : "response" in error &&
          error.response &&
          typeof error.response === "object" &&
          "headers" in error.response &&
          error.response.headers &&
          typeof error.response.headers === "object"
        ? (error.response.headers as Record<string, unknown>)
        : undefined;
  if (!headers) return undefined;
  const raw =
    headers["retry-after"] ??
    headers["Retry-After"] ??
    (typeof (headers as { get?: (k: string) => unknown }).get === "function"
      ? (headers as { get: (k: string) => unknown }).get("retry-after")
      : undefined);
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const dateMs = Date.parse(text);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
};

/**
 * Full-jitter exponential backoff delay for attempt index (0-based), capped at maxWaitMs.
 * When `retryAfterMs` is set, use min(retryAfter, maxWait).
 */
export const computeBackoffMs = (
  attemptIndex: number,
  options?: {
    baseDelayMs?: number;
    maxWaitMs?: number;
    retryAfterMs?: number;
    random?: () => number;
  },
): number => {
  const base = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxWait = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const random = options?.random ?? Math.random;
  if (options?.retryAfterMs !== undefined) {
    return Math.min(Math.max(0, options.retryAfterMs), maxWait);
  }
  const exp = Math.min(maxWait, base * 2 ** attemptIndex);
  return Math.floor(random() * exp);
};

/** Sleep that rejects promptly when `signal` aborts. */
export const sleepWithAbort = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
