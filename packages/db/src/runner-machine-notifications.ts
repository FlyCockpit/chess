import { Buffer } from "node:buffer";
import { env } from "@cockpit-chess/env/shared";
import { Client } from "pg";
import { z } from "zod";

// Keep this local: importing the publisher from auth would introduce a cycle.
const CHANNEL = "runner_machine_revoked";
const TIMEOUT_MS = 5_000;
const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 30_000;
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const invalidation = z.object({ userId: identifier, machineId: identifier.optional() }).strict();

type Invalidation = { userId: string; machineId?: string };
type Notification = { channel: string; payload?: string };

/** The small pg surface needed here also allows tests to avoid TCP entirely. */
type NotificationClient = {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "notification", listener: (message: Notification) => void): unknown;
  on(event: "error" | "end", listener: () => void): unknown;
  removeListener(event: "notification", listener: (message: Notification) => void): unknown;
  removeListener(event: "error" | "end", listener: () => void): unknown;
};

function parseInvalidation(payload: string | undefined): Invalidation | undefined {
  if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > 1_024) return;
  try {
    const value: unknown = JSON.parse(payload);
    const result = invalidation.safeParse(value);
    if (result.success) return result.data;
  } catch {
    // Neither malformed messages nor pg errors may reach logs (including URLs).
  }
}

function ignoreError() {}

function invoke(callback: () => void) {
  try {
    // A void callback can still be implemented by an async function.
    void Promise.resolve(callback()).catch(ignoreError);
  } catch {
    // Socket-closing callbacks must not escape an EventEmitter handler.
  }
}

/**
 * A dedicated, reconnecting LISTEN connection. Notifications only prompt socket
 * closure; callers must still check durable authority on connect/action/heartbeat.
 * Drain stop() before shutting down shared database and Redis resources.
 */
export function startRunnerMachineNotifications({
  onInvalidate,
  onUnavailable,
  onReady,
  createClient = () =>
    new Client({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: TIMEOUT_MS,
      query_timeout: TIMEOUT_MS,
    }),
}: {
  onInvalidate: (event: Invalidation) => void;
  onUnavailable: () => void;
  onReady?: () => void;
  createClient?: () => NotificationClient;
}): { isReady: () => boolean; stop: () => Promise<void> } {
  let stopped = false;
  let ready = false;
  let retryMs = INITIAL_RETRY_MS;
  let cancelAttempt: (() => void) | undefined;
  let cancelRetry: (() => void) | undefined;

  async function listen() {
    let client: NotificationClient | undefined;
    let lost = false;
    let stageTimer: ReturnType<typeof setTimeout> | undefined;
    let signalLoss: () => void = ignoreError;
    const disconnected = new Promise<void>((resolve) => {
      signalLoss = resolve;
    });

    function cancel() {
      lost = true;
      clearTimeout(stageTimer);
      signalLoss();
    }

    function unavailable() {
      if (stopped || lost) return;
      ready = false;
      // Mark lost before invoking user code, including reentrant stop().
      cancel();
      invoke(onUnavailable);
    }

    function notification(message: Notification) {
      if (stopped || lost || !ready || message.channel !== CHANNEL) return;
      const event = parseInvalidation(message.payload);
      if (event) invoke(() => onInvalidate(event));
    }

    async function step(operation: () => Promise<unknown>): Promise<boolean> {
      if (stopped || lost) return false;
      stageTimer = setTimeout(unavailable, TIMEOUT_MS);
      stageTimer.unref?.();
      try {
        // Racing loss/stop matters: pg can leave connect() pending when end()
        // interrupts its handshake. The losing promise still has a rejection
        // handler, and cleanup joins end() before another client is created.
        return await Promise.race([operation().then(() => true), disconnected.then(() => false)]);
      } finally {
        clearTimeout(stageTimer);
        stageTimer = undefined;
      }
    }

    cancelAttempt = cancel;
    try {
      const connection = createClient();
      client = connection;
      connection.on("error", unavailable);
      connection.on("end", unavailable);
      connection.on("notification", notification);
      if (!(await step(() => connection.connect())) || stopped || lost) return;
      if (!(await step(() => connection.query(`LISTEN ${CHANNEL}`))) || stopped || lost) return;
      ready = true;
      retryMs = INITIAL_RETRY_MS;
      if (onReady) invoke(onReady);
      await disconnected;
    } catch {
      unavailable();
    } finally {
      ready = false;
      cancel();
      if (client) {
        try {
          await client.end();
        } catch {
          // Cleanup failures are never logged or allowed to reject stop().
        }
        // Retired clients need no references to callbacks. Keep a detached error
        // sink for a late pg event after end() or a cancelled handshake.
        client.on("error", ignoreError);
        client.removeListener("error", unavailable);
        client.removeListener("end", unavailable);
        client.removeListener("notification", notification);
      }
      cancelAttempt = undefined;
    }
  }

  function waitToRetry() {
    // Equal jitter: each delay is 50–100% of an exponentially increasing cap.
    const delay = retryMs * (0.5 + Math.random() * 0.5);
    retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cancelRetry = undefined;
        resolve();
      }, delay);
      timer.unref?.();
      cancelRetry = () => {
        clearTimeout(timer);
        cancelRetry = undefined;
        resolve();
      };
    });
  }

  const finished = Promise.resolve()
    .then(async () => {
      while (!stopped) {
        await listen();
        if (!stopped) await waitToRetry();
      }
    })
    .catch(() => {
      // Catch even unexpected lifecycle failures; pg errors may contain secrets.
      ready = false;
      if (!stopped) invoke(onUnavailable);
    });

  return {
    isReady: () => ready,
    stop() {
      stopped = true;
      ready = false;
      cancelRetry?.();
      cancelAttempt?.();
      return finished;
    },
  };
}
