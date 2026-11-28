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
const QUERY_DEADLINE_MS = 4000;
// Three failures abort as before; one extra tick allows a successful third retry
// to settle, while a hung query still loses authority within eight seconds.
const OWNERSHIP_FENCE_MS = INTERVAL_MS * (FAILURES_BEFORE_ABORT + 1);

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
const confirmed = new Map<HeartbeatClaim, { wall: number; mono: number }>();
let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;
let failures = 0;

/** Matches this process is running now (the admin capacity view). */
export function runningChessMatches() {
  return claims.size;
}

/** Read ownership only; a timed-out result must never mutate local authority. */
async function checkClaims(current: HeartbeatClaim[]) {
  const result = await prisma.chessMatch.updateMany({
    where: {
      source: "hosted",
      status: "running",
      Owner: { deletionRequestedAt: null },
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
        source: "hosted",
        status: "running",
        Owner: { deletionRequestedAt: null },
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
  return { lost, revoked };
}

function fail(claim: HeartbeatClaim) {
  confirmed.delete(claim);
  claim.onFailing();
}

async function tick() {
  // Run even when the previous database call is hung. The synchronous request
  // guard also covers suspended processes before their timers can catch up.
  for (const claim of claims) if (confirmed.has(claim) && !isFresh(claim)) fail(claim);
  if (ticking) return;
  const current = [...claims].filter((claim) => confirmed.has(claim));
  if (!current.length) return;
  ticking = true;
  const sent = { wall: Date.now(), mono: performance.now() };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const { lost, revoked } = await Promise.race([
      checkClaims(current),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Heartbeat timed out")), QUERY_DEADLINE_MS);
      }),
    ]);
    failures = 0;
    for (const claim of current)
      if (
        claims.has(claim) &&
        confirmed.has(claim) &&
        !lost.includes(claim) &&
        !revoked.includes(claim)
      )
        confirmed.set(claim, sent);
    for (const claim of lost) {
      if (!claims.has(claim) || !confirmed.has(claim)) continue;
      confirmed.delete(claim);
      claim.onLost();
    }
    for (const claim of revoked) {
      if (!claims.has(claim) || !confirmed.has(claim)) continue;
      confirmed.delete(claim);
      claim.onRevoked();
    }
  } catch {
    failures += 1;
    if (failures >= FAILURES_BEFORE_ABORT)
      for (const claim of current) if (claims.has(claim) && confirmed.has(claim)) fail(claim);
  } finally {
    if (deadline) clearTimeout(deadline);
    ticking = false;
  }
}

function isFresh(claim: HeartbeatClaim) {
  const last = confirmed.get(claim);
  return (
    last !== undefined &&
    Math.max(Date.now() - last.wall, performance.now() - last.mono) < OWNERSHIP_FENCE_MS
  );
}

/** Joins the shared heartbeat; the returned function leaves it. */
export function registerHeartbeat(claim: HeartbeatClaim) {
  claims.add(claim);
  confirmed.set(claim, { wall: Date.now(), mono: performance.now() });
  timer ??= setInterval(() => void tick(), INTERVAL_MS);
  const leave = () => {
    claims.delete(claim);
    confirmed.delete(claim);
    if (!claims.size && timer) {
      clearInterval(timer);
      timer = undefined;
      failures = 0;
    }
  };
  return Object.assign(leave, {
    /** Synchronous guard used for every actual provider request, including retries. */
    assertUsable() {
      if (isFresh(claim)) return;
      if (confirmed.has(claim)) fail(claim);
      throw new Error("Hosted match ownership could not be confirmed");
    },
  });
}
