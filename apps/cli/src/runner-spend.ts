import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

import { runnerSpendFile } from "./paths";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 32_768;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(128);
const recordSchema = z.strictObject({
  matchId: identifier,
  requestId: identifier,
  atMs: safeInteger,
  reservedMicros: safeInteger,
  micros: safeInteger,
  settled: z.boolean(),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  authorityId: z.string().regex(/^[a-f0-9]{64}$/),
  clockMs: safeInteger,
  blocked: z.boolean(),
  records: z.array(recordSchema).max(MAX_RECORDS),
});
type State = z.infer<typeof stateSchema>;

/** Codes only: callers translate these without exposing paths, keys or provider errors. */
export class RunnerSpendError extends Error {
  constructor(
    readonly code:
      | "INVALID"
      | "LOCKED"
      | "STORAGE"
      | "MATCH_LIMIT"
      | "DAY_LIMIT"
      | "REPLAY"
      | "SETTLEMENT",
  ) {
    super(`RUNNER_SPEND_${code}`);
    this.name = "RunnerSpendError";
  }
}

/** One key means one authority across website origins, claims, profiles and directories. */
export function spendingAuthorityId(apiKey: string): string {
  if (!apiKey) throw new RunnerSpendError("INVALID");
  return createHash("sha256").update("cockpit-chess:spend:v1\0").update(apiKey).digest("hex");
}

export interface SpendReservation {
  /** Local durable match identifier shared by both sides. */
  matchId: string;
  /** Locally generated one-use identifier; never a website command ID. */
  requestId: string;
  micros: number;
  matchLimitMicros: number;
  dayLimitMicros: number;
}

interface SpendSettlement {
  requestId: string;
  /** Exact or conservatively rounded known cost, never an estimate for missing usage. */
  micros: number;
}

interface SpendOptions {
  authorityId: string;
  /** Test-only IO seam. Product callers use the stable per-user authority path. */
  file?: string;
  now?: () => number;
  monotonicNow?: () => number;
}

function integer(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RunnerSpendError("INVALID");
  return value;
}

function add(a: number, b: number): number {
  return integer(a + b);
}

async function privateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RunnerSpendError("STORAGE");
  if (
    process.platform !== "win32" &&
    ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
  )
    throw new RunnerSpendError("STORAGE");
  // A durable ledger file cannot protect spend if a power loss can discard one
  // of its ancestor directory entries. Sync even an existing child: an earlier
  // startup may have created it and failed before syncing its parent.
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not support opening/fsyncing directories. File FlushFileBuffers and
  // same-volume atomic rename still apply there; every POSIX directory sync is mandatory.
  if (process.platform === "win32") return;
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function persist(file: string, state: State): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const data = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new RunnerSpendError("STORAGE");
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    await syncDirectory(dirname(file));
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}

/**
 * An exclusive local authority. Every successful reservation is durable before the
 * caller may send HTTP. Missing usage and timeouts never refund it; a trustworthy
 * known result may reduce it through the awaited, durable settle operation.
 * A crashed process intentionally leaves its lock: only a local operator may recover
 * it after confirming the process is dead; a second invocation never guesses.
 */
export class RunnerSpend {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private poisoned = false;
  private retainLock = false;
  private closing = false;
  private readonly requests = new Set<string>();
  private readonly matches = new Map<string, number>();
  private readonly baseClock: number;
  private readonly baseMonotonic: number;

  private constructor(
    private readonly file: string,
    private readonly lock: string,
    private readonly options: SpendOptions,
    private state: State,
  ) {
    this.baseClock = state.clockMs;
    this.baseMonotonic = (options.monotonicNow ?? (() => performance.now()))();
    for (const record of state.records) {
      if (
        this.requests.has(record.requestId) ||
        record.atMs > state.clockMs ||
        record.micros > record.reservedMicros ||
        (!record.settled && record.micros !== record.reservedMicros)
      )
        throw new RunnerSpendError("STORAGE");
      this.requests.add(record.requestId);
      this.matches.set(record.matchId, add(this.matches.get(record.matchId) ?? 0, record.micros));
    }
  }

