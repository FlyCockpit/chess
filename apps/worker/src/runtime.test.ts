import { QUEUE_NAMES } from "@cockpit-chess/queue/jobs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[],
  workers: [] as Array<{
    name: string;
    options: { concurrency: number; autorun: boolean };
    running: boolean;
    run: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  ping: vi.fn(),
  disconnect: vi.fn(),
  scheduler: vi.fn(),
  heartbeatStart: vi.fn(),
  heartbeatStop: vi.fn(),
  waitReady: vi.fn(),
  run: vi.fn(),
}));
vi.mock("@cockpit-chess/queue", async () => {
  const jobs = await import("@cockpit-chess/queue/jobs");
  return {
    ...jobs,
    createRedisConnection: () => ({
      ping: state.ping,
      disconnect: state.disconnect,
      status: "ready",
    }),
    chessReconcileQueue: {
      upsertJobScheduler: (...args: unknown[]) => {
        state.events.push("chess-reconcile-upsert");
        return state.scheduler(...args);
      },
    },
    reapExpiredAuthTokensQueue: { upsertJobScheduler: state.scheduler },
    checkBackupFreshnessQueue: { upsertJobScheduler: state.scheduler },
    notifyDataDeletionsQueue: { upsertJobScheduler: state.scheduler },
  };
});
vi.mock("@cockpit-chess/queue/consumer-health", () => ({
  createConsumerHeartbeat: (
    _connection: unknown,
    _mode: string,
    _queues: readonly string[],
    healthy: () => boolean,
  ) => ({
    start: state.heartbeatStart,
    stop: state.heartbeatStop,
    isReady: healthy,
  }),
}));
vi.mock("./backup-freshness-scheduler.js", () => ({
  syncBackupFreshnessScheduler: () => state.scheduler().then(() => "upserted"),
}));
vi.mock("./operational-alerts.js", () => ({
  closeOperationalAlertConnection: () => state.events.push("alerts-close"),
  sendOperationalFailureAlert: vi.fn(async () => {}),
}));
vi.mock("./handlers/chess-run.js", () => ({
  handleChessRunJob: vi.fn(),
  handleChessReconcileJob: vi.fn(),
}));
vi.mock("./handlers/check-backup-freshness.js", () => ({ handleCheckBackupFreshnessJob: vi.fn() }));
vi.mock("./handlers/notify-data-deletions.js", () => ({ handleNotifyDataDeletionsJob: vi.fn() }));
vi.mock("./handlers/reap-expired-auth-tokens.js", () => ({
  handleReapExpiredAuthTokensJob: vi.fn(),
}));
vi.mock("bullmq", () => ({
  Worker: class {
    running = false;
    constructor(
      public name: string,
      _processor: unknown,
      public options: { concurrency: number; autorun: boolean },
    ) {
      state.workers.push(this);
    }
    on = vi.fn();
    waitUntilReady = state.waitReady;
    isRunning = () => this.running;
    isPaused = () => false;
    run = vi.fn(() => {
      this.running = true;
      state.events.push("run");
      return state.run();
    });
    close = vi.fn(async () => {
      this.running = false;
      state.events.push("close");
    });
  },
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.workers.length = 0;
  state.events.length = 0;
  state.ping.mockResolvedValue("PONG");
  state.waitReady.mockResolvedValue(undefined);
  state.run.mockImplementation(() => new Promise<void>(() => {}));
  state.scheduler.mockImplementation(async () => {
    state.events.push("scheduler");
  });
  state.heartbeatStart.mockResolvedValue(undefined);
  state.heartbeatStop.mockImplementation(async () => {
    state.events.push("heartbeat-stop");
  });
  state.disconnect.mockImplementation(() => state.events.push("disconnect"));
});
afterEach(() => vi.useRealTimers());

describe("startWorkerRuntime", () => {
  it("runs every declared queue embedded, with conservative concurrency and one scheduler path", async () => {
    const { startWorkerRuntime } = await import("./runtime");
    const runtime = await startWorkerRuntime({ embedded: true, onFatal: vi.fn() });
    expect(state.workers.map((worker) => worker.name).sort()).toEqual(
      Object.values(QUEUE_NAMES).sort(),
    );
    expect(
      state.workers.every((worker) => worker.options.concurrency === 1 && !worker.options.autorun),
    ).toBe(true);
    expect(state.events.lastIndexOf("scheduler")).toBeLessThan(state.events.indexOf("run"));
    expect(runtime.isReady()).toBe(true);
    await expect(startWorkerRuntime({ embedded: true, onFatal: vi.fn() })).rejects.toThrow(
      "already started",
    );
    const stop = runtime.stop();
    expect(runtime.stop()).toBe(stop);
    expect(runtime.isReady()).toBe(false);
    await stop;
    await expect(startWorkerRuntime({ embedded: false, onFatal: vi.fn() })).rejects.toThrow(
      "already started",
    );
  });

  it("still drains every consumer when heartbeat withdrawal fails", async () => {
    const { startWorkerRuntime } = await import("./runtime");
    const runtime = await startWorkerRuntime({ embedded: true, onFatal: vi.fn() });
    state.heartbeatStop.mockRejectedValueOnce(new Error("offline"));
    await expect(runtime.stop()).rejects.toThrow("did not close cleanly");
    expect(state.workers.every((worker) => worker.close.mock.calls.length === 1)).toBe(true);
  });

  it("cleans up partial startup and never starts consumers when scheduler registration fails", async () => {
    state.scheduler.mockRejectedValueOnce(new Error("registration failed"));
    const { startWorkerRuntime } = await import("./runtime");
    await expect(startWorkerRuntime({ embedded: true, onFatal: vi.fn() })).rejects.toThrow(
      "registration failed",
    );
    expect(
      state.workers.every(
        (worker) => worker.run.mock.calls.length === 0 && worker.close.mock.calls.length === 1,
      ),
    ).toBe(true);
    expect(state.disconnect).toHaveBeenCalledTimes(2);
  });

  it("retries startup Redis without creating duplicate consumers", async () => {
    vi.useFakeTimers();
    state.ping.mockRejectedValueOnce(new Error("offline"));
    const { startWorkerRuntime } = await import("./runtime");
    const starting = startWorkerRuntime({ embedded: true, onFatal: vi.fn() });
    await vi.advanceTimersByTimeAsync(500);
    const runtime = await starting;
    expect(state.ping).toHaveBeenCalledTimes(2);
    expect(state.workers).toHaveLength(Object.keys(QUEUE_NAMES).length);
    await runtime.stop();
  });

  it("aborted startup cannot enter processing later", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    state.ping.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { startWorkerRuntime } = await import("./runtime");
    const starting = startWorkerRuntime({
      embedded: true,
      onFatal: vi.fn(),
      signal: controller.signal,
    });
    const rejected = expect(starting).rejects.toThrow("cancelled");
    controller.abort();
    release?.();
    await rejected;
    expect(state.workers).toHaveLength(0);
  });

  it("closes admission immediately when cancelled during the initial heartbeat, and drains before cleanup", async () => {
    let publish: (() => void) | undefined;
    let drain: (() => void) | undefined;
    state.heartbeatStart.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          publish = resolve;
        }),
    );
    state.heartbeatStop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          drain = resolve;
        }),
    );
    const controller = new AbortController();
    const { startWorkerRuntime } = await import("./runtime");
    const starting = startWorkerRuntime({
      embedded: true,
      onFatal: vi.fn(),
      signal: controller.signal,
    });
    const rejected = expect(starting).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(state.heartbeatStart).toHaveBeenCalled());
    expect(state.workers.every((worker) => worker.running)).toBe(true);
    controller.abort();
    expect(state.workers.every((worker) => worker.close.mock.calls.length === 1)).toBe(true);
    expect(state.disconnect).not.toHaveBeenCalled();
    publish?.();
    drain?.();
    await rejected;
    expect(state.disconnect).toHaveBeenCalledTimes(2);
  });

  it("propagates an unclean startup drain instead of disguising it as an ordinary startup failure", async () => {
    vi.useFakeTimers();
    state.heartbeatStart.mockRejectedValueOnce(new Error("publication failed"));
    state.heartbeatStop.mockImplementationOnce(() => new Promise(() => {}));
    const { startWorkerRuntime, WorkerDrainError } = await import("./runtime");
    const assertion = expect(
      startWorkerRuntime({ embedded: true, onFatal: vi.fn() }),
    ).rejects.toBeInstanceOf(WorkerDrainError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(state.workers.every((worker) => worker.close.mock.calls.length === 1)).toBe(true);
    expect(state.disconnect).not.toHaveBeenCalled();
  });

  it("bounds a hung drain and stays unready without prematurely disconnecting dependencies", async () => {
    vi.useFakeTimers();
    const { startWorkerRuntime } = await import("./runtime");
    const runtime = await startWorkerRuntime({ embedded: true, onFatal: vi.fn() });
    state.workers[0]?.close.mockImplementation(() => new Promise(() => {}));
    const stopped = expect(runtime.stop()).rejects.toThrow("must exit");
    await vi.advanceTimersByTimeAsync(15_000);
    await stopped;
    expect(runtime.isReady()).toBe(false);
    expect(state.disconnect).not.toHaveBeenCalled();
  });

  it("a missing or duplicate registered queue suppresses readiness", async () => {
    const { startWorkerRuntime } = await import("./runtime");
    const runtime = await startWorkerRuntime({ embedded: false, onFatal: vi.fn() });
    const worker = state.workers[0];
    if (!worker) throw new Error("missing test worker");
    worker.name = "unregistered-queue";
    expect(runtime.isReady()).toBe(false);
    await runtime.stop();
  });

  it("retains every scheduler identity before the first job", async () => {
    const jobs = await import("@cockpit-chess/queue/jobs");
    const { startWorkerRuntime } = await import("./runtime");
    const runtime = await startWorkerRuntime({ embedded: true, onFatal: vi.fn() });
    expect(state.scheduler.mock.calls.map((args) => args[0]).filter(Boolean)).toEqual([
      "chess-reconcile",
      jobs.REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
      jobs.NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID,
    ]);
    expect(state.events.lastIndexOf("scheduler")).toBeLessThan(state.events.indexOf("run"));
    await runtime.stop();
  });

  it("registers the chess reconcile scheduler on its own queue, not concurrency-1 chess-run", async () => {
    const { startWorkerRuntime } = await import("./runtime");
    const runtime = await startWorkerRuntime({ embedded: true, onFatal: vi.fn() });
    expect(state.events).toContain("chess-reconcile-upsert");
    expect(state.scheduler).toHaveBeenCalledWith(
      "chess-reconcile",
      { every: 60000 },
      { name: "chess-reconcile", data: { reason: "cron" } },
    );
    expect(state.workers.map((worker) => worker.name)).toContain(QUEUE_NAMES.chessReconcile);
    await runtime.stop();
  });

  it("cancelled scheduler startup admits no subsequent scheduler or job", async () => {
    const controller = new AbortController();
    state.scheduler.mockImplementationOnce(async () => {
      controller.abort();
    });
    const { startWorkerRuntime } = await import("./runtime");
    await expect(
      startWorkerRuntime({ embedded: true, onFatal: vi.fn(), signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(state.scheduler).toHaveBeenCalledOnce();
    expect(state.run).not.toHaveBeenCalled();
  });

  it("a pre-aborted startup and exhausted Redis retries cannot construct consumers", async () => {
    vi.useFakeTimers();
    let runtimeModule = await import("./runtime");
    await expect(
      runtimeModule.startWorkerRuntime({
        embedded: true,
        onFatal: vi.fn(),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("cancelled");
    expect(state.ping).not.toHaveBeenCalled();
    expect(state.workers).toHaveLength(0);
    vi.resetModules();
    runtimeModule = await import("./runtime");
    state.ping.mockRejectedValue(new Error("offline"));
    const assertion = expect(
      runtimeModule.startWorkerRuntime({ embedded: true, onFatal: vi.fn() }),
    ).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(7500);
    await assertion;
    expect(state.ping).toHaveBeenCalledTimes(5);
    expect(state.workers).toHaveLength(0);
  });

  it("times out consumer readiness before starting any jobs", async () => {
    vi.useFakeTimers();
    state.waitReady.mockImplementation(() => new Promise(() => {}));
    const { startWorkerRuntime } = await import("./runtime");
    const assertion = expect(
      startWorkerRuntime({ embedded: true, onFatal: vi.fn() }),
    ).rejects.toThrow("startup timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(state.run).not.toHaveBeenCalled();
    expect(state.workers.every((worker) => worker.close.mock.calls.length === 1)).toBe(true);
  });

  it("a consumer run rejection revokes readiness and reaches the host fatal path", async () => {
    state.run.mockRejectedValueOnce(new Error("consumer crashed"));
    const fatal = vi.fn();
    const { startWorkerRuntime } = await import("./runtime");
    const runtime = await startWorkerRuntime({ embedded: true, onFatal: fatal });
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ message: "consumer crashed" }));
    expect(runtime.isReady()).toBe(false);
    await runtime.stop();
  });

  it("rejected consumer close cannot authorize runtime-owned connection teardown", async () => {
    const { startWorkerRuntime, WorkerDrainError } = await import("./runtime");
    const runtime = await startWorkerRuntime({ embedded: true, onFatal: vi.fn() });
    state.workers[0]?.close.mockRejectedValueOnce(new Error("still active"));
    await expect(runtime.stop()).rejects.toBeInstanceOf(WorkerDrainError);
    expect(state.disconnect).not.toHaveBeenCalled();
  });
});

it("registers deletion notices every 15 minutes before consumption without owning a registry heartbeat", async () => {
  const { startWorkerRuntime } = await import("./runtime");
  const runtime = await startWorkerRuntime({ embedded: true, onFatal: vi.fn() });
  expect(state.scheduler).toHaveBeenCalledWith(
    "notify-data-deletions",
    { pattern: "*/15 * * * *" },
    { name: "notify-data-deletions", data: { reason: "cron" } },
  );
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
  expect(source).not.toContain("startInstanceHeartbeat");
  await runtime.stop();
});

describe("external worker host registry", () => {
  const host = {
    events: [] as string[],
    listeners: new Map<string, (...args: unknown[]) => void>(),
    query: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    ready: vi.fn(),
    stopInstance: vi.fn(),
    register: vi.fn(),
  };
  beforeEach(() => {
    host.events.length = 0;
    host.listeners.clear();
    host.query.mockReset().mockResolvedValue(1);
    host.disconnect.mockReset().mockImplementation(async () => {
      host.events.push("disconnect");
    });
    host.stop.mockReset().mockImplementation(async () => {
      host.events.push("jobs-drained");
    });
    host.start
      .mockReset()
      .mockImplementation(async () => ({ isReady: () => true, stop: host.stop }));
    host.ready.mockReset();
    host.stopInstance.mockReset().mockImplementation(async () => {
      host.events.push("instance-drained");
    });
    host.register.mockReset().mockReturnValue({ markReady: host.ready, stop: host.stopInstance });
    vi.spyOn(process, "on").mockImplementation((event, callback) => {
      host.listeners.set(String(event), callback);
      return process;
    });
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.doMock("@cockpit-chess/env/load-dotenv", () => ({}));
    vi.doMock("@cockpit-chess/env/shared", () => ({ env: { NODE_ENV: "test" } }));
    vi.doMock("@cockpit-chess/db", () => ({
      default: { $queryRaw: host.query, $disconnect: host.disconnect },
    }));
    vi.doMock("@cockpit-chess/db/instance-heartbeat", () => ({
      startInstanceHeartbeat: host.register,
    }));
    vi.doMock("node:http", () => ({
      createServer: () => ({ close: vi.fn(), on: vi.fn(), listen: vi.fn() }),
    }));
    vi.doMock("@cockpit-chess/queue", () => ({ redisConnection: { disconnect: vi.fn() } }));
    vi.doMock("./runtime.js", () => ({
      startWorkerRuntime: host.start,
      WorkerDrainError: class extends Error {},
    }));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    for (const name of [
      "@cockpit-chess/env/load-dotenv",
      "@cockpit-chess/env/shared",
      "@cockpit-chess/db",
      "@cockpit-chess/db/instance-heartbeat",
      "node:http",
      "@cockpit-chess/queue",
      "./runtime.js",
    ])
      vi.doUnmock(name);
  });

  it("owns exactly one worker registration and drains its last write before Prisma", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    host.stopInstance.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await import("./index");
    expect(host.register).toHaveBeenCalledExactlyOnceWith({ role: "worker" });
    expect(host.start).toHaveBeenCalledWith(expect.objectContaining({ embedded: false }));
    expect(host.ready).toHaveBeenCalledOnce();
    expect(host.start.mock.invocationCallOrder[0]).toBeLessThan(
      host.ready.mock.invocationCallOrder[0] ?? 0,
    );
    host.listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.stop).toHaveBeenCalledOnce();
    expect(host.disconnect).not.toHaveBeenCalled();
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.events.indexOf("jobs-drained")).toBeLessThan(host.events.indexOf("disconnect"));
    expect(host.disconnect).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("failed consumer startup stops the heartbeat without marking ready", async () => {
    vi.useFakeTimers();
    host.start.mockRejectedValueOnce(new Error("consumer startup failed"));
    await import("./index");
    await vi.advanceTimersByTimeAsync(0);
    expect(host.register).toHaveBeenCalledOnce();
    expect(host.ready).not.toHaveBeenCalled();
    expect(host.stopInstance).toHaveBeenCalledOnce();
    expect(host.disconnect).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("cancellation during dependency startup cannot register or start consumers later", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    host.query.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const starting = import("./index");
    await vi.waitFor(() => expect(host.query).toHaveBeenCalledOnce());
    host.listeners.get("SIGINT")?.();
    finish?.();
    await starting;
    expect(host.register).not.toHaveBeenCalled();
    expect(host.start).not.toHaveBeenCalled();
    expect(host.ready).not.toHaveBeenCalled();
  });
});
