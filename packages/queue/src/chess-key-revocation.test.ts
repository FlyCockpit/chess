import type IORedis from "ioredis";
import { describe, expect, it, vi } from "vitest";
import {
  chessKeyLeasesBlocking,
  forgetChessKeyRevocations,
  holdChessKeyLease,
  parseChessKeyRevocation,
  recordChessKeyRevoked,
} from "./chess-key-revocation";
import { fakeValkey } from "./chess-key-revocation.test-support";

it("retires only the erased account's revoked-hash history, never its live lease proof", async () => {
  const valkey = fakeValkey();
  await recordChessKeyRevoked(valkey.connection, "erased", "key-hash", () => {});
  await holdChessKeyLease(valkey.connection, "erased", "active", "key-hash");
  await forgetChessKeyRevocations(valkey.connection, "erased");
  expect(valkey.sets.has("cockpit-chess:openrouter-key-revoked:erased")).toBe(false);
  expect(await chessKeyLeasesBlocking(valkey.connection, "erased", [], null)).toBe(true);
  expect([...valkey.values.values()]).toEqual(["retired"]);
  expect([...valkey.values.keys()][0]).toMatch(/^cockpit-chess:key-retirement:[a-f0-9]{64}$/);
  expect([...valkey.values.keys()][0]).not.toContain("erased");
});

/** A MULTI whose EXEC answers `results` (per-command `[error, value]` pairs). */
const answering = (results: Array<[Error | null, unknown]> | null) =>
  ({
    multi: () => {
      const chain: Record<string, unknown> = {};
      for (const name of [
        "zadd",
        "zrem",
        "pexpire",
        "expire",
        "zremrangebyscore",
        "zrangebyscore",
        "zremrangebyrank",
        "zrevrange",
        "info",
      ])
        chain[name] = () => chain;
      chain.exec = async () => results;
      return chain;
    },
  }) as unknown as Pick<IORedis, "multi">;

