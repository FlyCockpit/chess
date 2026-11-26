import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import {
  configureEnginePool,
  defaultEnginePoolSize,
  enginePoolStats,
} from "@cockpit-chess/chess/engine";
import { env } from "@cockpit-chess/env/shared";
import { publishChessEngineStats } from "@cockpit-chess/queue/chess-capacity";
import type IORedis from "ioredis";
import { runningChessMatches } from "./handlers/chess-heartbeat.js";

const PUBLISH_EVERY_MS = 5000;

/**
 * Hosted chess capacity for this worker process, see docs/deployment.md § Sizing hosted chess.
 * `chess-run` runs up to CHESS_RUN_CONCURRENCY matches at once, while every
 * Stockfish evaluation goes through one shared engine pool of CHESS_ENGINE_POOL_SIZE
 * processes (0 = from the CPU count), so engine work never scales with the number of
 * matches. Publishes the live counts for the admin capacity view every 5 s.
 */
export function startChessCapacity(connection: Pick<IORedis, "set">) {
  const poolSize = env.CHESS_ENGINE_POOL_SIZE || defaultEnginePoolSize(availableParallelism());
  configureEnginePool({ size: poolSize });
  const instanceId = env.COCKPIT_CHESS_INSTANCE_ID ?? randomUUID();
  const publish = () => {
    const { busy, total, waiting } = enginePoolStats();
    // Best effort: the admin view shows a worker as gone once its entry expires.
    return publishChessEngineStats(connection, instanceId, {
      busy,
      total,
      waiting,
      running: runningChessMatches(),
      concurrency: env.CHESS_RUN_CONCURRENCY,
    }).catch(() => undefined);
  };
  void publish();
  const timer = setInterval(() => void publish(), PUBLISH_EVERY_MS);
  timer.unref();
  return {
    concurrency: env.CHESS_RUN_CONCURRENCY,
    poolSize,
    stop: () => clearInterval(timer),
  };
}
