import { t } from "./chess-i18n";

export const REQUEST_TIMEOUT_MS = 30_000;

/** Bound the entire operation, even when an injected transport ignores abort. */
export async function withNetworkDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = REQUEST_TIMEOUT_MS,
  callerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new DOMException(t("cli:requestTimeout"), "TimeoutError")),
    timeoutMs,
  );
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([
      aborted,
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation(signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
