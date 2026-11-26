import type IORedis from "ioredis";

/**
 * Live engine-pool numbers for the admin capacity view (`chess.capacity`). Each
 * worker process publishes its own pool under its instance id with a short expiry;
 * readers sum whatever is still fresh, so a dead worker drops out by itself.
 * Counts only: no match, user or key data is ever written here.
 */
const KEY = "cockpit-chess:chess-engine-pool:";
export const CHESS_ENGINE_STATS_TTL_SECONDS = 15;

export interface ChessEnginePoolStats {
  /** Engine processes evaluating right now. */
  busy: number;
  /** The pool's size (processes it may run at once). */
  total: number;
  /** Evaluations waiting for a free process. */
  waiting: number;
  /** Matches this worker process is running now, and its configured limit. */
  running: number;
  concurrency: number;
}

type StatsRedis = Pick<IORedis, "set" | "scan" | "mget">;

export async function publishChessEngineStats(
  connection: Pick<IORedis, "set">,
  instanceId: string,
  stats: ChessEnginePoolStats,
) {
  await connection.set(
    `${KEY}${instanceId}`,
    JSON.stringify(stats),
    "EX",
    CHESS_ENGINE_STATS_TTL_SECONDS,
  );
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

/** The sum over every worker process that published within the expiry. */
export async function readChessEngineStats(
  connection: StatsRedis,
): Promise<ChessEnginePoolStats & { workers: number }> {
  const keys: string[] = [];
  let cursor = "0";
  // Bounded: one key per live worker process; stop after a few hundred.
  do {
    const [next, batch] = await connection.scan(cursor, "MATCH", `${KEY}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0" && keys.length < 500);
  const total = { busy: 0, total: 0, waiting: 0, running: 0, concurrency: 0, workers: 0 };
  if (!keys.length) return total;
  for (const raw of await connection.mget(...keys)) {
    if (!raw) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    total.workers += 1;
    total.busy += count(parsed.busy);
    total.total += count(parsed.total);
    total.waiting += count(parsed.waiting);
    total.running += count(parsed.running);
    total.concurrency += count(parsed.concurrency);
  }
  return total;
}