  static async open(options: SpendOptions): Promise<RunnerSpend> {
    if (!/^[a-f0-9]{64}$/.test(options.authorityId)) throw new RunnerSpendError("INVALID");
    const file = options.file ?? runnerSpendFile(options.authorityId);
    const lock = `${file}.lock`;
    let locked = false;
    try {
      // Validate each app-owned ancestor before descending. mkdir's mode alone
      // does not protect an already-existing writable or symlinked directory.
      if (!options.file) await privateDirectory(dirname(dirname(file)));
      await privateDirectory(dirname(file));
      try {
        const handle = await open(lock, "wx", 0o600);
        locked = true;
        try {
          // No key, origin, profile or pathname in the lock content.
          await handle.writeFile(`${process.pid}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(dirname(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new RunnerSpendError("LOCKED");
        throw error;
      }
      const now = integer((options.now ?? Date.now)());
      let state: State;
      try {
        // O_NOFOLLOW rejects a symlink rather than reading a different authority file.
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new RunnerSpendError("STORAGE");
          if (
            process.platform !== "win32" &&
            ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
          )
            throw new RunnerSpendError("STORAGE");
          state = stateSchema.parse(JSON.parse(await handle.readFile("utf8")));
        } finally {
          await handle.close();
        }
        if (state.authorityId !== options.authorityId) throw new RunnerSpendError("STORAGE");
        if (state.blocked) throw new RunnerSpendError("SETTLEMENT");
        state.clockMs = Math.max(state.clockMs, now);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = {
          version: 1,
          authorityId: options.authorityId,
          clockMs: now,
          blocked: false,
          records: [],
        };
      }
      const ledger = new RunnerSpend(file, lock, options, state);
      // Persist the high-water clock before returning authority, including empty ledgers.
      await persist(file, state);
      return ledger;
    } catch (error) {
      if (locked) await unlink(lock).catch(() => {});
      if (error instanceof RunnerSpendError) throw error;
      throw new RunnerSpendError("STORAGE");
    }
  }

  private time(): number {
    const monotonic = (this.options.monotonicNow ?? (() => performance.now()))();
    const elapsed = Math.max(0, Math.floor(monotonic - this.baseMonotonic));
    return integer(
      Math.max(this.state.clockMs, (this.options.now ?? Date.now)(), this.baseClock + elapsed),
    );
  }

  private usable(): void {
    if (this.closed || this.poisoned) throw new RunnerSpendError("STORAGE");
  }

  reserve(reservation: SpendReservation): Promise<void> {
    if (this.closing) return Promise.reject(new RunnerSpendError("STORAGE"));
    // Detach caller-owned values before awaiting any other operation.
    const input = { ...reservation };
    const task = this.tail.then(async () => {
      this.usable();
      const parsed = recordSchema.safeParse({
        matchId: input.matchId,
        requestId: input.requestId,
        atMs: 0,
        reservedMicros: input.micros,
        micros: input.micros,
        settled: false,
      });
      if (!parsed.success) throw new RunnerSpendError("INVALID");
      integer(input.matchLimitMicros);
      integer(input.dayLimitMicros);
      if (this.requests.has(input.requestId)) throw new RunnerSpendError("REPLAY");
      if (this.state.records.length >= MAX_RECORDS) throw new RunnerSpendError("STORAGE");
      const atMs = this.time();
      const matchTotal = add(this.matches.get(input.matchId) ?? 0, input.micros);
      if (matchTotal > input.matchLimitMicros) throw new RunnerSpendError("MATCH_LIMIT");
      let dayTotal = input.micros;
      for (const record of this.state.records) {
        // Future records stay charged after rollback; midnight never resets the day.
        if (record.atMs > atMs - DAY_MS) dayTotal = add(dayTotal, record.micros);
      }
      if (dayTotal > input.dayLimitMicros) throw new RunnerSpendError("DAY_LIMIT");
      const next: State = {
        ...this.state,
        clockMs: atMs,
        records: [...this.state.records, { ...parsed.data, atMs }],
      };
      try {
        await persist(this.file, next);
      } catch {
        // Rename may have succeeded before a directory-sync failure. Nothing else
        // dispatches from this handle, and restart keeps any persisted reservation.
        this.poisoned = true;
        throw new RunnerSpendError("STORAGE");
      }
      this.state = next;
      this.matches.set(input.matchId, matchTotal);
      this.requests.add(input.requestId);
    });
    this.tail = task.catch(() => {});
    return task;
  }

  settle(settlement: SpendSettlement): Promise<void> {
    if (this.closing) return Promise.reject(new RunnerSpendError("STORAGE"));
    const input = { ...settlement };
    const task = this.tail.then(async () => {
      this.usable();
      if (!identifier.safeParse(input.requestId).success) throw new RunnerSpendError("INVALID");
      integer(input.micros);
      const index = this.state.records.findIndex((record) => record.requestId === input.requestId);
      const record = this.state.records[index];
      if (!record) throw new RunnerSpendError("INVALID");
      if (
        input.micros > record.reservedMicros ||
        (record.settled && input.micros !== record.micros)
      ) {
        // The route exceeded its proved bound or contradicted its final cost. Keep
        // the full reservation and durably block the profile, including after restart.
        this.poisoned = true;
        this.retainLock = true;
        const records = [...this.state.records];
        records[index] = { ...record, micros: record.reservedMicros, settled: false };
        const blocked: State = { ...this.state, blocked: true, clockMs: this.time(), records };
        try {
          await persist(this.file, blocked);
          this.state = blocked;
          this.retainLock = false;
        } catch {
          // An uncertain block write must not permit a later process to authorize
          // the old unblocked state. Leave the lock for local investigation.
          this.retainLock = true;
          throw new RunnerSpendError("STORAGE");
        }
        throw new RunnerSpendError("SETTLEMENT");
      }
      if (record.settled) return;
      const records = [...this.state.records];
      records[index] = { ...record, micros: input.micros, settled: true };
      const next: State = { ...this.state, clockMs: this.time(), records };
      try {
        await persist(this.file, next);
      } catch {
        this.poisoned = true;
        throw new RunnerSpendError("STORAGE");
      }
      this.state = next;
      this.matches.set(
        record.matchId,
        integer((this.matches.get(record.matchId) ?? 0) - record.micros + input.micros),
      );
    });
    this.tail = task.catch(() => {});
    return task;
  }

  /** Safe local diagnostics. No credential, fingerprint or provider response is exposed. */
  snapshot(): { requests: number; dayMicros: number; matches: ReadonlyMap<string, number> } {
    this.usable();
    const now = this.time();
    let dayMicros = 0;
    for (const record of this.state.records) {
      if (record.atMs > now - DAY_MS) dayMicros = add(dayMicros, record.micros);
    }
    return { requests: this.requests.size, dayMicros, matches: new Map(this.matches) };
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.tail;
    if (this.closed) return;
    this.closed = true;
    if (this.retainLock) throw new RunnerSpendError("STORAGE");
    try {
      await unlink(this.lock);
      await syncDirectory(dirname(this.file));
    } catch {
      throw new RunnerSpendError("STORAGE");
    }
  }
}

export function openRunnerSpend(options: SpendOptions): Promise<RunnerSpend> {
  return RunnerSpend.open(options);
}
