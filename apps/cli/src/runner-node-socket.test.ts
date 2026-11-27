import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { RunnerSocketEvents, RunnerSocketFactory } from "./runner-connection";
import { createNodeRunnerSocket } from "./runner-node-socket";

type Completion = (error?: Error) => void;
type TextSend = (
  frame: string,
  options: { binary: boolean; compress: boolean },
  callback: Completion,
) => void;
type NativePing = (nonce: string, mask: boolean, callback: Completion) => void;
interface MockSocket extends EventEmitter {
  readyState: number;
  bufferedAmount: number;
  send: Mock<TextSend>;
  ping: Mock<NativePing>;
  close: Mock<(code: number) => void>;
  terminate: Mock<() => void>;
}

const mock = vi.hoisted(() => ({
  construct: vi.fn(),
  sockets: [] as MockSocket[],
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter implements MockSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      bufferedAmount = 0;
      send = vi.fn<TextSend>();
      ping = vi.fn<NativePing>();
      close = vi.fn<(code: number) => void>(() => {
        this.readyState = 2;
      });
      terminate = vi.fn<() => void>(() => {
        this.readyState = 2;
      });
      constructor(...args: unknown[]) {
        super();
        mock.construct(...args);
        mock.sockets.push(this);
      }
    },
  };
});

const url = "wss://runner.example/api/cli/runner/ws";
const authorization = "Bearer adapter-test-placeholder";
const rawFailure = new Error("private transport detail must stay inside adapter");

function setup(open = true) {
  const factory: RunnerSocketFactory = createNodeRunnerSocket;
  const adapter = factory(url, { headers: { Authorization: authorization }, maxPayload: 65_536 });
  const ws = mock.sockets.at(-1);
  if (!ws) throw new Error("Missing mock websocket");
  const events = {
    open: vi.fn<RunnerSocketEvents["open"]>(),
    message: vi.fn<RunnerSocketEvents["message"]>(),
    close: vi.fn<RunnerSocketEvents["close"]>(),
    error: vi.fn<RunnerSocketEvents["error"]>(),
  };
  const unsubscribe = adapter.subscribe(events);
  if (open) {
    ws.readyState = 1;
    ws.emit("open");
  }
  return { adapter, ws, events, unsubscribe };
}

function expectClean(ws: MockSocket) {
  expect(vi.getTimerCount()).toBe(0);
  expect(ws.eventNames()).toEqual(["error"]);
  expect(ws.listenerCount("error")).toBe(1);
  expect(() => ws.emit("error", rawFailure)).not.toThrow();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  mock.construct.mockReset();
  mock.sockets.length = 0;
});

