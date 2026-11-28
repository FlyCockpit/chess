import { EventEmitter } from "node:events";
import { WSContext, type WSEvents } from "hono/ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

vi.mock("@cockpit-chess/auth/runner-limits", () => ({
  RunnerLimitsError: class extends Error {},
  runnerLimitsService: {
    hello: vi.fn(async () => null),
    pending: vi.fn(async () => null),
    result: vi.fn(async () => true),
  },
}));

const state = vi.hoisted(() => ({
  redis: vi.fn(),
  notifications: vi.fn(),
  authority: vi.fn(),
  store: vi.fn(),
  monitor: vi.fn(),
  outbox: vi.fn().mockResolvedValue([]),
  handle: vi.fn().mockResolvedValue([]),
  disconnected: vi.fn().mockResolvedValue(undefined),
  events: undefined as WSEvents<WebSocket> | undefined,
}));
vi.mock("@cockpit-chess/api/lib/chess-runner", () => ({
  RUNNER_COMMAND_CHANNEL: "chess_runner_command",
  runnerOutbox: state.outbox,
  handleRunnerControl: state.handle,
  disconnectRunnerMatches: state.disconnected,
}));
vi.mock("@cockpit-chess/queue", () => ({
  createRedisConnection: state.redis,
  redisConnection: {},
}));
vi.mock("@cockpit-chess/db/runner-machine-notifications", () => ({
  startRunnerMachineNotifications: state.notifications,
}));
vi.mock("./runner-ws-authority.js", () => ({ createRunnerAuthority: state.authority }));
vi.mock("./runner-ws-store.js", () => ({ createRunnerLeaseStore: state.store }));
vi.mock("./runner-ws-invalidation.js", () => ({ createRunnerInvalidationMonitor: state.monitor }));
vi.mock("@hono/node-server", () => ({
  upgradeWebSocket: (factory: () => WSEvents<WebSocket>) => {
    state.events = factory();
    return vi.fn();
  },
}));
const { createRunnerWebSocketRuntime } = await import("./runner-ws-runtime.js");

