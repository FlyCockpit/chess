import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunnerConnection, type RunnerSocketEvents } from "./runner-connection";

const fixture = vi.hoisted(() => ({
  connection: undefined as RunnerConnection | undefined,
  events: undefined as RunnerSocketEvents | undefined,
  terminal: undefined as Promise<void> | undefined,
  release: undefined as (() => void) | undefined,
  blockNext: false,
  sent: vi.fn<(frame: string) => void>(),
}));

vi.mock("./runner-connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner-connection")>();
  return {
    ...actual,
    RunnerConnection: class extends actual.RunnerConnection {
      constructor(options: import("./runner-connection").RunnerConnectionOptions) {
        super({
          ...options,
          onTerminal: () => {
            fixture.terminal = Promise.resolve(options.onTerminal?.());
            return fixture.terminal;
          },
          socketFactory: () => ({
            bufferedAmount: 0,
            send: fixture.sent,
            close: () => {},
            subscribe(events) {
              fixture.events = events;
              return () => {
                fixture.events = undefined;
              };
            },
          }),
        });
        fixture.connection = this;
      }
    },
  };
});

vi.mock("./runner-limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner-limits")>();
  return {
    ...actual,
    runnerLimitFileStore: async (...args: Parameters<typeof actual.runnerLimitFileStore>) => {
      const store = await actual.runnerLimitFileStore(...args);
      return {
        ...store,
        async save(state: import("./runner-limits").RunnerLimitState) {
          await store.save(state);
          if (fixture.blockNext) {
            fixture.blockNext = false;
            await new Promise<void>((resolve) => {
              fixture.release = resolve;
            });
          }
        },
      };
    },
  };
});

import { runnerLimitFileStore } from "./runner-limits";
import { type RunnerExecution, runnerFileStore, runRunnerStartup } from "./runner-start";

const origin = "https://runner.example.com";
const machineId = "production-lifecycle";
function currentFixture(): typeof fixture {
  return fixture;
}

