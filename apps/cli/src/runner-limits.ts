import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  runnerHardLimitsSchema,
  runnerLimitResultSchema,
  runnerLimitUpdateSchema,
  runnerOperatingLimitsSchema,
} from "@cockpit-chess/chess/runner-protocol";
import { z } from "zod";
import { t } from "./chess-i18n";
import { configDir } from "./paths";
import { RunnerLock } from "./runner-lock";

type RunnerHardLimits = z.infer<typeof runnerHardLimitsSchema>;
type RunnerOperatingLimits = z.infer<typeof runnerOperatingLimitsSchema>;
export type RunnerLimitUpdate = z.infer<typeof runnerLimitUpdateSchema>;
type RunnerLimitResult = z.infer<typeof runnerLimitResultSchema>;
const MAX_RECEIPTS = 128;
const MAX_BYTES = 128 * 1024;
const stateSchema = z
  .object({
    version: z.literal(1),
    operatingLimits: runnerOperatingLimitsSchema,
    stopped: z.boolean(),
    receipts: z
      .array(
        z.object({ update: runnerLimitUpdateSchema, result: runnerLimitResultSchema }).strict(),
      )
      // One final reserved receipt records the capacity refusal itself.
      .max(MAX_RECEIPTS + 1),
  })
  .strict();
export type RunnerLimitState = z.infer<typeof stateSchema>;

export interface RunnerLimitStore {
  load(): Promise<unknown | undefined>;
  save(state: RunnerLimitState): Promise<void>;
  /** File stores preallocate durable monotonic intent before exposing authority. */
  stopIntent?(): void;
  /** No event-loop yield between the final guard, unlock and release callback. */
  close(beforeRelease?: () => void, afterRelease?: () => void): Promise<void>;
}

/** A local executor adapter; no provider configuration or credentials cross this seam. */
export interface RunnerLimitPolicy {
  applyOperatingLimits(limits: RunnerHardLimits, revision: number): void;
  restoreOperatingLimits(limits: RunnerOperatingLimits): void;
  stopOperatingLimits(): void;
}

function sameLimits(left: RunnerHardLimits, right: RunnerHardLimits): boolean {
  return (
    left.matchMicros === right.matchMicros &&
    left.dayMicros === right.dayMicros &&
    left.concurrency === right.concurrency
  );
}
function sameUpdate(left: RunnerLimitUpdate, right: RunnerLimitUpdate): boolean {
  return (
    left.commandId === right.commandId &&
    left.revision === right.revision &&
    left.expectedRevision === right.expectedRevision &&
    sameLimits(left, right)
  );
}
function within(limits: RunnerHardLimits, hard: RunnerHardLimits): boolean {
  return (
    limits.matchMicros <= hard.matchMicros &&
    limits.dayMicros <= hard.dayMicros &&
    limits.concurrency <= hard.concurrency
  );
}

/** Serialized durable revisions. A lost ACK replays the receipt, never a second change. */
export class RunnerLimitController {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private released = false;
  private stopRequested: boolean;
  private constructor(
    private state: RunnerLimitState,
    private readonly hard: RunnerHardLimits,
    private readonly store: RunnerLimitStore,
    private readonly terminal: (notice: string) => void,
    private readonly policy?: RunnerLimitPolicy,
  ) {
    this.stopRequested = state.stopped;
  }

  static async open(options: {
    hard: RunnerHardLimits;
    store: RunnerLimitStore;
    terminal(notice: string): void;
    policy?: RunnerLimitPolicy;
  }): Promise<RunnerLimitController> {
    const hard = runnerHardLimitsSchema.parse(options.hard);
    let state: RunnerLimitState;
    try {
      const loaded = await options.store.load();
      state =
        loaded === undefined
          ? {
              version: 1,
              operatingLimits: {
                matchMicros: Math.min(1_000_000, hard.matchMicros),
                dayMicros: Math.min(10_000_000, hard.dayMicros),
                concurrency: Math.min(2, hard.concurrency),
                revision: 0,
              },
              stopped: false,
              receipts: [],
            }
          : stateSchema.parse(loaded);
      if (!within(state.operatingLimits, hard)) throw new Error();
      if (
        state.receipts.length > MAX_RECEIPTS &&
        (!state.stopped || state.receipts[MAX_RECEIPTS]?.result.reason !== "storage")
      )
        throw new Error();
      const ids = new Set<string>();
      for (const receipt of state.receipts) {
        if (
          ids.has(receipt.update.commandId) ||
          receipt.result.commandId !== receipt.update.commandId ||
          receipt.result.revision !== receipt.update.revision
        )
          throw new Error();
        ids.add(receipt.update.commandId);
      }
      if (state.stopped) options.policy?.stopOperatingLimits();
      else options.policy?.restoreOperatingLimits(state.operatingLimits);
      await options.store.save(state);
    } catch {
      options.policy?.stopOperatingLimits();
      await options.store.close().catch(() => {});
      throw new Error("RUNNER_LIMIT_STORAGE");
    }
    return new RunnerLimitController(
      state,
      Object.freeze(hard),
      options.store,
      options.terminal,
      options.policy,
    );
  }

