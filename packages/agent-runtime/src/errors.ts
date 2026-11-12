export class FatalToolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FatalToolError";
  }
}

export class AgentRuntimeError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  /** Provider error code (`invalid_api_key`, `context_overflow`, …), when one was reported. */
  readonly code?: string;
  /** How long the provider asked the caller to wait before retrying, when it said. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      status?: number;
      code?: string;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "AgentRuntimeError";
    this.retryable = options.retryable;
    this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}
