import prisma, { type Prisma } from "@cockpit-chess/db";
import { checkAdminAuthority, protectedProcedure } from "../index";
import {
  fetchOpenRouterKeyInfo,
  OpenRouterAccountError,
  type OpenRouterKeyInfo,
  ownOpenRouterAvailable,
} from "../lib/openrouter-account";
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
type Live = { at: number; info: OpenRouterKeyInfo | null; rejected: boolean };
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
  const key = await openOwnerOpenRouterKey(userId);
  if (key.state === "ok" && key.keyHash === keyHash) {
    try {
      info = await fetchOpenRouterKeyInfo(key.apiKey);
    } catch (error) {
      if (error instanceof OpenRouterAccountError && error.code === "rejected") {
        rejected = true;
        await markOpenRouterKeyInvalid(userId, keyHash);
      }
    }
  } else if ((key.state === "unreadable" || key.state === "inactive") && key.keyHash === keyHash) {
    // This server cannot open the stored key (sealed by a secret it does not hold, or
    // broken and marked invalid by the read): the user must reconnect, not wait for an
    // outage to pass. A row sealed by an unknown secret is left active for replicas
    // that still hold it.
    rejected = true;
  }
  const entry = { at: Date.now(), info, rejected };
  liveCache.delete(cacheKey);
  liveCache.set(cacheKey, entry);
  while (liveCache.size > LIVE_CACHE_MAX) {
    const oldest = liveCache.keys().next().value;
    if (oldest === undefined) break;
    liveCache.delete(oldest);
  }
  return entry;
}

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
   * Forgets the caller's key here. It stays valid on OpenRouter until the user revokes
   * it there (`keyHash` links to its page); a running match on it stops at its next
   * heartbeat.
   */
  disconnect: protectedProcedure.handler(async ({ context }) => {
    const userId = context.session.user.id;
    const row = await prisma.openRouterConnection.findUnique({
      where: { userId },
      select: { keyHash: true },
    });
    await prisma.openRouterConnection.deleteMany({ where: { userId } });
    if (row) liveCache.delete(`${userId}:${row.keyHash}`);
    return { disconnected: true as const, keyHash: row?.keyHash ?? null };
  }),
};