  snapshot(): { operatingLimits: RunnerOperatingLimits; hardLimits: RunnerHardLimits } {
    return { operatingLimits: { ...this.state.operatingLimits }, hardLimits: { ...this.hard } };
  }

  private notice(update: RunnerLimitUpdate, result: RunnerLimitResult): void {
    this.terminal(
      t("cli.runner.limitResult", {
        defaultValue:
          "Operating limit revision {{revision}}: {{status}} ({{reason}}). Requested {{match}}/match, {{day}}/day, concurrency {{concurrency}}. Active revision {{activeRevision}}: {{activeMatch}}/match, {{activeDay}}/day, concurrency {{activeConcurrency}}. Local ceilings: {{hardMatch}}/match, {{hardDay}}/day, concurrency {{hardConcurrency}}.",
        revision: update.revision,
        status: t(`cli.runner.limitStatus.${result.status}`, {
          defaultValue: result.status === "applied" ? "applied" : "rejected",
        }),
        reason: t(`cli.runner.limitReason.${result.reason}`, {
          defaultValue: {
            applied: "confirmed locally",
            ceiling: "above the local ceiling",
            stale: "stale or conflicting revision",
            stopped: "run stopped locally",
            storage: "local storage unavailable",
          }[result.reason],
        }),
        match: `$${update.matchMicros / 1_000_000}`,
        day: `$${update.dayMicros / 1_000_000}`,
        concurrency: update.concurrency,
        activeRevision: this.state.operatingLimits.revision,
        activeMatch: `$${this.state.operatingLimits.matchMicros / 1_000_000}`,
        activeDay: `$${this.state.operatingLimits.dayMicros / 1_000_000}`,
        activeConcurrency: this.state.operatingLimits.concurrency,
        hardMatch: `$${this.hard.matchMicros / 1_000_000}`,
        hardDay: `$${this.hard.dayMicros / 1_000_000}`,
        hardConcurrency: this.hard.concurrency,
      }),
    );
  }

