import {
  CHESS_KEY_LEASE_FENCE_MS,
  CHESS_KEY_REVOCATION_CHANNEL,
  type ChessKeyRevocation,
  holdChessKeyLease,
  isChessKeyRevoked,
  parseChessKeyRevocation,
  releaseChessKeyLease,
} from "@cockpit-chess/queue/chess-key-revocation";
import type IORedis from "ioredis";

/**
 * This process's side of an OpenRouter Disconnect (packages/queue chess-key-revocation).
 *
 * Every own-key run holds a key-use lease from right after its claim, before it loads
 * the key, until it ends. The lease is refreshed every few seconds; a run whose lease
 * could not be refreshed for CHESS_KEY_LEASE_FENCE_MS is aborted (interrupted) before
 * the lease can run out, so Disconnect never mistakes a live run for an ended one.
 *
 * A revocation naming the run's key aborts it synchronously (its abort signal fires,
 * so no further provider request can leave with the key) and only then drops its
 * lease. One that arrives while the key is still loading is applied when it loads, and
 * after loading the run also checks the revoked list itself, for a message it missed.
 */
const REFRESH_MS = 2500;
/** Distinct hashes revoked while one run's key loads, beyond which it just stops. */
const PENDING_MAX = 50;

interface Run {
  matchId: string;
  userId: string;
  /** undefined: still loading; null: holds no key. */
  keyHash: string | null | undefined;
  /** Hashes revoked while the key was loading. */
  pending: Set<string>;
  /** When the last successful take/refresh was sent: wall clock and monotonic. */
  leasedAt: number;
  leasedAtMono: number;
  revoke: () => void;
  fence: () => void;
  ended: boolean;
}

const runs = new Set<Run>();
type LeaseConnection = Pick<IORedis, "multi" | "zscore">;
let connection: LeaseConnection | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

const release = (run: Run) => {
  if (!connection) return;
  void releaseChessKeyLease(connection, run.userId, run.matchId, run.keyHash ?? null).catch(
    () => undefined,
  );
};

/** Ends a run's use of the key: abort first (synchronously), then drop its lease. */
function revokeRun(run: Run) {
  if (run.ended) return;
  run.ended = true;
  runs.delete(run);
  run.revoke();
  release(run);
}

function fenceRun(run: Run) {
  if (run.ended) return;
  run.ended = true;
  runs.delete(run);
  run.fence();
  release(run);
}

/**
 * Time since the run's last successful take/refresh, by whichever clock says longer
 * (the wall clock keeps running through a host suspend, the monotonic one through a
 * clock step back).
 */
const leaseAge = (run: Run) =>
  Math.max(Date.now() - run.leasedAt, performance.now() - run.leasedAtMono);

function leased(run: Run, sentAt: number, sentAtMono: number) {
  if (run.ended) return;
  if (sentAt > run.leasedAt) run.leasedAt = sentAt;
  if (sentAtMono > run.leasedAtMono) run.leasedAtMono = sentAtMono;
}

async function refresh() {
  for (const run of [...runs]) {
    if (leaseAge(run) >= CHESS_KEY_LEASE_FENCE_MS - REFRESH_MS) {
      fenceRun(run);
      continue;
    }
    if (!connection) continue;
    const sentAt = Date.now();
    const sentAtMono = performance.now();
    holdChessKeyLease(connection, run.userId, run.matchId, run.keyHash ?? null).then(
      () => leased(run, sentAt, sentAtMono),
      () => undefined,
    );
  }
}

/** Applies one revocation message (exported for tests; the subscriber calls it). */
export function applyChessKeyRevocation(revocation: ChessKeyRevocation) {
  const revoked = new Set(revocation.keyHashes);
  for (const run of [...runs]) {
    if (run.userId !== revocation.userId) continue;
    if (run.keyHash === undefined) {
      for (const hash of revoked) run.pending.add(hash);
      if (run.pending.size > PENDING_MAX) fenceRun(run);
    } else if (run.keyHash !== null && revoked.has(run.keyHash)) revokeRun(run);
  }
}

