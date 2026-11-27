import { describe, expect, it, vi } from "vitest";
import {
  createRunnerLeaseStore,
  RUNNER_ACTIONS_PER_MINUTE,
  RUNNER_IP_CONNECTIONS,
  RUNNER_LEASE_TTL_MS,
} from "./runner-ws-store.js";

const lease = {
  machineId: "machine1",
  userId: "owner1",
  generation: 4,
  connectionId: "connection1",
  ip: "203.0.113.1",
};

describe("Redis runner lease commands", () => {
  it("atomically acquires a generation fence, IP quota, expiry and ID-only replacement push", async () => {
    const evalCommand = vi.fn().mockResolvedValue(1);
    const store = createRunnerLeaseStore({ eval: evalCommand });
    expect(await store.acquire(lease)).toBe(true);
    const [script, count, key, ip, value, generation, id, ttl, machineId] =
      evalCommand.mock.calls[0] ?? [];
    expect(script).toContain("decoded.generation >= tonumber(ARGV[2])");
    expect(script).toContain("redis.call('TIME')");
    expect(script).toContain("redis.call('PUBLISH', 'runner_ws_replaced'");
    expect(script).toContain("if not present then return 0 end");
    expect(count).toBe(2);
    expect(key).toBe("runner:ws:lease:machine1");
    expect(ip).toMatch(/^runner:ws:ip:[a-f0-9]{64}$/);
    expect(ip).not.toContain(lease.ip);
    expect(JSON.parse(value)).toEqual(lease);
    expect([generation, id, ttl, machineId]).toEqual([
      4,
      "connection1",
      RUNNER_LEASE_TTL_MS,
      "machine1",
    ]);
  });

  it("reserves IP capacity before a generation claim and expires abandoned members", async () => {
    const evalCommand = vi.fn().mockResolvedValue(1);
    const store = createRunnerLeaseStore({ eval: evalCommand });
    expect(await store.reserveIp(lease.ip, lease.connectionId)).toBe(true);
    const [script, count, key, id, ttl, quota] = evalCommand.mock.calls[0] ?? [];
    expect(script).toContain("redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3])");
    expect(script).toContain("redis.call('TIME')");
    expect(script).toContain("redis.call('ZREMRANGEBYSCORE'");
    expect([count, id, ttl, quota]).toEqual([
      1,
      lease.connectionId,
      RUNNER_LEASE_TTL_MS,
      RUNNER_IP_CONNECTIONS,
    ]);
    expect(key).toMatch(/^runner:ws:ip:[a-f0-9]{64}$/);
    await store.releaseIp(lease.ip, lease.connectionId);
    expect(evalCommand.mock.calls[1]).toEqual([
      "return redis.call('ZREM', KEYS[1], ARGV[1])",
      1,
      key,
      lease.connectionId,
    ]);
  });

  it("validates exact connection ownership and uses a distinct machine action budget", async () => {
    const evalCommand = vi.fn().mockResolvedValue(1);
    const store = createRunnerLeaseStore({ eval: evalCommand });
    expect(await store.validate(lease)).toBe(true);
    const [script, count, key, ip, actionKey, value, id, ttl, action, limit] =
      evalCommand.mock.calls[0] ?? [];
    expect(script).toContain("redis.call('GET', KEYS[1]) ~= ARGV[1]");
    expect(script).toContain("redis.call('INCR', KEYS[3])");
    expect(script).toContain("redis.call('ZREMRANGEBYSCORE'");
    expect(count).toBe(3);
    expect(key).toBe("runner:ws:lease:machine1");
    expect(ip).toMatch(/^runner:ws:ip:/);
    expect(actionKey).toBe("runner:ws:actions:machine1");
    expect(value).toBe(JSON.stringify(lease));
    expect([id, ttl, action, limit]).toEqual([
      "connection1",
      RUNNER_LEASE_TTL_MS,
      "1",
      RUNNER_ACTIONS_PER_MINUTE,
    ]);
    await store.validate(lease, false);
    expect(evalCommand.mock.calls[1]?.at(-2)).toBe("0");
  });

  it("releases only the exact lease and its own IP member", async () => {
    const evalCommand = vi.fn().mockResolvedValue(1);
    await createRunnerLeaseStore({ eval: evalCommand }).release(lease);
    const [script, count, key, ip, value, id] = evalCommand.mock.calls[0] ?? [];
    expect(script).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(script).toContain("redis.call('ZREM', KEYS[2], ARGV[2])");
    expect([count, key, value, id]).toEqual([
      2,
      "runner:ws:lease:machine1",
      JSON.stringify(lease),
      "connection1",
    ]);
    expect(ip).toMatch(/^runner:ws:ip:/);
  });

  it("denies quota/replacement failures and never accepts a non-integer Redis response", async () => {
    const evalCommand = vi.fn().mockResolvedValue(0);
    const store = createRunnerLeaseStore({ eval: evalCommand });
    expect(await store.acquire(lease)).toBe(false);
    expect(await store.validate(lease)).toBe(false);
    evalCommand.mockResolvedValue("1");
    expect(await store.acquire(lease)).toBe(false);
    evalCommand.mockRejectedValue(new Error("Redis unavailable"));
    await expect(store.validate(lease)).rejects.toThrow("Redis unavailable");
  });
});
