import { randomUUID } from "node:crypto";
import {
  parseRunnerClientFrame,
  RUNNER_HEARTBEAT_MS,
  RUNNER_LIVENESS_MS,
  RUNNER_MAX_BUFFERED_BYTES,
  RUNNER_MAX_FRAME_BYTES,
  RUNNER_RESUME_GRACE_MS,
  type RunnerServerMessage,
  runnerServerMessageSchema,
} from "@cockpit-chess/chess/runner-protocol";
import type { RunnerMachineIdentity } from "./runner-session.js";
import type { RunnerAuthority } from "./runner-ws-authority.js";
import type { RunnerLease, RunnerLeaseStore } from "./runner-ws-store.js";

const RUNNER_MAX_PENDING_MESSAGES = 8;
export const RUNNER_MAX_LOCAL_CONNECTIONS = 128;
const IO_TIMEOUT_MS = 5000;

export interface RunnerSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

/** No submitted data, error object or bearer may enter logs or close reasons. */
async function withRunnerDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Runner storage timeout")), IO_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Options = {
  authority: RunnerAuthority;
  leases: RunnerLeaseStore;
  isAvailable: () => boolean;
  now?: () => number;
};

/**
 * Transport simulation only. E4 owns durable command delivery and move CAS.
 * Valid match actions are scope-checked then answered UNSUPPORTED, never run.
 */
