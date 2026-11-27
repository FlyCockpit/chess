import type IORedis from "ioredis";
import { describe, expect, it } from "vitest";
import {
  chessKeyLeasesBlocking,
  holdChessKeyLease,
  parseChessKeyRevocation,
  recordChessKeyRevoked,
} from "./chess-key-revocation";
import { fakeValkey } from "./chess-key-revocation.test-support";

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
      hashes = await recordChessKeyRevoked(valkey.connection, "u", `hash-${index}`);
    expect(hashes).toHaveLength(50);
    expect(hashes).toContain("hash-59");
    expect(hashes).not.toContain("hash-0");
    expect(await recordChessKeyRevoked(valkey.connection, "u", null)).toEqual(hashes);
  });
});
