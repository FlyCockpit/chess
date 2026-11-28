import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  archiveByteLength,
  archiveSchema,
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  validateArchive,
} from "@cockpit-chess/chess";
import { z } from "zod";

import { configDir } from "./paths";

export interface RunnerGameRecord {
  digest: string;
  phase: "offered" | "ready" | "uncertain" | "terminal";
  archive: MatchArchive;
  confirmedPly: number;
}

export interface RunnerJournal {
  load(matchId: string): Promise<RunnerGameRecord | undefined>;
  save(matchId: string, record: RunnerGameRecord): Promise<void>;
  close(): Promise<void>;
}

// The archive has its own canonical byte limit; only this fixed envelope is extra.
const MAX_RECORD_BYTES = MAX_ARCHIVE_BYTES + 1024;
const matchIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const recordSchema = z.strictObject({
  digest: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]{64}$/i),
  phase: z.enum(["offered", "ready", "uncertain", "terminal"]),
  archive: archiveSchema,
  confirmedPly: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/** Internal codes only. The command boundary supplies translated user messages. */
class JournalError extends Error {
  constructor(readonly code: "INVALID" | "STORAGE" | "LOCKED") {
    super(`RUNNER_JOURNAL_${code}`);
  }
}

function validateRecord(input: unknown): RunnerGameRecord {
  const record = recordSchema.parse(input);
  if (archiveByteLength(record.archive) > MAX_ARCHIVE_BYTES) throw new JournalError("INVALID");
  record.archive = validateArchive(record.archive);
  const moves = record.archive.events.filter(
    (event) => event.type === "attempt" && event.accepted,
  ).length;
  if (
    record.confirmedPly > moves ||
    Buffer.byteLength(JSON.stringify(record)) + 1 > MAX_RECORD_BYTES
  )
    throw new JournalError("INVALID");
  return record;
}

function privateStat(stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()))
    throw new JournalError("STORAGE");
  if (
    process.platform !== "win32" &&
    (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600))
  )
    throw new JournalError("STORAGE");
  if (!directory && stat.nlink !== 1) throw new JournalError("STORAGE");
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not support directory fsync; file sync and atomic rename still apply.
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareDirectory(path: string, privateParent: boolean): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await prepareDirectory(parent, false);
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o700 });
    stat = await lstat(path);
    privateStat(stat, true);
    await syncDirectory(parent);
  }
  // Above the app root, system directories may have other owners/modes, but no
  // ancestor may redirect the private subtree through a symlink.
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new JournalError("STORAGE");
  if (privateParent) {
    privateStat(stat, true);
    // Sync even existing entries: an earlier startup may have failed after mkdir.
    await syncDirectory(parent);
  }
}

class FileRunnerJournal implements RunnerJournal {
  private tail: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private poisoned = false;
  private readonly digests = new Map<string, string>();

  constructor(
    private readonly directories: string[],
    private readonly directory: string,
    private readonly lock: string,
    private readonly lockStat: Stats,
  ) {}

  private async checkStorage(): Promise<void> {
    for (const directory of this.directories) privateStat(await lstat(directory), true);
    const stat = await lstat(this.lock);
    privateStat(stat, false);
    if (stat.dev !== this.lockStat.dev || stat.ino !== this.lockStat.ino)
      throw new JournalError("STORAGE");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new JournalError("STORAGE"));
    const task = this.tail.then(async () => {
      if (this.poisoned) throw new JournalError("STORAGE");
      try {
        await this.checkStorage();
        return await operation();
      } catch (error) {
        this.poisoned = true;
        if (error instanceof JournalError) throw error;
        throw new JournalError("STORAGE");
      }
    });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private file(matchId: string): string {
    if (typeof matchId !== "string" || matchIdPattern.exec(matchId)?.[0] !== matchId)
      throw new JournalError("INVALID");
    return join(this.directory, `${matchId}.json`);
  }