describe("chess key revocation contract", () => {
  it("parses only well-formed messages", () => {
    expect(parseChessKeyRevocation(JSON.stringify({ userId: "u", keyHashes: ["a", "b"] }))).toEqual(
      { userId: "u", keyHashes: ["a", "b"] },
    );
    for (const raw of [
      "nope",
      "null",
      "[]",
      JSON.stringify({ userId: "u" }),
      JSON.stringify({ userId: "u", keyHashes: "a" }),
      JSON.stringify({ userId: "u", keyHashes: [1] }),
      JSON.stringify({ userId: "", keyHashes: [] }),
      JSON.stringify({ userId: "u", keyHashes: Array.from({ length: 51 }, () => "a") }),
    ])
      expect(parseChessKeyRevocation(raw)).toBeUndefined();
  });

  it("never reads a failed or aborted transaction as success", async () => {
    const wrongType = new Error("WRONGTYPE");
    await expect(
      holdChessKeyLease(
        answering([
          [wrongType, null],
          [null, 1],
        ]),
        "u",
        "h",
      ),
    ).rejects.toThrow("WRONGTYPE");
    await expect(holdChessKeyLease(answering(null), "u", "h")).rejects.toThrow();
    // An errored listing is "can't tell", never "no lease".
    await expect(
      chessKeyLeasesBlocking(
        answering([
          [null, "uptime_in_seconds:3600\r\n"],
          [null, 0],
          [wrongType, null],
        ]),
        "u",
        [],
        null,
      ),
    ).rejects.toThrow("WRONGTYPE");
  });

  it("can't tell while Valkey has been up for less than a lease's lifetime", async () => {
    const valkey = fakeValkey();
    expect(await chessKeyLeasesBlocking(valkey.connection, "u", [], null)).toBe(false);
    valkey.state.uptimeSeconds = 5;
    await expect(chessKeyLeasesBlocking(valkey.connection, "u", [], null)).rejects.toThrow(
      "restarted",
    );
  });

  it("blocks on a lease on any key that is not the connected one, even unlisted", async () => {
    const valkey = fakeValkey();
    await holdChessKeyLease(valkey.connection, "u", "m1", "hash-old");
    // The revoked list was lost (a Valkey restart): the lease still blocks.
    expect(await chessKeyLeasesBlocking(valkey.connection, "u", [], null)).toBe(true);
    expect(await chessKeyLeasesBlocking(valkey.connection, "u", [], "hash-new")).toBe(true);
    // A run on the key that is still connected does not.
    expect(await chessKeyLeasesBlocking(valkey.connection, "u", [], "hash-old")).toBe(false);
  });

  it("keeps the newest revoked hashes, bounded", async () => {
    const valkey = fakeValkey();
    let hashes: string[] = [];
    for (let index = 0; index < 60; index += 1)
      hashes = await recordChessKeyRevoked(valkey.connection, "u", `hash-${index}`, () => {});
    expect(hashes).toHaveLength(50);
    expect(hashes).toContain("hash-59");
    expect(hashes).not.toContain("hash-0");
    expect(await recordChessKeyRevoked(valkey.connection, "u", null, () => {})).toEqual(hashes);
  });

  it.each(["retired", "missing"])(
    "rejects an underlying late cache mutation after its epoch is %s",
    async (mode) => {
      const valkey = fakeValkey();
      let captured: Parameters<typeof valkey.connection.eval> | undefined;
      const delayed = {
        ...valkey.connection,
        eval: (async (...args: Parameters<typeof valkey.connection.eval>) => {
          captured = args;
          throw new Error("synthetic client timeout");
        }) as unknown as typeof valkey.connection.eval,
      };
      await expect(
        recordChessKeyRevoked(delayed, "erased", "late-key-hash", () => {}),
      ).rejects.toThrow("client timeout");
      if (!captured) throw new Error("Expected captured record Lua");
      await forgetChessKeyRevocations(valkey.connection, "erased");
      if (mode === "missing") valkey.values.clear();
      expect(await valkey.connection.eval(...captured)).toEqual([0]);
      expect(valkey.sets.has("cockpit-chess:openrouter-key-revoked:erased")).toBe(false);
      expect(
        await recordChessKeyRevoked(valkey.connection, "peer", "active-peer-hash", () => {}),
      ).toEqual(["active-peer-hash"]);
    },
  );

  it("uses the original holder deadline again after initialization resumes", async () => {
    const valkey = fakeValkey();
    let expired = false;
    const delayed = {
      ...valkey.connection,
      set: (async (...args: Parameters<typeof valkey.connection.set>) => {
        const result = await valkey.connection.set(...args);
        expired = true;
        return result;
      }) as typeof valkey.connection.set,
      get: vi.fn(valkey.connection.get),
      eval: vi.fn(valkey.connection.eval),
    };
    await expect(
      recordChessKeyRevoked(
        delayed as unknown as Parameters<typeof recordChessKeyRevoked>[0],
        "erased",
        "never-recorded",
        () => {
          if (expired) throw new Error("original owner lock expired");
        },
      ),
    ).rejects.toThrow("original owner lock expired");
    expect(delayed.get).not.toHaveBeenCalled();
    expect(delayed.eval).not.toHaveBeenCalled();
    expect(valkey.sets.has("cockpit-chess:openrouter-key-revoked:erased")).toBe(false);
  });

  it("does not issue a new read or mutation after a paused initialization exceeds its short bound", async () => {
    const valkey = fakeValkey();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const delayed = {
        ...valkey.connection,
        set: (async (...args: Parameters<typeof valkey.connection.set>) => {
          const result = await valkey.connection.set(...args);
          clock.mockReturnValue(2500);
          return result;
        }) as typeof valkey.connection.set,
        get: vi.fn(valkey.connection.get),
        eval: vi.fn(valkey.connection.eval),
      };
      await expect(
        recordChessKeyRevoked(
          delayed as unknown as Parameters<typeof recordChessKeyRevoked>[0],
          "erased",
          "never-recorded",
          () => {},
        ),
      ).rejects.toThrow("publication expired");
      expect(delayed.get).not.toHaveBeenCalled();
      expect(delayed.eval).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