afterEach(() => {
  // Close all transports to prove tests leave no adapter timers behind.
  for (const ws of mock.sockets) ws.emit("close", 1000, Buffer.alloc(0));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createNodeRunnerSocket", () => {
  it("pins security and resource options and forwards only Authorization", () => {
    const options = {
      headers: {
        Authorization: authorization,
        Cookie: "must-not-forward",
        Origin: "https://must-not-forward.example",
        "Sec-WebSocket-Protocol": "must-not-forward",
        "X-Other": "must-not-forward",
      },
      maxPayload: 1_000_000,
    };
    createNodeRunnerSocket(url, options);
    expect(mock.construct).toHaveBeenCalledExactlyOnceWith(url, {
      headers: { Authorization: authorization },
      maxPayload: 65_536,
      perMessageDeflate: false,
      followRedirects: false,
      maxRedirects: 0,
      handshakeTimeout: 10_000,
      allowSynchronousEvents: false,
      autoPong: true,
      maxFragments: 128,
      maxBufferedChunks: 128,
      rejectUnauthorized: true,
    });
  });

  it("accepts the localhost ws URL already authorized by RunnerConnection", () => {
    const local = "ws://127.0.0.1:3000/api/cli/runner/ws";
    createNodeRunnerSocket(local, {
      headers: { Authorization: authorization },
      maxPayload: 65_536,
    });
    expect(mock.construct.mock.calls[0]?.[0]).toBe(local);
  });

  it("sanitizes synchronous constructor errors", () => {
    mock.construct.mockImplementationOnce(() => {
      throw rawFailure;
    });
    expect(() => setup()).toThrow(/^RUNNER_SOCKET_CONNECTION_FAILED$/);
  });

  it("normalizes Buffer, ArrayBuffer and Buffer[] text after receipt, preserving UTF-8", () => {
    const { ws, events } = setup();
    const bytes = Buffer.from("runner ♟");
    const inputs = [
      bytes,
      Uint8Array.from(bytes).buffer,
      [bytes.subarray(0, 8), bytes.subarray(8)],
    ];
    for (const data of inputs) ws.emit("message", data, false);
    expect(events.open).toHaveBeenCalledExactlyOnceWith();
    expect(events.message.mock.calls).toEqual(inputs.map(() => ["runner ♟", false]));
    expect(events.error).not.toHaveBeenCalled();
  });

  it("preserves binary data and its binary flag for all RawData shapes", () => {
    const { ws, events } = setup();
    const inputs = [Buffer.from("binary"), new ArrayBuffer(2), [Buffer.from("fragment")]];
    for (const data of inputs) ws.emit("message", data, true);
    for (const [index, data] of inputs.entries()) {
      expect(events.message.mock.calls[index]?.[0]).toBe(data);
      expect(events.message.mock.calls[index]?.[1]).toBe(true);
    }
  });

  it("sends only OPEN text frames with compression disabled and reports bufferedAmount", () => {
    const { adapter, ws, events } = setup();
    ws.bufferedAmount = 23;
    expect(adapter.bufferedAmount).toBe(23);
    adapter.send("frame");
    expect(ws.send).toHaveBeenCalledExactlyOnceWith(
      "frame",
      { binary: false, compress: false },
      expect.any(Function),
    );
    ws.send.mock.calls[0]?.[2]();
    expect(events.error).not.toHaveBeenCalled();
  });

  it.each([0, 2, 3])("rejects send in readyState %s without leaking native errors", (state) => {
    const { adapter, ws, events } = setup(false);
    ws.readyState = state;
    expect(() => adapter.send("frame")).toThrow(/^RUNNER_SOCKET_SEND_FAILED$/);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledOnce();
    expect(events.error).toHaveBeenCalledExactlyOnceWith();
    expectClean(ws);
  });

  it.each(["throw", "callback"])("sanitizes send %s failures", (mode) => {
    const { adapter, ws, events } = setup();
    if (mode === "throw") {
      ws.send.mockImplementationOnce(() => {
        throw rawFailure;
      });
      expect(() => adapter.send("frame")).toThrow(/^RUNNER_SOCKET_SEND_FAILED$/);
    } else {
      adapter.send("frame");
      ws.send.mock.calls[0]?.[2](rawFailure);
    }
    expect(events.error).toHaveBeenCalledExactlyOnceWith();
    expect(ws.terminate).toHaveBeenCalledOnce();
    expectClean(ws);
  });

  it("converts native error to a single generic callback and ignores all late events", () => {
    const { ws, events } = setup();
    vi.advanceTimersByTime(25_000);
    ws.emit("error", rawFailure);
    ws.emit("error", rawFailure);
    ws.emit("message", Buffer.from("late"), false);
    ws.emit("close", 1006, Buffer.from("private close reason"));
    expect(events.error).toHaveBeenCalledExactlyOnceWith();
    expect(events.message).not.toHaveBeenCalled();
    expect(events.close).not.toHaveBeenCalled();
    expectClean(ws);
  });

  it("starts native challenges only after OPEN, every 25s, and accepts matching pongs", () => {
    const { ws, events } = setup(false);
    vi.advanceTimersByTime(30_000);
    expect(ws.ping).not.toHaveBeenCalled();
    ws.readyState = 1;
    ws.emit("open");
    vi.advanceTimersByTime(24_999);
    expect(ws.ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    const first = ws.ping.mock.calls[0];
    expect(first).toEqual([expect.any(String), true, expect.any(Function)]);
    ws.emit("pong", Buffer.from(first?.[0] ?? ""));
    vi.advanceTimersByTime(25_000);
    expect(ws.ping).toHaveBeenCalledTimes(2);
    expect(ws.ping.mock.calls[1]?.[0]).not.toBe(first?.[0]);
    ws.emit("pong", Buffer.from(ws.ping.mock.calls[1]?.[0] ?? ""));
    vi.advanceTimersByTime(35_000);
    expect(events.error).not.toHaveBeenCalled();
  });

  it("keeps at most three outstanding native challenges and expires each after 60s", () => {
    const { ws, events } = setup();
    vi.advanceTimersByTime(75_000);
    expect(ws.ping).toHaveBeenCalledTimes(3);
    // Two intervals and exactly three nonce deadline timers.
    expect(vi.getTimerCount()).toBe(5);
    vi.advanceTimersByTime(9999);
    ws.emit("ping", Buffer.from("peer is alive"));
    ws.emit("pong", Buffer.from("unrelated"));
    ws.emit("message", Buffer.from("unrelated traffic"), false);
    expect(events.error).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(events.error).toHaveBeenCalledExactlyOnceWith();
    expect(ws.ping).toHaveBeenCalledTimes(3);
    expect(ws.terminate).toHaveBeenCalledOnce();
    expectClean(ws);
  });

  it("a matching pong clears only its own deadline; duplicate pongs do not extend others", () => {
    const { ws, events } = setup();
    vi.advanceTimersByTime(50_000);
    const nonce = ws.ping.mock.calls[0]?.[0] ?? "";
    ws.emit("pong", Buffer.from(nonce));
    vi.advanceTimersByTime(35_000);
    expect(events.error).not.toHaveBeenCalled();
    ws.emit("pong", Buffer.from(nonce));
    vi.advanceTimersByTime(25_000);
    expect(events.error).toHaveBeenCalledExactlyOnceWith();
    expectClean(ws);
  });

  it.each(["throw", "callback"])("sanitizes native ping %s failures", (mode) => {
    const { ws, events } = setup();
    if (mode === "throw") {
      ws.ping.mockImplementationOnce(() => {
        throw rawFailure;
      });
    }
    vi.advanceTimersByTime(25_000);
    if (mode === "callback") ws.ping.mock.calls[0]?.[2](rawFailure);
    expect(events.error).toHaveBeenCalledExactlyOnceWith();
    expectClean(ws);
  });

  it.each(["ping", "pong", "mixed"])("bounds %s control traffic to 240 frames/minute", (kind) => {
    const { ws, events } = setup();
    for (let i = 0; i < 240; i++) {
      ws.emit(kind === "mixed" ? (i % 2 ? "ping" : "pong") : kind, Buffer.alloc(0));
    }
    expect(events.error).not.toHaveBeenCalled();
    ws.emit("ping", Buffer.alloc(0));
    expect(events.error).toHaveBeenCalledExactlyOnceWith();
    expect(ws.terminate).toHaveBeenCalledOnce();
    expectClean(ws);
  });

  it("expires old controls in a rolling minute without resetting at a wall-clock boundary", () => {
    const { ws, events } = setup();
    vi.advanceTimersByTime(20_000);
    for (let i = 0; i < 240; i++) ws.emit("ping", Buffer.alloc(0));
    // Old controls expire before our first native challenge's deadline.
    vi.advanceTimersByTime(60_000);
    ws.emit("ping", Buffer.alloc(0));
    expect(events.error).not.toHaveBeenCalled();
    ws.emit("pong", Buffer.from(ws.ping.mock.calls[0]?.[0] ?? ""));
    expect(events.error).not.toHaveBeenCalled();
  });

  it("does not reset the control budget at a fixed minute boundary", () => {
    const { ws, events } = setup();
    vi.advanceTimersByTime(59_000);
    for (let i = 0; i < 240; i++) ws.emit("ping", Buffer.alloc(0));
    vi.advanceTimersByTime(1000);
    ws.emit("pong", Buffer.alloc(0));
    expect(events.error).toHaveBeenCalledExactlyOnceWith();
    expectClean(ws);
  });

  it.each(["idle", "message", "ping", "pong", "send", "open"])(
    "terminates an overfull native buffer on %s",
    (trigger) => {
      const { adapter, ws, events } = setup(trigger !== "open");
      ws.bufferedAmount = 262_145;
      if (trigger === "idle") vi.advanceTimersByTime(1000);
      else if (trigger === "send") {
        expect(() => adapter.send("x")).toThrow(/^RUNNER_SOCKET_SEND_FAILED$/);
      } else if (trigger === "open") {
        ws.readyState = 1;
        ws.emit("open");
      } else ws.emit(trigger, Buffer.from("x"), false);
      expect(events.error).toHaveBeenCalledExactlyOnceWith();
      expect(events.message).not.toHaveBeenCalled();
      expect(ws.terminate).toHaveBeenCalledOnce();
      expectClean(ws);
    },
  );

  it("permits the buffer boundary, checks projected UTF-8 sends and catches post-send growth", () => {
    const first = setup();
    first.ws.bufferedAmount = 262_144;
    first.ws.emit("message", Buffer.from("text"), false);
    expect(first.events.message).toHaveBeenCalledOnce();
    first.ws.bufferedAmount -= 2;
    expect(() => first.adapter.send("♟")).toThrow(/^RUNNER_SOCKET_SEND_FAILED$/);
    expect(first.ws.send).not.toHaveBeenCalled();
    expectClean(first.ws);

    const second = setup();
    second.ws.send.mockImplementationOnce(() => {
      second.ws.bufferedAmount = 262_145;
    });
    second.adapter.send("x");
    expect(second.events.error).toHaveBeenCalledExactlyOnceWith();
    expectClean(second.ws);
  });

  it.each([401, 403, 301, 302, 307, 308, 400, 500, undefined])(
    "bounds unexpected HTTP %s without reading or forwarding headers or bodies",
    (statusCode) => {
      const { ws, events } = setup(false);
      const network = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      const request = Object.assign(new EventEmitter(), { socket: network, destroy: vi.fn() });
      const response = Object.assign(new EventEmitter(), {
        statusCode,
        socket: network,
        destroy: vi.fn(),
      });
      const forbiddenRead = vi.fn(() => {
        throw new Error("Response details must never be read");
      });
      Object.defineProperties(response, {
        headers: { get: forbiddenRead },
        statusMessage: { get: forbiddenRead },
        body: { get: forbiddenRead },
      });
      ws.emit("unexpected-response", request, response);
      expect(request.destroy).toHaveBeenCalledExactlyOnceWith();
      expect(response.destroy).toHaveBeenCalledExactlyOnceWith();
      expect(network.destroy).toHaveBeenCalledExactlyOnceWith();
      expect(response.listenerCount("data")).toBe(0);
      expect(forbiddenRead).not.toHaveBeenCalled();
      expect(ws.terminate).toHaveBeenCalledOnce();
      expect(mock.construct).toHaveBeenCalledOnce();
      if (statusCode === 401 || statusCode === 403) {
        expect(events.close).toHaveBeenCalledExactlyOnceWith(4401);
        expect(events.error).not.toHaveBeenCalled();
      } else {
        expect(events.error).toHaveBeenCalledExactlyOnceWith();
        expect(events.close).not.toHaveBeenCalled();
      }
      for (const stream of [request, response, network]) {
        expect(() => stream.emit("error", rawFailure)).not.toThrow();
      }
      ws.emit("error", rawFailure);
      ws.emit("close", 1006);
      expectClean(ws);
    },
  );

  it("cleans native close without forwarding its reason or leaving timers/listeners", () => {
    const { ws, events } = setup();
    vi.advanceTimersByTime(25_000);
    ws.emit("close", 4409, Buffer.from("private close detail"));
    expect(events.close).toHaveBeenCalledExactlyOnceWith(4409);
    expect(events.error).not.toHaveBeenCalled();
    expectClean(ws);
  });

  it("keeps HTTP auth failure terminal even if destroying its body raises a native error", () => {
    const { ws, events } = setup(false);
    const network = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const request = Object.assign(new EventEmitter(), { socket: network, destroy: vi.fn() });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 401,
      socket: network,
      destroy: vi.fn(() => ws.emit("error", rawFailure)),
    });
    ws.emit("unexpected-response", request, response);
    expect(events.close).toHaveBeenCalledExactlyOnceWith(4401);
    expect(events.error).not.toHaveBeenCalled();
    expectClean(ws);
  });

  it("unsubscribe clears operational timers/listeners and suppresses all later callbacks", () => {
    const { adapter, ws, events, unsubscribe } = setup();
    adapter.send("frame");
    vi.advanceTimersByTime(25_000);
    unsubscribe();
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
    for (const name of ["message", "ping", "pong", "open", "unexpected-response"]) {
      expect(ws.listenerCount(name)).toBe(0);
    }
    ws.emit("message", Buffer.from("late"), false);
    ws.emit("open");
    ws.send.mock.calls[0]?.[2](rawFailure);
    ws.ping.mock.calls[0]?.[2](rawFailure);
    ws.emit("error", rawFailure);
    ws.emit("close", 4401);
    expect(events.open).toHaveBeenCalledOnce();
    expect(events.message).not.toHaveBeenCalled();
    expect(events.error).not.toHaveBeenCalled();
    expect(events.close).not.toHaveBeenCalled();
    expectClean(ws);
  });

  it("retains cleanup after unsubscribe-before-close and cancels forced termination on close", () => {
    const { adapter, ws, events, unsubscribe } = setup();
    vi.advanceTimersByTime(25_000);
    unsubscribe();
    adapter.close(1000);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(999);
    ws.emit("close", 1000);
    vi.advanceTimersByTime(1);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(events.close).not.toHaveBeenCalled();
    expectClean(ws);
  });

  it("forces termination exactly 1s after close, including unsubscribe-after-close", () => {
    const { adapter, ws, events, unsubscribe } = setup();
    adapter.close(1000);
    unsubscribe();
    adapter.close(1001);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000);
    vi.advanceTimersByTime(999);
    expect(ws.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ws.terminate).toHaveBeenCalledOnce();
    expect(events.close).not.toHaveBeenCalled();
    expect(events.error).not.toHaveBeenCalled();
    expectClean(ws);
  });

  it("notifies a subscribed observer once when forced termination finishes teardown", () => {
    const { adapter, ws, events } = setup();
    adapter.close(1000);
    vi.advanceTimersByTime(1000);
    expect(events.close).toHaveBeenCalledExactlyOnceWith(1006);
    expect(events.error).not.toHaveBeenCalled();
    expectClean(ws);
  });

  it("error during close clears the forced-termination timer even after unsubscribe", () => {
    const { adapter, ws, events, unsubscribe } = setup();
    unsubscribe();
    adapter.close(1000);
    ws.emit("error", rawFailure);
    expect(ws.terminate).toHaveBeenCalledOnce();
    expect(events.error).not.toHaveBeenCalled();
    expectClean(ws);
  });

  it("closes during CONNECTING with terminate and safely absorbs late abort errors", () => {
    const { adapter, ws, events, unsubscribe } = setup(false);
    unsubscribe();
    adapter.close(1000);
    expect(ws.close).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledOnce();
    expect(events.error).not.toHaveBeenCalled();
    expectClean(ws);
  });

  it("clears forced termination even when native close fires synchronously", () => {
    const { adapter, ws, events } = setup();
    ws.close.mockImplementationOnce((code) => {
      ws.readyState = 3;
      ws.emit("close", code);
    });
    adapter.close(1000);
    expect(events.close).toHaveBeenCalledExactlyOnceWith(1000);
    expect(ws.terminate).not.toHaveBeenCalled();
    expectClean(ws);
  });

  it("cleans up a synchronous native close failure", () => {
    const { adapter, ws, events } = setup();
    ws.close.mockImplementationOnce(() => {
      throw rawFailure;
    });
    expect(() => adapter.close(1000)).not.toThrow();
    expect(events.error).toHaveBeenCalledExactlyOnceWith();
    expectClean(ws);
  });
});
