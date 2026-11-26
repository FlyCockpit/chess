import prisma from "@cockpit-chess/db";

/**
 * One heartbeat for every hosted match this worker process runs, instead of one
 * timer and one UPDATE per match: with hundreds of concurrent matches that would be
 * hundreds of writes a second. Every 2 s a single compare-and-set UPDATE refreshes
 * `heartbeatAt` for all claims still `running` under their own run token (the
 * stale-run reconcile reads it), and, for matches paid with the owner's own key, a
 * single read checks that each owner's connection is still the one the run loaded.
 *
 * Per claim, the outcomes are the ones the per-match timer had:
 *   - `lost`: the row is no longer running under this token (stopped, reconciled);
 *   - `revoked`: the owner disconnected, reconnected another key, or the key was
 *     marked invalid; the run stops with the credential-revoked ending;
 *   - `failing`: three consecutive ticks failed (the database is unreachable), so the
 *     run cannot prove it still owns the row and stops as interrupted.
 */
const INTERVAL_MS = 2000;
const FAILURES_BEFORE_ABORT = 3;

export interface HeartbeatClaim {
  matchId: string;
  runToken: string;
  /** Set for owner-key matches: the owner and the hash of the key the run loaded. */
  ownerKey?: { userId: string; keyHash: string };
  onLost: () => void;
  onRevoked: () => void;
  onFailing: () => void;
}

const claims = new Set<HeartbeatClaim>();
let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;
let failures = 0;

/** Matches this process is running now (the admin capacity view). */
export function runningChessMatches() {
  return claims.size;
}

async function tick() {
  if (ticking || !claims.size) return;
  ticking = true;
  const current = [...claims];
  try {
    const result = await prisma.chessMatch.updateMany({
      where: {
        status: "running",
        OR: current.map((claim) => ({ id: claim.matchId, runToken: claim.runToken })),
      },
      data: { heartbeatAt: new Date() },
    });
    let lost: HeartbeatClaim[] = [];
    if (result.count === 0) lost = current;
    else if (result.count < current.length) {
      // pagination:audited — bounded by this process's claims (CHESS_RUN_CONCURRENCY).
      const owned = await prisma.chessMatch.findMany({
        where: {
          status: "running",
          OR: current.map((claim) => ({ id: claim.matchId, runToken: claim.runToken })),
        },
        select: { id: true, runToken: true },
      });
      const alive = new Set(owned.map((row) => `${row.id}:${row.runToken}`));
      lost = current.filter((claim) => !alive.has(`${claim.matchId}:${claim.runToken}`));
    }
    const keyed = current.filter((claim) => claim.ownerKey && !lost.includes(claim));
    let revoked: HeartbeatClaim[] = [];
    if (keyed.length) {
      // pagination:audited — bounded by this process's claims (CHESS_RUN_CONCURRENCY).
      const connections = await prisma.openRouterConnection.findMany({
        where: { userId: { in: [...new Set(keyed.map((claim) => claim.ownerKey?.userId ?? ""))] } },
        select: { userId: true, keyHash: true, status: true },
      });
      const active = new Map(
        connections
          .filter((connection) => connection.status === "active")
          .map((connection) => [connection.userId, connection.keyHash]),
      );
      revoked = keyed.filter(
        (claim) => claim.ownerKey && active.get(claim.ownerKey.userId) !== claim.ownerKey.keyHash,
      );
    }
    failures = 0;
    for (const claim of lost) claim.onLost();
    for (const claim of revoked) claim.onRevoked();
  } catch {
    failures += 1;
    if (failures >= FAILURES_BEFORE_ABORT) for (const claim of current) claim.onFailing();
  } finally {
    ticking = false;
  }
}

/** Joins the shared heartbeat; the returned function leaves it. */
export function registerHeartbeat(claim: HeartbeatClaim) {
  claims.add(claim);
  timer ??= setInterval(() => void tick(), INTERVAL_MS);
  return () => {
    claims.delete(claim);
    if (!claims.size && timer) {
      clearInterval(timer);
      timer = undefined;
      failures = 0;
    }
  };
}
