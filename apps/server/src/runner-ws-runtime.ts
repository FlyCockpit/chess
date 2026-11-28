import {
  disconnectRunnerMatches,
  handleRunnerControl,
  RUNNER_COMMAND_CHANNEL,
  runnerOutbox,
} from "@cockpit-chess/api/lib/chess-runner";
import { runnerLimitsService } from "@cockpit-chess/auth/runner-limits";
import {
  RUNNER_MAX_BUFFERED_BYTES,
  RUNNER_MAX_FRAME_BYTES,
  RUNNER_WS_PATH,
} from "@cockpit-chess/chess/runner-protocol";
import { startRunnerMachineNotifications } from "@cockpit-chess/db/runner-machine-notifications";
import { createRedisConnection, redisConnection } from "@cockpit-chess/queue";
import { upgradeWebSocket } from "@hono/node-server";
import WebSocket, { WebSocketServer } from "ws";
import { createRunnerTransport, type RunnerSocket } from "./runner-ws.js";
import { createRunnerAuthority, type RunnerOwnerActive } from "./runner-ws-authority.js";
import { createRunnerInvalidationMonitor } from "./runner-ws-invalidation.js";
import { createRunnerLeaseStore } from "./runner-ws-store.js";

/** Node upgrade adapter. null is the deliberate D2a activation gate. */
export function createRunnerWebSocketRuntime(options: { isOwnerActive: RunnerOwnerActive | null }) {
  const server = new WebSocketServer({
    noServer: true,
    path: RUNNER_WS_PATH,
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: RUNNER_MAX_FRAME_BYTES,
    maxFragments: 128,
    maxBufferedChunks: 128,
    allowSynchronousEvents: false,
    autoPong: true,
  });
  // Never pass adapter error objects to logs: upgrade errors can contain URLs.
  server.on("error", () => {});
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const authority = options.isOwnerActive ? createRunnerAuthority(options.isOwnerActive) : null;
  let monitor: ReturnType<typeof createRunnerInvalidationMonitor> | undefined;
  const isAvailable = () => !stopped && (monitor?.isAvailable() ?? false);
  const transport = authority
    ? createRunnerTransport({
        authority,
        leases: createRunnerLeaseStore(redisConnection),
        isAvailable,
        limits: runnerLimitsService,
        controls: {
          outbox: runnerOutbox,
          handle: handleRunnerControl,
          disconnected: async (identity) => {
            await disconnectRunnerMatches(identity);
          },
        },
      })
    : null;
  if (transport) {
    monitor = createRunnerInvalidationMonitor({
      subscriber: createRedisConnection({ maxRetriesPerRequest: 1, commandTimeout: 5000 }),
      startNotifications: startRunnerMachineNotifications,
      invalidate: transport.invalidate,
      commandChannel: RUNNER_COMMAND_CHANNEL,
      wake: transport.wake,
    });
  }
  const runtime =
    authority && transport
      ? {
          authority,
          transport,
          isAvailable,
          upgrade: (reservation: NonNullable<Awaited<ReturnType<typeof transport.reserve>>>) =>
            upgradeWebSocket(
              () => ({
                onOpen(_event, context) {
                  const contextSocket = context.raw;
                  if (!(contextSocket instanceof WebSocket)) {
                    context.close(1011, "UNAVAILABLE");
                    void reservation.release();
                    return;
                  }
                  const raw: WebSocket = contextSocket;
                  let active: Awaited<ReturnType<typeof reservation.attach>>;
                  let retired = false;
                  let controlFrames = 0;
                  let controlWindow = Date.now();
                  let termination: ReturnType<typeof setTimeout> | undefined;
                  function close(code: number, reason: string) {
                    if (raw.readyState === WebSocket.CLOSED) return;
                    if (!termination) {
                      termination = setTimeout(() => raw.terminate(), 1000);
                      termination.unref?.();
                    }
                    raw.close(code, reason);
                  }
                  const socket: RunnerSocket = {
                    get bufferedAmount() {
                      return raw.bufferedAmount;
                    },
                    send(frame) {
                      if (raw.readyState !== WebSocket.OPEN)
                        throw new Error("Runner socket closed");
                      raw.send(frame, { compress: false }, (error) => {
                        if (error) active?.close();
                      });
                    },
                    ping() {
                      if (raw.readyState === WebSocket.OPEN) raw.ping();
                    },
                    close,
                    terminate: () => raw.terminate(),
                  };
                  function control() {
                    if (Date.now() - controlWindow >= 60_000) {
                      controlWindow = Date.now();
                      controlFrames = 0;
                    }
                    if (++controlFrames > 240 || raw.bufferedAmount > RUNNER_MAX_BUFFERED_BYTES) {
                      active?.close(4408, "BACKPRESSURE");
                      close(4408, "BACKPRESSURE");
                      void reservation.release();
                      return false;
                    }
                    return true;
                  }
                  raw.on("pong", () => {
                    if (control()) active?.pong();
                  });
                  raw.on("ping", control);
                  raw.on("message", (data, binary) => {
                    if (!active) {
                      close(4400, "INVALID");
                      void reservation.release();
                      return;
                    }
                    // ws enforces maxPayload while assembling, before this allocation.
                    const bytes = Array.isArray(data)
                      ? Buffer.concat(data)
                      : Buffer.isBuffer(data)
                        ? data
                        : Buffer.from(data);
                    active.receive(bytes, binary);
                  });
                  raw.on("error", () => {
                    active?.close();
                    close(4401, "UNAUTHORIZED");
                    void reservation.release();
                  });
                  raw.once("close", () => {
                    retired = true;
                    clearTimeout(termination);
                    active?.finished();
                    void reservation.release();
                  });
                  void reservation
                    .attach(socket)
                    .then((connection) => {
                      active = connection;
                      if (retired) active?.finished();
                    })
                    .catch(() => {
                      close(4401, "UNAUTHORIZED");
                      void reservation.release();
                    });
                },
              }),
              {
                onError: () => {
                  void reservation.release();
                },
              },
            ),
        }
      : null;
  return {
    server,
    runtime,
    stop() {
      if (stopping) return stopping;
      stopped = true;
      const terminated = setTimeout(() => {
        for (const socket of server.clients) socket.terminate();
      }, 1000);
      terminated.unref?.();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      stopping = Promise.all([transport?.drain(), monitor?.stop(), closed])
        .then(() => {})
        .finally(() => clearTimeout(terminated));
      return stopping;
    },
  };
}
