import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

import { runnerSpendFile } from "./paths";
import { RunnerLock, RunnerLockError } from "./runner-lock";
import {
  classifyFinancialInput,
  type FinancialContext,
  settlementContextSchema,
} from "./runner-pricing";

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
  context: settlementContextSchema,
});
const stateSchema = z.strictObject({
  version: z.literal(2),
  authorityId: z.string().regex(/^[a-f0-9]{64}$/),
  clockMs: safeInteger,
  blocked: z.boolean(),
  records: z.array(recordSchema).max(MAX_RECORDS),
  checkpoint: z.strictObject({
    sequence: safeInteger,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["empty", "held", "settled"]),
  }),
});
type State = z.infer<typeof stateSchema>;
const MAX_RECEIPT_BYTES = 128 * 1024;
const receiptSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("empty"),
    version: z.literal(1),
    authorityId: stateSchema.shape.authorityId,
    sequence: z.literal(0),
  }),
  z.strictObject({
    kind: z.literal("input"),
    version: z.literal(1),
    authorityId: stateSchema.shape.authorityId,
    sequence: safeInteger.min(1),
    previous: stateSchema.shape.checkpoint,
    prior: recordSchema,
    payload: z.string().max(64 * 1024),
  }),
]);
type Receipt = z.infer<typeof receiptSchema>;
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function receiptDigest(receipt: Receipt): string {
  return digest(JSON.stringify(receiptSchema.parse(receipt)));
}

/** Detach bounded JSON without invoking getters/toJSON or interpreting financial fields. */
function opaqueInput(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) throw new RunnerSpendError("INVALID");
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input === "string") {
      bytes += Buffer.byteLength(input);
      if (bytes > 64 * 1024) throw new RunnerSpendError("INVALID");
      return input;
    }
    if (typeof input !== "object" || input === null) throw new RunnerSpendError("INVALID");
    if (Array.isArray(input)) {
      if (input.length > 4096) throw new RunnerSpendError("INVALID");
      const result: unknown[] = [];
      for (let i = 0; i < input.length; i++) {
        const property = Object.getOwnPropertyDescriptor(input, String(i));
        if (!property || !("value" in property)) throw new RunnerSpendError("INVALID");
        result.push(copy(property.value, depth + 1));
      }
      return result;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input)))
      throw new RunnerSpendError("INVALID");
    const result: Record<string, unknown> = Object.create(null);
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue;
      bytes += Buffer.byteLength(key);
      if (bytes > 64 * 1024) throw new RunnerSpendError("INVALID");
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (!property || !("value" in property)) throw new RunnerSpendError("INVALID");
      // Missing JSON fields remain missing, as at the provider observer boundary.
      if (property.value !== undefined) result[key] = copy(property.value, depth + 1);
    }
    return result;
  };
  const encoded = JSON.stringify(copy(value ?? null, 0));
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new RunnerSpendError("INVALID");
  return encoded;
}

async function readReceipt(file: string): Promise<Receipt> {
  const h = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await h.stat();
    if (
      !stat.isFile() ||
      stat.size > MAX_RECEIPT_BYTES ||
      stat.nlink !== 1 ||
      (process.platform !== "win32" && (stat.mode & 0o077 || stat.uid !== process.getuid?.()))
    )
      throw new RunnerSpendError("STORAGE");
    const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await h.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_RECEIPT_BYTES) throw new RunnerSpendError("STORAGE");
    const envelope = z
      .strictObject({ body: z.string(), digest: z.string() })
      .parse(JSON.parse(buffer.subarray(0, size).toString("utf8")));
    if (digest(envelope.body) !== envelope.digest) throw new RunnerSpendError("STORAGE");
    return receiptSchema.parse(JSON.parse(envelope.body));
  } finally {
    await h.close();
  }
}