  async apply(input: unknown): Promise<RunnerLimitResult> {
    // Detach caller-owned objects before entering the queue.
    const update = runnerLimitUpdateSchema.parse(input);
    const task = this.tail.then(async () => {
      let reason: RunnerLimitResult["reason"] = "applied";
      const prior = this.state.receipts.find(
        (receipt) => receipt.update.commandId === update.commandId,
      );
      if (prior && sameUpdate(prior.update, update)) {
        // The command outcome is durable, while ceilings are selected anew by
        // the local operator at startup. A lost ACK must advertise those current
        // ceilings, matching this connection's hello after explicit resume.
        const result = { ...structuredClone(prior.result), hardLimits: { ...this.hard } };
        this.notice(update, result);
        return result;
      }
      if (prior) reason = "stale";
      else if (this.closed || this.stopRequested) reason = "stopped";
      else if (this.state.receipts.length >= MAX_RECEIPTS) reason = "storage";
      else if (
        update.expectedRevision !== this.state.operatingLimits.revision ||
        update.revision !== update.expectedRevision + 1
      )
        reason = "stale";
      else if (!within(update, this.hard)) reason = "ceiling";
      const nextLimits =
        reason === "applied"
          ? {
              matchMicros: update.matchMicros,
              dayMicros: update.dayMicros,
              concurrency: update.concurrency,
              revision: update.revision,
            }
          : { ...this.state.operatingLimits };
      let result: RunnerLimitResult = {
        commandId: update.commandId,
        revision: update.revision,
        status: reason === "applied" ? "applied" : "rejected",
        reason,
        operatingLimits: nextLimits,
        hardLimits: { ...this.hard },
      };
      if (
        !this.closed &&
        !prior &&
        (this.state.receipts.length < MAX_RECEIPTS ||
          (this.state.receipts.length === MAX_RECEIPTS && reason === "storage"))
      ) {
        if (reason === "storage") {
          this.stopRequested = true;
          this.policy?.stopOperatingLimits();
        }
        const next: RunnerLimitState = {
          ...this.state,
          stopped: this.stopRequested,
          operatingLimits: nextLimits,
          receipts: [...this.state.receipts, { update, result }],
        };
        try {
          // No ACK and no live raised limit before the durable replacement completes.
          await this.store.save(next);
          if (this.closed) throw new Error();
          // stop() marks intent synchronously, outside this queue. Preserve it
          // for every outcome, including refusals whose old snapshot was false.
          if (this.stopRequested && !next.stopped) {
            next.stopped = true;
            if (reason === "applied") {
              next.operatingLimits = { ...this.state.operatingLimits };
              result = {
                ...result,
                status: "rejected",
                reason: "stopped",
                operatingLimits: { ...this.state.operatingLimits },
              };
              const receipt = next.receipts.at(-1);
              if (!receipt) throw new Error();
              receipt.result = result;
            }
            await this.store.save(next);
          }
          if (reason === "applied" && !this.stopRequested)
            this.policy?.applyOperatingLimits(
              {
                matchMicros: update.matchMicros,
                dayMicros: update.dayMicros,
                concurrency: update.concurrency,
              },
              update.revision,
            );
          this.state = next;
        } catch {
          this.stopRequested = true;
          this.policy?.stopOperatingLimits();
          result = {
            ...result,
            status: "rejected",
            reason: "storage",
            operatingLimits: { ...this.state.operatingLimits },
          };
          // Retain the local lock if the durability of this stop is uncertain.
          try {
            const stopped = {
              ...this.state,
              stopped: true,
              receipts: [...this.state.receipts, { update, result }],
            };
            await this.store.save(stopped);
            this.state = stopped;
          } catch {
            this.closed = true;
          }
        }
      }
      this.notice(update, result);
      return structuredClone(result);
    });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  /** Local cancellation is permanent for this paired run, including explicit resume. */
  stop(): Promise<void> {
    this.stopRequested = true;
    this.policy?.stopOperatingLimits();
    if (this.closed) return Promise.reject(new Error("RUNNER_LIMIT_CLOSED"));
    try {
      this.store.stopIntent?.();
    } catch {
      this.closed = true;
      return Promise.reject(new Error("RUNNER_LIMIT_STORAGE"));
    }
    const task = this.tail.then(async () => {
      if (this.closed) {
        // A preceding close observed our synchronous cancellation intent and
        // persisted it before releasing the lock. Otherwise cancellation failed.
        if (this.released && this.state.stopped) return;
        throw new Error("RUNNER_LIMIT_CLOSED");
      }
      try {
        const stopped = { ...this.state, stopped: true };
        await this.store.save(stopped);
        this.state = stopped;
      } catch {
        this.closed = true;
        throw new Error("RUNNER_LIMIT_STORAGE");
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }

  close(onReleased?: () => void): Promise<void> {
    const task = this.tail.then(async () => {
      if (this.released) {
        onReleased?.();
        return;
      }
      if (this.closed) throw new Error("RUNNER_LIMIT_STORAGE");
      const retryRelease = new Error("RUNNER_LIMIT_RELEASE_RETRY");
      for (;;) {
        try {
          if (this.stopRequested && !this.state.stopped) {
            const stopped = { ...this.state, stopped: true };
            await this.store.save(stopped);
            this.state = stopped;
          }
          await this.store.close(
            () => {
              // A stop may arrive while an IO adapter prepares to release.
              // Throw before unlock so it can be durably fenced and retried.
              if (this.stopRequested && !this.state.stopped) throw retryRelease;
            },
            () => {
              this.closed = true;
              this.released = true;
              onReleased?.();
            },
          );
          if (!this.released) throw new Error("RUNNER_LIMIT_STORAGE");
          return;
        } catch (error) {
          if (error === retryRelease) continue;
          this.closed = true;
          this.policy?.stopOperatingLimits();
          throw new Error("RUNNER_LIMIT_STORAGE");
        }
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function privateDirectory(path: string, recursive = false): Promise<void> {
  await mkdir(path, { recursive, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new Error("RUNNER_LIMIT_STORAGE");
  await syncDirectory(dirname(path));
}

/** Exclusive private state, reclaimed only from an exactly identified dead process. */
export async function runnerLimitFileStore(
  origin: string,
  machineId: string,
  root = configDir(),
): Promise<RunnerLimitStore> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(machineId) || new URL(origin).origin !== origin)
    throw new Error("RUNNER_LIMIT_STORAGE");
  await privateDirectory(root, true);
  const directory = join(root, "runner-limits-v1");
  await privateDirectory(directory);
  const file = join(
    directory,
    `${createHash("sha256").update(origin).update("\0").update(machineId).digest("hex")}.json`,
  );
  const lock = `${file}.lock`;
  const ownership = await RunnerLock.acquire(lock);
  // One fixed, monotonic cell per paired run: never reset, replaced or removed.
  // An open writable FD survives directory chmod and new-name allocation failure.
  let intent: number | undefined;
  let stopped: boolean;
  try {
    // Controller.open saves JSON before exposing execution or installing stop().
    // Only no-JSON initialization may complete an empty cell after owner death.
    let hasState = true;
    try {
      await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hasState = false;
    }
    const flags = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    try {
      intent = openSync(`${file}.stop`, flags);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Existing prerelease state without intent evidence is unsupported, not fresh.
      if (hasState) throw new Error("RUNNER_LIMIT_STORAGE");
      intent = openSync(`${file}.stop`, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
    }
    const info = fstatSync(intent);
    const data = Buffer.alloc(2);
    if (
      !info.isFile() ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new Error("RUNNER_LIMIT_STORAGE");
    if (info.size === 0 && !hasState) {
      if (writeSync(intent, Buffer.from("0"), 0, 1, 0) !== 1) throw new Error();
    } else if (info.size !== 1) throw new Error("RUNNER_LIMIT_STORAGE");
    if (readSync(intent, data, 0, 2, 0) !== 1 || (data[0] !== 48 && data[0] !== 49))
      throw new Error("RUNNER_LIMIT_STORAGE");
    stopped = data[0] === 49;
    // Also finish initialization left visible by a predecessor killed before sync.
    fsyncSync(intent);
    await syncDirectory(directory);
  } catch {
    if (intent !== undefined) closeSync(intent);
    await ownership.release().catch(() => {});
    throw new Error("RUNNER_LIMIT_STORAGE");
  }
  const intentFd = intent;
  let released = false;
  const stopIntent = () => {
    if (released) throw new Error("RUNNER_LIMIT_STORAGE");
    if (stopped) return;
    if (writeSync(intentFd, Buffer.from("1"), 0, 1, 0) !== 1)
      throw new Error("RUNNER_LIMIT_STORAGE");
    fsyncSync(intentFd);
    stopped = true;
  };
  return {
    stopIntent,
    async load() {
      await ownership.check();
      try {
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = await handle.stat();
          if (
            !info.isFile() ||
            info.size > MAX_BYTES ||
            (process.platform !== "win32" &&
              ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
          )
            throw new Error("RUNNER_LIMIT_STORAGE");
          const state = stateSchema.parse(JSON.parse(await handle.readFile("utf8")));
          return stopped ? { ...state, stopped: true } : state;
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !stopped) return undefined;
        throw new Error("RUNNER_LIMIT_STORAGE");
      }
    },
    async save(state) {
      if (state.stopped) stopIntent();
      await ownership.check();
      const data = `${JSON.stringify(stateSchema.parse(state))}\n`;
      if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("RUNNER_LIMIT_STORAGE");
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        await rename(temporary, file);
        await syncDirectory(directory);
      } finally {
        await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
      }
    },
    async close(beforeRelease = () => {}, afterRelease = () => {}) {
      ownership.releaseSync(beforeRelease, () => {
        if (!released) {
          released = true;
          try {
            closeSync(intentFd);
          } finally {
            afterRelease();
          }
        } else afterRelease();
      });
    },
  };
}
