import { afterEach, expect, it, vi } from "vitest";
import { withNetworkDeadline } from "./network";

afterEach(() => vi.useRealTimers());

it("clears the deadline after success and failure", async () => {
  vi.useFakeTimers();
  await expect(withNetworkDeadline(async () => 42)).resolves.toBe(42);
  const failure = new Error("transport failed");
  await expect(
    withNetworkDeadline(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves caller cancellation even if the operation ignores abort", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const operation = vi.fn(async (_signal: AbortSignal) => new Promise<void>(() => {}));
  const result = withNetworkDeadline(operation, 30_000, controller.signal);
  const failure = new Error("cancelled by caller");
  const rejected = expect(result).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(1);
  controller.abort(failure);
  await rejected;
  expect(operation.mock.calls[0]?.[0].aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start an operation for an already aborted caller", async () => {
  const controller = new AbortController();
  controller.abort();
  const operation = vi.fn(async () => 42);
  await expect(withNetworkDeadline(operation, 30_000, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(operation).not.toHaveBeenCalled();
});

it("uses a request timeout message rather than a chess termination reason", async () => {
  vi.useFakeTimers();
  const result = withNetworkDeadline(() => new Promise<void>(() => {}), 10);
  const rejected = expect(result).rejects.toMatchObject({
    name: "TimeoutError",
    message: "Request timed out",
  });
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
