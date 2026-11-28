import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { type BackendFactory, createRedisBackend, type RedisQueueBackend } from "bullmq";
import { addDelayedJob } from "bullmq/dist/esm/scripts/addDelayedJob-6.js";
import { addParentJob } from "bullmq/dist/esm/scripts/addParentJob-6.js";
import { addPrioritizedJob } from "bullmq/dist/esm/scripts/addPrioritizedJob-9.js";
import { addStandardJob } from "bullmq/dist/esm/scripts/addStandardJob-9.js";
import { reprocessJob } from "bullmq/dist/esm/scripts/reprocessJob-9.js";
import { updateData } from "bullmq/dist/esm/scripts/updateData-1.js";

export const chessJobRegistryKey = (matchId: string) => `cockpit-chess:match-jobs:${matchId}`;
/** Minimal purpose-bound retirement fence; no raw account or match identity. */
export const chessJobEpochKey = (matchId: string) =>
  `cockpit-chess:work-epoch:${createHash("sha256").update("chess-job-retirement:v1:").update(matchId).digest("hex")}`;

type Publication = { matchId: string; epoch: string; entry: string };
const publication = new AsyncLocalStorage<Publication>();
export const withChessPublication = <T>(context: Publication, run: () => Promise<T>) =>
  publication.run(context, run);

const commands = new Map(
  [addDelayedJob, addParentJob, addPrioritizedJob, addStandardJob, reprocessJob, updateData].map(
    (script) => [script.name, script],
  ),
);

/**
 * The guard and BullMQ's pinned Lua are ONE Redis operation. Client timeout,
 * offline replay and process suspension cannot bypass a retirement epoch.
 * Remove the guard-only KEYS/ARGV before running the unchanged BullMQ script.
 */
export const CHESS_PUBLICATION_GUARD = `
local registry = table.remove(KEYS)
local epochKey = table.remove(KEYS)
local entry = table.remove(ARGV)
local epoch = table.remove(ARGV)
if redis.call('GET', epochKey) ~= epoch then
  return redis.error_reply('Chess job publication retired')
end
if redis.call('SISMEMBER', registry, entry) == 0 and redis.call('SCARD', registry) >= 4096 then
  return redis.error_reply('Chess job registry full')
end
redis.call('SADD', registry, entry)
`;

/** Use BullMQ's backend extension seam only for the two chess producer queues. */
export const createChessJobBackend: BackendFactory<RedisQueueBackend> = (...args) => {
  const backend = createRedisBackend(...args);
  const original = backend.execCommand.bind(backend);
  backend.execCommand = (client, command, values: unknown[]) => {
    const context = publication.getStore();
    const script = commands.get(command);
    if (!context || !script) return original(client, command, values);
    if (!("defineCommand" in client))
      throw new Error("Chess job publication does not support batched mutations");
    const guarded = `cockpit-chess-retirement-v1:${command}`;
    client.defineCommand(guarded, {
      numberOfKeys: script.keys + 2,
      lua: CHESS_PUBLICATION_GUARD + script.content,
    });
    return client.runCommand(guarded, [
      ...values.slice(0, script.keys),
      chessJobEpochKey(context.matchId),
      chessJobRegistryKey(context.matchId),
      ...values.slice(script.keys),
      context.epoch,
      context.entry,
    ]);
  };
  return backend;
};
