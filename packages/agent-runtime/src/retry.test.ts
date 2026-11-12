import { describe, expect, it, vi } from "vitest";

import {
  classifyModelError,
  computeBackoffMs,
  isTransientModelError,
  parseRetryAfterMs,
  sleepWithAbort,
} from "./retry";

describe("isTransientModelError", () => {
  it("retries 429/502/503/504 and network-ish errors", () => {
    expect(isTransientModelError({ status: 429 })).toBe(true);
    expect(isTransientModelError({ status: 503 })).toBe(true);
    expect(isTransientModelError({ status: 502 })).toBe(true);
    expect(isTransientModelError({ status: 504 })).toBe(true);
    expect(isTransientModelError(new Error("fetch failed"))).toBe(true);
    expect(isTransientModelError(new Error("ECONNRESET"))).toBe(true);
  });

  it("fails fast on other 4xx", () => {
    expect(isTransientModelError({ status: 401 })).toBe(false);
    expect(isTransientModelError({ status: 400 })).toBe(false);
    expect(isTransientModelError({ status: 404 })).toBe(false);
  });
});

// TanStack AI 1.0 chat() moves non-AG-UI RUN_ERROR fields under metadata.tanstack.
describe("classifyModelError on 1.0 RUN_ERROR chunks", () => {
  it("reads errorType and retryAfterMs at the top level (adapter chunk)", () => {
    expect(
      classifyModelError({
        type: "RUN_ERROR",
        message: "quota",
        code: "429",
        errorType: "insufficient_quota",
        retryAfterMs: 1500,
      }),
    ).toEqual({ retryable: false, status: 429, code: "insufficient_quota", retryAfterMs: 1500 });
  });

  it("reads errorType and retryAfterMs from metadata.tanstack (public chat() chunk)", () => {
    expect(
      classifyModelError({
        type: "RUN_ERROR",
        message: "overloaded",
        code: "529",
        metadata: { tanstack: { errorType: "overloaded_error", retryAfterMs: 250 } },
      }),
    ).toEqual({ retryable: true, status: 529, code: "overloaded_error", retryAfterMs: 250 });
  });
});

describe("parseRetryAfterMs", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfterMs({ headers: { "retry-after": "2" } })).toBe(2000);
  });
});

describe("computeBackoffMs", () => {
  it("honors Retry-After capped by maxWait", () => {
    expect(computeBackoffMs(0, { retryAfterMs: 1_000, maxWaitMs: 15_000, random: () => 1 })).toBe(
      1000,
    );
    expect(computeBackoffMs(0, { retryAfterMs: 60_000, maxWaitMs: 15_000, random: () => 1 })).toBe(
      15_000,
    );
  });

  it("uses full-jitter exponential when no Retry-After", () => {
    const delay = computeBackoffMs(1, { baseDelayMs: 500, maxWaitMs: 15_000, random: () => 0.5 });
    // attempt 1 → exp = 1000, jitter * 0.5 → 500
    expect(delay).toBe(500);
  });
});

describe("sleepWithAbort", () => {
  it("rejects when the signal aborts during the wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleepWithAbort(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    vi.useRealTimers();
  });
});
