import { randomUUID } from "node:crypto";
import {
  type createRunnerLimitsService,
  RunnerLimitsError,
} from "@cockpit-chess/auth/runner-limits";
import {
  parseRunnerClientFrame,
  RUNNER_COMMAND_WINDOW,
  RUNNER_HEARTBEAT_MS,
  RUNNER_LIVENESS_MS,
  RUNNER_MAX_BUFFERED_BYTES,
  RUNNER_MAX_FRAME_BYTES,
  RUNNER_RESUME_GRACE_MS,
  type RunnerClientMessage,
  type RunnerDelivery,
  runnerServerMessageSchema,
} from "@cockpit-chess/chess/runner-protocol";
import { ORPCError } from "@orpc/server";
import type { RunnerMachineIdentity } from "./runner-session.js";
import type { RunnerAuthority } from "./runner-ws-authority.js";
import type { RunnerLease, RunnerLeaseStore } from "./runner-ws-store.js";

// Four commands each produce a semantic reply and snapshot. Reserve four more
// slots for concurrent heartbeat/pong and operating-limit replies.
const RUNNER_MAX_PENDING_MESSAGES = RUNNER_COMMAND_WINDOW * 2 + 4;
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

function failureClose(error: unknown): [number, string] {
  if (
    (error instanceof ORPCError &&
      ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)) ||
    (error instanceof RunnerLimitsError && ["NOT_FOUND", "FORBIDDEN"].includes(error.code))
  )
    return [4401, "UNAUTHORIZED"];
  return [1012, "UNAVAILABLE"];
}

type Options = {
  authority: RunnerAuthority;
  leases: RunnerLeaseStore;
  isAvailable: () => boolean;
  now?: () => number;
  limits?: Pick<ReturnType<typeof createRunnerLimitsService>, "hello" | "pending" | "result">;
  controls?: {
    outbox(
      identity: RunnerMachineIdentity,
      outstandingIds: readonly string[],
    ): Promise<RunnerDelivery[]>;
    handle(
      identity: RunnerMachineIdentity,
      message: RunnerClientMessage,
    ): Promise<RunnerDelivery[]>;
  };
};