/**
 * Starts an own-key run's lease. Rejects (nothing to clean up) when it cannot be taken:
 * the run must not load the key then. `revoke` aborts the run as credential-revoked,
 * `fence` as interrupted.
 */
export async function leaseOwnerKeyRun(input: {
  matchId: string;
  userId: string;
  revoke: () => void;
  fence: () => void;
}) {
  const lease = connection;
  if (!lease) throw new Error("Key revocations are not running");
  const run: Run = {
    ...input,
    keyHash: undefined,
    pending: new Set(),
    leasedAt: Date.now(),
    leasedAtMono: performance.now(),
    ended: false,
  };
  // Listed before the lease exists: a revocation published once Disconnect can see the
  // lease is applied to this run from then on.
  runs.add(run);
  timer ??= setInterval(() => void refresh(), REFRESH_MS);
  try {
    const sentAt = Date.now();
    const sentAtMono = performance.now();
    await holdChessKeyLease(lease, run.userId, run.matchId);
    leased(run, sentAt, sentAtMono);
  } catch (error) {
    run.ended = true;
    runs.delete(run);
    release(run);
    throw error;
  }
  return {
    /**
     * Call synchronously after the key load returns, with its hash (or null: no key).
     * Resolves once the lease is on that key and the revoked list was checked.
     */
    async loaded(keyHash: string | null) {
      if (run.ended || run.keyHash !== undefined) return;
      run.keyHash = keyHash;
      const pending = run.pending;
      run.pending = new Set();
      if (keyHash === null) {
        // Holds no key: nothing to lease or to revoke.
        run.ended = true;
        runs.delete(run);
        release(run);
        return;
      }
      if (pending.has(keyHash)) return revokeRun(run);
      try {
        const sentAt = Date.now();
        const sentAtMono = performance.now();
        await holdChessKeyLease(lease, run.userId, run.matchId, keyHash);
        leased(run, sentAt, sentAtMono);
        if (await isChessKeyRevoked(lease, run.userId, keyHash)) revokeRun(run);
      } catch {
        // Cannot prove the key is still allowed: stop before using it.
        fenceRun(run);
      }
    },
    /**
     * The provider dispatch boundary (`beforeDispatch`): throws, and stops the run, once
     * the lease may have run out (a stalled process whose refresh timer has not fired
     * yet) or the run was revoked or fenced. Synchronous, so nothing is sent after it.
     */
    assertUsable() {
      if (!run.ended && leaseAge(run) >= CHESS_KEY_LEASE_FENCE_MS) fenceRun(run);
      if (run.ended) throw new Error("The OpenRouter key may no longer be used by this run");
    },
    /** The run ended: drop the lease (again, if a revoke or fence already did). */
    finish() {
      run.ended = true;
      runs.delete(run);
      release(run);
    },
  };
}

/**
 * Subscribes this process to revocations. `subscriber` becomes a dedicated subscriber
 * connection (ioredis resubscribes after a reconnect) that the caller closes; leases
 * go over `leases`.
 */
export async function startChessKeyRevocations(subscriber: IORedis, leases: LeaseConnection) {
  connection = leases;
  subscriber.on("message", (channel: string, raw: string) => {
    if (channel !== CHESS_KEY_REVOCATION_CHANNEL) return;
    const revocation = parseChessKeyRevocation(raw);
    if (revocation) applyChessKeyRevocation(revocation);
  });
  await subscriber.subscribe(CHESS_KEY_REVOCATION_CHANNEL);
}

/** Stops refreshing (runtime shutdown and tests). */
export function stopChessKeyRevocations() {
  if (timer) clearInterval(timer);
  timer = undefined;
  runs.clear();
  connection = undefined;
}

/** Test setup: the lease connection without a subscriber. */
export function resetChessKeyRevocations(leases?: LeaseConnection) {
  stopChessKeyRevocations();
  connection = leases;
}