/** Two fixed names; only the synced atomic publication is financial acceptance. */
async function captureReceipt(file: string, receipt: Receipt): Promise<void> {
  const pending = `${file}.pending`;
  try {
    const stat = await lstat(pending);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.platform !== "win32" && (stat.mode & 0o077 || stat.uid !== process.getuid?.()))
    )
      throw new RunnerSpendError("STORAGE");
    await unlink(pending); // Uncommitted staging only, under exclusive spend ownership.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const body = JSON.stringify(receiptSchema.parse(receipt));
  const data = JSON.stringify({ body, digest: digest(body) });
  if (Buffer.byteLength(data) > MAX_RECEIPT_BYTES) throw new RunnerSpendError("STORAGE");
  const h = await open(pending, "wx", 0o600);
  try {
    await h.writeFile(data);
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(pending, file);
  await syncDirectory(dirname(file));
}

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
      | "SETTLEMENT"
      | "UNCERTAIN",
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
  /** Original trusted pricing context, detached durably before HTTP dispatch. */
  context?: FinancialContext;
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
  /** Local recovery only: never grants dispatch authority. */
  recovery?: boolean;
  /** Test-only crash/fault boundary: receipt is durable; classifier has not run. */
  afterCapture?: () => Promise<void>;
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
 * Exact dead owners are reclaimed by the immutable ownership chain; durable
 * unsettled reservations require explicit conservative local recovery.
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
    private readonly lock: RunnerLock,
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
    let ownership: RunnerLock | undefined;
    try {
      // Validate each app-owned ancestor before descending. mkdir's mode alone
      // does not protect an already-existing writable or symlinked directory.
      if (!options.file) await privateDirectory(dirname(dirname(file)));
      await privateDirectory(dirname(file));
      ownership = await RunnerLock.acquire(lock);
      const now = integer((options.now ?? Date.now)());
      let state: State;
      let fresh = false;
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
        if (state.blocked && !options.recovery) throw new RunnerSpendError("SETTLEMENT");
        state.clockMs = Math.max(state.clockMs, now);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        fresh = true;
        state = {
          version: 2,
          authorityId: options.authorityId,
          clockMs: now,
          blocked: false,
          records: [],
          checkpoint: { sequence: 0, digest: "", outcome: "empty" },
        };
      }
      const receiptFile = `${file}.receipt`;
      let receipt: Receipt;
      if (fresh) {
        try {
          receipt = await readReceipt(receiptFile);
          if (receipt.kind !== "empty" || receipt.authorityId !== options.authorityId)
            throw new RunnerSpendError("STORAGE");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          receipt = { kind: "empty", version: 1, sequence: 0, authorityId: options.authorityId };
          await captureReceipt(receiptFile, receipt);
        }
        state.checkpoint.digest = receiptDigest(receipt);
      } else receipt = await readReceipt(receiptFile);
      if (await ownership.fenced()) state.blocked = true;
      if (state.blocked && !options.recovery) throw new RunnerSpendError("SETTLEMENT");
      const ledger = new RunnerSpend(file, ownership, options, state);
      ledger.replayReceipt(receipt);
      if (state.blocked && !options.recovery) throw new RunnerSpendError("SETTLEMENT");
      if (!options.recovery && state.records.some((record) => !record.settled))
        throw new RunnerSpendError("UNCERTAIN");
      // Persist the high-water clock before returning authority, including empty ledgers.
      await persist(file, state);
      return ledger;
    } catch (error) {
      if (ownership) await ownership.release().catch(() => {});
      if (error instanceof RunnerLockError) throw new RunnerSpendError(error.code);
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
    if (this.closed || this.poisoned || this.state.blocked) throw new RunnerSpendError("STORAGE");
  }

  /** Final wire guard: no IO or yield after observing local authority validity. */
  assertDispatchable(): void {
    this.usable();
    if (this.closing || this.options.recovery) throw new RunnerSpendError("STORAGE");
  }

  private async checkLock(): Promise<void> {
    try {
      await this.lock.check();
    } catch {
      this.poisoned = true;
      throw new RunnerSpendError("STORAGE");
    }
  }

  reserve(reservation: SpendReservation): Promise<void> {
    if (this.closing) return Promise.reject(new RunnerSpendError("STORAGE"));
    // Detach caller-owned values before awaiting any other operation.
    const input = {
      ...reservation,
      context: settlementContextSchema.parse(reservation.context ?? { kind: "numeric" }),
    };
    const task = this.tail.then(async () => {
      this.usable();
      if (this.options.recovery) throw new RunnerSpendError("STORAGE");
      await this.checkLock();
      const parsed = recordSchema.safeParse({
        matchId: input.matchId,
        requestId: input.requestId,
        atMs: 0,
        reservedMicros: input.micros,
        micros: input.micros,
        settled: false,
        context: input.context ?? { kind: "numeric" },
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

  /** Numeric prerelease adapter: invocation is NOT acceptance; capture must succeed first.
   * Only numeric-context reservations may use it. Production uses captureUsage. */
  settle(settlement: SpendSettlement): Promise<void> {
    try {
      integer(settlement.micros);
    } catch {
      return Promise.reject(new RunnerSpendError("INVALID"));
    }
    return this.capture(settlement.requestId, { micros: settlement.micros }, true);
  }

  captureUsage(input: { requestId: string; usage: unknown }): Promise<void> {
    return this.capture(input.requestId, input.usage, false);
  }

  private replayReceipt(receipt: Receipt): void {
    if (receipt.authorityId !== this.state.authorityId) throw new RunnerSpendError("STORAGE");
    const checkpoint = this.state.checkpoint;
    const hash = receiptDigest(receipt);
    if (receipt.kind === "empty") {
      if (checkpoint.sequence !== 0 || checkpoint.digest !== hash || checkpoint.outcome !== "empty")
        throw new RunnerSpendError("STORAGE");
      return;
    }
    const record = this.state.records.find((entry) => entry.requestId === receipt.prior.requestId);
    if (
      !record ||
      record.matchId !== receipt.prior.matchId ||
      record.atMs !== receipt.prior.atMs ||
      record.reservedMicros !== receipt.prior.reservedMicros ||
      JSON.stringify(record.context) !== JSON.stringify(receipt.prior.context)
    )
      throw new RunnerSpendError("STORAGE");
    const actual = classifyFinancialInput(JSON.parse(receipt.payload), receipt.prior.context);
    const invalid =
      actual !== undefined &&
      (actual > receipt.prior.reservedMicros ||
        (receipt.prior.settled && actual !== receipt.prior.micros));
    if (checkpoint.sequence === receipt.sequence) {
      if (
        checkpoint.digest !== hash ||
        invalid ||
        checkpoint.outcome === "empty" ||
        (checkpoint.outcome === "settled" &&
          (actual === undefined || !record.settled || record.micros !== actual)) ||
        (checkpoint.outcome === "held" && record.micros !== receipt.prior.micros)
      )
        throw new RunnerSpendError("STORAGE");
      return;
    }
    if (
      receipt.sequence !== checkpoint.sequence + 1 ||
      JSON.stringify(receipt.previous) !== JSON.stringify(checkpoint)
    )
      throw new RunnerSpendError("STORAGE");
    if (invalid) {
      if (
        JSON.stringify(record) !== JSON.stringify(receipt.prior) &&
        !(this.state.blocked && !record.settled && record.micros === record.reservedMicros)
      )
        throw new RunnerSpendError("STORAGE");
      this.state.blocked = true;
      this.state.records = this.state.records.map((entry) =>
        entry.requestId === record.requestId
          ? { ...entry, micros: entry.reservedMicros, settled: false }
          : entry,
      );
      this.matches.set(
        record.matchId,
        add(this.matches.get(record.matchId) ?? 0, record.reservedMicros - record.micros),
      );
      return;
    }
    if (JSON.stringify(record) !== JSON.stringify(receipt.prior))
      throw new RunnerSpendError("STORAGE");
    // Replay does not invent the refund whose durable ledger commit never succeeded.
    // Checkpointing the safe observation leaves the original full uncertain hold.
    this.state.checkpoint = {
      sequence: receipt.sequence,
      digest: hash,
      outcome: record.settled && actual !== undefined ? "settled" : "held",
    };
  }

  private capture(requestId: string, raw: unknown, numeric: boolean): Promise<void> {
    if (this.closing) return Promise.reject(new RunnerSpendError("STORAGE"));
    let payload: string;
    try {
      payload = opaqueInput(raw);
    } catch {
      return Promise.reject(new RunnerSpendError("INVALID"));
    }
    const task = this.tail.then(async () => {
      this.usable();
      if (this.options.recovery) throw new RunnerSpendError("STORAGE");
      await this.checkLock();
      if (!identifier.safeParse(requestId).success) throw new RunnerSpendError("INVALID");
      const index = this.state.records.findIndex((record) => record.requestId === requestId);
      const record = this.state.records[index];
      if (!record || numeric !== (record.context.kind === "numeric"))
        throw new RunnerSpendError("INVALID");
      const receipt: Receipt = {
        kind: "input",
        version: 1,
        authorityId: this.state.authorityId,
        sequence: add(this.state.checkpoint.sequence, 1),
        previous: { ...this.state.checkpoint },
        prior: { ...record },
        payload,
      };
      try {
        await captureReceipt(`${this.file}.receipt`, receipt);
        await this.options.afterCapture?.();
      } catch {
        this.poisoned = true;
        throw new RunnerSpendError("STORAGE");
      }
      // No classifier or comparison runs until durable capture above succeeds.
      const actual = classifyFinancialInput(JSON.parse(receipt.payload), record.context);
      if (
        actual !== undefined &&
        (actual > record.reservedMicros || (record.settled && actual !== record.micros))
      ) {
        this.poisoned = true;
        this.retainLock = true;
        // The receipt is the permanent proof even if BOTH following writes fail.
        try {
          await this.lock.fence();
        } catch {
          /* receipt remains committed */
        }
        const blockedRecords = [...this.state.records];
        blockedRecords[index] = { ...record, micros: record.reservedMicros, settled: false };
        const blocked = { ...this.state, blocked: true, records: blockedRecords };
        try {
          await persist(this.file, blocked);
        } catch {
          throw new RunnerSpendError("STORAGE");
        }
        this.state = blocked;
        this.retainLock = false;
        throw new RunnerSpendError("SETTLEMENT");
      }
      const records = [...this.state.records];
      if (actual !== undefined) records[index] = { ...record, micros: actual, settled: true };
      const next: State = {
        ...this.state,
        clockMs: this.time(),
        records,
        checkpoint: {
          sequence: receipt.sequence,
          digest: receiptDigest(receipt),
          outcome: actual === undefined ? "held" : "settled",
        },
      };
      try {
        await persist(this.file, next);
      } catch {
        this.poisoned = true;
        throw new RunnerSpendError("STORAGE");
      }
      this.state = next;
      this.matches.set(
        record.matchId,
        integer(
          (this.matches.get(record.matchId) ?? 0) - record.micros + (actual ?? record.micros),
        ),
      );
    });
    this.tail = task.catch(() => {});
    return task;
  }

  recoverySnapshot(): { blocked: boolean; records: Omit<State["records"][number], "context">[] } {
    if (this.closed || !this.options.recovery) throw new RunnerSpendError("STORAGE");
    return {
      blocked: this.state.blocked,
      records: this.state.records.map((record) => ({
        matchId: record.matchId,
        requestId: record.requestId,
        atMs: record.atMs,
        reservedMicros: record.reservedMicros,
        micros: record.micros,
        settled: record.settled,
      })),
    };
  }

  /** Caller must durably abandon affected games FIRST. Totals/times/IDs remain unchanged. */
  resolveUncertain(): Promise<void> {
    if (this.closing) return Promise.reject(new RunnerSpendError("STORAGE"));
    const task = this.tail.then(async () => {
      if (this.closed || this.poisoned || !this.options.recovery)
        throw new RunnerSpendError("STORAGE");
      if (this.state.blocked) throw new RunnerSpendError("SETTLEMENT");
      await this.checkLock();
      const next = {
        ...this.state,
        records: this.state.records.map((record) => ({ ...record, settled: true })),
      };
      try {
        await persist(this.file, next);
      } catch {
        this.poisoned = true;
        throw new RunnerSpendError("STORAGE");
      }
      this.state = next;
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
      await this.lock.release();
    } catch {
      throw new RunnerSpendError("STORAGE");
    }
  }
}

export function openRunnerSpend(options: SpendOptions): Promise<RunnerSpend> {
  return RunnerSpend.open(options);
}
