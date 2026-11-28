import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  parseRunnerServerFrame,
  RUNNER_HEARTBEAT_MS,
  RUNNER_LIVENESS_MS,
  RUNNER_MAX_BUFFERED_BYTES,
  RUNNER_MAX_FRAME_BYTES,
  RUNNER_WS_PATH,
  type RunnerClientMessage,
  type RunnerServerMessage,
  runnerClientMessageSchema,
  serializeRunnerFrame,
} from "@cockpit-chess/chess/runner-protocol";

export interface RunnerSocketEvents {
  open(): void;
  message(data: unknown, isBinary?: boolean): void;
  close(code: number): void;
  error(): void;
}

/** Adapter must preserve text/binary distinction, disable redirects and never add cookies. */
export interface RunnerSocket {
  readonly bufferedAmount: number;
  send(frame: string): void;
  close(code: number): void;
  subscribe(events: RunnerSocketEvents): () => void;
}
export type RunnerSocketFactory = (
  url: string,
  options: { headers: { Authorization: string }; maxPayload: number },
) => RunnerSocket;

type Action<T> = T extends RunnerClientMessage
  ? Omit<T, "version" | "generation" | "id" | "seq" | "ack">
  : never;
type ClientAction = Action<RunnerClientMessage>;
export type RunnerClientAction = Exclude<ClientAction, { type: "hello" | "heartbeat" | "pong" }>;
type RunnerMessageHandler = (
  message: Exclude<RunnerServerMessage, { type: "welcome" | "heartbeat" | "pong" }>,
  signal: AbortSignal,
) => void | Promise<void>;
export type RunnerConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "stopped";

