import {
  parseRunnerClientFrame,
  RUNNER_HEARTBEAT_MS,
  RUNNER_LIVENESS_MS,
  RUNNER_MAX_BUFFERED_BYTES,
  RUNNER_MAX_FRAME_BYTES,
  type RunnerServerMessage,
} from "@cockpit-chess/chess/runner-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunnerConnection,
  type RunnerConnectionOptions,
  type RunnerSocket,
  type RunnerSocketEvents,
} from "./runner-connection";

const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const hello = {
  models: [],
  engine: false,
  hardLimits: { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
  operatingLimits: { matchMicros: 1, dayMicros: 2, concurrency: 1, revision: 0 },
};

class Socket implements RunnerSocket {
  bufferedAmount = 0;
  events?: RunnerSocketEvents;
  oldEvents?: RunnerSocketEvents;
  send = vi.fn<(frame: string) => void>();
  close = vi.fn<(code: number) => void>();
  unsubscribe = vi.fn(() => {
    this.events = undefined;
  });
  subscribe(events: RunnerSocketEvents) {
    this.events = events;
    this.oldEvents = events;
    return this.unsubscribe;
  }
  open() {
    this.events?.open();
  }
  frame(frame: unknown, binary = false) {
    this.events?.message(typeof frame === "string" ? frame : JSON.stringify(frame), binary);
  }
  welcome(generation = 1) {
    this.open();
    this.frame({
      version: 1,
      generation,
      id: "welcome",
      seq: 1,
      ack: 0,
      type: "welcome",
      payload: { heartbeatMs: 25000, livenessMs: 60000, resumeGraceMs: 120000 },
    });
  }
  message(type: string, payload: unknown, seq = 2, extra = {}) {
    this.frame({
      version: 1,
      generation: 1,
      id: `server_${seq}`,
      seq,
      ack: 1,
      type,
      payload,
      ...extra,
    });
  }
  clientFrames() {
    return this.send.mock.calls.map(([frame]) => parseRunnerClientFrame(frame));
  }
}

function harness(options: Partial<RunnerConnectionOptions> = {}) {
  const sockets: Socket[] = [];
  const socketFactory = vi.fn(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  });
  const onState = vi.fn<NonNullable<RunnerConnectionOptions["onState"]>>();
  const connection = new RunnerConnection({
    url: "wss://runner.example/api/cli/runner/ws",
    credential: "test-credential",
    hello,
    socketFactory,
    random: () => 0.5,
    onState,
    ...options,
  });
  connection.start();
  return { connection, sockets, socket: sockets[0] as Socket, socketFactory, onState };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("runner outbound connection", () => {
  it("sends only Authorization to the exact endpoint and uses authenticated welcome generation", () => {
    const h = harness();
    expect(h.socketFactory).toHaveBeenCalledWith("wss://runner.example/api/cli/runner/ws", {
      headers: { Authorization: "Bearer test-credential" },
      maxPayload: RUNNER_MAX_FRAME_BYTES,
    });
    expect(h.socket.send).not.toHaveBeenCalled();
    expect(
      h.connection.send({ type: "ack", payload: { commandId: "c" } }, new AbortController().signal),
    ).toBe(false);
    h.socket.welcome(42);
    expect(h.socket.clientFrames()[0]).toMatchObject({
      type: "hello",
      generation: 42,
      seq: 1,
      ack: 1,
      payload: hello,
    });
    expect(h.connection.getState()).toBe("connected");
    expect(h.onState.mock.calls.map(([state]) => state)).toEqual(["connecting", "connected"]);
    h.connection.stop();
  });

  it.each([
    "https://runner.example/api/cli/runner/ws",
    "http://localhost/api/cli/runner/ws",
    "ws://localhost/api/cli/runner/ws",
    "wss://runner.example/other",
    "wss://runner.example/api/cli/runner/ws?token=secret",
    "wss://runner.example/api/cli/runner/ws#token",
    "wss://user:secret@runner.example/api/cli/runner/ws",
    "not a URL",
  ])("rejects unsafe endpoint %s without opening a socket", (url) => {
    expect(() => harness({ url })).toThrow("RUNNER_CONNECTION_INVALID");
  });

  it("allows ws only for explicit loopback development and rejects header injection", () => {
    const h = harness({ url: "ws://localhost:3000/api/cli/runner/ws", allowLocalhostWs: true });
    h.connection.stop();
    expect(() =>
      harness({ url: "ws://evil.example/api/cli/runner/ws", allowLocalhostWs: true }),
    ).toThrow("RUNNER_CONNECTION_INVALID");
    expect(() => harness({ credential: "token\r\nCookie: secret" })).toThrow(
      "RUNNER_CONNECTION_INVALID",
    );
    expect(() => harness({ credential: "" })).toThrow("RUNNER_CONNECTION_INVALID");
  });

  it("requires explicit task handler and never dispatches resume automatically", () => {
    const h = harness();
    h.socket.welcome();
    h.socket.message("resume", { commandId: "c", acceptedSeq: 5, fen, ply: 2 }, 2, {
      matchId: "m",
    });
    expect(h.socket.close).toHaveBeenCalledWith(4400);
    expect(h.connection.getState()).toBe("disconnected");
    expect(h.socket.clientFrames().map((frame) => frame.type)).toEqual(["hello"]);
    expect(vi.getTimerCount()).toBe(0);
    h.connection.stop();
  });

  it("processes commands in order with connection signal and monotonic outbound sequence/ack", async () => {
    const seen: RunnerServerMessage[] = [];
    const onMessage = vi.fn<NonNullable<RunnerConnectionOptions["onMessage"]>>(
      (message, signal) => {
        expect(signal.aborted).toBe(false);
        seen.push(message);
        if (message.type === "start")
          expect(h.connection.send({ type: "ack", payload: { commandId: "c1" } }, signal)).toBe(
            true,
          );
      },
    );
    const h = harness({ onMessage });
    h.socket.welcome();
    h.socket.message("start", { commandId: "c1", expectedSeq: 0 }, 2, { matchId: "m" });
    h.socket.message("stop", { commandId: "c2" }, 3, { matchId: "m" });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.map((message) => message.type)).toEqual(["start", "stop"]);
    expect(h.socket.clientFrames()[1]).toMatchObject({ seq: 2, ack: 3, generation: 1 });
    h.connection.stop();
    expect(onMessage.mock.calls[0]?.[1].aborted).toBe(true);
  });

  it("refuses missing, unrelated and aborted send signals without consuming sequence", async () => {
    const onMessage = vi.fn<NonNullable<RunnerConnectionOptions["onMessage"]>>();
    const h = harness({ onMessage });
    h.socket.welcome();
    h.socket.message("ack", { commandId: "ready" });
    await vi.advanceTimersByTimeAsync(0);
    const signal = onMessage.mock.calls[0]?.[1];
    if (!signal) throw new Error("missing handler signal");
    const action = { type: "ack", payload: { commandId: "reply" } } as const;
    // @ts-expect-error — runtime callers must also be refused when the required signal is omitted.
    expect(h.connection.send(action)).toBe(false);
    const unrelated = new AbortController();
    expect(h.connection.send(action, unrelated.signal)).toBe(false);
    unrelated.abort();
    expect(h.connection.send(action, unrelated.signal)).toBe(false);
    expect(h.socket.clientFrames()).toHaveLength(1);
    expect(h.connection.getState()).toBe("connected");
    expect(h.connection.send(action, signal)).toBe(true);
    expect(h.socket.clientFrames()[1]).toMatchObject({
      type: "ack",
      generation: 1,
      seq: 2,
      ack: 2,
    });
    h.connection.stop();
    expect(signal.aborted).toBe(true);
    expect(h.connection.send(action, signal)).toBe(false);
    expect(h.socket.clientFrames()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { version: 2 },
    { generation: 0 },
    { generation: 2 },
    { seq: 1 },
    { seq: 3 },
    { ack: 2 },
    { ack: -1 },
    { ownerId: "u" },
    { type: "execute" },
  ])("closes invalid/stale post-welcome frame %j terminally", async (extra) => {
    const onMessage = vi.fn();
    const h = harness({ onMessage });
    h.socket.welcome();
    h.socket.message("ack", { commandId: "c" }, 2, extra);
    expect(h.socket.close).toHaveBeenCalledWith(4400);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.socketFactory).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
    h.connection.stop();
  });

  it("rejects acknowledgements that move backwards", () => {
    const h = harness();
    h.socket.welcome();
    h.socket.message("ack", { commandId: "c" });
    h.socket.message("ack", { commandId: "c" }, 3, { ack: 0 });
    expect(h.socket.close).toHaveBeenCalledWith(4400);
    h.connection.stop();
  });

  it.each([
    { generation: 0 },
    { seq: 2 },
    { ack: 1 },
    { type: "heartbeat", payload: { nonce: "n" } },
  ])("requires first welcome generation>0 seq1 ack0 %j", (extra) => {
    const h = harness();
    h.socket.open();
    h.socket.frame({
      version: 1,
      generation: 1,
      id: "welcome",
      seq: 1,
      ack: 0,
      type: "welcome",
      payload: { heartbeatMs: 25000, livenessMs: 60000, resumeGraceMs: 120000 },
      ...extra,
    });
    expect(h.socket.close).toHaveBeenCalledWith(4400);
    expect(h.socket.send).not.toHaveBeenCalled();
    h.connection.stop();
  });

  it.each(["json", "binary", "object", "oversize", "before-open"])("rejects %s input", (kind) => {
    const h = harness();
    if (kind !== "before-open") h.socket.welcome();
    if (kind === "json") h.socket.frame("{secret");
    if (kind === "binary") h.socket.events?.message(Buffer.from("{}"), true);
    if (kind === "object") h.socket.events?.message({ data: "{}" });
    if (kind === "oversize") h.socket.frame("é".repeat(RUNNER_MAX_FRAME_BYTES));
    if (kind === "before-open") h.socket.message("ack", { commandId: "c" });
    expect(h.socket.close).toHaveBeenCalledWith(4400);
    h.connection.stop();
  });

  it.each([false, true])("bounds stalled open/welcome (opened=%s)", async (opened) => {
    const h = harness();
    if (opened) h.socket.open();
    await vi.advanceTimersByTimeAsync(9999);
    expect(h.connection.getState()).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.socket.close).toHaveBeenCalledWith(1001);
    expect(h.connection.getState()).toBe("disconnected");
    h.connection.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends application heartbeats, checks nonce pongs, and replies to server heartbeats", async () => {
    const h = harness();
    h.socket.welcome();
    await vi.advanceTimersByTimeAsync(RUNNER_HEARTBEAT_MS);
    const heartbeat = h.socket.clientFrames()[1];
    expect(heartbeat).toMatchObject({ type: "heartbeat", seq: 2, ack: 1 });
    if (heartbeat?.type !== "heartbeat") throw new Error("missing heartbeat");
    h.socket.message("pong", heartbeat.payload, 2, { ack: 2 });
    h.socket.message("heartbeat", { nonce: "server_nonce" }, 3, { ack: 2 });
    expect(h.socket.clientFrames()[2]).toMatchObject({
      type: "pong",
      payload: { nonce: "server_nonce" },
      seq: 3,
      ack: 3,
    });
    await vi.advanceTimersByTimeAsync(RUNNER_HEARTBEAT_MS);
    expect(h.socket.clientFrames()[3]).toMatchObject({ type: "heartbeat", seq: 4, ack: 3 });
    h.socket.message("pong", { nonce: "wrong" }, 4, { ack: 4 });
    expect(h.socket.close).toHaveBeenCalledWith(4400);
    h.connection.stop();
  });

  it("loses liveness even if unrelated frames try to mask missing pongs", async () => {
    const h = harness();
    h.socket.welcome();
    await vi.advanceTimersByTimeAsync(25_000);
    h.socket.message("ack", { commandId: "c" });
    await vi.advanceTimersByTimeAsync(25_000);
    h.socket.message("ack", { commandId: "c" }, 3);
    await vi.advanceTimersByTimeAsync(25_000);
    h.socket.message("ack", { commandId: "c" }, 4);
    expect(h.connection.getState()).toBe("connected");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.connection.getState()).toBe("disconnected");
    expect(h.socket.close).toHaveBeenCalledWith(1001);
    h.connection.stop();
  });

  it("keeps the advertised 60s idle window while sending heartbeats every 25s", async () => {
    const h = harness();
    h.socket.welcome();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.connection.getState()).toBe("connected");
    expect(h.socket.clientFrames().map((frame) => frame.type)).toEqual([
      "hello",
      "heartbeat",
      "heartbeat",
    ]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.connection.getState()).toBe("disconnected");
    h.connection.stop();
  });

  it.each(["inbound", "outbound"])(
    "enforces 60s liveness before late %s traffic can revive it",
    async (direction) => {
      let clock = 0;
      const onMessage = vi.fn<NonNullable<RunnerConnectionOptions["onMessage"]>>();
      const h = harness({ now: () => clock, onMessage });
      h.socket.welcome();
      h.socket.message("ack", { commandId: "ready" });
      await vi.advanceTimersByTimeAsync(0);
      const signal = onMessage.mock.calls[0]?.[1];
      if (!signal) throw new Error("missing handler signal");
      clock = RUNNER_LIVENESS_MS;
      if (direction === "inbound")
        h.socket.message("start", { commandId: "c", expectedSeq: 0 }, 3, { matchId: "m" });
      else
        expect(h.connection.send({ type: "ack", payload: { commandId: "c" } }, signal)).toBe(false);
      expect(h.connection.getState()).toBe("disconnected");
      expect(h.socket.close).toHaveBeenCalledWith(1001);
      expect(onMessage).toHaveBeenCalledTimes(1);
      h.connection.stop();
    },
  );

  it.each(["open", "welcome"])("rejects late %s even before timeout callback runs", (phase) => {
    let clock = 0;
    const h = harness({ now: () => clock });
    if (phase === "welcome") h.socket.open();
    clock = 10000;
    if (phase === "open") h.socket.open();
    else
      h.socket.frame({
        version: 1,
        generation: 1,
        id: "w",
        seq: 1,
        ack: 0,
        type: "welcome",
        payload: { heartbeatMs: 25000, livenessMs: 60000, resumeGraceMs: 120000 },
      });
    expect(h.socket.close).toHaveBeenCalledWith(1001);
    expect(h.socket.send).not.toHaveBeenCalled();
    h.connection.stop();
  });

  it.each([4400, 4401])("never reconnects terminal close %s", async (code) => {
    const h = harness();
    h.socket.welcome();
    h.socket.events?.close(code);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.socketFactory).toHaveBeenCalledTimes(1);
    h.connection.stop();
  });

  it("treats unauthorized application error as immediate revocation", () => {
    const onMessage = vi.fn();
    const h = harness({ onMessage });
    h.socket.welcome();
    h.socket.message("error", { code: "UNAUTHORIZED" });
    expect(h.socket.close).toHaveBeenCalledWith(4401);
    expect(onMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    h.connection.stop();
  });

  it.each([1012, 4409])(
    "reconnects %s with full jitter, fresh generation/sequence and no replay",
    async (code) => {
      const onMessage = vi.fn<NonNullable<RunnerConnectionOptions["onMessage"]>>();
      const h = harness({ onMessage });
      h.socket.welcome();
      h.socket.message("start", { commandId: "c", expectedSeq: 0 }, 2, { matchId: "m" });
      await vi.advanceTimersByTimeAsync(0);
      const signal = onMessage.mock.calls[0]?.[1];
      if (!signal) throw new Error("missing handler signal");
      expect(
        h.connection.send({ type: "event", matchId: "m", payload: { kind: "started" } }, signal),
      ).toBe(true);
      expect(h.socket.clientFrames()[1]).toMatchObject({
        type: "event",
        generation: 1,
        seq: 2,
        ack: 2,
      });
      h.socket.events?.close(code);
      expect(h.connection.getState()).toBe("disconnected");
      expect(h.connection.send({ type: "ack", payload: { commandId: "offline" } }, signal)).toBe(
        false,
      );
      await vi.advanceTimersByTimeAsync(499);
      expect(h.socketFactory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const next = h.sockets[1] as Socket;
      next.welcome(2);
      expect(next.clientFrames()).toHaveLength(1);
      expect(next.clientFrames()[0]).toMatchObject({
        type: "hello",
        generation: 2,
        seq: 1,
        ack: 1,
      });
      h.socket.oldEvents?.message("bad late frame");
      h.socket.oldEvents?.close(4401);
      h.socket.oldEvents?.open();
      expect(h.connection.getState()).toBe("connected");
      expect(onMessage).toHaveBeenCalledTimes(1);
      h.connection.stop();
    },
  );

  it("rejects stale welcome generations on reconnect", async () => {
    const h = harness();
    h.socket.welcome(4);
    h.socket.events?.close(1012);
    await vi.advanceTimersByTimeAsync(500);
    const next = h.sockets[1] as Socket;
    next.welcome(4);
    expect(next.close).toHaveBeenCalledWith(4400);
    h.connection.stop();
  });

  it("rebuilds the safe hello from current local limits on every reconnect", async () => {
    let revision = 0;
    const h = harness({
      hello: () => ({ ...hello, operatingLimits: { ...hello.operatingLimits, revision } }),
    });
    h.socket.welcome();
    expect(h.socket.clientFrames()[0]).toMatchObject({
      type: "hello",
      payload: { operatingLimits: { revision: 0 } },
    });
    revision = 4;
    h.socket.events?.close(1012);
    await vi.advanceTimersByTimeAsync(500);
    const next = h.sockets[1] as Socket;
    next.welcome(2);
    expect(next.clientFrames()[0]).toMatchObject({
      type: "hello",
      payload: { operatingLimits: { revision: 4 }, hardLimits: hello.hardLimits },
    });
    h.connection.stop();
  });

  it("caps full jitter at 30s and limits reconnect attempts", async () => {
    const delays: number[] = [];
    const onTerminal = vi.fn();
    const h = harness({
      onTerminal,
      random: () => 0.999999,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    for (let index = 0; index <= 10; index++) {
      const socket = h.sockets[index];
      socket?.events?.close(1012);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(delays).toEqual([999, 1999, 3999, 7999, 15999, 29999, 29999, 29999, 29999, 29999]);
    expect(h.socketFactory).toHaveBeenCalledTimes(11);
    expect(h.connection.getState()).toBe("disconnected");
    expect(onTerminal).toHaveBeenCalledOnce();
    h.connection.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it.each([4400, 4401])("runs terminal cleanup once after protocol shutdown %s", async (code) => {
    const onTerminal = vi.fn();
    const h = harness({ onTerminal });
    h.socket.welcome();
    h.socket.events?.close(code);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledOnce();
    h.connection.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains local resources during an ordinary reconnect and closes only on terminal stop", async () => {
    const onTerminal = vi.fn();
    const h = harness({ onTerminal });
    h.socket.welcome();
    h.socket.events?.close(1012);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.socketFactory).toHaveBeenCalledTimes(2);
    expect(onTerminal).not.toHaveBeenCalled();
    h.connection.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("bounds repeated replacement fights even after successful welcomes", async () => {
    const h = harness({ random: () => 0 });
    for (let index = 0; index < 4; index++) {
      const socket = h.sockets[index] as Socket;
      socket.welcome(index + 1);
      socket.events?.close(4409);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.socketFactory).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    h.connection.stop();
  });

  it("stop aborts reconnect sleep, removes listeners/timers and cannot restart", async () => {
    let delaySignal: AbortSignal | undefined;
    const h = harness({
      sleep: async (_ms, signal) => {
        delaySignal = signal;
        return new Promise(() => {});
      },
    });
    h.socket.welcome();
    h.socket.events?.error();
    h.connection.stop();
    expect(delaySignal?.aborted).toBe(true);
    expect(h.socket.unsubscribe).toHaveBeenCalledTimes(1);
    h.connection.start();
    h.socket.oldEvents?.open();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.connection.getState()).toBe("stopped");
    expect(h.socketFactory).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop cancels the default delay and ignores late input", async () => {
    const h = harness();
    h.socket.welcome();
    h.socket.events?.close(1012);
    expect(vi.getTimerCount()).toBe(1);
    h.connection.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.socketFactory).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["throw", "reject", "stall"])("bounds and catches %s handler", async (mode) => {
    let signal: AbortSignal | undefined;
    const h = harness({
      onMessage: (_message, value) => {
        signal = value;
        if (mode === "throw") throw new Error("private");
        if (mode === "reject") return Promise.reject(new Error("private"));
        return new Promise(() => {});
      },
    });
    h.socket.welcome();
    h.socket.message("start", { commandId: "c", expectedSeq: 0 }, 2, { matchId: "m" });
    await vi.advanceTimersByTimeAsync(mode === "stall" ? 10000 : 0);
    expect(signal?.aborted).toBe(true);
    expect(h.connection.getState()).toBe("disconnected");
    expect(h.socket.close).toHaveBeenCalledWith(4400);
    expect(vi.getTimerCount()).toBe(0);
    h.connection.stop();
  });

  it("disconnect aborts in-flight callback and drops queued commands, including resume", async () => {
    let signal: AbortSignal | undefined;
    const onMessage = vi.fn((_message, value: AbortSignal) => {
      signal = value;
      return new Promise<void>((resolve) =>
        value.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const h = harness({ onMessage });
    h.socket.welcome();
    h.socket.message("start", { commandId: "c", expectedSeq: 0 }, 2, { matchId: "m" });
    h.socket.message("resume", { commandId: "r", acceptedSeq: 0, fen, ply: 0 }, 3, {
      matchId: "m",
    });
    await vi.advanceTimersByTimeAsync(0);
    h.socket.events?.close(1012);
    expect(signal?.aborted).toBe(true);
    expect(h.connection.getState()).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(500);
    (h.sockets[1] as Socket).welcome(2);
    expect(onMessage).toHaveBeenCalledTimes(1);
    h.connection.stop();
  });

  it("does not overlap a handler ignoring abort with a new connection", async () => {
    const onMessage = vi.fn(() => new Promise<void>(() => {}));
    const h = harness({ onMessage });
    h.socket.welcome();
    h.socket.message("start", { commandId: "c", expectedSeq: 0 }, 2, { matchId: "m" });
    await vi.advanceTimersByTimeAsync(0);
    h.socket.events?.close(1012);
    await vi.advanceTimersByTimeAsync(500);
    const next = h.sockets[1] as Socket;
    next.welcome(2);
    next.message("start", { commandId: "c2", expectedSeq: 0 }, 2, { generation: 2, matchId: "m" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(next.close).toHaveBeenCalledWith(4400);
    h.connection.stop();
  });

  it("fences an abort-ignoring callback reply after 1012 reconnect before the new ACK", async () => {
    let finishOld = () => {};
    const oldWork = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    const replies = vi.fn<(accepted: boolean) => void>();
    const onMessage = vi.fn<NonNullable<RunnerConnectionOptions["onMessage"]>>(
      async (message, signal) => {
        if (message.type === "start") await oldWork;
        replies(h.connection.send({ type: "ack", payload: { commandId: "reply" } }, signal));
      },
    );
    const h = harness({ onMessage });
    h.socket.welcome();
    h.socket.message("start", { commandId: "old", expectedSeq: 0 }, 2, { matchId: "m" });
    await vi.advanceTimersByTimeAsync(0);
    const oldSignal = onMessage.mock.calls[0]?.[1];
    expect(oldSignal?.aborted).toBe(false);
    h.socket.events?.close(1012);
    expect(oldSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    const next = h.sockets[1] as Socket;
    next.welcome(2);
    expect(h.connection.getState()).toBe("connected");
    expect(onMessage).toHaveBeenCalledTimes(1);

    // The old operation settles while B has only welcomed, before its hello ACK/handler.
    finishOld();
    await vi.advanceTimersByTimeAsync(0);
    expect(replies.mock.calls).toEqual([[false]]);
    expect(h.socket.clientFrames().map((frame) => frame.type)).toEqual(["hello"]);
    expect(next.clientFrames()).toHaveLength(1);
    expect(next.clientFrames()[0]).toMatchObject({ type: "hello", generation: 2, seq: 1, ack: 1 });
    expect(next.close).not.toHaveBeenCalled();
    expect(h.connection.getState()).toBe("connected");

    next.message("ack", { commandId: "hello" }, 2, { generation: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[1]?.[1]).not.toBe(oldSignal);
    expect(replies.mock.calls).toEqual([[false], [true]]);
    expect(next.clientFrames()).toHaveLength(2);
    expect(next.clientFrames()[1]).toMatchObject({ type: "ack", generation: 2, seq: 2, ack: 2 });
    h.connection.stop();
    expect(h.socket.unsubscribe).toHaveBeenCalledTimes(1);
    expect(next.unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds pending processing count and bytes without invoking queued handlers", async () => {
    const onMessage = vi.fn(() => new Promise<void>(() => {}));
    const h = harness({ onMessage });
    h.socket.welcome();
    for (let seq = 2; seq <= 34; seq++)
      h.socket.message("start", { commandId: `c${seq}`, expectedSeq: 0 }, seq, { matchId: "m" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.socket.close).toHaveBeenCalledWith(4400);
    // The queued microtask checks abort before starting work.
    expect(onMessage).not.toHaveBeenCalled();
    h.connection.stop();

    const bytes = harness({ onMessage });
    bytes.socket.welcome();
    for (let seq = 2; seq <= 6; seq++) {
      const message = JSON.stringify({
        version: 1,
        generation: 1,
        id: `f${seq}`,
        seq,
        ack: 1,
        type: "start",
        matchId: "m",
        payload: { commandId: "c", expectedSeq: 0 },
      });
      bytes.socket.frame(message.padEnd(RUNNER_MAX_FRAME_BYTES, " "));
    }
    expect(bytes.socket.close).toHaveBeenCalledWith(4400);
    bytes.connection.stop();
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each([RUNNER_MAX_BUFFERED_BYTES, Infinity, -1])(
    "closes outbound backpressure %s",
    async (amount) => {
      const onMessage = vi.fn<NonNullable<RunnerConnectionOptions["onMessage"]>>();
      const h = harness({ onMessage });
      h.socket.welcome();
      h.socket.message("ack", { commandId: "ready" });
      await vi.advanceTimersByTimeAsync(0);
      const signal = onMessage.mock.calls[0]?.[1];
      if (!signal) throw new Error("missing handler signal");
      h.socket.bufferedAmount = amount;
      expect(h.connection.send({ type: "ack", payload: { commandId: "c" } }, signal)).toBe(false);
      expect(h.socket.close).toHaveBeenCalledWith(4400);
      h.connection.stop();
    },
  );

  it("handles socket send/factory/observer exceptions without leaking values", async () => {
    const h = harness({
      onState: () => {
        throw new Error("private");
      },
    });
    h.socket.send.mockImplementation(() => {
      throw new Error("private");
    });
    h.socket.welcome();
    expect(h.connection.getState()).toBe("disconnected");
    h.connection.stop();
    const factory = harness({
      socketFactory: () => {
        throw new Error("private");
      },
    });
    factory.connection.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["reject", "stall"])("catches and bounds async state observer %s", async (mode) => {
    const signals: AbortSignal[] = [];
    const h = harness({
      onState: (_state, signal) => {
        signals.push(signal);
        if (mode === "reject") return Promise.reject(new Error("private"));
        return new Promise(() => {});
      },
    });
    h.socket.welcome();
    await vi.advanceTimersByTimeAsync(10000);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    h.connection.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("disconnected state is visible synchronously to callback abort listeners", async () => {
    let observed: string | undefined;
    const h = harness({
      onMessage: (_message, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observed = h.connection.getState();
              resolve();
            },
            { once: true },
          );
        }),
    });
    h.socket.welcome();
    h.socket.message("start", { commandId: "c", expectedSeq: 0 }, 2, { matchId: "m" });
    await vi.advanceTimersByTimeAsync(0);
    h.socket.events?.close(1012);
    expect(observed).toBe("disconnected");
    h.connection.stop();
  });

  it("stop during socket construction closes the late socket without listeners/timers", () => {
    const socket = new Socket();
    const connection = new RunnerConnection({
      url: "wss://runner.example/api/cli/runner/ws",
      credential: "test-credential",
      hello,
      socketFactory: () => {
        connection.stop();
        return socket;
      },
    });
    connection.start();
    expect(socket.close).toHaveBeenCalledWith(1000);
    expect(socket.events).toBeUndefined();
    expect(connection.getState()).toBe("stopped");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stop", "disconnect"])(
    "cleans up reentrant send/stop during %s cancellation",
    async (cause) => {
      const replies = vi.fn<(accepted: boolean) => void>();
      const h = harness({
        onMessage: (_message, signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                replies(h.connection.send({ type: "ack", payload: { commandId: "late" } }, signal));
                h.connection.stop();
                resolve();
              },
              { once: true },
            );
          }),
      });
      h.socket.welcome();
      h.socket.message("start", { commandId: "c", expectedSeq: 0 }, 2, { matchId: "m" });
      await vi.advanceTimersByTimeAsync(0);
      if (cause === "stop") h.connection.stop();
      else h.socket.events?.close(1012);
      await vi.advanceTimersByTimeAsync(0);
      expect(replies.mock.calls).toEqual([[false]]);
      expect(h.socket.clientFrames().map((frame) => frame.type)).toEqual(["hello"]);
      expect(h.socket.unsubscribe).toHaveBeenCalledTimes(1);
      expect(h.socket.close).toHaveBeenCalledTimes(1);
      expect(h.connection.getState()).toBe("stopped");
      expect(h.onState.mock.calls.at(-1)?.[0]).toBe("stopped");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