/**
 * Durable control delivery shares the transport's authority, bounds and drain.
 * Gameplay handlers remain unavailable until authoritative move CAS is installed.
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
    if (draining || !options.isAvailable()) return "unavailable";
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
    let pumping = false;
    let deliveryEpoch = 0;
    const delivered = new Set<string>();
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
      if (result === "unavailable") close(1012, "UNAVAILABLE");
      return !closed && result === "ok";
    }

    function durableCommandId(message: RunnerDelivery) {
      return ["offer", "start", "stop", "resume", "human-move"].includes(message.type) &&
        "commandId" in message.payload
        ? message.payload.commandId
        : null;
    }

    function send(message: RunnerDelivery) {
      if (closed) return;
      const commandId = durableCommandId(message);
      if (commandId && (delivered.has(commandId) || delivered.size >= RUNNER_COMMAND_WINDOW))
        return;
      if (socket.bufferedAmount > RUNNER_MAX_BUFFERED_BYTES) {
        close(4408, "BACKPRESSURE");
        return;
      }
      const frame = JSON.stringify(
        runnerServerMessageSchema.parse({
          ...message,
          version: 1,
          generation: lease.generation,
          id: "commandId" in message.payload ? message.payload.commandId : randomUUID(),
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
      if (commandId) delivered.add(commandId);
      socket.send(frame);
    }

    async function deliver() {
      if (closed || !hello || pumping || !options.controls) return;
      pumping = true;
      try {
        if (!(await authorized(false))) {
          close();
          return;
        }
        const epoch = deliveryEpoch;
        const messages = await run(options.controls.outbox(identity, [...delivered]));
        if (messages.length > 32) throw new Error("Runner delivery bound");
        if (!(await authorized(false))) {
          close();
          return;
        }
        // A semantic ACK can commit while the poll/auth reads are pending. Never
        // replay that stale snapshot after its delivery slot was released.
        if (epoch !== deliveryEpoch) return;
        const pendingIds = new Set(messages.map(durableCommandId));
        // The helper independently checks our outstanding IDs, including direct
        // replies beyond the FIFO page. Absence proves cancellation/ACK/expiry.
        for (const id of delivered) if (!pendingIds.has(id)) delivered.delete(id);
        for (const message of messages) send(message);
      } finally {
        pumping = false;
      }
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
        if (!hello) return;
        // A missed Redis wake never loses a committed command. Poll the bounded
        // durable outbox while the connection is live, also on reconnect hello.
        await deliver();
        if (!(await authorized(false))) {
          close();
          return;
        }
        if (closed) return;
        if (options.limits) {
          const command = await run(options.limits.pending(identity));
          if (closed) return;
          if (command) send({ type: "limits", payload: command });
        }
        if (now() - lastHeartbeat < RUNNER_HEARTBEAT_MS) return;
        lastHeartbeat = now();
        const nonce = randomUUID();
        heartbeatNonces.set(nonce, now() + RUNNER_LIVENESS_MS);
        send({ type: "heartbeat", payload: { nonce } });
        socket.ping();
      } catch (error) {
        close(...failureClose(error));
      } finally {
        ticking = false;
      }
    }
    // Track the whole callback, including the gaps between its storage reads,
    // so drain/idle cannot observe a temporarily empty IO set mid-tick.
    const timer = setInterval(
      () => void run(tick()).catch((error) => close(...failureClose(error))),
      5000,
    );
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
            if (options.limits) {
              const command = await run(
                options.limits.hello(identity, {
                  operatingLimits: message.payload.operatingLimits,
                  hardLimits: message.payload.hardLimits,
                }),
              );
              if (closed) return;
              if (command) send({ type: "limits", payload: command });
            }
            send({ type: "ack", payload: { commandId: message.id } });
            await deliver();
          } else if (message.type === "limits-result") {
            if (options.limits) {
              await run(options.limits.result(identity, message.payload));
              if (closed) return;
              send({ type: "ack", payload: { commandId: message.payload.commandId } });
            } else send({ type: "error", payload: { code: "UNSUPPORTED" } });
          } else {
            if (options.controls) {
              let replies: RunnerDelivery[];
              try {
                replies = await run(options.controls.handle(identity, message));
              } catch (error) {
                if (error instanceof ORPCError && error.code === "UNAUTHORIZED") {
                  close();
                  return;
                }
                const code =
                  error instanceof ORPCError
                    ? error.code === "CONFLICT"
                      ? "STALE"
                      : error.code === "TOO_MANY_REQUESTS"
                        ? "BUSY"
                        : error.code === "BAD_REQUEST"
                          ? "UNSUPPORTED"
                          : null
                    : null;
                if (!code) {
                  close(...failureClose(error));
                  return;
                }
                // The failed semantic write releases no slot. Re-read authority
                // and the authoritative outbox after a normal per-match race.
                ++deliveryEpoch;
                if (!(await authorized(false))) {
                  close();
                  return;
                }
                send({ type: "error", payload: { code } });
                await deliver();
                return;
              }
              ++deliveryEpoch;
              if (message.type === "accept" || message.type === "reject" || message.type === "ack")
                delivered.delete(message.payload.commandId);
              if (replies.length > 32) throw new Error("Runner response bound");
              if (!(await authorized(false))) {
                close();
                return;
              }
              for (const reply of replies) send(reply);
              await deliver();
            } else send({ type: "error", payload: { code: "UNSUPPORTED" } });
          }
        })
        .catch((error) => close(...failureClose(error)))
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
      deliver,
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
                  authority === "replaced" ? 4409 : authority === "unavailable" ? 1012 : 4401,
                  authority === "replaced"
                    ? "REPLACED"
                    : authority === "unavailable"
                      ? "UNAVAILABLE"
                      : "UNAUTHORIZED",
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
            } catch (error) {
              await release(...failureClose(error));
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
    wake(machineId: string) {
      for (const active of connections) {
        if (active.identity.machineId === machineId)
          void run(active.deliver()).catch((error) => active.close(...failureClose(error)));
      }
    },
    /** Join already-started transport work without retiring live authority. */
    async idle() {
      while (inflight.size) await withRunnerDeadline(Promise.allSettled([...inflight]));
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
