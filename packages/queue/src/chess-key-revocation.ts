import type IORedis from "ioredis";

/**
 * Stopping a disconnected OpenRouter key at once (Settings → OpenRouter → Disconnect).
 *
 * Every use of a user's key holds a **key-use lease** in Valkey for as long as it may
 * send a request with it: a worker's hosted run (refreshed while it runs) and the
 * server's Settings status check. A lease is taken BEFORE the connection row is read,
 * as `<holder>|loading`, and becomes `<holder>|<key hash>` once the key is loaded
 * (or is dropped when there is none). A holder that cannot refresh its lease stops
 * using the key before the lease runs out (`CHESS_KEY_LEASE_FENCE_MS`), so a lease
 * that has expired is a use that has ended.
 *
 * Disconnect: records the key's hash as revoked, deletes the row, publishes the
 * revoked hashes (workers abort those runs at once and drop their leases), then waits
 * until the user has no live lease that is loading or on a revoked hash. A use that
 * Disconnect does not see as a lease started after the row was deleted, so it finds no
 * key. Ids and hashes only: never the key.
 */
export const CHESS_KEY_REVOCATION_CHANNEL = "cockpit-chess:openrouter-key-revoked";
const LEASES = "cockpit-chess:openrouter-key-use:";
const REVOKED = "cockpit-chess:openrouter-key-revoked:";
/** A lease's lifetime from its last refresh. */
export const CHESS_KEY_LEASE_MS = 30_000;
/**
 * The holder's own limit: it stops using the key once this long has passed since its
 * last successful take/refresh. The 10 s gap absorbs clock skew between hosts.
 */
export const CHESS_KEY_LEASE_FENCE_MS = 20_000;
const REVOKED_TTL_SECONDS = 24 * 60 * 60;
/** Revoked hashes kept per user (newest first); keys are created at most 20 per 10 min. */
const REVOKED_KEEP = 50;
const LOADING = "loading";

export interface ChessKeyRevocation {
  userId: string;
  /** Hashes of the user's keys that must no longer be used (bounded, newest first). */
  keyHashes: string[];
}

type Multi = Pick<IORedis, "multi">;

/** Runs a MULTI and fails if it or any of its commands failed. */
async function exec(
  connection: Multi,
  build: (multi: ReturnType<IORedis["multi"]>) => unknown,
): Promise<unknown[]> {
  const multi = connection.multi();
  build(multi);
  const results = await multi.exec();
  if (!results) throw new Error("Valkey transaction aborted");
  return results.map(([error, value]) => {
    if (error) throw error;
    return value;
  });
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;

export function parseChessKeyRevocation(raw: string): ChessKeyRevocation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const fields = parsed as Record<string, unknown>;
  const userId = text(fields.userId, 200);
  if (!userId || !Array.isArray(fields.keyHashes) || fields.keyHashes.length > REVOKED_KEEP)
    return undefined;
  const keyHashes = fields.keyHashes.map((hash) => text(hash, 200));
  if (keyHashes.some((hash) => hash === undefined)) return undefined;
  return { userId, keyHashes: keyHashes as string[] };
}

/** Records `keyHash` as revoked for `userId`; returns every recently revoked hash. */
export async function recordChessKeyRevoked(
  connection: Multi,
  userId: string,
  keyHash: string | null,
): Promise<string[]> {
  const key = `${REVOKED}${userId}`;
  const results = await exec(connection, (multi) => {
    if (keyHash) multi.zadd(key, Date.now(), keyHash);
    multi.zremrangebyrank(key, 0, -(REVOKED_KEEP + 1));
    multi.expire(key, REVOKED_TTL_SECONDS);
    multi.zrevrange(key, 0, -1);
  });
  const hashes = results.at(-1);
  return Array.isArray(hashes) ? hashes.filter((hash) => typeof hash === "string") : [];
}

/** Whether `keyHash` was revoked for `userId` (a worker's check after loading a key). */
export async function isChessKeyRevoked(
  connection: Pick<IORedis, "zscore">,
  userId: string,
  keyHash: string,
): Promise<boolean> {
  return (await connection.zscore(`${REVOKED}${userId}`, keyHash)) !== null;
}

export async function publishChessKeyRevocation(
  connection: Pick<IORedis, "publish">,
  revocation: ChessKeyRevocation,
) {
  await connection.publish(CHESS_KEY_REVOCATION_CHANNEL, JSON.stringify(revocation));
}

const member = (holder: string, keyHash: string | null) => `${holder}|${keyHash ?? LOADING}`;

/** Takes (or refreshes) `holder`'s lease as loading (`keyHash` null) or on `keyHash`. */
export async function holdChessKeyLease(
  connection: Multi,
  userId: string,
  holder: string,
  keyHash: string | null = null,
) {
  const key = `${LEASES}${userId}`;
  await exec(connection, (multi) => {
    multi.zadd(key, Date.now() + CHESS_KEY_LEASE_MS, member(holder, keyHash));
    if (keyHash) multi.zrem(key, member(holder, null));
    multi.pexpire(key, CHESS_KEY_LEASE_MS);
  });
}

/** Ends `holder`'s lease (whatever it is on). */
export async function releaseChessKeyLease(
  connection: Multi,
  userId: string,
  holder: string,
  keyHash: string | null,
) {
  const key = `${LEASES}${userId}`;
  await exec(connection, (multi) => {
    multi.zrem(key, member(holder, null));
    if (keyHash) multi.zrem(key, member(holder, keyHash));
  });
}

/**
 * Whether `userId` still has a live lease that is loading, on one of `keyHashes`, or on
 * any key other than `connectedKeyHash` (the one still connected, if any): a lease on a
 * key that is no longer connected is a use Disconnect must wait for even when the
 * revoked list was lost. Throws when Valkey cannot tell (the caller must not read that
 * as "no"), including while Valkey has been up for less than a lease's lifetime (a
 * restart may have lost leases whose holders have not refreshed or fenced yet). The
 * uptime is read in the same transaction as the leases, so both describe one Valkey
 * process. (A failover to a replica that lost recent writes is not detected: run one
 * Valkey, or replicate synchronously.)
 */
export async function chessKeyLeasesBlocking(
  connection: Multi,
  userId: string,
  keyHashes: readonly string[],
  connectedKeyHash: string | null,
): Promise<boolean> {
  const key = `${LEASES}${userId}`;
  const now = Date.now();
  const [info, , live] = await exec(connection, (multi) => {
    multi.info("server");
    multi.zremrangebyscore(key, "-inf", now);
    multi.zrangebyscore(key, now, "+inf");
  });
  const uptime = typeof info === "string" ? /^uptime_in_seconds:(\d+)/m.exec(info)?.[1] : undefined;
  if (uptime === undefined || Number(uptime) * 1000 < CHESS_KEY_LEASE_MS)
    throw new Error("Valkey restarted recently: leases may be missing");
  if (!Array.isArray(live)) throw new Error("Unexpected lease listing");
  const revoked = new Set(keyHashes);
  return live.some((entry) => {
    if (typeof entry !== "string") return true;
    const hash = entry.slice(entry.lastIndexOf("|") + 1);
    return hash === LOADING || revoked.has(hash) || hash !== connectedKeyHash;
  });
}
