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
  const keys = new Set<string>();
  let cursor = "0";
  let scans = 0;
  let truncated = false;
  // SCAN may repeat keys or return empty batches with a nonzero cursor. Bound
  // both work and result size, and count each worker at most once.
  do {
    const [next, batch] = await connection.scan(cursor, "MATCH", `${KEY}*`, "COUNT", 100);
    cursor = next;
    for (const key of batch) {
      if (keys.size >= 500 && !keys.has(key)) {
        truncated = true;
        break;
      }
      keys.add(key);
    }
    scans += 1;
  } while (cursor !== "0" && keys.size < 500 && scans < 10);
  // SCAN MATCH walks the whole shared keyspace, including unrelated queue/cache
  // entries. A bounded prefix is unavailable telemetry, never a complete total.
  if (cursor !== "0" || truncated) throw new Error("Hosted capacity scan incomplete");
  const total = { busy: 0, total: 0, waiting: 0, running: 0, concurrency: 0, workers: 0 };
  if (!keys.size) return total;
  for (const raw of await connection.mget(...keys)) {
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    if (
      !("busy" in parsed) ||
      !("total" in parsed) ||
      !("waiting" in parsed) ||
      !("running" in parsed) ||
      !("concurrency" in parsed) ||
      ![parsed.busy, parsed.total, parsed.waiting, parsed.running, parsed.concurrency].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
      )
    )
      continue;
    total.workers += 1;
    total.busy += count(parsed.busy);
    total.total += count(parsed.total);
    total.waiting += count(parsed.waiting);
    total.running += count(parsed.running);
    total.concurrency += count(parsed.concurrency);
  }
  return total;
}
