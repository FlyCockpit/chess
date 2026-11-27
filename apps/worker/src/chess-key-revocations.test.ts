import { EventEmitter } from "node:events";
import {
  chessKeyLeasesBlocking,
  recordChessKeyRevoked,
} from "@cockpit-chess/queue/chess-key-revocation";
import { fakeValkey } from "@cockpit-chess/queue/chess-key-revocation/test-support";
import type IORedis from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyChessKeyRevocation,
  leaseOwnerKeyRun,
  resetChessKeyRevocations,
  startChessKeyRevocations,
  stopChessKeyRevocations,
} from "./chess-key-revocations";

let valkey: ReturnType<typeof fakeValkey>;
beforeEach(() => {
  valkey = fakeValkey();
  resetChessKeyRevocations(valkey.connection);
});
afterEach(() => {
  stopChessKeyRevocations();
  vi.useRealTimers();
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
const leases = (userId = "user-b") => [
  ...(valkey.sets.get(`cockpit-chess:openrouter-key-use:${userId}`)?.keys() ?? []),
];
/** Disconnect's check, with hash-b still the connected key unless said otherwise. */
const blocking = (hashes: string[], connected: string | null = "hash-b") =>
  chessKeyLeasesBlocking(valkey.connection, "user-b", hashes, connected);
const start = async (matchId: string, userId = "user-b") => {
  const revoke = vi.fn();
  const fence = vi.fn();
  const lease = await leaseOwnerKeyRun({ matchId, userId, revoke, fence });
  return { revoke, fence, ...lease };
};

describe("OpenRouter key-use leases in a worker", () => {
  it("holds a loading lease before the key is loaded, then one on the key", async () => {
    const run = await start("m1");
    expect(leases()).toEqual(["m1|loading"]);
    expect(await blocking([])).toBe(true);
    await run.loaded("hash-b");
    expect(leases()).toEqual(["m1|hash-b"]);
    expect(await blocking([])).toBe(false);
    expect(await blocking(["hash-b"])).toBe(true);
    run.finish();
    await flush();
    expect(leases()).toEqual([]);
  });

  it("aborts a run on a revoked key synchronously, then drops its lease", async () => {
    const order: string[] = [];
    const lease = await leaseOwnerKeyRun({
      matchId: "m2",
      userId: "user-b",
      revoke: () => order.push(`revoke, lease held: ${leases().length}`),
      fence: vi.fn(),
    });
    await lease.loaded("hash-b");
    applyChessKeyRevocation({ userId: "user-b", keyHashes: ["hash-b"] });
    order.push("returned");
    await flush();
    expect(order).toEqual(["revoke, lease held: 1", "returned"]);
    expect(await blocking(["hash-b"])).toBe(false);
  });

  it("leaves a newer key of the same user and other users alone", async () => {
    const newer = await start("m3");
    await newer.loaded("hash-new");
    const other = await start("m4", "user-a");
    await other.loaded("hash-b");
    applyChessKeyRevocation({ userId: "user-b", keyHashes: ["hash-b"] });
    await flush();
    expect(newer.revoke).not.toHaveBeenCalled();
    expect(other.revoke).not.toHaveBeenCalled();
    expect(leases()).toEqual(["m3|hash-new"]);
  });

  it("applies a revocation that arrived while the key was loading", async () => {
    const run = await start("m5");
    applyChessKeyRevocation({ userId: "user-b", keyHashes: ["hash-b"] });
    await run.loaded("hash-b");
    expect(run.revoke).toHaveBeenCalledTimes(1);
    await flush();
    expect(leases()).toEqual([]);
  });

  it("catches a missed message through the revoked list after loading", async () => {
    valkey.sets.set("cockpit-chess:openrouter-key-revoked:user-b", new Map([["hash-b", 1]]));
    const run = await start("m6");
    await run.loaded("hash-b");
    expect(run.revoke).toHaveBeenCalledTimes(1);
  });

  it("drops the lease of a run that found no key", async () => {
    const run = await start("m7");
    await run.loaded(null);
    await flush();
    expect(run.revoke).not.toHaveBeenCalled();
    expect(leases()).toEqual([]);
  });

  it("refuses to start without a lease, and fences a run that cannot prove its key", async () => {
    valkey.state.down = true;
    await expect(start("m8")).rejects.toThrow();
    valkey.state.down = false;
    const run = await start("m9");
    valkey.state.down = true;
    await run.loaded("hash-b");
    expect(run.fence).toHaveBeenCalledTimes(1);
  });

  it("refreshes the lease, and aborts a run before a lease it cannot refresh runs out", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const run = await start("m10");
    await run.loaded("hash-b");
    const score = () =>
      valkey.sets.get("cockpit-chess:openrouter-key-use:user-b")?.get("m10|hash-b");
    const first = score() ?? 0;
    await vi.advanceTimersByTimeAsync(5000);
    expect(score() ?? 0).toBeGreaterThan(first);
    valkey.state.down = true;
    const brokeAt = Date.now();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run.fence).toHaveBeenCalledTimes(1);
    // Aborted while its last refreshed lease was still live, by at least the skew margin.
    expect((score() ?? 0) - Date.now()).toBeGreaterThan(5000);
    expect(Date.now() - brokeAt).toBeLessThanOrEqual(20_000);
    expect(run.revoke).not.toHaveBeenCalled();
  });

  it("refuses dispatch synchronously once the lease may have run out, timers or not", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const run = await start("m12");
    await run.loaded("hash-b");
    expect(() => run.assertUsable()).not.toThrow();
    // The process stalls: the clock moves on, no refresh timer has fired.
    vi.setSystemTime(Date.now() + 20_000);
    expect(() => run.assertUsable()).toThrow();
    expect(run.fence).toHaveBeenCalledTimes(1);
    await flush();
    expect(leases()).toEqual([]);
  });

  it("refuses dispatch after a revocation, and never re-takes a lease for a run with no key", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const revoked = await start("m13");
    await revoked.loaded("hash-b");
    applyChessKeyRevocation({ userId: "user-b", keyHashes: ["hash-b"] });
    expect(() => revoked.assertUsable()).toThrow();
    const keyless = await start("m14");
    await keyless.loaded(null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(leases()).toEqual([]);
  });

  it("stops a run whose key load sees too many distinct revocations", async () => {
    const run = await start("m15");
    for (let index = 0; index < 51; index += 1)
      applyChessKeyRevocation({ userId: "user-b", keyHashes: [`hash-${index}`] });
    expect(run.fence).toHaveBeenCalledTimes(1);
    await flush();
    expect(leases()).toEqual([]);
  });

  it("never lets a renewing run that missed Disconnect read as stopped across a Valkey restart", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const run = await start("m16");
    await run.loaded("hash-b");
    // Disconnect, the way the API does it, while this worker misses the message.
    const disconnect = async () => {
      const revoked = await recordChessKeyRevoked(valkey.connection, "user-b", null);
      return chessKeyLeasesBlocking(valkey.connection, "user-b", revoked, null).then(
        (busy) => (busy ? "pending" : "none"),
        () => "pending",
      );
    };
    await recordChessKeyRevoked(valkey.connection, "user-b", "hash-b");
    expect(await disconnect()).toBe("pending");
    // Valkey restarts and loses everything: leases and the revoked list.
    valkey.sets.clear();
    valkey.state.uptimeSeconds = 0;
    expect(await disconnect()).toBe("pending");
    // The worker keeps renewing its lease on the old key...
    await vi.advanceTimersByTimeAsync(5000);
    valkey.state.uptimeSeconds = 60;
    expect(leases()).toEqual(["m16|hash-b"]);
    // ...and a repeated Disconnect, with no row and no revoked list, still can't say "none".
    expect(await disconnect()).toBe("pending");
    expect(() => run.assertUsable()).not.toThrow();
    run.finish();
    await flush();
    expect(await disconnect()).toBe("none");
  });

  it("subscribes to the channel and ignores other channels and malformed messages", async () => {
    const subscriber = Object.assign(new EventEmitter(), {
      subscribe: vi.fn(async () => 1),
    }) as unknown as IORedis;
    await startChessKeyRevocations(subscriber, valkey.connection);
    expect(subscriber.subscribe).toHaveBeenCalledWith("cockpit-chess:openrouter-key-revoked");
    const run = await start("m11");
    await run.loaded("hash-b");
    const channel = "cockpit-chess:openrouter-key-revoked";
    const message = JSON.stringify({ userId: "user-b", keyHashes: ["hash-b"] });
    subscriber.emit("message", "some-other-channel", message);
    subscriber.emit("message", channel, "{not json");
    subscriber.emit("message", channel, "null");
    subscriber.emit("message", channel, JSON.stringify({ userId: "user-b", keyHashes: "hash-b" }));
    expect(run.revoke).not.toHaveBeenCalled();
    subscriber.emit("message", channel, message);
    expect(run.revoke).toHaveBeenCalledTimes(1);
  });
});
