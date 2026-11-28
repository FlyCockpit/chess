import { createHash } from "node:crypto";
import { RUNNER_APPLICATION_FRAMES_PER_MINUTE } from "@cockpit-chess/chess/runner-protocol";
import {
  RUNNER_DELETION_LEASE_MS,
  runnerMachineLeaseKey,
} from "@cockpit-chess/queue/account-deletion";

/** One live lease per machine across replicas; identifiers never contain credentials. */
export type RunnerLease = {
  machineId: string;
  userId: string;
  generation: number;
  connectionId: string;
  ip: string;
};

type RedisCommands = {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export const RUNNER_LEASE_TTL_MS = RUNNER_DELETION_LEASE_MS;
export const RUNNER_IP_CONNECTIONS = 16;
export const RUNNER_ACTIONS_PER_MINUTE = RUNNER_APPLICATION_FRAMES_PER_MINUTE;
export const RUNNER_REPLACEMENT_CHANNEL = "runner_ws_replaced";

const reserveIpScript = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;

// Redis TIME, rather than a replica's wall clock, bounds quota expiry. Generation
// comes from the durable machine row; a delayed older handshake cannot replace it.
const acquireScript = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local previous = redis.call('GET', KEYS[1])
if previous then
  local decoded = cjson.decode(previous)
  if decoded.generation >= tonumber(ARGV[2]) then return 0 end
end
local present = redis.call('ZSCORE', KEYS[2], ARGV[3])
if not present then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[4])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[4]), ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
redis.call('PUBLISH', '${RUNNER_REPLACEMENT_CHANNEL}', cjson.encode({machineId=ARGV[5],generation=tonumber(ARGV[2])}))
return 1`;

const validateScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
if not redis.call('ZSCORE', KEYS[2], ARGV[2]) then return 0 end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if not redis.call('ZSCORE', KEYS[2], ARGV[2]) then return 0 end
if ARGV[4] == '1' then
  local count = redis.call('INCR', KEYS[3])
  if count == 1 then redis.call('PEXPIRE', KEYS[3], 60000) end
  if count > tonumber(ARGV[5]) then return 0 end
end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[3]), ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1`;

const releaseScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
redis.call('ZREM', KEYS[2], ARGV[2])
return 1`;

function leaseKey(lease: RunnerLease) {
  return runnerMachineLeaseKey(lease.machineId);
}
function ipKey(lease: RunnerLease) {
  return ipAddressKey(lease.ip);
}
function ipAddressKey(ip: string) {
  return `runner:ws:ip:${createHash("sha256").update(ip).digest("hex")}`;
}
function encoded(lease: RunnerLease) {
  return JSON.stringify(lease);
}

export function createRunnerLeaseStore(redis: RedisCommands) {
  return {
    async reserveIp(ip: string, connectionId: string): Promise<boolean> {
      return (
        (await redis.eval(
          reserveIpScript,
          1,
          ipAddressKey(ip),
          connectionId,
          RUNNER_LEASE_TTL_MS,
          RUNNER_IP_CONNECTIONS,
        )) === 1
      );
    },
    async releaseIp(ip: string, connectionId: string): Promise<void> {
      await redis.eval(
        "return redis.call('ZREM', KEYS[1], ARGV[1])",
        1,
        ipAddressKey(ip),
        connectionId,
      );
    },
    async acquire(lease: RunnerLease): Promise<boolean> {
      return (
        (await redis.eval(
          acquireScript,
          2,
          leaseKey(lease),
          ipKey(lease),
          encoded(lease),
          lease.generation,
          lease.connectionId,
          RUNNER_LEASE_TTL_MS,
          lease.machineId,
        )) === 1
      );
    },
    async validate(lease: RunnerLease, action = true): Promise<boolean> {
      return (
        (await redis.eval(
          validateScript,
          3,
          leaseKey(lease),
          ipKey(lease),
          `runner:ws:actions:${lease.machineId}`,
          encoded(lease),
          lease.connectionId,
          RUNNER_LEASE_TTL_MS,
          action ? "1" : "0",
          RUNNER_ACTIONS_PER_MINUTE,
        )) === 1
      );
    },
    async release(lease: RunnerLease): Promise<void> {
      await redis.eval(
        releaseScript,
        2,
        leaseKey(lease),
        ipKey(lease),
        encoded(lease),
        lease.connectionId,
      );
    },
  };
}

export type RunnerLeaseStore = ReturnType<typeof createRunnerLeaseStore>;
