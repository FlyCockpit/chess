import type IORedis from "ioredis";

/**
 * Test support: just enough of Valkey for the key-revocation contract (sorted sets,
 * MULTI, PUBLISH), in memory, with a kill switch.
 */
export function fakeValkey() {
  const sets = new Map<string, Map<string, number>>();
  const state = { down: false, uptimeSeconds: 3600, failAfterApplying: false };
  const published: Array<[string, string]> = [];
  const set = (key: string) => {
    const entry = sets.get(key) ?? new Map<string, number>();
    sets.set(key, entry);
    return entry;
  };
  const range = (key: string, min: number, max: number) =>
    [...set(key)].filter(([, score]) => score >= min && score <= max).map(([member]) => member);
  const bound = (value: number | string) =>
    value === "-inf" ? -Infinity : value === "+inf" ? Infinity : Number(value);
  const connection = {
    multi() {
      const ops: Array<() => unknown> = [];
      const chain = {
        zadd: (key: string, score: number, member: string) =>
          ops.push(() => set(key).set(member, score)) && chain,
        zrem: (key: string, member: string) => ops.push(() => set(key).delete(member)) && chain,
        pexpire: () => ops.push(() => 1) && chain,
        expire: () => ops.push(() => 1) && chain,
        zremrangebyscore: (key: string, min: number | string, max: number | string) =>
          ops.push(() => {
            for (const member of range(key, bound(min), bound(max))) set(key).delete(member);
          }) && chain,
        zrangebyscore: (key: string, min: number | string, max: number | string) =>
          ops.push(() => range(key, bound(min), bound(max))) && chain,
        zremrangebyrank: (key: string, start: number, stop: number) =>
          ops.push(() => {
            const sorted = [...set(key)].sort((a, b) => a[1] - b[1]).map(([member]) => member);
            const end = stop < 0 ? sorted.length + stop : stop;
            if (end < start) return;
            for (const member of sorted.slice(start, end + 1)) set(key).delete(member);
          }) && chain,
        zrevrange: (key: string) =>
          ops.push(() => [...set(key)].sort((a, b) => b[1] - a[1]).map(([member]) => member)) &&
          chain,
        info: () =>
          ops.push(
            () => `# Server\r\nredis_version:8.0.0\r\nuptime_in_seconds:${state.uptimeSeconds}\r\n`,
          ) && chain,
        exec: async () => {
          if (state.failAfterApplying) {
            // The commands ran, but the reply was lost (a timeout, a dropped connection).
            for (const op of ops) op();
            throw new Error("valkey reply lost");
          }
          if (state.down) throw new Error("valkey down");
          return ops.map((op) => [null, op()]);
        },
      };
      return chain;
    },
    publish: async (channel: string, message: string) => {
      if (state.down) throw new Error("valkey down");
      published.push([channel, message]);
      return 1;
    },
    zscore: async (key: string, member: string) => {
      if (state.down) throw new Error("valkey down");
      const score = set(key).get(member);
      return score === undefined ? null : String(score);
    },
  };
  return {
    sets,
    state,
    published,
    connection: connection as unknown as Pick<IORedis, "multi" | "zscore" | "publish">,
  };
}
