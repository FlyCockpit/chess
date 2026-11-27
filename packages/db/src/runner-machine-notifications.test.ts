import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: { DATABASE_URL: "postgresql://test:test@db.invalid:5432/test" },
  client: vi.fn<new (options: unknown) => object>(),
}));
vi.mock("@cockpit-chess/env/shared", () => ({ env: state.env }));
vi.mock("pg", () => ({ Client: state.client }));

import { startRunnerMachineNotifications } from "./runner-machine-notifications";

const CHANNEL = "runner_machine_revoked";
const event = { userId: "user-1", machineId: "machine_1" };
const running: ReturnType<typeof startRunnerMachineNotifications>[] = [];

class FakeClient extends EventEmitter {
  connect = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
  query = vi.fn<(sql: string) => Promise<unknown>>().mockResolvedValue(undefined);
  end = vi.fn<() => Promise<unknown>>().mockImplementation(async () => {
    this.emit("end");
  });

  notify(payload: string | undefined = JSON.stringify(event), channel = CHANNEL) {
    this.emit("notification", { channel, payload });
  }
}

function deferred() {
  let resolve: () => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function start(clients: FakeClient[] = [new FakeClient()]) {
  let index = 0;
  const createClient = vi.fn(() => {
    const client = clients[index++];
    if (!client) throw new Error("No fake client available");
    return client;
  });
  const onInvalidate = vi.fn();
  const onUnavailable = vi.fn();
  const onReady = vi.fn();
  const subscriber = startRunnerMachineNotifications({
    createClient,
    onInvalidate,
    onUnavailable,
    onReady,
  });
  running.push(subscriber);
  return { ...subscriber, createClient, onInvalidate, onUnavailable, onReady };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  state.client.mockReset();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((subscriber) => subscriber.stop()));
  expect(vi.getTimerCount()).toBe(0);
  expect(console.log).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startRunnerMachineNotifications", () => {
  it("becomes ready only after both connect and LISTEN succeed", async () => {
    const client = new FakeClient();
    const connected = deferred();
    const listening = deferred();
    client.connect.mockReturnValue(connected.promise);
    client.query.mockReturnValue(listening.promise);
    const subscriber = start([client]);

    expect(subscriber.isReady()).toBe(false);
    await flush();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.query).not.toHaveBeenCalled();
    client.notify();
    expect(subscriber.onInvalidate).not.toHaveBeenCalled();

    connected.resolve();
    await flush();
    expect(client.query).toHaveBeenCalledExactlyOnceWith(`LISTEN ${CHANNEL}`);
    expect(subscriber.isReady()).toBe(false);
    expect(subscriber.onReady).not.toHaveBeenCalled();
    client.notify();
    expect(subscriber.onInvalidate).not.toHaveBeenCalled();

    listening.resolve();
    await flush();
    expect(subscriber.isReady()).toBe(true);
    expect(subscriber.onReady).toHaveBeenCalledOnce();
    expect(subscriber.onUnavailable).not.toHaveBeenCalled();
    client.notify();
    expect(subscriber.onInvalidate).toHaveBeenCalledExactlyOnceWith(event);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a dedicated pg.Client with shared DATABASE_URL and five second timeouts", async () => {
    let client: FakeClient | undefined;
    state.client.mockImplementation(
      class extends FakeClient {
        constructor() {
          super();
          client = this;
        }
      },
    );
    const subscriber = startRunnerMachineNotifications({
      onInvalidate: vi.fn(),
      onUnavailable: vi.fn(),
    });
    running.push(subscriber);
    await flush();

    expect(state.client).toHaveBeenCalledExactlyOnceWith({
      connectionString: state.env.DATABASE_URL,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
    });
    expect(subscriber.isReady()).toBe(true);
    await subscriber.stop();
    expect(client?.end).toHaveBeenCalledOnce();
  });

  it("accepts bounded IDs and user-wide invalidation while ignoring malformed payloads", async () => {
    const client = new FakeClient();
    const subscriber = start([client]);
    await flush();
    const invalid = [
      "",
      "{",
      "null",
      "true",
      "1",
      "[]",
      "{}",
      JSON.stringify([event]),
      JSON.stringify({ machineId: "m1" }),
      JSON.stringify({ userId: 1 }),
      JSON.stringify({ userId: null }),
      JSON.stringify({ userId: "" }),
      JSON.stringify({ userId: "a".repeat(129) }),
      JSON.stringify({ userId: "_leading" }),
      JSON.stringify({ userId: "user/name" }),
      JSON.stringify({ userId: "user.name" }),
      JSON.stringify({ userId: "user name" }),
      JSON.stringify({ userId: "user\nname" }),
      JSON.stringify({ userId: "üser" }),
      JSON.stringify({ userId: "u1", machineId: null }),
      JSON.stringify({ userId: "u1", machineId: "" }),
      JSON.stringify({ userId: "u1", machineId: "m".repeat(129) }),
      JSON.stringify({ userId: "u1", machineId: "bad/id" }),
      JSON.stringify({ userId: "u1", machineId: {} }),
      JSON.stringify({ ...event, secret: "ignored extra field" }),
      '{"userId":"u1","__proto__":{"machineId":"m1"}}',
      '{"userId":"u1","constructor":"m1"}',
      `${" ".repeat(1_024)}${JSON.stringify(event)}`,
    ];
    for (const payload of invalid) client.notify(payload);
    client.emit("notification", { channel: CHANNEL });
    client.notify(JSON.stringify(event), "other_channel");
    expect(subscriber.onInvalidate).not.toHaveBeenCalled();
    expect(subscriber.onUnavailable).not.toHaveBeenCalled();
    expect(subscriber.isReady()).toBe(true);

    client.notify(JSON.stringify({ userId: "u1" }));
    const maxIds = { userId: "u".repeat(128), machineId: "m".repeat(128) };
    client.notify(JSON.stringify(maxIds));
    const json = JSON.stringify(event);
    client.notify(`${" ".repeat(1_024 - json.length)}${json}`);
    client.notify(`${" ".repeat(1_025 - json.length)}${json}`);
    expect(subscriber.onInvalidate.mock.calls).toEqual([[{ userId: "u1" }], [maxIds], [event]]);
  });

  it.each(["error", "end"] as const)(
    "reports %s loss immediately, closes the old client, and re-LISTENs before becoming ready",
    async (kind) => {
      const first = new FakeClient();
      const second = new FakeClient();
      const listening = deferred();
      second.query.mockReturnValue(listening.promise);
      const subscriber = start([first, second]);
      await flush();

      first.emit(kind, new Error("private connection details"));
      expect(subscriber.isReady()).toBe(false);
      expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
      first.emit("error", new Error("duplicate loss"));
      first.notify();
      expect(subscriber.onInvalidate).not.toHaveBeenCalled();
      expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
      await flush();
      expect(first.end).toHaveBeenCalledOnce();
      expect(first.listenerCount("notification")).toBe(0);
      expect(first.listenerCount("end")).toBe(0);
      await vi.advanceTimersByTimeAsync(124);
      expect(subscriber.createClient).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(subscriber.createClient).toHaveBeenCalledTimes(2);
      expect(second.query).toHaveBeenCalledExactlyOnceWith(`LISTEN ${CHANNEL}`);
      expect(subscriber.isReady()).toBe(false);
      expect(subscriber.onReady).toHaveBeenCalledOnce();

      // Even a late event from a retired pg client cannot escape or affect readiness.
      first.emit("error", new Error("late private connection details"));
      first.notify();
      listening.resolve();
      await flush();
      expect(subscriber.isReady()).toBe(true);
      expect(subscriber.onReady).toHaveBeenCalledTimes(2);
      second.notify();
      expect(subscriber.onInvalidate).toHaveBeenCalledExactlyOnceWith(event);
      expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
    },
  );

  it.each(["connect", "query"] as const)(
    "cleans up a rejected %s before retrying without exposing the error",
    async (method) => {
      const first = new FakeClient();
      const second = new FakeClient();
      first[method].mockRejectedValue(new Error("private connection details"));
      const subscriber = start([first, second]);
      await flush();
      expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
      expect(subscriber.isReady()).toBe(false);
      expect(subscriber.onReady).not.toHaveBeenCalled();
      expect(first.end).toHaveBeenCalledOnce();
      if (method === "connect") expect(first.query).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(125);
      expect(subscriber.isReady()).toBe(true);
      expect(subscriber.onReady).toHaveBeenCalledOnce();
    },
  );

  it.each(["connect", "query"] as const)(
    "handles synchronous %s failures and cleanup failures without an unhandled rejection",
    async (method) => {
      const first = new FakeClient();
      const second = new FakeClient();
      first[method].mockImplementation(() => {
        throw new Error("private connection details");
      });
      first.end.mockRejectedValue(new Error("private cleanup details"));
      const subscriber = start([first, second]);
      await flush();
      expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
      expect(first.end).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(125);
      expect(subscriber.isReady()).toBe(true);
      second.end.mockImplementation(() => {
        throw new Error("private cleanup details");
      });
      await expect(subscriber.stop()).resolves.toBeUndefined();
    },
  );

  it("retries a throwing client factory", async () => {
    const subscriber = start();
    subscriber.createClient.mockImplementationOnce(() => {
      throw new Error("private connection details");
    });
    await flush();
    expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
    expect(subscriber.isReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(125);
    expect(subscriber.isReady()).toBe(true);
  });

  it.each(["connect", "query"] as const)(
    "cancels pending %s on loss and consumes its late rejection",
    async (method) => {
      const first = new FakeClient();
      const second = new FakeClient();
      const pending = deferred();
      first[method].mockReturnValue(pending.promise);
      const subscriber = start([first, second]);
      await flush();
      first.emit("error", new Error("private connection details"));
      expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
      await flush();
      expect(first.end).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(125);
      expect(subscriber.isReady()).toBe(true);
      pending.reject(new Error("late private connection details"));
      await flush();
      expect(subscriber.isReady()).toBe(true);
      expect(subscriber.onReady).toHaveBeenCalledOnce();
      expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
    },
  );

  it.each(["connect", "query"] as const)(
    "bounds pending %s to five seconds and closes its client before retry",
    async (method) => {
      const client = new FakeClient();
      const pending = deferred();
      client[method].mockReturnValue(pending.promise);
      const subscriber = start([client]);
      await flush();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(subscriber.onUnavailable).not.toHaveBeenCalled();
      expect(subscriber.createClient).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
      expect(subscriber.isReady()).toBe(false);
      expect(client.end).toHaveBeenCalledOnce();
      await subscriber.stop();
      pending.resolve();
      await flush();
      expect(subscriber.onReady).not.toHaveBeenCalled();
      if (method === "connect") expect(client.query).not.toHaveBeenCalled();
    },
  );

  it("gives LISTEN its own full deadline after a slow successful connect", async () => {
    const client = new FakeClient();
    const connected = deferred();
    const listening = deferred();
    client.connect.mockReturnValue(connected.promise);
    client.query.mockReturnValue(listening.promise);
    const subscriber = start([client]);
    await flush();
    await vi.advanceTimersByTimeAsync(4_000);
    connected.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(subscriber.onUnavailable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
    await subscriber.stop();
    listening.resolve();
  });

  it("backs off exponentially with jitter bounded at thirty seconds", async () => {
    const clients = Array.from({ length: 11 }, () => {
      const client = new FakeClient();
      client.connect.mockRejectedValue(new Error("private connection details"));
      return client;
    });
    const subscriber = start(clients);
    await flush();
    let attempts = 1;
    // With random=0, equal jitter uses half of the exponentially increasing cap.
    for (const delay of [125, 250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(subscriber.createClient).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      expect(subscriber.createClient).toHaveBeenCalledTimes(++attempts);
    }
    expect(subscriber.onUnavailable).toHaveBeenCalledTimes(attempts);
    // Changing the random sample changes the next capped delay to 22.5 seconds.
    vi.mocked(Math.random).mockReturnValue(0.5);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(subscriber.createClient).toHaveBeenCalledTimes(++attempts);
    await vi.advanceTimersByTimeAsync(22_499);
    expect(subscriber.createClient).toHaveBeenCalledTimes(attempts);
    expect(subscriber.isReady()).toBe(false);
  });

  it("waits for old client cleanup before scheduling another connection", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const third = new FakeClient();
    const closed = deferred();
    first.end.mockReturnValue(closed.promise);
    const subscriber = start([first, second, third]);
    await flush();
    first.emit("end");
    expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.end).toHaveBeenCalledOnce();
    expect(subscriber.createClient).toHaveBeenCalledOnce();
    closed.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(125);
    expect(subscriber.isReady()).toBe(true);
    // A successful LISTEN resets the retry cap.
    second.emit("end");
    await flush();
    await vi.advanceTimersByTimeAsync(124);
    expect(subscriber.createClient).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(subscriber.createClient).toHaveBeenCalledTimes(3);
    expect(subscriber.isReady()).toBe(true);
    await subscriber.stop();
  });

  it.each(["ready", "unavailable", "invalidate"] as const)(
    "allows reentrant stop from the %s callback and joins the active client",
    async (callback) => {
      const client = new FakeClient();
      const subscriber = start([client]);
      const stop = () => subscriber.stop();
      if (callback === "ready") subscriber.onReady.mockImplementation(stop);
      if (callback === "unavailable") subscriber.onUnavailable.mockImplementation(stop);
      if (callback === "invalidate") subscriber.onInvalidate.mockImplementation(stop);
      await flush();
      if (callback === "unavailable") client.emit("end");
      if (callback === "invalidate") client.notify();
      expect(subscriber.isReady()).toBe(false);
      await subscriber.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.end).toHaveBeenCalledOnce();
      expect(subscriber.createClient).toHaveBeenCalledOnce();
      expect(subscriber.onUnavailable).toHaveBeenCalledTimes(callback === "unavailable" ? 1 : 0);
    },
  );

  it.each(["throw", "reject"] as const)(
    "contains callback failures that %s and keeps processing events",
    async (kind) => {
      const client = new FakeClient();
      const subscriber = start([client]);
      const callback = () => {
        if (kind === "throw") throw new Error("private callback details");
        return Promise.reject(new Error("private callback details"));
      };
      subscriber.onReady.mockImplementation(callback);
      subscriber.onInvalidate.mockImplementation(callback);
      subscriber.onUnavailable.mockImplementation(callback);
      await flush();
      expect(subscriber.isReady()).toBe(true);
      client.notify();
      client.notify();
      expect(subscriber.onInvalidate).toHaveBeenCalledTimes(2);
      client.emit("error", new Error("private connection details"));
      expect(subscriber.isReady()).toBe(false);
      expect(subscriber.onUnavailable).toHaveBeenCalledOnce();
      await flush();
      await expect(subscriber.stop()).resolves.toBeUndefined();
    },
  );

  it.each(["connect", "query"] as const)(
    "stop cancels pending %s, joins cleanup, and consumes a late rejection",
    async (method) => {
      const client = new FakeClient();
      const pending = deferred();
      const closed = deferred();
      client[method].mockReturnValue(pending.promise);
      client.end.mockReturnValue(closed.promise);
      const subscriber = start([client]);
      await flush();
      const done = vi.fn();
      const stopping = subscriber.stop();
      expect(subscriber.stop()).toBe(stopping);
      void stopping.then(done);
      await flush();
      expect(client.end).toHaveBeenCalledOnce();
      expect(done).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      client.notify();
      client.emit("error", new Error("shutdown connection details"));
      closed.resolve();
      await stopping;
      pending.reject(new Error("late private connection details"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(done).toHaveBeenCalledOnce();
      expect(subscriber.createClient).toHaveBeenCalledOnce();
      expect(subscriber.onReady).not.toHaveBeenCalled();
      expect(subscriber.onUnavailable).not.toHaveBeenCalled();
      expect(subscriber.onInvalidate).not.toHaveBeenCalled();
    },
  );

  it("stop before the first microtask creates no client", async () => {
    const subscriber = start();
    await subscriber.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscriber.createClient).not.toHaveBeenCalled();
  });

  it("stop cancels a pending retry and ignores notifications after shutdown", async () => {
    const client = new FakeClient();
    const subscriber = start([client]);
    await flush();
    client.emit("end");
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    await subscriber.stop();
    client.notify();
    client.emit("error", new Error("late private connection details"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscriber.createClient).toHaveBeenCalledOnce();
    expect(subscriber.onInvalidate).not.toHaveBeenCalled();
    expect(subscriber.isReady()).toBe(false);
  });
});
