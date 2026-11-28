import { RunnerLimitsError } from "@cockpit-chess/auth/runner-limits";
import {
  RUNNER_APPLICATION_FRAMES_PER_MINUTE,
  RUNNER_RECEIVE_WINDOW,
  type RunnerClientMessage,
  type RunnerDelivery,
  runnerConfigDigest,
  runnerMatchConfigSchema,
} from "@cockpit-chess/chess/runner-protocol";
import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerMachineIdentity } from "./runner-session.js";
import {
  createRunnerTransport,
  RUNNER_MAX_LOCAL_CONNECTIONS,
  type RunnerSocket,
} from "./runner-ws.js";
import type { RunnerLease } from "./runner-ws-store.js";

vi.mock("@cockpit-chess/auth/runner-limits", () => ({
  RunnerLimitsError: class extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = "RunnerLimitsError";
    }
  },
}));

function harness(controls?: Parameters<typeof createRunnerTransport>[0]["controls"]) {
  const live = new Map<string, RunnerMachineIdentity>();
  const leases = new Map<string, RunnerLease>();
  let available = true;
  const identity: RunnerMachineIdentity = {
    userId: "owner1",
    machineId: "machine1",
    connectionGeneration: 0,
    expiresAt: new Date(Date.now() + 120_000),
  };
  live.set("Bearer secret", identity);
  const authority = {
    claim: vi.fn(async (authorization: string) => {
      const row = live.get(authorization);
      if (!row) return null;
      const next = { ...row, connectionGeneration: row.connectionGeneration + 1 };
      live.set(authorization, next);
      return next;
    }),
    resolve: vi.fn(async (authorization: string) => live.get(authorization) ?? null),
    ownsMatch: vi.fn(
      async (_identity: RunnerMachineIdentity, matchId: string) => matchId === "owned",
    ),
  };
  const store = {
    reserveIp: vi.fn(async () => true),
    releaseIp: vi.fn(async () => {}),
    acquire: vi.fn(async (lease: RunnerLease) => {
      if ((leases.get(lease.machineId)?.generation ?? -1) >= lease.generation) return false;
      leases.set(lease.machineId, lease);
      return true;
    }),
    validate: vi.fn(async (lease: RunnerLease) => leases.get(lease.machineId) === lease),
    release: vi.fn(async (lease: RunnerLease) => {
      if (leases.get(lease.machineId) === lease) leases.delete(lease.machineId);
    }),
  };
  const transport = (limits?: Parameters<typeof createRunnerTransport>[0]["limits"]) =>
    createRunnerTransport({
      authority,
      leases: store,
      isAvailable: () => available,
      now: Date.now,
      limits,
      controls,
    });
  return {
    live,
    leases,
    identity,
    authority,
    store,
    transport,
    unavailable: () => {
      available = false;
    },
  };
}
function socket() {
  const sent: Record<string, unknown>[] = [];
  const peer: RunnerSocket = {
    bufferedAmount: 0,
    send: vi.fn((value: string) => sent.push(JSON.parse(value))),
    ping: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  };
  return { peer, sent };
}
function hello(generation = 1, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    generation,
    id: "hello1",
    seq: 1,
    ack: 1,
    type: "hello",
    payload: {
      models: [],
      engine: true,
      hardLimits: { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
      operatingLimits: {
        matchMicros: 1_000_000,
        dayMicros: 10_000_000,
        concurrency: 2,
        revision: 0,
      },
    },
    ...overrides,
  });
}
function frame(type: string, seq: number, payload: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    generation: 1,
    id: `message${seq}`,
    seq,
    ack: 2,
    type,
    payload,
    ...extra,
  });
}
async function connect(h: ReturnType<typeof harness>, transport = h.transport()) {
  const reservation = await transport.reserve("Bearer secret", "203.0.113.1");
  if (!reservation) throw new Error("Expected reservation");
  const { peer, sent } = socket();
  const active = await reservation.attach(peer);
  if (!active) throw new Error("Expected connection");
  return { transport, active, peer, sent };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("durable runner transport controls", () => {
  const stop = { type: "stop", matchId: "owned", payload: { commandId: "durable1" } } as const;

  it("stops the socket immediately and joins one disconnect write across close, finished and drain", async () => {
    const write = Promise.withResolvers<void>();
    const disconnected = vi.fn(() => write.promise);
    const h = harness({
      outbox: vi.fn().mockResolvedValue([]),
      handle: vi.fn().mockResolvedValue([]),
      disconnected,
    });
    const { active, peer, transport } = await connect(h);
    active.close(1012, "RESTART");
    expect(active.isClosed()).toBe(true);
    expect(peer.close).toHaveBeenCalledExactlyOnceWith(1012, "RESTART");
    active.finished();
    active.close();
    let drained = false;
    const draining = transport.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(disconnected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        userId: "owner1",
        machineId: "machine1",
        connectionGeneration: 1,
      }),
    );
    expect(drained).toBe(false);
    write.resolve();
    await draining;
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("reports the retired generation once when a socket is replaced", async () => {
    const disconnected = vi.fn(async () => {});
    const h = harness({
      outbox: vi.fn().mockResolvedValue([]),
      handle: vi.fn().mockResolvedValue([]),
      disconnected,
    });
    const first = await connect(h);
    const second = await connect(h, first.transport);
    await first.transport.idle();
    expect(first.peer.close).toHaveBeenCalledWith(4409, "REPLACED");
    expect(second.active.isClosed()).toBe(false);
    expect(disconnected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ connectionGeneration: 1 }),
    );
    first.active.finished();
    await first.transport.drain();
    second.active.finished();
    expect(disconnected).toHaveBeenCalledTimes(2);
    expect(disconnected).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectionGeneration: 2 }),
    );
  });

  it("contains a failed disconnect write without delaying close or repeating it", async () => {
    const disconnected = vi.fn(async () => {
      throw new Error("untrusted storage detail");
    });
    const h = harness({
      outbox: vi.fn().mockResolvedValue([]),
      handle: vi.fn().mockResolvedValue([]),
      disconnected,
    });
    const { active, peer, transport } = await connect(h);
    active.finished();
    expect(peer.close).toHaveBeenCalledOnce();
    await transport.drain();
    active.finished();
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("recovers a missed wake by polling and preserves command IDs only through reconnect redelivery", async () => {
    const outbox = vi.fn().mockResolvedValue([]);
    const handle = vi.fn().mockResolvedValue([]);
    const h = harness({ outbox, handle });
    const { active, sent, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    expect(sent).toHaveLength(2);
    outbox.mockResolvedValue([stop]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.at(-1)).toMatchObject({ ...stop, id: "durable1", generation: 1, seq: 3 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.filter((message) => message.type === "stop")).toHaveLength(1);
    const replacement = await connect(h, transport);
    replacement.active.receive(hello(2));
    await replacement.active.idle();
    expect(replacement.sent.at(-1)).toMatchObject({ ...stop, id: "durable1", generation: 2 });
    expect(outbox).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: "machine1", connectionGeneration: 1 }),
      expect.any(Array),
    );
    await transport.drain();
  });

  it("windows durable commands and never floods a slow live consumer with repeated callbacks", async () => {
    const pending = Array.from({ length: 16 }, (_, index) => ({
      ...stop,
      payload: { commandId: `command${index}` },
    }));
    const outbox = vi.fn(async () => [...pending]);
    const handle = vi.fn(async () => {
      pending.shift();
      return [];
    });
    const h = harness({ outbox, handle });
    const { active, peer, sent, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    expect(sent.filter((message) => message.type === "stop")).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(15_000);
    await transport.idle();
    expect(sent.filter((message) => message.type === "stop")).toHaveLength(4);
    expect(peer.close).not.toHaveBeenCalled();
    active.receive(frame("ack", 2, { commandId: "command0" }));
    await active.idle();
    expect(sent.filter((message) => message.type === "stop")).toHaveLength(5);
    expect(sent.at(-1)).toMatchObject({ type: "stop", payload: { commandId: "command4" } });
    await transport.drain();
  });

  it("reclaims a saturated result slot for resume and withholds the next start until its ACK", async () => {
    const blockers = Array.from({ length: 3 }, (_, index) => ({
      ...stop,
      payload: { commandId: `blocker${index}` },
    }));
    const previous: RunnerDelivery = {
      type: "start",
      matchId: "owned",
      payload: { commandId: "previous-start", expectedSeq: 0 },
    };
    const next: RunnerDelivery = {
      type: "start",
      matchId: "owned",
      payload: { commandId: "aaa-next-start", expectedSeq: 1 },
    };
    const resume: RunnerDelivery = {
      type: "resume",
      matchId: "owned",
      payload: {
        commandId: "zzz-required-resume",
        acceptedSeq: 1,
        ply: 1,
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      },
    };
    let phase: "previous" | "resume" | "next" = "previous";
    // Storage supplies an executable frontier, regardless of tied timestamps or
    // the next start's lexically earlier random ID. The real PG tests prove selection.
    const outbox = vi.fn(
      async (): Promise<RunnerDelivery[]> => [
        ...blockers,
        phase === "previous" ? previous : phase === "resume" ? resume : next,
      ],
    );
    const handle = vi.fn(
      async (
        _identity: RunnerMachineIdentity,
        message: RunnerClientMessage,
      ): Promise<RunnerDelivery[]> => {
        if (message.type === "move") phase = "resume";
        if (message.type === "ack" && message.payload.commandId === resume.payload.commandId)
          phase = "next";
        return [{ type: "ack", payload: { commandId: message.id } }];
      },
    );
    const h = harness({ outbox, handle });
    const { active, peer, sent, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    expect(sent.filter((message) => ["start", "stop"].includes(String(message.type)))).toHaveLength(
      4,
    );
    const before = sent.length;
    active.receive(
      frame("move", 2, { uci: "e2e4", ply: 1, fen: resume.payload.fen }, { matchId: "owned" }),
    );
    await active.idle();
    expect(sent.slice(before).map((message) => message.type)).toEqual(["ack", "resume"]);
    expect(
      sent.some(
        (message) =>
          (message.payload as { commandId?: string }).commandId === next.payload.commandId,
      ),
    ).toBe(false);
    await active.deliver();
    expect(sent.filter((message) => message.type === "resume")).toHaveLength(1);
    active.receive(frame("ack", 3, { commandId: resume.payload.commandId }));
    await active.idle();
    expect(sent.at(-1)).toMatchObject(next);
    await active.deliver();
    await active.deliver();
    expect(
      sent.filter(
        (message) =>
          (message.payload as { commandId?: string }).commandId === next.payload.commandId,
      ),
    ).toHaveLength(1);
    expect(peer.close).not.toHaveBeenCalled();
    await transport.drain();
  });

  it("polls only the replacement frontier while post-accept authority is paused", async () => {
    const config = runnerMatchConfigSchema.parse({
      promptVersion: "1",
      white: { name: "White", model: "test/white", protocol: "openai-chat" },
      black: { name: "Black", model: "random", protocol: "random" },
      rules: {},
    });
    const offer: RunnerDelivery = {
      type: "offer",
      matchId: "owned",
      payload: {
        commandId: "replacement-offer",
        config,
        configDigest: runnerConfigDigest(config),
      },
    };
    const resume: RunnerDelivery = {
      type: "resume",
      matchId: "owned",
      payload: {
        commandId: "replacement-resume",
        acceptedSeq: 0,
        ply: 0,
        fen: config.initialFen,
      },
    };
    const start: RunnerDelivery = {
      type: "start",
      matchId: "owned",
      payload: { commandId: "older-start", expectedSeq: 0 },
    };
    let phase: "offer" | "resume" | "start" = "offer";
    let postAcceptPaused = false;
    const authorization = Promise.withResolvers<RunnerMachineIdentity>();
    const outbox = vi.fn(
      async (): Promise<RunnerDelivery[]> => [
        phase === "offer" ? offer : phase === "resume" ? resume : start,
      ],
    );
    const handle = vi.fn(
      async (
        _identity: RunnerMachineIdentity,
        message: RunnerClientMessage,
      ): Promise<RunnerDelivery[]> => {
        if (message.type === "accept") {
          phase = "resume";
          h.authority.resolve.mockImplementationOnce(() => {
            postAcceptPaused = true;
            return authorization.promise;
          });
        }
        if (message.type === "ack" && message.payload.commandId === resume.payload.commandId)
          phase = "start";
        return [{ type: "ack", payload: { commandId: message.id } }];
      },
    );
    const h = harness({ outbox, handle });
    const old = await connect(h);
    const replacement = await connect(h, old.transport);
    replacement.active.receive(hello(2));
    await replacement.active.idle();
    replacement.active.receive(
      frame(
        "accept",
        2,
        { commandId: offer.payload.commandId },
        { generation: 2, matchId: "owned" },
      ),
    );
    for (let index = 0; index < 80 && !postAcceptPaused; ++index) await Promise.resolve();
    expect(postAcceptPaused).toBe(true);
    await replacement.active.deliver();
    expect(replacement.sent.at(-1)).toMatchObject(resume);
    expect(replacement.sent.some((message) => message.type === "start")).toBe(false);
    const live = h.live.get("Bearer secret");
    if (!live) throw new Error("Expected replacement identity");
    authorization.resolve(live);
    await replacement.active.idle();
    expect(replacement.sent.filter((message) => message.type === "resume")).toHaveLength(1);
    expect(replacement.sent.some((message) => message.type === "start")).toBe(false);
    replacement.active.receive(
      frame("ack", 3, { commandId: resume.payload.commandId }, { generation: 2 }),
    );
    await replacement.active.idle();
    expect(replacement.sent.at(-1)).toMatchObject(start);
    expect(replacement.active.isClosed()).toBe(false);
    await old.transport.drain();
  });

  it("reclaims cancelled offer slots for stop commands without replaying other offers", async () => {
    const config = runnerMatchConfigSchema.parse({
      promptVersion: "1",
      white: { name: "White", model: "test/white", protocol: "openai-chat" },
      black: { name: "Black", model: "test/black", protocol: "openai-chat" },
      rules: {},
    });
    const offers = Array.from({ length: 4 }, (_, index) => ({
      type: "offer" as const,
      matchId: "owned",
      payload: { commandId: `offer${index}`, config, configDigest: runnerConfigDigest(config) },
    }));
    const outbox = vi.fn().mockResolvedValue(offers);
    const h = harness({ outbox, handle: vi.fn().mockResolvedValue([]) });
    const { active, sent, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    outbox.mockResolvedValue([...offers.slice(1), stop]);
    await vi.advanceTimersByTimeAsync(5000);
    await transport.idle();
    expect(sent.filter((message) => message.type === "offer")).toHaveLength(4);
    expect(sent.at(-1)).toMatchObject({ type: "stop", payload: stop.payload });
    await transport.drain();
  });

  it("does not replay a stale poll snapshot after a semantic ACK commits", async () => {
    const outbox = vi.fn().mockResolvedValue([stop]);
    const h = harness({ outbox, handle: vi.fn().mockResolvedValue([]) });
    const { active, sent, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    const poll = Promise.withResolvers<(typeof stop)[]>();
    outbox.mockReturnValueOnce(poll.promise).mockResolvedValue([]);
    const delivering = active.deliver();
    for (let i = 0; i < 20 && outbox.mock.calls.length < 2; ++i) await Promise.resolve();
    active.receive(frame("ack", 2, { commandId: "durable1" }));
    await active.idle();
    poll.resolve([stop]);
    await delivering;
    expect(sent.filter((message) => message.type === "stop")).toHaveLength(1);
    expect(active.isClosed()).toBe(false);
    await transport.drain();
  });

  it("tracks direct durable snapshot replies so the following poll cannot redeliver them", async () => {
    const resume = {
      type: "resume",
      matchId: "owned",
      payload: {
        commandId: "resume1",
        acceptedSeq: 0,
        fen: "8/8/8/8/8/8/5k2/7K w - - 0 1",
        ply: 0,
      },
    } as const;
    const outbox = vi.fn().mockResolvedValue([]);
    const handle = vi.fn(async () => {
      outbox.mockResolvedValue([resume]);
      return [resume];
    });
    const h = harness({ outbox, handle });
    const { active, sent, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    active.receive(
      frame(
        "snapshot",
        2,
        { acceptedSeq: 0, fen: resume.payload.fen, ply: 0 },
        { matchId: "owned" },
      ),
    );
    await active.idle();
    expect(sent.filter((message) => message.type === "resume")).toHaveLength(1);
    await transport.drain();
  });

  it.each([
    ["CONFLICT", "STALE"],
    ["TOO_MANY_REQUESTS", "BUSY"],
    ["BAD_REQUEST", "UNSUPPORTED"],
  ] as const)("keeps a live machine after a typed %s control race", async (code, wireCode) => {
    const outbox = vi.fn().mockResolvedValue([]);
    const handle = vi
      .fn()
      .mockImplementationOnce(async () => {
        outbox.mockResolvedValue([stop]);
        throw new ORPCError(code, { message: "private exception detail" });
      })
      .mockResolvedValue([]);
    const h = harness({ outbox, handle });
    const { active, peer, sent, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    active.receive(frame("accept", 2, { commandId: "cancelled-offer" }, { matchId: "owned" }));
    await active.idle();
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "error", payload: { code: wireCode } }),
    );
    expect(sent.at(-1)).toMatchObject({ type: "stop", payload: stop.payload });
    expect(peer.close).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).not.toContain("private exception detail");
    active.receive(frame("accept", 3, { commandId: "other-offer" }, { matchId: "owned" }));
    await active.idle();
    expect(handle).toHaveBeenCalledTimes(2);
    expect(active.isClosed()).toBe(false);
    await transport.drain();
  });

  it("rechecks authority before exposing a recoverable control error", async () => {
    const handle = vi.fn();
    const h = harness({ outbox: vi.fn().mockResolvedValue([]), handle });
    handle.mockImplementation(async () => {
      h.live.clear();
      throw new ORPCError("CONFLICT");
    });
    const { active, sent, peer, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    active.receive(frame("accept", 2, { commandId: "offer1" }, { matchId: "owned" }));
    await active.idle();
    expect(sent.some((message) => message.type === "error")).toBe(false);
    expect(peer.close).toHaveBeenCalledWith(4401, "UNAUTHORIZED");
    await transport.drain();
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"] as const)(
    "keeps actual typed %s control denial terminal",
    async (code) => {
      const h = harness({
        outbox: vi.fn().mockResolvedValue([]),
        handle: vi.fn().mockRejectedValue(new ORPCError(code)),
      });
      const { active, peer, transport } = await connect(h);
      active.receive(hello());
      await active.idle();
      active.receive(frame("accept", 2, { commandId: "offer1" }, { matchId: "owned" }));
      await active.idle();
      expect(peer.close).toHaveBeenCalledWith(4401, "UNAUTHORIZED");
      await transport.drain();
    },
  );

  it("keeps a failed semantic command charged until the outbox proves resolution", async () => {
    const commands = Array.from({ length: 5 }, (_, index) => ({
      ...stop,
      payload: { commandId: `charge${index}` },
    }));
    const outbox = vi.fn().mockResolvedValue(commands);
    const h = harness({ outbox, handle: vi.fn().mockRejectedValue(new ORPCError("CONFLICT")) });
    const { active, sent, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    active.receive(frame("ack", 2, { commandId: "charge0" }));
    await active.idle();
    expect(sent.filter((message) => message.type === "stop")).toHaveLength(4);
    expect(outbox).toHaveBeenLastCalledWith(expect.anything(), [
      "charge0",
      "charge1",
      "charge2",
      "charge3",
    ]);
    expect(active.isClosed()).toBe(false);
    await transport.drain();
  });

  it("retains direct replies beyond the FIFO page while an older poll races ACKs", async () => {
    const older = Array.from({ length: 33 }, (_, index) => ({
      ...stop,
      payload: { commandId: `old${index}` },
    }));
    const resume = {
      type: "resume",
      matchId: "owned",
      payload: {
        commandId: "offpage-resume",
        acceptedSeq: 0,
        fen: "8/8/8/8/8/8/5k2/7K w - - 0 1",
        ply: 0,
      },
    } as const;
    let pending: Array<(typeof older)[number] | typeof resume> = [...older];
    const page = (ids: readonly string[]) => {
      const pinned = pending.filter((message) => ids.includes(message.payload.commandId));
      return [
        ...pinned,
        ...pending.filter((message) => !ids.includes(message.payload.commandId)),
      ].slice(0, 32);
    };
    const outbox = vi.fn(async (_identity: RunnerMachineIdentity, ids: readonly string[]) =>
      page(ids),
    );
    const handle = vi.fn(async (_identity: RunnerMachineIdentity, message: RunnerClientMessage) => {
      if (message.type === "ack")
        pending = pending.filter(
          (command) => command.payload.commandId !== message.payload.commandId,
        );
      if (message.type === "snapshot") {
        pending.push(resume);
        return [resume];
      }
      return [];
    });
    const h = harness({ outbox, handle });
    const { active, sent, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    const authority = Promise.withResolvers<RunnerMachineIdentity>();
    let blocked = false;
    outbox.mockImplementationOnce(async (_identity, ids) => {
      h.authority.resolve.mockImplementationOnce(() => {
        blocked = true;
        return authority.promise;
      });
      return page(ids);
    });
    const stalePoll = active.deliver();
    for (let i = 0; i < 40 && !blocked; ++i) await Promise.resolve();
    expect(blocked).toBe(true);
    active.receive(frame("ack", 2, { commandId: "old0" }));
    await active.idle();
    active.receive(
      frame(
        "snapshot",
        3,
        { acceptedSeq: 0, fen: resume.payload.fen, ply: 0 },
        { matchId: "owned" },
      ),
    );
    await active.idle();
    authority.resolve(h.live.get("Bearer secret")!);
    await stalePoll;
    await active.deliver();
    await active.deliver();
    expect(outbox).toHaveBeenLastCalledWith(expect.anything(), [
      "old1",
      "old2",
      "old3",
      "offpage-resume",
    ]);
    expect(
      sent.filter((message) => ["stop", "resume"].includes(String(message.type))),
    ).toHaveLength(5);
    expect(sent.filter((message) => message.type === "resume")).toHaveLength(1);
    expect(
      sent.some((message) => (message.payload as { commandId?: string })?.commandId === "old4"),
    ).toBe(false);
    await transport.drain();
  });

  it("closes transient outbox failures resumably and suppresses late frames", async () => {
    const outbox = vi.fn().mockResolvedValue([]);
    const h = harness({ outbox, handle: vi.fn().mockResolvedValue([]) });
    const { active, sent, peer, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    const pending = Promise.withResolvers<(typeof stop)[]>();
    outbox.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(peer.close).toHaveBeenCalledWith(1012, "UNAVAILABLE");
    pending.resolve([stop]);
    await transport.idle();
    expect(sent.some((message) => message.type === "stop")).toBe(false);
    const replacement = await connect(h, transport);
    replacement.active.receive(hello(2));
    await replacement.active.idle();
    expect(replacement.active.isClosed()).toBe(false);
    await transport.drain();
  });

  it("routes only authorized match controls and returns their schema-fixed acknowledgement", async () => {
    const handle = vi.fn().mockResolvedValue([{ type: "ack", payload: { commandId: "message2" } }]);
    const h = harness({ outbox: vi.fn().mockResolvedValue([]), handle });
    const { active, sent, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    active.receive(frame("accept", 2, { commandId: "offer1" }, { matchId: "owned" }));
    await active.idle();
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: "machine1" }),
      expect.objectContaining({ type: "accept", matchId: "owned" }),
    );
    expect(sent.at(-1)).toMatchObject({ type: "ack", payload: { commandId: "message2" }, ack: 2 });
    active.receive(frame("accept", 3, { commandId: "offer1" }, { matchId: "foreign" }));
    await active.idle();
    expect(handle).toHaveBeenCalledOnce();
    expect(active.isClosed()).toBe(true);
    await transport.drain();
  });

  it("rechecks current generation after a pending outbox read before sending", async () => {
    let finish: ((value: (typeof stop)[]) => void) | undefined;
    const h = harness({
      outbox: vi.fn(
        () =>
          new Promise<(typeof stop)[]>((resolve) => {
            finish = resolve;
          }),
      ),
      handle: vi.fn().mockResolvedValue([]),
    });
    const { active, sent, transport } = await connect(h);
    active.receive(hello());
    for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
    expect(finish).toBeDefined();
    h.live.set("Bearer secret", { ...h.identity, connectionGeneration: 2 });
    finish?.([stop]);
    await active.idle();
    expect(sent.some((message) => message.type === "stop")).toBe(false);
    expect(active.isClosed()).toBe(true);
    await transport.drain();
  });

  it("bounds pending durable deliveries and closes on invalid stored payloads", async () => {
    for (const deliveries of [
      Array.from({ length: 33 }, () => stop),
      [{ ...stop, payload: { commandId: "bad/id" } }],
    ]) {
      const h = harness({
        outbox: vi.fn().mockResolvedValue(deliveries),
        handle: vi.fn().mockResolvedValue([]),
      });
      const { active, sent, transport } = await connect(h);
      active.receive(hello());
      await active.idle();
      expect(active.isClosed()).toBe(true);
      expect(sent.some((message) => message.type === "stop")).toBe(false);
      await transport.drain();
    }
  });
});

describe("runner transport simulation", () => {
  it(`admits configured result bursts while authority is delayed and retains the${RUNNER_RECEIVE_WINDOW}-frame flood bound`, async () => {
    const h = harness();
    const { active, peer, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    const blocked = Promise.withResolvers<RunnerMachineIdentity>();
    h.authority.resolve.mockImplementationOnce(() => blocked.promise);
    for (let index = 0; index < RUNNER_RECEIVE_WINDOW; ++index) {
      active.receive(frame("heartbeat", index + 2, { nonce: `result_control_${index}` }));
      expect(peer.close).not.toHaveBeenCalled();
    }
    active.receive(frame("heartbeat", RUNNER_RECEIVE_WINDOW + 2, { nonce: "over_pending" }));
    expect(peer.close).toHaveBeenCalledWith(4400, "INVALID");
    const identity = h.live.get("Bearer secret");
    if (!identity) throw new Error("Missing live identity");
    blocked.resolve(identity);
    await active.idle();
    await transport.drain();
  });

  it("rejects a second queued hello before an authentication read can drain it", async () => {
    const h = harness();
    const { active, peer, sent, transport } = await connect(h);
    const blocked = Promise.withResolvers<RunnerMachineIdentity>();
    let reading = false;
    h.authority.resolve.mockImplementationOnce(() => {
      reading = true;
      return blocked.promise;
    });
    active.receive(hello());
    for (let index = 0; index < 20 && !reading; ++index) await Promise.resolve();
    expect(reading).toBe(true);
    active.receive(hello());
    expect(peer.close).toHaveBeenCalledWith(4400, "INVALID");
    const identity = h.live.get("Bearer secret");
    if (!identity) throw new Error("Missing live identity");
    blocked.resolve(identity);
    await active.idle();
    expect(sent).toHaveLength(1);
    await transport.drain();
  });

  it("admits the supported gameplay minute and rejects its next application frame", async () => {
    const h = harness();
    const { active, peer, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    for (let seq = 2; seq <= RUNNER_APPLICATION_FRAMES_PER_MINUTE; ++seq) {
      active.receive(frame("heartbeat", seq, { nonce: `budget_${seq}` }));
      await active.idle();
    }
    expect(peer.close).not.toHaveBeenCalled();
    active.receive(
      frame("heartbeat", RUNNER_APPLICATION_FRAMES_PER_MINUTE + 1, { nonce: "over_budget" }),
    );
    expect(peer.close).toHaveBeenCalledWith(4400, "INVALID");
    await transport.drain();
  });

  it("assigns identity/generation server-side, validates hello, and acknowledges exact sequence", async () => {
    const h = harness();
    const { active, sent, transport } = await connect(h);
    expect(sent[0]).toMatchObject({ type: "welcome", generation: 1, seq: 1, ack: 0 });
    active.receive(hello());
    await active.idle();
    expect(sent[1]).toMatchObject({
      type: "ack",
      seq: 2,
      ack: 1,
      payload: { commandId: "hello1" },
    });
    expect(h.authority.resolve).toHaveBeenCalledWith("Bearer secret");
    expect(h.store.validate).toHaveBeenCalledWith(active.lease, true);
    await transport.drain();
  });

  it.each([
    hello(99),
    hello(1, { seq: 0 }),
    hello(1, { seq: 2 }),
    hello(1, { ack: 2 }),
    hello(1, { version: 2 }),
    hello(1, { ownerId: "victim" }),
    hello(1, { machineId: "victim" }),
    frame("heartbeat", 1, { nonce: "nonce" }),
    "{",
    " ".repeat(65_537),
  ])("closes malformed, spoofed, stale and out-of-order frames %#", async (input) => {
    const { active, peer } = await connect(harness());
    active.receive(input);
    await active.idle();
    expect(peer.close).toHaveBeenCalledWith(4400, "INVALID");
  });

  it("does not parse binary frames or process repeated hello or duplicate sequence", async () => {
    const h = harness();
    const first = await connect(h);
    first.active.receive(hello(), true);
    expect(first.peer.close).toHaveBeenCalledWith(4400, "INVALID");
    const second = await connect(h);
    second.active.receive(hello(2));
    await second.active.idle();
    second.active.receive(hello(2));
    await second.active.idle();
    expect(second.peer.close).toHaveBeenCalledWith(4400, "INVALID");
  });

  it("checks owner/source scope and never executes valid match messages", async () => {
    const { active, peer, sent } = await connect(harness());
    active.receive(hello());
    await active.idle();
    active.receive(frame("event", 2, { kind: "started" }, { matchId: "owned" }));
    await active.idle();
    expect(sent.at(-1)).toMatchObject({ type: "error", payload: { code: "UNSUPPORTED" } });
    active.receive(frame("event", 3, { kind: "started" }, { matchId: "foreign" }));
    await active.idle();
    expect(peer.close).toHaveBeenCalledWith(4401, "UNAUTHORIZED");
  });

  it("rechecks durable authority even when invalidation delivery was lost", async () => {
    const h = harness();
    const { active, peer } = await connect(h);
    active.receive(hello());
    await active.idle();
    h.live.clear();
    active.receive(frame("heartbeat", 2, { nonce: "nonce" }));
    await active.idle();
    expect(peer.close).toHaveBeenCalledWith(4401, "UNAUTHORIZED");
  });

  it("fences stale sockets across replicas and does not delete the replacement lease", async () => {
    const h = harness();
    const first = await connect(h);
    first.active.receive(hello());
    await first.active.idle();
    const second = await connect(h);
    second.active.receive(hello(2));
    await second.active.idle();
    first.active.receive(frame("heartbeat", 2, { nonce: "nonce" }));
    await first.active.idle();
    expect(first.peer.close).toHaveBeenCalledWith(4409, "REPLACED");
    expect(h.leases.get("machine1")).toBe(second.active.lease);
    expect(second.peer.close).not.toHaveBeenCalled();
  });

  it("a delayed older reservation cannot replace a newer socket on the same replica", async () => {
    const h = harness();
    const transport = h.transport();
    const older = await transport.reserve("Bearer secret", "ip");
    const newer = await connect(h, transport);
    const stale = socket();
    expect(await older?.attach(stale.peer)).toBeNull();
    expect(stale.peer.close).toHaveBeenCalledWith(4409, "REPLACED");
    expect(newer.peer.close).not.toHaveBeenCalled();
    expect(h.leases.get("machine1")).toBe(newer.active.lease);
    await transport.drain();
  });

  it("rechecks durable authority before welcome and retires pending reservations on invalidation", async () => {
    const h = harness();
    const transport = h.transport();
    const first = await transport.reserve("Bearer secret", "ip");
    h.live.clear();
    const revoked = socket();
    expect(await first?.attach(revoked.peer)).toBeNull();
    expect(revoked.peer.send).not.toHaveBeenCalled();
    expect(revoked.peer.close).toHaveBeenCalledWith(4401, "UNAUTHORIZED");
    h.live.set("Bearer secret", h.identity);
    const second = await transport.reserve("Bearer secret", "ip");
    transport.invalidate("owner1", "machine1");
    const invalidated = socket();
    expect(await second?.attach(invalidated.peer)).toBeNull();
    expect(invalidated.peer.send).not.toHaveBeenCalled();
    expect(h.leases.size).toBe(0);
  });

  it("does not activate when invalidation arrives during activation storage reads", async () => {
    const h = harness();
    const transport = h.transport();
    const reservation = await transport.reserve("Bearer secret", "ip");
    let finish: ((identity: RunnerMachineIdentity) => void) | undefined;
    h.authority.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const peer = socket();
    const attaching = reservation?.attach(peer.peer);
    transport.invalidate("owner1");
    finish?.({ ...h.identity, connectionGeneration: 1 });
    expect(await attaching).toBeNull();
    expect(peer.peer.send).not.toHaveBeenCalled();
    expect(peer.peer.close).toHaveBeenCalledWith(4401, "UNAUTHORIZED");
  });

  it("an IP quota rejection leaves a healthy machine generation and socket intact", async () => {
    const h = harness();
    const { transport, active, peer } = await connect(h);
    active.receive(hello());
    await active.idle();
    h.store.reserveIp.mockResolvedValueOnce(false);
    expect(await transport.reserve("Bearer secret", "full-ip")).toBeNull();
    expect(h.authority.claim).toHaveBeenCalledTimes(1);
    expect(h.live.get("Bearer secret")?.connectionGeneration).toBe(1);
    active.receive(frame("heartbeat", 2, { nonce: "nonce" }));
    await active.idle();
    expect(peer.close).not.toHaveBeenCalled();
    await transport.drain();
  });

  it("accepts nonce responses delayed beyond one heartbeat interval but within liveness", async () => {
    const { active, peer, sent, transport } = await connect(harness());
    active.receive(hello());
    await active.idle();
    await vi.advanceTimersByTimeAsync(25_000);
    const firstNonce = sent.at(-1)?.payload;
    active.pong();
    await vi.advanceTimersByTimeAsync(25_000);
    active.receive(frame("pong", 2, firstNonce));
    await active.idle();
    expect(peer.close).not.toHaveBeenCalled();
    await transport.drain();
  });

  it("pushes reset/revoke and replacement invalidation only to matching identities", async () => {
    const h = harness();
    const { transport, active, peer } = await connect(h);
    transport.invalidate("someone-else");
    transport.invalidate(undefined, "another-machine");
    transport.invalidate(undefined, "machine1", 1);
    expect(peer.close).not.toHaveBeenCalled();
    transport.invalidate(undefined, "machine1", 2);
    expect(peer.close).toHaveBeenCalledWith(4409, "REPLACED");
    active.receive(hello());
    expect(peer.send).toHaveBeenCalledTimes(1);
  });

  it.each(["storage", "lease", "subscriber"])("fails closed on %s loss", async (kind) => {
    const h = harness();
    const { active, peer } = await connect(h);
    if (kind === "storage")
      h.authority.resolve.mockRejectedValue(new Error("private storage detail"));
    if (kind === "lease") h.store.validate.mockRejectedValue(new Error("redis unavailable"));
    if (kind === "subscriber") h.unavailable();
    active.receive(hello());
    await active.idle();
    expect(peer.close).toHaveBeenCalledWith(1012, "UNAVAILABLE");
    expect(peer.close).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("private"),
    );
  });

  it("bounds a stalled authority lookup and the pending input queue", async () => {
    const h = harness();
    const first = await connect(h);
    first.active.receive(hello());
    await first.active.idle();
    h.authority.resolve.mockImplementationOnce(() => new Promise(() => {}));
    first.active.receive(frame("heartbeat", 2, { nonce: "nonce" }));
    await vi.advanceTimersByTimeAsync(5001);
    await first.active.idle();
    expect(first.peer.close).toHaveBeenCalledWith(1012, "UNAVAILABLE");
    const second = await connect(h);
    for (let i = 0; i < 13; i++) second.active.receive(hello(2));
    expect(second.peer.close).toHaveBeenCalledWith(4400, "INVALID");
  });

  it("heartbeats at 25 seconds, checks both liveness channels, and closes at 60 seconds", async () => {
    const { active, peer, sent } = await connect(harness());
    active.receive(hello());
    await active.idle();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(peer.ping).toHaveBeenCalledTimes(1);
    const heartbeat = sent.at(-1);
    expect(heartbeat).toMatchObject({ type: "heartbeat", seq: 3 });
    active.receive(frame("pong", 2, heartbeat?.payload));
    await active.idle();
    active.pong();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(peer.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(peer.close).toHaveBeenCalledWith(4408, "LIVENESS");
  });

  it("uses monotonic elapsed time for liveness when the wall clock moves backwards", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const h = harness();
    const transport = createRunnerTransport({
      authority: h.authority,
      leases: h.store,
      isAvailable: () => true,
    });
    const { active, peer } = await connect(h, transport);
    active.receive(hello());
    await active.idle();
    vi.setSystemTime(Date.now() - 3_600_000);
    clock.mockReturnValue(60_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(peer.close).toHaveBeenCalledWith(4408, "LIVENESS");
    clock.mockRestore();
    await transport.drain();
  });

  it("rejects forged pong nonces and closes slow consumers", async () => {
    const first = await connect(harness());
    first.active.receive(hello());
    await first.active.idle();
    first.active.receive(frame("pong", 2, { nonce: "unsolicited" }));
    await first.active.idle();
    expect(first.peer.close).toHaveBeenCalledWith(4400, "INVALID");
    const second = await connect(harness());
    Object.defineProperty(second.peer, "bufferedAmount", { value: 262_145 });
    second.active.receive(hello());
    await second.active.idle();
    expect(second.peer.close).toHaveBeenCalledWith(4408, "BACKPRESSURE");
    await vi.advanceTimersByTimeAsync(1000);
    expect(second.peer.terminate).toHaveBeenCalled();
  });

  it("releases failed/local abandoned reservations and bounds local connections", async () => {
    const h = harness();
    const transport = h.transport();
    for (let i = 0; i < RUNNER_MAX_LOCAL_CONNECTIONS + 1; i++) {
      expect(await transport.reserve("invalid", "ip")).toBeNull();
    }
    const reservation = await transport.reserve("Bearer secret", "ip");
    expect(reservation).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.leases.size).toBe(0);
    const { peer } = socket();
    expect(await reservation?.attach(peer)).toBeNull();
  });

  it("drains with resumable restart before refusing future reservations", async () => {
    const { transport, peer } = await connect(harness());
    await transport.drain();
    expect(peer.close).toHaveBeenCalledWith(1012, "RESTART");
    expect(await transport.reserve("Bearer secret", "ip")).toBeNull();
  });

  it("joins pre-upgrade checks before storage disconnect and refuses checks after drain", async () => {
    const h = harness();
    const transport = h.transport();
    let finish: ((value: string) => void) | undefined;
    const checking = transport.admit(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    let drained = false;
    const draining = transport.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish?.("checked");
    expect(await checking).toBe("checked");
    await draining;
    const late = vi.fn(async () => "late");
    await expect(transport.admit(late)).rejects.toThrow("admission unavailable");
    expect(late).not.toHaveBeenCalled();
  });

  it("retains capacity for underlying checks that outlive response deadlines", async () => {
    const transport = harness().transport();
    const finish: Array<() => void> = [];
    const checks = Array.from({ length: RUNNER_MAX_LOCAL_CONNECTIONS }, () =>
      transport.admit(
        () =>
          new Promise<void>((resolve) => {
            finish.push(resolve);
          }),
      ),
    );
    const results = Promise.allSettled(checks);
    await vi.advanceTimersByTimeAsync(5001);
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    const extra = vi.fn(async () => {});
    await expect(transport.admit(extra)).rejects.toThrow("admission unavailable");
    expect(extra).not.toHaveBeenCalled();
    for (const complete of finish) complete();
    await transport.drain();
  });
});

describe("durable operating-limit transport", () => {
  const command = {
    commandId: "limit-command",
    expectedRevision: 0,
    revision: 1,
    matchMicros: 2_000_000,
    dayMicros: 10_000_000,
    concurrency: 2,
  };
  const hardLimits = { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 };
  const result = {
    commandId: command.commandId,
    revision: command.revision,
    status: "applied",
    reason: "applied",
    operatingLimits: {
      matchMicros: command.matchMicros,
      dayMicros: command.dayMicros,
      concurrency: command.concurrency,
      revision: command.revision,
    },
    hardLimits,
  };
  function backend() {
    return {
      hello: vi.fn(async () => command),
      pending: vi.fn(async () => command),
      result: vi.fn(async () => true),
    };
  }
  it("registers authoritative hello, redelivers durable command and accepts exact terminal result", async () => {
    const h = harness();
    const limits = backend();
    const { active, sent, transport } = await connect(h, h.transport(limits));
    active.receive(hello());
    await active.idle();
    expect(limits.hello).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: "machine1", connectionGeneration: 1 }),
      expect.objectContaining({ hardLimits }),
    );
    expect(
      sent.filter((message) => message.type === "limits").map((message) => message.payload),
    ).toEqual([command]);
    vi.setSystemTime(Date.now() + 5000);
    await active.tick();
    expect(limits.pending).toHaveBeenCalledTimes(1);
    expect(
      sent.filter((message) => message.type === "limits").map((message) => message.payload),
    ).toEqual([command, command]);
    active.receive(frame("limits-result", 2, result));
    await active.idle();
    expect(limits.result).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: "machine1", connectionGeneration: 1 }),
      result,
    );
    expect(sent.at(-1)).toMatchObject({ type: "ack", payload: { commandId: command.commandId } });
    await transport.drain();
  });
  it("keeps limit delivery independent from a full chess window and routes results exclusively", async () => {
    const stops = Array.from({ length: 5 }, (_, index) => ({
      type: "stop" as const,
      matchId: "owned",
      payload: { commandId: `chess${index}` },
    }));
    const handle = vi.fn().mockResolvedValue([]);
    const h = harness({ outbox: vi.fn().mockResolvedValue(stops), handle });
    const limits = backend();
    const { active, sent, transport } = await connect(h, h.transport(limits));
    active.receive(hello());
    await active.idle();
    expect(sent.filter((message) => message.type === "stop")).toHaveLength(4);
    expect(sent.filter((message) => message.type === "limits")).toHaveLength(1);
    vi.setSystemTime(Date.now() + 5000);
    await active.tick();
    expect(sent.filter((message) => message.type === "stop")).toHaveLength(4);
    expect(sent.filter((message) => message.type === "limits")).toHaveLength(2);
    active.receive(frame("limits-result", 2, result));
    await active.idle();
    expect(limits.result).toHaveBeenCalledOnce();
    expect(handle).not.toHaveBeenCalled();
    active.receive(frame("accept", 3, { commandId: "offer1" }, { matchId: "owned" }));
    await active.idle();
    expect(handle).toHaveBeenCalledOnce();
    expect(limits.result).toHaveBeenCalledOnce();
    await transport.drain();
  });
  it("admits two replies per command with concurrent liveness and limit traffic", async () => {
    const blocked = Promise.withResolvers<void>();
    const handle = vi.fn(async () => {
      await blocked.promise;
      return [];
    });
    const h = harness({ outbox: vi.fn().mockResolvedValue([]), handle });
    const limits = backend();
    const { active, peer, transport } = await connect(h, h.transport(limits));
    active.receive(hello());
    await active.idle();
    for (let seq = 2; seq <= 9; seq++)
      active.receive(frame("ack", seq, { commandId: `command${seq}` }));
    active.receive(frame("heartbeat", 10, { nonce: "parallel-heartbeat" }));
    active.receive(frame("limits-result", 11, result));
    expect(peer.close).not.toHaveBeenCalled();
    blocked.resolve();
    await active.idle();
    expect(handle).toHaveBeenCalledTimes(8);
    expect(limits.result).toHaveBeenCalledOnce();
    expect(peer.close).not.toHaveBeenCalled();
    await transport.drain();
  });
  it("refuses limit results without a limit service without forwarding them to chess controls", async () => {
    const handle = vi.fn().mockResolvedValue([]);
    const h = harness({ outbox: vi.fn().mockResolvedValue([]), handle });
    const { active, sent, transport } = await connect(h);
    active.receive(hello());
    await active.idle();
    active.receive(frame("limits-result", 2, result));
    await active.idle();
    expect(handle).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: "error", payload: { code: "UNSUPPORTED" } });
    expect(active.isClosed()).toBe(false);
    await transport.drain();
  });
  it.each([
    new ORPCError("UNAUTHORIZED"),
    new RunnerLimitsError("NOT_FOUND"),
    new RunnerLimitsError("FORBIDDEN"),
  ])("keeps typed limit authority denial terminal", async (error) => {
    const h = harness();
    const limits = backend();
    limits.result.mockRejectedValue(error);
    const { active, peer, sent, transport } = await connect(h, h.transport(limits));
    active.receive(hello());
    await active.idle();
    active.receive(frame("limits-result", 2, result));
    await active.idle();
    expect(peer.close).toHaveBeenCalledWith(4401, "UNAUTHORIZED");
    expect(sent.at(-1)).not.toMatchObject({
      type: "ack",
      payload: { commandId: result.commandId },
    });
    await transport.drain();
  });
  it("never delivers pending commands after revocation or storage validation failure", async () => {
    const h = harness();
    const limits = backend();
    const { active, peer, transport } = await connect(h, h.transport(limits));
    active.receive(hello());
    await active.idle();
    h.live.clear();
    vi.setSystemTime(Date.now() + 5000);
    await active.tick();
    expect(limits.pending).not.toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalledWith(4401, "UNAUTHORIZED");
    await transport.drain();
  });
  it("closes on unavailable durable delivery and never substitutes invented command state", async () => {
    const h = harness();
    const limits = backend();
    limits.pending.mockRejectedValue(new Error("storage unavailable"));
    const { active, peer, transport } = await connect(h, h.transport(limits));
    active.receive(hello());
    await active.idle();
    vi.setSystemTime(Date.now() + 5000);
    await active.tick();
    expect(peer.close).toHaveBeenCalledWith(1012, "UNAVAILABLE");
    await transport.drain();
  });
});