export interface RunnerConnectionOptions {
  /** Exact websocket endpoint, never an HTTP URL to downgrade. */
  url: string;
  credential: string;
  hello:
    | Extract<RunnerClientMessage, { type: "hello" }>["payload"]
    | (() => Extract<RunnerClientMessage, { type: "hello" }>["payload"]);
  socketFactory: RunnerSocketFactory;
  allowLocalhostWs?: boolean;
  onMessage?: RunnerMessageHandler;
  /** Observer cancellation follows state changes; observers never block transport. */
  onState?: (state: RunnerConnectionState, signal: AbortSignal) => void | Promise<void>;
  /** Exactly once when reconnect is no longer possible; joins durable local cleanup. */
  onTerminal?: () => void | Promise<void>;
  random?: () => number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const HANDSHAKE_MS = 10_000;
const CALLBACK_MS = 10_000;
const MAX_PENDING_MESSAGES = 32;
const MAX_RECONNECTS = 10;
const MAX_REPLACEMENTS = 3;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("RUNNER_STOPPED"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function endpoint(options: RunnerConnectionOptions): string {
  try {
    const url = new URL(options.url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "wss:" && !(options.allowLocalhostWs && local && url.protocol === "ws:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== RUNNER_WS_PATH ||
      !/^[\x21-\x7e]{1,4096}$/.test(options.credential)
    )
      throw new Error();
    return url.href;
  } catch {
    throw new Error("RUNNER_CONNECTION_INVALID");
  }
}

type Session = {
  socket: RunnerSocket;
  controller: AbortController;
  unsubscribe: () => void;
  timers: Set<ReturnType<typeof setTimeout>>;
  handshake?: ReturnType<typeof setTimeout>;
  liveness?: ReturnType<typeof setTimeout>;
  generation: number;
  received: number;
  sent: number;
  acknowledged: number;
  opened: boolean;
  deadlineAt: number;
  lastValidAt: number;
  pendingNonces: Map<string, ReturnType<typeof setTimeout>>;
  queue: { message: Parameters<RunnerMessageHandler>[0]; bytes: number }[];
  pendingBytes: number;
  processing: boolean;
};

/** Outbound transport only. Nothing executes commands unless onMessage is explicitly installed. */
export class RunnerConnection {
  private readonly url: string;
  private readonly lifetime = new AbortController();
  private state: RunnerConnectionState = "idle";
  private session?: Session;
  private reconnects = 0;
  private replacements = 0;
  private lastGeneration = 0;
  private terminal = false;
  private terminalNotified = false;
  private handlerRunning = false;
  private stateNotification?: AbortController;

  constructor(private readonly options: RunnerConnectionOptions) {
    this.url = endpoint(options);
    // Validate and detach capabilities from subsequent caller mutation.
    const hello = runnerClientMessageSchema.safeParse({
      version: 1,
      generation: 0,
      id: "hello",
      seq: 1,
      ack: 0,
      type: "hello",
      payload: typeof options.hello === "function" ? options.hello() : options.hello,
    });
    if (!hello.success || hello.data.type !== "hello") throw new Error("RUNNER_CONNECTION_INVALID");
    this.options = {
      ...options,
      hello: typeof options.hello === "function" ? options.hello : hello.data.payload,
    };
  }

  getState(): RunnerConnectionState {
    return this.state;
  }

  start(): void {
    if (this.state !== "idle" || this.terminal) return;
    this.connect();
  }

  stop(): void {
    if (this.state === "stopped") return;
    this.markTerminal();
    if (this.session) this.disconnect(this.session, 1000, false);
    this.setState("stopped");
  }

  /** Requires the originating onMessage session's signal; never buffers or replays commands. */
  send(message: RunnerClientAction, signal: AbortSignal): boolean {
    const session = this.session;
    if (
      !session ||
      this.state !== "connected" ||
      signal !== session.controller.signal ||
      signal.aborted
    )
      return false;
    // Runtime callers also cannot issue a second hello or impersonate heartbeat state.
    if (["hello", "heartbeat", "pong"].includes(message.type)) return false;
    return this.write(session, message);
  }

  private setState(state: RunnerConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateNotification?.abort();
    if (this.state === state) void this.notifyState(state);
  }

  private markTerminal(): void {
    this.terminal = true;
    this.lifetime.abort();
    if (this.terminalNotified) return;
    this.terminalNotified = true;
    // Cleanup is separate from cancellable status observers: a terminal
    // observer's cancellation must never skip releasing a process lock.
    void Promise.resolve()
      .then(() => this.options.onTerminal?.())
      .catch(() => {});
  }

  private async notifyState(state: RunnerConnectionState): Promise<void> {
    const observer = this.options.onState;
    if (!observer) return;
    const controller = new AbortController();
    this.stateNotification = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    try {
      const result = observer(state, controller.signal);
      if (result === undefined) return;
      const aborted = new Promise<void>((resolve) => {
        onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) resolve();
      });
      if (this.terminal) controller.abort();
      else timer = setTimeout(() => controller.abort(), CALLBACK_MS);
      await Promise.race([result, aborted]);
    } catch {
      // Observers cannot keep a lost socket connected or escape an event callback.
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  private timer(session: Session, ms: number, callback: () => void) {
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      if (this.session === session && !session.controller.signal.aborted) callback();
    }, ms);
    session.timers.add(timer);
    return timer;
  }

  private cancelTimer(session: Session, timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer === undefined) return;
    clearTimeout(timer);
    session.timers.delete(timer);
  }

  private connect(): void {
    if (this.terminal) return;
    this.setState("connecting");
    if (this.terminal) return;
    try {
      const socket = this.options.socketFactory(this.url, {
        headers: { Authorization: `Bearer ${this.options.credential}` },
        maxPayload: RUNNER_MAX_FRAME_BYTES,
      });
      if (this.terminal) {
        socket.close(1000);
        return;
      }
      const session: Session = {
        socket,
        controller: new AbortController(),
        unsubscribe: () => {},
        timers: new Set(),
        generation: 0,
        received: 0,
        sent: 0,
        acknowledged: 0,
        opened: false,
        deadlineAt: this.now() + HANDSHAKE_MS,
        lastValidAt: this.now(),
        pendingNonces: new Map(),
        queue: [],
        pendingBytes: 0,
        processing: false,
      };
      this.session = session;
      session.handshake = this.timer(session, HANDSHAKE_MS, () => this.disconnect(session, 1001));
      const unsubscribe = socket.subscribe({
        open: () => {
          if (this.session !== session) return;
          if (session.opened) return this.disconnect(session, 4400);
          if (this.now() >= session.deadlineAt) return this.disconnect(session, 1001);
          session.opened = true;
          session.deadlineAt = this.now() + HANDSHAKE_MS;
          this.cancelTimer(session, session.handshake);
          session.handshake = this.timer(session, HANDSHAKE_MS, () =>
            this.disconnect(session, 1001),
          );
        },
        message: (data, isBinary) => this.receive(session, data, isBinary),
        close: (code) => this.disconnect(session, code),
        error: () => this.disconnect(session, 1006),
      });
      session.unsubscribe = unsubscribe;
      // An injected adapter may emit synchronously during registration.
      if (this.session !== session) unsubscribe();
    } catch {
      if (this.session) this.disconnect(this.session, 1006);
      else this.retry();
    }
  }

  private write(session: Session, action: ClientAction): boolean {
    if (this.session !== session || session.controller.signal.aborted) return false;
    if (session.generation && this.now() - session.lastValidAt >= RUNNER_LIVENESS_MS) {
      this.disconnect(session, 1001);
      return false;
    }
    try {
      const parsed = runnerClientMessageSchema.safeParse({
        ...action,
        version: 1,
        generation: session.generation,
        id: randomUUID(),
        seq: session.sent + 1,
        ack: session.received,
      });
      if (!parsed.success) throw new Error();
      const frame = serializeRunnerFrame(parsed.data);
      const buffered = session.socket.bufferedAmount;
      if (
        !Number.isFinite(buffered) ||
        buffered < 0 ||
        buffered + Buffer.byteLength(frame, "utf8") > RUNNER_MAX_BUFFERED_BYTES
      )
        throw new Error();
      session.sent += 1;
      session.socket.send(frame);
      return this.session === session;
    } catch {
      this.disconnect(session, 4400);
      return false;
    }
  }

  private receive(session: Session, input: unknown, isBinary = false): void {
    if (this.session !== session || session.controller.signal.aborted) return;
    if (
      session.generation
        ? this.now() - session.lastValidAt >= RUNNER_LIVENESS_MS
        : this.now() >= session.deadlineAt
    ) {
      this.disconnect(session, 1001);
      return;
    }
    try {
      if (!session.opened || isBinary || typeof input !== "string") throw new Error();
      const buffered = session.socket.bufferedAmount;
      if (!Number.isFinite(buffered) || buffered < 0 || buffered > RUNNER_MAX_BUFFERED_BYTES)
        throw new Error();
      const message = parseRunnerServerFrame(input);
      if (
        message.seq !== session.received + 1 ||
        message.ack < session.acknowledged ||
        message.ack > session.sent
      )
        throw new Error();
      if (session.generation === 0) {
        if (
          message.type !== "welcome" ||
          message.generation <= this.lastGeneration ||
          message.seq !== 1 ||
          message.ack !== 0
        )
          throw new Error();
        session.generation = message.generation;
        this.lastGeneration = message.generation;
        session.received = 1;
        session.lastValidAt = this.now();
        this.cancelTimer(session, session.handshake);
        const hello = this.options.hello;
        if (
          !this.write(session, {
            type: "hello",
            payload: typeof hello === "function" ? hello() : hello,
          })
        )
          return;
        this.setState("connected");
        if (this.session !== session) return;
        this.touch(session);
        this.heartbeat(session);
        return;
      }
      if (message.generation !== session.generation || message.type === "welcome")
        throw new Error();
      if (message.type === "pong") {
        const deadline = session.pendingNonces.get(message.payload.nonce);
        if (deadline === undefined) throw new Error();
        this.cancelTimer(session, deadline);
        session.pendingNonces.delete(message.payload.nonce);
      }
      session.received = message.seq;
      session.acknowledged = message.ack;
      this.touch(session);
      if (message.type === "heartbeat") {
        this.write(session, { type: "pong", payload: message.payload });
      } else if (message.type !== "pong") {
        if (message.type === "error" && message.payload.code === "UNAUTHORIZED") {
          this.disconnect(session, 4401);
          return;
        }
        if (!this.options.onMessage) {
          // Acknowledgements and safe errors require no task executor.
          if (message.type !== "ack" && message.type !== "error") this.disconnect(session, 4400);
          return;
        }
        const bytes = Buffer.byteLength(input, "utf8");
        if (
          session.queue.length + Number(session.processing) >= MAX_PENDING_MESSAGES ||
          session.pendingBytes + bytes > RUNNER_MAX_BUFFERED_BYTES
        )
          throw new Error();
        session.queue.push({ message, bytes });
        session.pendingBytes += bytes;
        void this.process(session);
      }
    } catch {
      this.disconnect(session, 4400);
    }
  }

  private touch(session: Session): void {
    session.lastValidAt = this.now();
    this.cancelTimer(session, session.liveness);
    session.liveness = this.timer(session, RUNNER_LIVENESS_MS, () =>
      this.disconnect(session, 1001),
    );
  }

  private heartbeat(session: Session): void {
    this.timer(session, RUNNER_HEARTBEAT_MS, () => {
      // At most three challenges are outstanding (60s deadline, 25s cadence).
      // Unrelated traffic cannot keep an unanswered challenge alive forever.
      const nonce = randomUUID();
      session.pendingNonces.set(
        nonce,
        this.timer(session, RUNNER_LIVENESS_MS, () => this.disconnect(session, 1001)),
      );
      if (this.write(session, { type: "heartbeat", payload: { nonce } })) this.heartbeat(session);
    });
  }

  private async process(session: Session): Promise<void> {
    if (session.processing) return;
    session.processing = true;
    try {
      while (this.session === session && !session.controller.signal.aborted) {
        const item = session.queue.shift();
        if (!item) break;
        const handler = this.options.onMessage;
        // A handler ignoring cancellation must not overlap a new connection's work.
        if (!handler || this.handlerRunning) throw new Error();
        this.handlerRunning = true;
        const signal = session.controller.signal;
        let onAbort = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("RUNNER_DISCONNECTED"));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        const timer = this.timer(session, CALLBACK_MS, () => this.disconnect(session, 4400));
        try {
          const callback = Promise.resolve()
            .then(() => {
              signal.throwIfAborted();
              if (this.session !== session || this.state !== "connected") throw new Error();
              return handler(item.message, signal);
            })
            .finally(() => {
              this.handlerRunning = false;
            });
          await Promise.race([callback, aborted]);
        } finally {
          this.cancelTimer(session, timer);
          signal.removeEventListener("abort", onAbort);
          session.pendingBytes -= item.bytes;
        }
      }
    } catch {
      if (this.session === session) this.disconnect(session, 4400);
    } finally {
      session.processing = false;
    }
  }