export function createRunnerTransport(options: Options) {
  const now = options.now ?? (() => performance.now());
  const connections = new Set<ReturnType<typeof connection>>();
  let draining = false;
  let opening = 0;
  const inflight = new Set<Promise<unknown>>();
  type Reservation = {
    identity: RunnerMachineIdentity;
    lease: RunnerLease;
    release: (code?: number, reason?: string) => Promise<void>;
  };
  const reservations = new Set<Reservation>();

  function run<T>(operation: Promise<T>): Promise<T> {
    inflight.add(operation);
    void operation.finally(() => inflight.delete(operation)).catch(() => {});
    return withRunnerDeadline(operation);
  }

  async function checkAuthority(
    authorization: string,
    identity: RunnerMachineIdentity,
    lease: RunnerLease,
    action: boolean,
  ) {
    if (draining || !options.isAvailable()) return "unauthorized";
    const classify = (current: RunnerMachineIdentity | null) => {
      if (
        !current ||
        current.userId !== identity.userId ||
        current.machineId !== identity.machineId
      )
        return "unauthorized";
      if (current.connectionGeneration > identity.connectionGeneration) return "replaced";
      return current.connectionGeneration === identity.connectionGeneration ? "ok" : "unauthorized";
    };
    const result = classify(await run(options.authority.resolve(authorization)));
    if (result !== "ok") return result;
    if (await run(options.leases.validate(lease, action))) return "ok";
    // Replacement can commit between the durable read and Redis validation.
    const latest = classify(await run(options.authority.resolve(authorization)));
    return latest === "replaced" ? "replaced" : "unauthorized";
  }

  function connection(
    socket: RunnerSocket,
    authorization: string,
    identity: RunnerMachineIdentity,
    lease: RunnerLease,
  ) {
    let closed = false;
    let pending = 0;
    let received = 0;
    let sent = 0;
    let lastAck = 0;
    let hello = false;
    let lastSeen = now();
    let lastPong = now();
    const heartbeatNonces = new Map<string, number>();
    let lastHeartbeat = now();
    let ticking = false;
    let processing = Promise.resolve();
    let terminating: ReturnType<typeof setTimeout> | undefined;
    let windowStart = now();
    let frames = 0;

    function close(code = 4401, reason = "UNAUTHORIZED") {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearTimeout(helloTimeout);
      heartbeatNonces.clear();
      connections.delete(api);
      // Do not await an unavailable store before stopping authority locally.
      void run(options.leases.release(lease)).catch(() => {});
      try {
        terminating = setTimeout(() => socket.terminate(), 1000);
        terminating.unref?.();
        socket.close(code, reason);
      } catch {
        clearTimeout(terminating);
        socket.terminate();
      }
    }

    async function authorized(action: boolean) {
      if (closed) return false;
      const result = await checkAuthority(authorization, identity, lease, action);
      if (result === "replaced") close(4409, "REPLACED");
      return !closed && result === "ok";
    }

    function send(
      message: Omit<RunnerServerMessage, "version" | "generation" | "id" | "seq" | "ack">,
    ) {
      if (closed) return;
      if (socket.bufferedAmount > RUNNER_MAX_BUFFERED_BYTES) {
        close(4408, "BACKPRESSURE");
        return;
      }
      const frame = JSON.stringify(
        runnerServerMessageSchema.parse({
          ...message,
          version: 1,
          generation: lease.generation,
          id: randomUUID(),
          seq: ++sent,
          ack: received,
        }),
      );
      const bytes = Buffer.byteLength(frame);
      if (bytes > RUNNER_MAX_FRAME_BYTES) throw new Error("Runner frame limit");
      if (socket.bufferedAmount + bytes > RUNNER_MAX_BUFFERED_BYTES) {
        close(4408, "BACKPRESSURE");
        return;
      }
      socket.send(frame);
    }

    async function tick() {
      if (closed || ticking) return;
      ticking = true;
      try {
        if (now() - lastSeen >= RUNNER_LIVENESS_MS || now() - lastPong >= RUNNER_LIVENESS_MS) {
          close(4408, "LIVENESS");
          return;
        }
        if ([...heartbeatNonces.values()].some((expires) => expires <= now())) {
          close(4408, "LIVENESS");
          return;
        }
        if (now() - lastHeartbeat < RUNNER_HEARTBEAT_MS) return;
        if (!(await authorized(false))) {
          close();
          return;
        }
        if (closed) return;
        lastHeartbeat = now();
        const nonce = randomUUID();
        heartbeatNonces.set(nonce, now() + RUNNER_LIVENESS_MS);
        send({ type: "heartbeat", payload: { nonce } });
        socket.ping();
      } catch {
        close();
      } finally {
        ticking = false;
      }
    }
    const timer = setInterval(() => void tick(), 5000);
    timer.unref?.();
    const helloTimeout = setTimeout(() => close(4408, "HANDSHAKE"), IO_TIMEOUT_MS);
    helloTimeout.unref?.();

    function receive(data: string | Uint8Array, binary = false) {
      if (closed) return;
      if (now() - windowStart >= 60_000) {
        windowStart = now();
        frames = 0;
      }
      if (
        binary ||
        Buffer.byteLength(data) > RUNNER_MAX_FRAME_BYTES ||
        ++frames > 240 ||
        pending >= RUNNER_MAX_PENDING_MESSAGES
      ) {
        close(4400, "INVALID");
        return;
      }
      let message: ReturnType<typeof parseRunnerClientFrame>;
      try {
        message = parseRunnerClientFrame(
          typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
        );
      } catch {
        close(4400, "INVALID");
        return;
      }
      ++pending;
      processing = processing
        .then(async () => {
          if (closed) return;
          if (
            message.generation !== lease.generation ||
            message.seq !== received + 1 ||
            message.ack < lastAck ||
            message.ack > sent ||
            (!hello && message.type !== "hello") ||
            (hello && message.type === "hello")
          ) {
            close(4400, "INVALID");
            return;
          }
          if (!(await authorized(true))) {
            close();
            return;
          }
          if (closed) return;
          if (
            "matchId" in message &&
            !(await run(options.authority.ownsMatch(identity, message.matchId)))
          ) {
            close();
            return;
          }
          if (closed) return;
          received = message.seq;
          lastAck = message.ack;
          if (message.type === "pong") {
            const expires = heartbeatNonces.get(message.payload.nonce);
            if (expires === undefined || expires <= now()) {
              close(4400, "INVALID");
              return;
            }
            heartbeatNonces.delete(message.payload.nonce);
            lastSeen = now();
          } else if (message.type === "heartbeat") {
            lastSeen = now();
            send({ type: "pong", payload: { nonce: message.payload.nonce } });
          } else if (message.type === "hello") {
            hello = true;
            clearTimeout(helloTimeout);
            lastSeen = now();
            send({ type: "ack", payload: { commandId: message.id } });
          } else {
            send({ type: "error", payload: { code: "UNSUPPORTED" } });
          }
        })
        .catch(() => close())
        .finally(() => --pending);
    }
    const api = {
      identity,
      lease,
      receive,
      pong() {
        lastPong = now();
      },
      close,
      finished() {
        close();
        clearTimeout(terminating);
      },
      idle: () => processing,
      tick,
      isClosed: () => closed,
    };
    try {
      send({
        type: "welcome",
        payload: {
          heartbeatMs: RUNNER_HEARTBEAT_MS,
          livenessMs: RUNNER_LIVENESS_MS,
          resumeGraceMs: RUNNER_RESUME_GRACE_MS,
        },
      });
    } catch {
      close();
    }
    return api;
  }

  return {
    /** Pre-upgrade reads/budgets share transport's capacity and shutdown join. */
    async admit<T>(check: () => Promise<T>): Promise<T> {
      if (draining || !options.isAvailable() || inflight.size >= RUNNER_MAX_LOCAL_CONNECTIONS) {
        throw new Error("Runner admission unavailable");
      }
      return run(check());
    },
    async reserve(authorization: string, ip: string) {
      if (
        draining ||
        !options.isAvailable() ||
        inflight.size >= RUNNER_MAX_LOCAL_CONNECTIONS ||
        connections.size + opening >= RUNNER_MAX_LOCAL_CONNECTIONS
      )
        return null;
      ++opening;
      let retained = false;
      const connectionId = randomUUID();
      let ipReserved = false;
      let pendingLease: RunnerLease | undefined;
      try {
        // Quota rejection must not commit a replacement generation.
        if (!(await run(options.leases.reserveIp(ip, connectionId)))) return null;
        ipReserved = true;
        const identity = await run(options.authority.claim(authorization));
        if (!identity || draining) return null;
        const lease: RunnerLease = {
          machineId: identity.machineId,
          userId: identity.userId,
          generation: identity.connectionGeneration,
          connectionId,
          ip,
        };
        pendingLease = lease;
        if (!(await run(options.leases.acquire(lease)))) return null;
        if (draining) return null;
        let phase: "reserved" | "attaching" | "attached" | "released" = "reserved";
        let attachingSocket: RunnerSocket | undefined;
        const timeout = setTimeout(() => void release(4408, "HANDSHAKE"), IO_TIMEOUT_MS);
        timeout.unref?.();
        const release = async (code = 4401, reason = "UNAUTHORIZED") => {
          if (phase === "released" || phase === "attached") return;
          phase = "released";
          reservations.delete(reservation);
          clearTimeout(timeout);
          --opening;
          attachingSocket?.close(code, reason);
          await run(options.leases.release(lease)).catch(() => {});
        };
        const reservation = { identity, lease, release };
        reservations.add(reservation);
        retained = true;
        return {
          release,
          async attach(socket: RunnerSocket) {
            if (phase !== "reserved" || draining || !options.isAvailable()) {
              socket.close(1012, "RESTART");
              await release();
              return null;
            }
            phase = "attaching";
            attachingSocket = socket;
            try {
              const authority = await checkAuthority(authorization, identity, lease, false);
              // A push/timeout can retire a pending handshake during the reads.
              if (
                authority !== "ok" ||
                !reservations.has(reservation) ||
                draining ||
                !options.isAvailable()
              ) {
                await release(
                  authority === "replaced" ? 4409 : 4401,
                  authority === "replaced" ? "REPLACED" : "UNAUTHORIZED",
                );
                return null;
              }
              for (const active of connections) {
                if (
                  active.identity.machineId === identity.machineId &&
                  active.lease.generation >= lease.generation
                ) {
                  await release(4409, "REPLACED");
                  return null;
                }
              }
              phase = "attached";
              reservations.delete(reservation);
              --opening;
              clearTimeout(timeout);
              for (const active of connections) {
                if (active.identity.machineId === identity.machineId)
                  active.close(4409, "REPLACED");
              }
              const active = connection(socket, authorization, identity, lease);
              if (!active.isClosed()) connections.add(active);
              return active;
            } catch {
              await release();
              return null;
            }
          },
        };
      } catch {
        return null;
      } finally {
        if (!retained) {
          --opening;
          if (pendingLease) await run(options.leases.release(pendingLease)).catch(() => {});
          else if (ipReserved)
            await run(options.leases.releaseIp(ip, connectionId)).catch(() => {});
        }
      }
    },
    invalidate(userId?: string, machineId?: string, generation?: number) {
      for (const reservation of reservations) {
        if (
          (!userId || reservation.identity.userId === userId) &&
          (!machineId || reservation.identity.machineId === machineId) &&
          (generation === undefined || reservation.lease.generation < generation)
        )
          void reservation.release(
            generation === undefined ? 4401 : 4409,
            generation === undefined ? "UNAUTHORIZED" : "REPLACED",
          );
      }
      for (const active of connections) {
        if (
          (!userId || active.identity.userId === userId) &&
          (!machineId || active.identity.machineId === machineId) &&
          (generation === undefined || active.lease.generation < generation)
        )
          active.close(
            generation === undefined ? 4401 : 4409,
            generation === undefined ? "UNAUTHORIZED" : "REPLACED",
          );
      }
    },
    async drain() {
      draining = true;
      for (const active of connections) active.close(1012, "RESTART");
      await Promise.allSettled(
        [...reservations].map((reservation) => reservation.release(1012, "RESTART")),
      );
      // Join storage activity before lifecycle disconnects Prisma/Redis. A
      // failed drain must not claim that dependencies are safe to disconnect.
      while (inflight.size) await withRunnerDeadline(Promise.allSettled([...inflight]));
    },
  };
}
