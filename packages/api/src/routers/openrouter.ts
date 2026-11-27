import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import prisma, { type Prisma } from "@cockpit-chess/db";
import { redisConnection } from "@cockpit-chess/queue";
import {
  CHESS_KEY_LEASE_FENCE_MS,
  chessKeyLeasesBlocking,
  holdChessKeyLease,
  publishChessKeyRevocation,
  recordChessKeyRevoked,
  releaseChessKeyLease,
} from "@cockpit-chess/queue/chess-key-revocation";
import { ORPCError } from "@orpc/server";
import { checkAdminAuthority, protectedProcedure } from "../index";
import { CHESS_CREATE_LOCK } from "../lib/chess-locks";
import { CREDENTIAL_REVOKED_ENDING } from "../lib/chess-stats";
import {
  fetchOpenRouterKeyInfo,
  OpenRouterAccountError,
  type OpenRouterKeyInfo,
  ownOpenRouterAvailable,
} from "../lib/openrouter-account";
import { createProcedureBudget } from "../lib/procedure-budget";
import { markOpenRouterKeyInvalid, openOwnerOpenRouterKey } from "../lib/provider-key";

/**
 * The caller's own OpenRouter connection (Settings → OpenRouter). Connecting is the
 * OAuth flow in apps/server/src/openrouter-routes.ts; these procedures only read and
 * delete the caller's row. Nothing here returns the key or its ciphertext: the label,
 * last four characters, the key's SHA-256 (for OpenRouter's own key page) and
 * OpenRouter's numbers for it.
 */

const LIVE_TTL_MS = 60_000;
const LIVE_CACHE_MAX = 2000;
type Live = {
  at: number;
  info: OpenRouterKeyInfo | null;
  rejected: boolean;
  /** This server cannot open the stored key (a sealing secret it does not hold). */
  unreadable: boolean;
};
/**
 * Per process, keyed by user and key hash: at most one `GET /api/v1/key` per user per
 * minute however often the settings page or create form polls. Failures are cached
 * too, so an OpenRouter outage is not retried on every read.
 */
const liveCache = new Map<string, Live>();
/** Reads in progress, so concurrent cold reads (one RPC batch, many tabs) share one call. */
const liveInFlight = new Map<string, Promise<Live>>();
export function resetOpenRouterStatusCache() {
  liveCache.clear();
  liveInFlight.clear();
}

function liveInfo(userId: string, keyHash: string): Promise<Live> {
  const cacheKey = `${userId}:${keyHash}`;
  const cached = liveCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return Promise.resolve(cached);
  const pending = liveInFlight.get(cacheKey);
  if (pending) return pending;
  const read = readLiveInfo(userId, keyHash).finally(() => liveInFlight.delete(cacheKey));
  liveInFlight.set(cacheKey, read);
  return read;
}

async function readLiveInfo(userId: string, keyHash: string): Promise<Live> {
  const cacheKey = `${userId}:${keyHash}`;
  let info: OpenRouterKeyInfo | null = null;
  let rejected = false;
  let unreadable = false;
  // A key-use lease, taken before the row is read, makes a concurrent Disconnect wait
  // for this call (or makes this read find no row). No lease, no call; and the call
  // is cut off before the lease could run out.
  const holder = randomUUID();
  const leasedAt = Date.now();
  const leased = await holdChessKeyLease(redisConnection, userId, holder).then(
    () => true,
    () => false,
  );
  try {
    // Released below in every case: a take that failed may still have been applied.
    const key = leased ? await openOwnerOpenRouterKey(userId) : ({ state: "none" } as const);
    const left = leasedAt + CHESS_KEY_LEASE_FENCE_MS - Date.now();
    if (key.state === "ok" && key.keyHash === keyHash && left > 1000) {
      try {
        info = await fetchOpenRouterKeyInfo(key.apiKey, fetch, AbortSignal.timeout(left));
      } catch (error) {
        if (error instanceof OpenRouterAccountError && error.code === "rejected") {
          rejected = true;
          await markOpenRouterKeyInvalid(userId, keyHash);
        }
      }
    } else if (
      (key.state === "unreadable" || key.state === "inactive") &&
      key.keyHash === keyHash
    ) {
      // This server cannot open the stored key (sealed by a secret it does not hold, or
      // broken and marked invalid by the read): the user must reconnect, not wait for an
      // outage to pass. A row sealed by an unknown secret is left active for replicas
      // that still hold it.
      rejected = true;
      unreadable = key.state === "unreadable";
    }
  } finally {
    await releaseChessKeyLease(redisConnection, userId, holder, null).catch(() => undefined);
  }
  const entry = { at: Date.now(), info, rejected, unreadable };
  liveCache.delete(cacheKey);
  liveCache.set(cacheKey, entry);
  while (liveCache.size > LIVE_CACHE_MAX) {
    const oldest = liveCache.keys().next().value;
    if (oldest === undefined) break;
    liveCache.delete(oldest);
  }
  return entry;
}