  private disconnect(session: Session, code: number, reconnect = true): void {
    if (this.session !== session) return;
    this.session = undefined;
    this.state = "disconnected";
    // Abort before observer notification: no callback can continue with live authority.
    session.controller.abort();
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    session.pendingNonces.clear();
    session.queue.length = 0;
    try {
      session.unsubscribe();
    } catch {
      /* Cleanup is best effort. */
    }
    try {
      session.socket.close(code === 1006 ? 1001 : code);
    } catch {
      /* Already closed. */
    }
    if (this.state === "disconnected") {
      this.stateNotification?.abort();
      if (this.state === "disconnected") void this.notifyState("disconnected");
    }
    if (code === 4400 || code === 4401 || !reconnect) this.markTerminal();
    if (code === 4409 && ++this.replacements > MAX_REPLACEMENTS) this.markTerminal();
    if (!this.terminal) this.retry();
    else this.stop();
  }

  private retry(): void {
    if (this.terminal || this.lifetime.signal.aborted) return;
    this.setState("disconnected");
    if (this.terminal || this.reconnects >= MAX_RECONNECTS) {
      this.markTerminal();
      this.stop();
      return;
    }
    const cap = Math.min(30_000, 1000 * 2 ** this.reconnects++);
    try {
      const random = (this.options.random ?? Math.random)();
      if (!Number.isFinite(random) || random < 0 || random >= 1) throw new Error();
      const delay = Math.floor(random * cap);
      const sleeping = (this.options.sleep ?? sleep)(delay, this.lifetime.signal);
      void sleeping
        .then(() => {
          if (!this.terminal && !this.lifetime.signal.aborted) this.connect();
        })
        .catch(() => {
          if (!this.lifetime.signal.aborted) {
            this.markTerminal();
            this.stop();
          }
        });
    } catch {
      this.markTerminal();
      this.stop();
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