function rawSocket() {
  // Real prototype for instanceof, fake IO methods: never constructs a TCP client.
  const raw: WebSocket = Object.create(WebSocket.prototype);
  EventEmitter.call(raw);
  let readyState: number = WebSocket.OPEN;
  const sent: Record<string, unknown>[] = [];
  const close = vi.fn(() => {
    readyState = WebSocket.CLOSED;
    raw.emit("close");
  });
  const ping = vi.fn();
  const terminate = vi.fn(() => {
    readyState = WebSocket.CLOSED;
    raw.emit("close");
  });
  Object.defineProperties(raw, {
    readyState: { get: () => readyState },
    bufferedAmount: { value: 0 },
    send: { value: vi.fn((frame: string) => sent.push(JSON.parse(frame))) },
    close: { value: close },
    ping: { value: ping },
    terminate: { value: terminate },
  });
  const context = new WSContext({
    raw,
    readyState: WebSocket.OPEN,
    protocol: "",
    send: () => {},
    close,
  });
  return { raw, context, sent, close, ping, terminate };
}
function setup() {
  const identity = {
    userId: "owner1",
    machineId: "machine1",
    connectionGeneration: 1,
    expiresAt: new Date(Date.now() + 60_000),
  };
  state.authority.mockReturnValue({
    resolve: vi.fn(async () => identity),
    claim: vi.fn(async () => identity),
    ownsMatch: vi.fn(async () => false),
  });
  const leases = {
    reserveIp: vi.fn(async () => true),
    releaseIp: vi.fn(async () => {}),
    acquire: vi.fn(async () => true),
    validate: vi.fn(async () => true),
    release: vi.fn(async () => {}),
  };
  state.store.mockReturnValue(leases);
  const stop = vi.fn(async () => {});
  state.monitor.mockReturnValue({ isAvailable: () => true, stop });
  return { leases, stop };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("Node runner upgrade adapter", () => {
  it("disables activation/subscribers without D2a and bounds parser/fragment resources", async () => {
    const runtime = createRunnerWebSocketRuntime({ isOwnerActive: null });
    expect(runtime.runtime).toBeNull();
    expect(state.authority).not.toHaveBeenCalled();
    expect(state.redis).not.toHaveBeenCalled();
    expect(runtime.server.options).toMatchObject({
      noServer: true,
      path: "/api/cli/runner/ws",
      maxPayload: 65536,
      maxFragments: 128,
      maxBufferedChunks: 128,
      perMessageDeflate: false,
      allowSynchronousEvents: false,
      autoPong: true,
    });
    await runtime.stop();
    await runtime.stop();
  });

  it("normalizes text, preserves binary rejection and forwards native ping/pong to the controller", async () => {
    const fixture = setup();
    const runtime = createRunnerWebSocketRuntime({ isOwnerActive: async () => true });
    const reservation = await runtime.runtime?.transport.reserve("Bearer fixture", "ip");
    if (!reservation || !runtime.runtime) throw new Error("Expected enabled reservation");
    runtime.runtime.upgrade(reservation);
    const raw = rawSocket();
    state.events?.onOpen?.(new Event("open"), raw.context);
    await vi.waitFor(() => expect(raw.sent).toHaveLength(1));
    raw.raw.emit(
      "message",
      [
        Buffer.from(
          '{"version":1,"generation":1,"id":"hello","seq":1,"ack":1,"type":"hello","payload":{"models":[],"engine":false,"hardLimits":{"matchMicros":25,"dayMicros":100,"concurrency":8},"operatingLimits":{"matchMicros":1,"dayMicros":1,"concurrency":1,"revision":0}}}',
        ),
      ],
      false,
    );
    await vi.waitFor(() => expect(raw.sent.at(-1)?.type).toBe("ack"));
    raw.raw.emit("pong", Buffer.alloc(0));
    raw.raw.emit("message", Buffer.from("{}"), true);
    await vi.waitFor(() => expect(raw.close).toHaveBeenCalledWith(4400, "INVALID"));
    await runtime.stop();
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.leases.release).toHaveBeenCalled();
    expect(state.disconnected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        userId: "owner1",
        machineId: "machine1",
        connectionGeneration: 1,
      }),
    );
  });

  it("closes a control-frame flood without logging submitted content", async () => {
    setup();
    const runtime = createRunnerWebSocketRuntime({ isOwnerActive: async () => true });
    const reservation = await runtime.runtime?.transport.reserve("Bearer fixture", "ip");
    if (!reservation || !runtime.runtime) throw new Error("Expected enabled reservation");
    runtime.runtime.upgrade(reservation);
    const raw = rawSocket();
    state.events?.onOpen?.(new Event("open"), raw.context);
    await vi.waitFor(() => expect(raw.sent).toHaveLength(1));
    for (let i = 0; i < 241; i++) raw.raw.emit("ping", Buffer.alloc(0));
    expect(raw.close).toHaveBeenCalledWith(4408, "BACKPRESSURE");
    await runtime.stop();
  });

  it("rejects application frames that arrive before fresh activation completes", async () => {
    setup();
    const runtime = createRunnerWebSocketRuntime({ isOwnerActive: async () => true });
    const reservation = await runtime.runtime?.transport.reserve("Bearer fixture", "ip");
    if (!reservation || !runtime.runtime) throw new Error("Expected enabled reservation");
    runtime.runtime.upgrade(reservation);
    const raw = rawSocket();
    state.events?.onOpen?.(new Event("open"), raw.context);
    raw.raw.emit("message", Buffer.from("{}"), false);
    expect(raw.close).toHaveBeenCalledWith(4400, "INVALID");
    await runtime.stop();
    expect(raw.sent).toHaveLength(0);
  });
});