/** Disconnect answers within this, from its start, whatever it waits on. */
const DISCONNECT_DEADLINE_MS = 10_000;
const STOP_POLL_MS = 100;
/**
 * Starts `work` only while time is left and resolves undefined once `deadline`
 * passes, so a stalled call never holds Disconnect. A started call is always observed.
 */
function within<T>(work: () => Promise<T>, deadline: number): Promise<T | undefined> {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.resolve(undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work().catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), left);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Broadcasts the revoked hashes and waits until the user has no live key-use lease
 * that is loading or on a revoked key: every run on it aborted and dropped its lease
 * (or its lease ran out, which its holder never outlives), and no status read is
 * holding the key. "none" when nothing held it from the start.
 */
async function stopKeyUse(
  userId: string,
  keyHashes: string[],
  connectedKeyHash: string | null,
  deadline: number,
): Promise<"none" | "stopped" | "pending"> {
  const published = await within(
    () => publishChessKeyRevocation(redisConnection, { userId, keyHashes }).then(() => true),
    deadline,
  );
  if (!published) return "pending";
  for (let first = true; ; first = false) {
    const blocking = await within(
      () => chessKeyLeasesBlocking(redisConnection, userId, keyHashes, connectedKeyHash),
      deadline,
    );
    if (blocking === false) return first ? "none" : "stopped";
    if (Date.now() + STOP_POLL_MS >= deadline) return "pending";
    await delay(STOP_POLL_MS);
  }
}

const disconnectBudget = createProcedureBudget({
  keyPrefix: "rl:openrouter-disconnect",
  points: 20,
  durationSeconds: 600,
  // Disconnecting is how a user stops spending: never refuse it for a Valkey outage
  // (the call itself then answers that it could not confirm the stop).
  failClosed: false,
  overBudgetMessage: (seconds) => `Too many disconnects. Try again in ${seconds} seconds.`,
  unavailableMessage: "Disconnect is unavailable right now. Try again.",
  unavailableLog: "[openrouter] disconnect budget unavailable; allowing",
});

const statusSelect = {
  keyHash: true,
  keyHint: true,
  label: true,
  limitMicros: true,
  expiresAt: true,
  status: true,
  createdAt: true,
} satisfies Prisma.OpenRouterConnectionSelect;

