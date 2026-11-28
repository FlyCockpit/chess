import { randomUUID } from "node:crypto";
import {
  chessJobEpochKey,
  chessJobRegistryKey,
  withChessPublication,
} from "./chess-job-publication.js";
import { redisConnection } from "./connection.js";
import { ensureRunnableJob } from "./ensure-job.js";
import { chessReconcileQueue, chessRunQueue } from "./index.js";

type Surface = "run" | "spectator";
const registryKey = chessJobRegistryKey;
const queues = { run: chessRunQueue, spectator: chessReconcileQueue };
const REGISTER = `
  if redis.call('GET', KEYS[2]) ~= ARGV[2] then return -1 end
  if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 1 end
  if redis.call('SCARD', KEYS[1]) >= 4096 then return 0 end
  redis.call('SADD', KEYS[1], ARGV[1])
  return 1`;

async function publicationEpoch(matchId: string) {
  const key = chessJobEpochKey(matchId);
  await redisConnection.set(key, randomUUID(), "NX");
  const epoch = await redisConnection.get(key);
  if (!epoch) throw new Error("Match publication epoch unavailable");
  return epoch;
}

/** Filter only exact indexed job IDs, without copying other users' event data. */
const ERASE_EVENT_PAGE = `
local ending = ARGV[2]
if ending == '' then
  local tail = redis.call('XREVRANGE', KEYS[1], '+', '-', 'COUNT', 1)
  if #tail == 0 then return {'', '', 0} end
  ending = tail[1][1]
end
local wanted = {}
for i = 3, #ARGV do wanted[ARGV[i]] = true end
local rows = redis.call('XRANGE', KEYS[1], ARGV[1], ending, 'COUNT', 512)
local last = ''
for _, row in ipairs(rows) do
  last = row[1]
  local fields = row[2]
  for i = 1, #fields, 2 do
    if fields[i] == 'jobId' and wanted[fields[i + 1]] then
      redis.call('XDEL', KEYS[1], row[1])
      break
    end
  end
end
return {last, ending, #rows}`;

async function purgeJobEvents(
  surface: Surface,
  ids: string[],
  deadline: number,
  assertFresh: () => void,
) {
  if (ids.length === 0) return true;
  let cursor = "-";
  let ending = "";
  // BullMQ bounds its event stream to ~10,000 entries. This also refuses an
  // unexpectedly unbounded stream instead of declaring partial erasure done.
  for (let page = 0; page < 64; page++) {
    assertFresh();
    if (performance.now() >= deadline) return false;
    const result = await redisConnection.eval(
      ERASE_EVENT_PAGE,
      1,
      queues[surface].toKey("events"),
      cursor,
      ending,
      ...ids,
    );
    if (
      !Array.isArray(result) ||
      result.length !== 3 ||
      typeof result[0] !== "string" ||
      typeof result[1] !== "string" ||
      typeof result[2] !== "number" ||
      result[2] < 0 ||
      result[2] > 512
    )
      throw new Error("Job event erasure cannot be confirmed");
    if (result[2] < 512 || result[0] === result[1]) return true;
    ending = result[1];
    cursor = `(${result[0]}`;
  }
  return false;
}

/** Index before publication; the owner's credential lock excludes deletion. */
export async function registerChessJob(
  matchId: string,
  surface: Surface,
  jobId: string,
  expectedEpoch?: string,
) {
  const epoch = expectedEpoch ?? (await publicationEpoch(matchId));
  const registered = await redisConnection.eval(
    REGISTER,
    2,
    registryKey(matchId),
    chessJobEpochKey(matchId),
    `${surface}|${jobId}`,
    epoch,
  );
  if (registered !== 1)
    throw new Error(
      registered === -1 ? "Match job publication retired" : "Match job registry is full",
    );
}

/**
 * Every mutating Redis call rechecks the caller's bounded owner-lock lifetime.
 * Queue producers use the shared five-second command timeout; callers reserve
 * more than that much time between this deadline and transaction expiry.
 */
export async function publishRegisteredChessJob<Data>(
  matchId: string,
  surface: Surface,
  name: string,
  data: Data,
  jobId: string,
  assertFresh: () => void,
  options: { priority?: number } = {},
) {
  assertFresh();
  const epoch = await publicationEpoch(matchId);
  assertFresh();
  return withChessPublication({ matchId, epoch, entry: `${surface}|${jobId}` }, async () => {
    // Index live/retained jobs too, even if ensure needs no mutating command.
    // An owned publisher holds the credential lock until this callback returns.
    await registerChessJob(matchId, surface, jobId, epoch);
    return ensureRunnableJob(queues[surface], name, data, jobId, {
      ...options,
      beforeWrite: assertFresh,
    });
  });
}

/**
 * Remove one bounded page of jobs and their retained results. Unknown state,
 * active work, Redis failure and a concurrent claim can never mean completion.
 * Caller holds the owner's credential lock, preventing further publication.
 */
export async function purgeChessJobs(
  matchId: string,
  assertFresh: () => void = () => {},
): Promise<boolean> {
  const key = registryKey(matchId);
  const deadline = performance.now() + 10_000;
  assertFresh();
  // Invalidate every previously admitted write at its actual Redis execution
  // boundary, including commands whose client already reported a timeout.
  await redisConnection.set(chessJobEpochKey(matchId), randomUUID());
  const entries = await redisConnection.srandmember(key, 10);
  const cleared: Array<{ entry: string; surface: Surface; jobId: string }> = [];
  for (const entry of entries) {
    if (performance.now() >= deadline) return false;
    assertFresh();
    const separator = entry.indexOf("|");
    const surface = entry.slice(0, separator);
    const jobId = entry.slice(separator + 1);
    if ((surface !== "run" && surface !== "spectator") || !jobId)
      throw new Error("Invalid match job registry entry");
    const job = await queues[surface].getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === "active" || state === "unknown") continue;
      try {
        assertFresh();
        if (performance.now() >= deadline) return false;
        await job.remove();
      } catch {
        // A worker may have claimed between getState and remove. Keep its
        // registry entry until a later cleanup can prove the job is gone.
        continue;
      }
    }
    cleared.push({ entry, surface, jobId });
  }
  // Completed/failed/remove events can contain private results or owner IDs.
  // Keep the index until BOTH the job and all its retained events are gone.
  for (const surface of ["run", "spectator"] as const)
    if (
      !(await purgeJobEvents(
        surface,
        cleared.filter((job) => job.surface === surface).map((job) => job.jobId),
        deadline,
        assertFresh,
      ))
    )
      return false;
  for (const job of cleared) {
    assertFresh();
    if (performance.now() >= deadline) return false;
    await redisConnection.srem(key, job.entry);
  }
  return (await redisConnection.scard(key)) === 0;
}
