import { describe, expect, it, vi } from "vitest";
import { createRunnerInvalidationMonitor } from "./runner-ws-invalidation.js";

function harness() {
  const events = new Map<string, (...args: string[]) => void>();
  const invalidate = vi.fn();
  const subscriber = {
    on: vi.fn((event: string, callback: (...args: string[]) => void) => {
      events.set(event, callback);
    }),
    subscribe: vi.fn().mockResolvedValue(1),
    disconnect: vi.fn(),
  };
  const pgStop = vi.fn().mockResolvedValue(undefined);
  const startNotifications = vi.fn((_callbacks) => ({ stop: pgStop }));
  const monitor = createRunnerInvalidationMonitor({ subscriber, startNotifications, invalidate });
  const pg = startNotifications.mock.calls[0]?.[0];
  if (!pg) throw new Error("Missing notifications callbacks");
  return {
    monitor,
    subscriber,
    pg,
    invalidate,
    pgStop,
    emit: (event: string, ...args: string[]) => events.get(event)?.(...args),
  };
}

describe("runner cross-replica invalidation monitor", () => {
  it("denies handshakes until both channels have confirmed subscription", async () => {
    const h = harness();
    expect(h.monitor.isAvailable()).toBe(false);
    h.pg.onReady();
    expect(h.monitor.isAvailable()).toBe(false);
    h.emit("ready");
    await Promise.resolve();
    expect(h.monitor.isAvailable()).toBe(true);
    expect(h.subscriber.subscribe).toHaveBeenCalledWith("runner_ws_replaced");
    await h.monitor.stop();
    expect(h.monitor.isAvailable()).toBe(false);
    expect(h.pgStop).toHaveBeenCalledOnce();
    expect(h.subscriber.disconnect).toHaveBeenCalledOnce();
  });

  it("closes all connections on Redis or PostgreSQL channel loss", async () => {
    const h = harness();
    h.emit("ready");
    h.pg.onReady();
    await Promise.resolve();
    h.emit("close");
    expect(h.monitor.isAvailable()).toBe(false);
    expect(h.invalidate).toHaveBeenCalledWith();
    h.emit("ready");
    await Promise.resolve();
    expect(h.monitor.isAvailable()).toBe(true);
    h.pg.onUnavailable();
    expect(h.monitor.isAvailable()).toBe(false);
    h.pg.onReady();
    expect(h.monitor.isAvailable()).toBe(true);
    await h.monitor.stop();
  });

  it("does not resurrect authority when a stale subscribe resolves after channel loss", async () => {
    const h = harness();
    let finish: (() => void) | undefined;
    h.subscriber.subscribe.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    h.pg.onReady();
    h.emit("ready");
    h.emit("error");
    finish?.();
    await Promise.resolve();
    expect(h.monitor.isAvailable()).toBe(false);
    await h.monitor.stop();
  });

  it("handles failed subscription and strict ID-only generation notifications", async () => {
    const h = harness();
    h.subscriber.subscribe.mockRejectedValueOnce(new Error("private connection details"));
    h.pg.onReady();
    h.emit("ready");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.monitor.isAvailable()).toBe(false);
    h.emit(
      "message",
      "runner_ws_replaced",
      JSON.stringify({ machineId: "machine1", generation: 2 }),
    );
    expect(h.invalidate).toHaveBeenCalledWith(undefined, "machine1", 2);
    h.invalidate.mockClear();
    for (const message of [
      "{",
      "x".repeat(1025),
      JSON.stringify({ machineId: "machine1", generation: -1 }),
      JSON.stringify({ machineId: "machine1", generation: 3, secret: "forbidden" }),
    ]) {
      h.emit("message", "runner_ws_replaced", message);
    }
    expect(h.invalidate).not.toHaveBeenCalled();
    h.pg.onInvalidate({ userId: "owner1", machineId: "machine1" });
    expect(h.invalidate).toHaveBeenCalledWith("owner1", "machine1");
    await h.monitor.stop();
    h.invalidate.mockClear();
    h.pg.onInvalidate({ userId: "owner1" });
    h.emit(
      "message",
      "runner_ws_replaced",
      JSON.stringify({ machineId: "machine1", generation: 4 }),
    );
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});