  private async read(matchId: string): Promise<RunnerGameRecord | undefined> {
    const file = this.file(matchId);
    let stat: Stats;
    try {
      stat = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (this.digests.has(matchId)) throw new JournalError("STORAGE");
      return undefined;
    }
    privateStat(stat, false);
    if (stat.size > MAX_RECORD_BYTES) throw new JournalError("STORAGE");
    const handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    let record: RunnerGameRecord;
    try {
      const opened = await handle.stat();
      privateStat(opened, false);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_RECORD_BYTES)
        throw new JournalError("STORAGE");
      // Bounded even if a file grows after stat. Never allocate from a disk-supplied size.
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_RECORD_BYTES) throw new JournalError("STORAGE");
      record = validateRecord(JSON.parse(buffer.subarray(0, size).toString("utf8")));
    } catch {
      throw new JournalError("STORAGE");
    } finally {
      await handle.close();
    }
    const known = this.digests.get(matchId);
    if (known !== undefined && known !== record.digest) throw new JournalError("STORAGE");
    this.digests.set(matchId, record.digest);
    return record;
  }

  load(matchId: string): Promise<RunnerGameRecord | undefined> {
    return this.enqueue(() => this.read(matchId));
  }

  save(matchId: string, record: RunnerGameRecord): Promise<void> {
    // Zod creates a detached deep snapshot synchronously, before the queue can yield.
    let snapshot: RunnerGameRecord | undefined;
    try {
      snapshot = validateRecord(record);
    } catch {
      // Queue validation failure too: earlier accepted operations must finish first.
    }
    return this.enqueue(async () => {
      const file = this.file(matchId);
      if (!snapshot) throw new JournalError("INVALID");
      const previous = await this.read(matchId);
      if (
        previous &&
        (previous.digest !== snapshot.digest ||
          (previous.phase === "terminal" && snapshot.phase !== "terminal"))
      )
        throw new JournalError("INVALID");
      const temporary = `${file}.${randomUUID()}.tmp`;
      let created = false;
      let renamed = false;
      try {
        const handle = await open(temporary, "wx", 0o600);
        created = true;
        try {
          privateStat(await handle.stat(), false);
          await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
        renamed = true;
        await syncDirectory(this.directory);
        this.digests.set(matchId, snapshot.digest);
      } finally {
        if (created && !renamed) await unlink(temporary);
      }
    });
  }

  close(): Promise<void> {
    this.closing ??= this.tail.then(async () => {
      if (this.poisoned) throw new JournalError("STORAGE");
      let released = false;
      try {
        await this.checkStorage();
        await unlink(this.lock);
        released = true;
        await syncDirectory(this.directory);
      } catch {
        this.poisoned = true;
        if (released) {
          // The removal's durability is unknown. Re-establish a fence if possible;
          // exclusive creation can never replace a new process's intervening lock.
          try {
            const handle = await open(this.lock, "wx", 0o600);
            try {
              await handle.writeFile(`${process.pid}\n`, "utf8");
              await handle.sync();
            } finally {
              await handle.close();
            }
            await syncDirectory(this.directory);
          } catch {
            // Keep any created/intervening lock and report only the fixed error.
          }
        }
        throw new JournalError("STORAGE");
      }
    });
    return this.closing;
  }
}

/** A crash deliberately leaves the exclusive lock for explicit local recovery. */
export async function openRunnerJournal(
  origin: string,
  machineId: string,
  root = configDir(),
): Promise<RunnerJournal> {
  if (
    typeof origin !== "string" ||
    !origin ||
    typeof machineId !== "string" ||
    !machineId ||
    typeof root !== "string" ||
    !root
  )
    throw new JournalError("INVALID");
  try {
    // JSON tuple framing prevents collisions from separators inside either input.
    const scope = createHash("sha256")
      .update("cockpit-chess:runner-games:v1\0")
      .update(JSON.stringify([origin, machineId]))
      .digest("hex");
    const base = resolve(root);
    const games = join(base, "runner-games");
    const directory = join(games, scope);
    for (const path of [base, games, directory]) await prepareDirectory(path, true);
    const lock = join(directory, "journal.lock");
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new JournalError("LOCKED");
      throw error;
    }
    // From this point on, every failure retains the lock. Startup never guesses
    // whether an earlier write or directory creation reached durable storage.
    let lockStat: Stats;
    try {
      lockStat = await handle.stat();
      privateStat(lockStat, false);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
    return new FileRunnerJournal([base, games, directory], directory, lock, lockStat);
  } catch (error) {
    if (error instanceof JournalError) throw error;
    throw new JournalError("STORAGE");
  }
}