export const openrouterRouter = {
  status: protectedProcedure.handler(async ({ context }) => {
    const userId = context.session.user.id;
    const admin = (await checkAdminAuthority(context.session, context.credential)).ok;
    const available = ownOpenRouterAvailable(admin);
    const row = await prisma.openRouterConnection.findUnique({
      where: { userId },
      select: statusSelect,
    });
    if (!row) return { available, connected: false as const };
    const live = row.status === "active" && available ? await liveInfo(userId, row.keyHash) : null;
    const info = live?.info ?? null;
    // A key the live check just refused reads as invalid at once.
    const status = live?.rejected ? "invalid" : row.status;
    const expiresAt = info?.expiresAt ?? row.expiresAt;
    const expired = expiresAt !== null && expiresAt.getTime() <= Date.now();
    return {
      available,
      connected: true as const,
      status: status === "active" && !expired ? ("active" as const) : ("invalid" as const),
      /**
       * Why an invalid key is invalid: "unreadable" when this server cannot open it (its
       * CHESS_PROVIDER_KEY_SECRET changed), so the operator can be pointed at the
       * secret; "rejected" otherwise (revoked, expired or out of credits). Null when active.
       */
      invalidReason:
        status === "active" && !expired
          ? null
          : live?.unreadable
            ? ("unreadable" as const)
            : ("rejected" as const),
      label: info?.label ?? row.label,
      keyHint: row.keyHint,
      keyHash: row.keyHash,
      limitMicros: info
        ? info.limitMicros
        : row.limitMicros === null
          ? null
          : Number(row.limitMicros),
      limitRemainingMicros: info?.limitRemainingMicros ?? null,
      usageMicros: info?.usageMicros ?? null,
      usageDailyMicros: info?.usageDailyMicros ?? null,
      expiresAt: expiresAt?.toISOString() ?? null,
      connectedAt: row.createdAt.toISOString(),
      /** False when OpenRouter's numbers could not be read just now (stored values shown). */
      live: info !== null,
    };
  }),
  /**
   * Forgets the caller's key here and stops every use of it before answering. It stays
   * valid on OpenRouter until the user revokes it there (`keyHash` links to its page).
   *
   * Records the key's hash as revoked (packages/queue chess-key-revocation), deletes
   * that exact row (a key connected meanwhile in another tab stays), cancels the
   * caller's queued own-key matches unless another key is connected, then broadcasts
   * the revoked hashes and waits until no key-use lease of the caller is loading or on
   * a key other than the one still connected (so a lost revoked list still waits). `stopped`: "none" (nothing was using it), "stopped" (every use ended:
   * no further provider request leaves with the key), or "pending" (not confirmed
   * within 10 s of the call: a worker missed the message or Valkey is slow; the
   * holder's own lease fence and the heartbeat's disconnect check still end it, and
   * the user should revoke the key on OpenRouter). Calling it again repeats the
   * broadcast and the wait for every recently revoked key.
   */
  disconnect: protectedProcedure.handler(async ({ context }) => {
    const userId = context.session.user.id;
    const deadline = Date.now() + DISCONNECT_DEADLINE_MS;
    // Over budget rejects at once; a slow limiter is not waited on (it fails open).
    const budget = disconnectBudget(userId);
    budget.catch(() => undefined);
    await Promise.race([budget, delay(1000)]);
    const unavailable = () =>
      new ORPCError("SERVICE_UNAVAILABLE", {
        message: "Couldn't disconnect right now. Try again.",
      });
    // Everything before the wait gets at most half the deadline; a transaction that runs
    // out rolls back (nothing deleted) and the user tries again.
    const transaction = prisma.$transaction(
      async (tx) => {
        // The create lock: no own-key match is queued for this user after the cancel
        // below (create re-checks the connection under it).
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${CHESS_CREATE_LOCK}))::text AS locked`;
        const found = await tx.openRouterConnection.findUnique({
          where: { userId },
          select: { keyHash: true },
        });
        // Lock before making revocation visible outside this transaction. Otherwise
        // a worker can observe Redis revocation and settle an account error while
        // Disconnect is still trying to acquire the row for owner withdrawal.
        // pagination:audited — admission permits one active own-key match per owner;
        // lock any surviving active rows, without returning match data to the caller.
        await tx.$queryRaw`SELECT "id" FROM "chess_match"
          WHERE "ownerId" = ${userId} AND "credentialSource" = 'owner-openrouter'
            AND "status" IN ('queued', 'running')
          ORDER BY "id" FOR UPDATE`;
        // Revoked before the row goes: a run that loaded the key before the delete
        // commits finds it on this list. Without the list nothing is deleted.
        const recorded = await within(
          () => recordChessKeyRevoked(redisConnection, userId, found?.keyHash ?? null),
          Math.min(deadline, Date.now() + 2000),
        );
        if (!recorded) throw unavailable();
        // That exact key: one connected meanwhile (another tab's callback) stays.
        if (found)
          await tx.openRouterConnection.deleteMany({ where: { userId, keyHash: found.keyHash } });
        const after = await tx.openRouterConnection.findUnique({
          where: { userId },
          select: { keyHash: true },
        });
        // Disconnect is an owner withdrawal, including running starts. Clear the
        // claim now so a late provider reply cannot replace the durable withdrawal.
        // Key-use leases below still determine when the stop can be confirmed.
        if (!after)
          await tx.chessMatch.updateMany({
            where: {
              ownerId: userId,
              credentialSource: "owner-openrouter",
              status: { in: ["queued", "running"] },
            },
            data: {
              status: "error",
              runToken: null,
              ending: CREDENTIAL_REVOKED_ENDING,
              terminalCause: "owner-disconnect",
            },
          });
        return { found, revoked: recorded, connected: after?.keyHash ?? null };
      },
      { maxWait: DISCONNECT_DEADLINE_MS / 4, timeout: DISCONNECT_DEADLINE_MS / 2 },
    );
    transaction.catch(() => undefined);
    // A database that stalls past half the deadline leaves the outcome unknown: say so
    // (trying again repeats everything) instead of hanging.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const row = await Promise.race([
      transaction,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(unavailable()), DISCONNECT_DEADLINE_MS / 2 + 500);
      }),
    ])
      .catch((error: unknown) => {
        throw error instanceof ORPCError ? error : unavailable();
      })
      .finally(() => clearTimeout(timer));
    if (row.found) liveCache.delete(`${userId}:${row.found.keyHash}`);
    const stopped = await stopKeyUse(userId, row.revoked, row.connected, deadline);
    return { disconnected: true as const, keyHash: row.found?.keyHash ?? null, stopped };
  }),
};
