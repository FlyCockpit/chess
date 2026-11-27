import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerMachineIdentity } from "./runner-session.js";
import {
  createRunnerTransport,
  RUNNER_MAX_LOCAL_CONNECTIONS,
  type RunnerSocket,
} from "./runner-ws.js";
import type { RunnerLease } from "./runner-ws-store.js";

function harness() {
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
  const transport = () =>
    createRunnerTransport({
      authority,
      leases: store,
      isAvailable: () => available,
      now: Date.now,
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

describe("runner transport simulation", () => {
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
    expect(peer.close).toHaveBeenCalledWith(4401, "UNAUTHORIZED");
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
    expect(first.peer.close).toHaveBeenCalledWith(4401, "UNAUTHORIZED");
    const second = await connect(h);
    for (let i = 0; i < 9; i++) second.active.receive(hello(2));
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