describe("scheduled runner transport work", () => {
  it("keeps queued receives out of unrelated admission slots", async () => {
    const h = harness();
    const { active, transport } = await connect(h, h.transport());
    active.receive(hello());
    await active.idle();
    let release: (() => void) | undefined;
    h.authority.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(h.live.get("Bearer secret") ?? null);
        }),
    );
    for (let index = 0; index < RUNNER_MAX_LOCAL_CONNECTIONS; index++) {
      active.receive(frame("heartbeat", index + 2, { nonce: `queued_${index}` }));
    }
    expect(await transport.admit(async () => true)).toBe(true);
    h.live.set("Bearer other", { ...h.identity, machineId: "machine2", connectionGeneration: 0 });
    const reserved = await transport.reserve("Bearer other", "203.0.113.2");
    expect(reserved).not.toBeNull();
    await reserved?.release();
    expect(release).toBeTypeOf("function");
    release?.();
    await transport.idle();
    expect(active.isClosed()).toBe(false);
    await transport.drain();
  });
  it("joins post-ACK delivery before idle returns", async () => {
    let entered: (() => void) | undefined;
    const delivering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: (() => void) | undefined;
    const delivered = new Promise<RunnerDelivery[]>((resolve) => {
      release = () => resolve([]);
    });
    const h = harness({
      outbox: async () => {
        entered?.();
        return delivered;
      },
      handle: async () => [],
    });
    const { active, peer, transport } = await connect(h, h.transport());
    let joined = false;
    let joining: Promise<void> | undefined;
    // Reproduce the runtime harness's boundary: the ACK is visible while the
    // hello handler still has asynchronous outbox work to start and finish.
    vi.mocked(peer.send).mockImplementation((value) => {
      if (JSON.parse(value).type === "ack") {
        joining = transport.idle().then(() => {
          joined = true;
        });
      }
    });
    active.receive(hello());
    await delivering;
    expect(joining).toBeDefined();
    expect(joined).toBe(false);
    release?.();
    await joining;
    await active.idle();
    expect(joined).toBe(true);
    await transport.drain();
  });
  it("joins a delayed outbox tick before advancing the heartbeat clock", async () => {
    const h = harness();
    const outbox = vi.fn(async () => []);
    const transport = createRunnerTransport({
      authority: h.authority,
      leases: h.store,
      isAvailable: () => true,
      now: Date.now,
      controls: { outbox, handle: async () => [] },
    });
    const { active, peer, sent } = await connect(h, transport);
    active.receive(hello());
    await active.idle();
    await transport.idle();
    let finish: (() => void) | undefined;
    outbox.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          finish = () => resolve([]);
        }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(finish).toBeTypeOf("function");
    let joined = false;
    const joining = transport.idle().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    finish?.();
    await joining;
    for (const step of [5000, 5000, 5000, 4999]) {
      await vi.advanceTimersByTimeAsync(step);
      await transport.idle();
    }
    expect(peer.ping).not.toHaveBeenCalled();
    expect(peer.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await transport.idle();
    expect(peer.ping).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({ type: "heartbeat" });
    await transport.drain();
  });
});