describe("production runner shutdown wiring", () => {
  it.each([
    { terminalFirst: true, signal: "SIGINT" as const },
    { terminalFirst: false, signal: "SIGTERM" as const },
  ])(
    "keeps OS cancellation live through durable release ($signal, terminal first: $terminalFirst)",
    async ({ terminalFirst, signal }) => {
      const root = await mkdtemp(join(tmpdir(), "runner-production-lifecycle-"));
      const oldInterrupts = new Set(process.listeners("SIGINT"));
      const oldTerminates = new Set(process.listeners("SIGTERM"));
      fixture.connection = undefined;
      fixture.events = undefined;
      fixture.terminal = undefined;
      fixture.release = undefined;
      fixture.blockNext = false;
      fixture.sent.mockClear();
      const execution: RunnerExecution = {
        hardLimits: { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
        limitPolicy: {
          restoreOperatingLimits: vi.fn(),
          applyOperatingLimits: vi.fn(),
          stopOperatingLimits: vi.fn(),
        },
        settleLimits: async () => {},
        startupNotice: () => "synthetic local policy",
        open: async () => ({
          hello: {
            models: [],
            engine: false,
            hardLimits: { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
            operatingLimits: {
              matchMicros: 1_000_000,
              dayMicros: 10_000_000,
              concurrency: 2,
              revision: 0,
            },
          },
          handle: async () => {},
        }),
        close: vi.fn(async () => {}),
      };
      let running: Promise<unknown> | undefined;
      try {
        await runnerFileStore(root).saveCredential(origin, {
          machineId,
          credential: "synthetic-runner-credential",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          claimant: { email: "owner@example.com" },
          controlPath: "/en-US/settings/cli",
        });
        // Start the real entry lifetime, then drive E2 while it remains pending.
        // Only local execution initialization and socket IO are synthetic.
        running = runRunnerStartup(
          { server: origin, resume: machineId },
          {
            isPrivateTerminal: () => true,
            origin: async () => origin,
            io: {
              initialize: async () => execution,
              fetch: vi.fn<typeof fetch>(async () => {
                throw new Error("unexpected network");
              }),
              now: Date.now,
              sleep: async () => {},
              makeProof: () => {
                throw new Error("unexpected pairing");
              },
              terminal: vi.fn(),
              store: runnerFileStore(root),
              limitsStore: (server, machine) => runnerLimitFileStore(server, machine, root),
              connect: (options) => new RunnerConnection(options),
            },
          },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        await vi.waitFor(() => expect(fixture.events).toBeDefined());
        expect(process.listenerCount("SIGINT")).toBe(oldInterrupts.size + 1);
        expect(process.listenerCount("SIGTERM")).toBe(oldTerminates.size + 1);
        const events = currentFixture().events;
        if (!events) throw new Error("missing production connection");
        events.open();
        events.message(
          JSON.stringify({
            version: 1,
            generation: 1,
            id: "welcome",
            seq: 1,
            ack: 0,
            type: "welcome",
            payload: { heartbeatMs: 25_000, livenessMs: 60_000, resumeGraceMs: 120_000 },
          }),
        );
        fixture.blockNext = true;
        events.message(
          JSON.stringify({
            version: 1,
            generation: 1,
            id: "limit-frame",
            seq: 2,
            ack: 1,
            type: "limits",
            payload: {
              commandId: "limit-command",
              expectedRevision: 0,
              revision: 1,
              matchMicros: 2_000_000,
              dayMicros: 20_000_000,
              concurrency: 3,
            },
          }),
        );
        await vi.waitFor(() => expect(fixture.release).toBeTypeOf("function"));
        if (terminalFirst) {
          events.close(4400);
          await vi.waitFor(() => expect(fixture.terminal).toBeDefined());
        }
        expect(process.emit(signal)).toBe(true);
        // Repeated Ctrl-C/termination still reaches our idempotent handler while
        // the private store is blocked, rather than restoring default exit.
        expect(process.emit(signal)).toBe(true);
        await vi.waitFor(() => expect(fixture.terminal).toBeDefined());
        expect(process.listenerCount("SIGINT")).toBe(oldInterrupts.size + 1);
        expect(process.listenerCount("SIGTERM")).toBe(oldTerminates.size + 1);
        await expect(runnerLimitFileStore(origin, machineId, root)).rejects.toThrow();
        currentFixture().release?.();
        await fixture.terminal;
        const result = await running;
        if (terminalFirst) expect(result).toMatchObject({ name: "CliError" });
        else expect(result).toBeUndefined();
        expect(execution.close).toHaveBeenCalledOnce();
        expect(execution.limitPolicy.stopOperatingLimits).toHaveBeenCalled();
        expect(execution.limitPolicy.applyOperatingLimits).not.toHaveBeenCalled();
        expect(process.listenerCount("SIGINT")).toBe(oldInterrupts.size);
        expect(process.listenerCount("SIGTERM")).toBe(oldTerminates.size);
        const store = await runnerLimitFileStore(origin, machineId, root);
        try {
          expect(await store.load()).toMatchObject({
            stopped: true,
            operatingLimits: { revision: 0 },
          });
        } finally {
          await store.close();
        }
        expect(fixture.sent.mock.calls.map(([frame]) => JSON.parse(frame).type)).not.toContain(
          "limits-result",
        );
      } finally {
        fixture.blockNext = false;
        currentFixture().release?.();
        currentFixture().connection?.stop();
        await currentFixture().terminal?.catch(() => {});
        await running;
        for (const listener of process.listeners("SIGINT"))
          if (!oldInterrupts.has(listener)) process.removeListener("SIGINT", listener);
        for (const listener of process.listeners("SIGTERM"))
          if (!oldTerminates.has(listener)) process.removeListener("SIGTERM", listener);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
