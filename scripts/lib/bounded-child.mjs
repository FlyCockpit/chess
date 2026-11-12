/** Own one direct native client through timeout/cancellation and final close. */
import { spawn } from "node:child_process";

export function boundedChild(
  file,
  args,
  { env = process.env, cwd, signal, timeout = 0, stdio = "inherit", cooperative = false } = {},
) {
  if (signal?.aborted)
    throw Object.assign(new Error("Client cancelled before start."), { code: "CHILD_CANCELLED" });
  const child = spawn(file, args, { env, cwd, stdio });
  // Keep ownership independent of adapters wrapping the public child handle.
  const kill = child.kill.bind(child);
  let stopped = false;
  let failure;
  let reason;
  let escalation;
  const stop = (code = "CHILD_CANCELLED", terminationSignal = "SIGTERM") => {
    if (stopped || child.exitCode !== null || child.signalCode !== null) return;
    stopped = true;
    reason = code;
    kill(terminationSignal);
    // Node owns the native process handle and observes exit before another JS
    // callback can signal it. A shell's saved $! does not have that property.
    // Known nested owners must finish their own leaf drain and EXIT cleanup;
    // forcing them down would orphan that leaf. Only native leaves escalate.
    if (!cooperative && terminationSignal !== "SIGKILL")
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) kill("SIGKILL");
      }, 5_000);
  };
  const abort = () => stop();
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = timeout ? setTimeout(() => stop("CHILD_DEADLINE"), timeout) : undefined;
  const done = new Promise((resolve, reject) => {
    // An error can also mean a failed signal while the process is still alive.
    // Only close is evidence that this owner may acknowledge its final drain.
    child.on("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", abort);
      if (failure || stopped || code !== 0) {
        const failureCode =
          reason ??
          (failure
            ? failure.syscall?.startsWith("spawn")
              ? "CHILD_SPAWN"
              : "CHILD_ERROR"
            : "CHILD_EXIT");
        const message =
          failureCode === "CHILD_DEADLINE"
            ? `Client deadline exceeded (${timeout}ms).`
            : failureCode === "CHILD_CANCELLED"
              ? "Client cancelled."
              : failure
                ? `Client error (${failure.code ?? "unknown"}).`
                : `Client exited with ${code === null ? `signal ${child.signalCode}` : `status ${code}`}.`;
        // Never include argv/env: callers may pass connection strings or tokens.
        reject(
          Object.assign(new Error(message), {
            code: failureCode,
            timeout,
            exitCode: code,
            signal: child.signalCode,
            ...(failure
              ? {
                  cause: Object.assign(new Error("Native client process error."), {
                    code: failure.code,
                  }),
                }
              : {}),
          }),
        );
      } else resolve();
    });
  });
  return { child, done, stop };
}
