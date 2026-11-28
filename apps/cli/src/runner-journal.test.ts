import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  archiveByteLength,
  boardAt,
  createMatch,
  finishMatch,
  MAX_ARCHIVE_BYTES,
  submitMove,
} from "@cockpit-chess/chess";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openRunnerJournal, type RunnerGameRecord, type RunnerJournal } from "./runner-journal";

const faults = vi.hoisted(() => ({
  read: false,
  write: false,
  sync: false,
  rename: false,
  directorySync: false,
  wrongOwner: false,
  failSyncPath: undefined as string | undefined,
  defaultRoot: undefined as string | undefined,
  synced: [] as string[],
}));

vi.mock("./paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths")>();
  return { ...actual, configDir: () => faults.defaultRoot ?? actual.configDir() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args);
      if (faults.wrongOwner) Object.defineProperty(stat, "uid", { value: Number(stat.uid) + 1 });
      return stat;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename) throw new Error("private disk detail");
      return actual.rename(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const directory = (await handle.stat()).isDirectory();
      if (faults.read && !directory && typeof args[1] === "number") {
        await handle.close();
        throw new Error("private disk detail");
      }
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (directory) faults.synced.push(String(args[0]));
        if (
          (directory && (faults.directorySync || faults.failSyncPath === String(args[0]))) ||
          (!directory && faults.sync)
        )
          throw new Error("private disk detail");
        await sync();
      };
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...input: Parameters<typeof handle.writeFile>) => {
        if (faults.write) throw new Error("private disk detail");
        return write(...input);
      };
      return handle;
    },
  };
});

const origin = "https://journal.example";
const machine = "machine-1";
const cleanup: (() => Promise<unknown>)[] = [];

function record(): RunnerGameRecord {
  const player = { name: "Random", model: "random", protocol: "random" as const };
  return {
    digest: "a".repeat(64),
    phase: "offered",
    archive: createMatch({ white: player, black: player, rules: {} }),
    confirmedPly: 0,
  };
}

function recordOfSize(target: number): RunnerGameRecord {
  const value = record();
  const match = value.archive;
  // Leave room for a final event, then measure only a few final padding steps.
  for (let index = 0; index < 120; index += 1)
    match.events.push({
      type: "tool",
      seq: index,
      at: "2026-11-27T00:00:00.000Z",
      side: "w",
      ply: 0,
      name: "board",
      input: "{}",
      output: "x".repeat(15_000),
    });
  while (archiveByteLength(match) < target) {
    const remaining = target - archiveByteLength(match);
    const roomy = match.events.find(
      (event) => event.type === "tool" && event.output.length + remaining <= 16_000,
    );
    if (roomy?.type === "tool") {
      roomy.output += "x".repeat(remaining);
    } else {
      match.events.push({
        type: "tool",
        seq: match.events.length,
        at: "2026-11-27T00:00:00.000Z",
        side: "w",
        ply: 0,
        name: "board",
        input: "{}",
        output: "",
      });
      const event = match.events.at(-1);
      if (event?.type === "tool")
        event.output = "x".repeat(Math.min(15_000, target - archiveByteLength(match)));
    }
  }
  return value;
}

async function temporaryRoot() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "runner-journal-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function track(journal: RunnerJournal) {
  cleanup.push(() => journal.close().catch(() => {}));
  return journal;
}

async function fixture() {
  const root = await temporaryRoot();
  const journal = track(await openRunnerJournal(origin, machine, root));
  const scopes = await readdir(join(root, "runner-games"));
  const directory = join(root, "runner-games", scopes[0] ?? "missing");
  return {
    root,
    journal,
    directory,
    lock: join(directory, "journal.lock"),
    file: join(directory, "match-1.json"),
  };
}

async function child(root: string, close: boolean) {
  const module = fileURLToPath(new URL("./runner-journal.ts", import.meta.url));
  const script = `
    import { openRunnerJournal } from ${JSON.stringify(module)};
    try {
      const journal = await openRunnerJournal(${JSON.stringify(origin)}, ${JSON.stringify(machine)}, ${JSON.stringify(root)});
      if (${close}) await journal.close();
      process.stdout.write("opened");
    } catch (error) {
      process.stdout.write(error.message);
    }
  `;
  return promisify(execFile)(process.execPath, [
    "--import",
    createRequire(import.meta.url).resolve("tsx/esm"),
    "--input-type=module",
    "-e",
    script,
  ]);
}

afterEach(async () => {
  faults.read = false;
  faults.write = false;
  faults.sync = false;
  faults.rename = false;
  faults.directorySync = false;
  faults.wrongOwner = false;
  faults.failSyncPath = undefined;
  faults.defaultRoot = undefined;
  faults.synced.length = 0;
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

describe("durable runner game journal", () => {
  it("inspection retains bounded phase/ID metadata for actual large terminal history", async () => {
    const { journal } = await fixture();
    const value = recordOfSize(1_850_000);
    finishMatch(value.archive, "*", "interrupted", "error");
    value.phase = "terminal";
    for (let i = 0; i < 8; i++) await journal.save(`history-${i}`, value);
    const inventory = await journal.inspect?.();
    expect(inventory).toHaveLength(8);
    expect(inventory?.every((row) => Object.keys(row).sort().join(",") === "matchId,phase")).toBe(
      true,
    );
    expect(Buffer.byteLength(JSON.stringify(inventory))).toBeLessThan(1024);
    // Inspection does not retire archives or their digest/tombstone replay fences.
    expect(await journal.load("history-0")).toMatchObject({
      phase: "terminal",
      digest: value.digest,
    });
    await expect(journal.save("history-0", { ...value, phase: "ready" })).rejects.toThrow(
      "INVALID",
    );
  });
  it("persists an exact cancellation tombstone across reopen and refuses a later offered game", async () => {
    const { root, journal, file } = await fixture();
    await journal.save("match-1", { phase: "cancelled" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ phase: "cancelled" });
    await journal.close();
    const restored = track(await openRunnerJournal(origin, machine, root));
    expect(await restored.load("match-1")).toEqual({ phase: "cancelled" });
    await restored.save("match-1", { phase: "cancelled" });
    await expect(restored.save("match-1", record())).rejects.toThrow("RUNNER_JOURNAL_INVALID");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ phase: "cancelled" });
  });

  it("rejects extra cancellation fields and cannot erase a known archive with a bare tombstone", async () => {
    const first = await fixture();
    await expect(
      first.journal.save("match-1", { phase: "cancelled", command: "extra" } as never),
    ).rejects.toThrow("RUNNER_JOURNAL_INVALID");
    const second = await fixture();
    const known = record();
    await second.journal.save("match-1", known);
    await expect(second.journal.save("match-1", { phase: "cancelled" })).rejects.toThrow(
      "RUNNER_JOURNAL_INVALID",
    );
    expect(JSON.parse(await readFile(second.file, "utf8"))).toEqual(known);
  });

  it("never lets a delayed ready snapshot reopen a durable stop fence", async () => {
    const f = await fixture();
    const ready = { ...record(), phase: "ready" as const };
    await f.journal.save("match-1", ready);
    await f.journal.save("match-1", { ...ready, phase: "terminal" });
    // A fence can retain the in-flight running archive until the loop has settled.
    expect(await f.journal.load("match-1")).toMatchObject({ archive: { status: "running" } });
    await expect(f.journal.save("match-1", ready)).rejects.toThrow("RUNNER_JOURNAL_INVALID");
    expect(JSON.parse(await readFile(f.file, "utf8")).phase).toBe("terminal");
  });

  it("persists all current phases, accepted plies and terminal digest tombstones across reopen", async () => {
    const { root, journal, directory, file } = await fixture();
    expect(await journal.load("absent")).toBeUndefined();
    const value = record();
    for (const phase of ["offered", "ready", "uncertain", "terminal"] as const) {
      value.phase = phase;
      if (phase === "terminal") {
        submitMove(value.archive, boardAt(value.archive), "e2e4");
        value.confirmedPly = 1;
        finishMatch(value.archive, "*", "cancelled", "stopped");
      }
      await journal.save("match-1", value);
      expect(await journal.load("match-1")).toEqual(value);
    }
    expect(await readdir(directory)).toEqual(["journal.lock", "match-1.json"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(value);
    if (process.platform !== "win32") {
      expect((await lstat(file)).mode & 0o777).toBe(0o600);
      expect((await lstat(join(directory, "journal.lock"))).mode & 0o777).toBe(0o600);
      for (const path of [root, dirname(directory), directory])
        expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    await journal.close();
    const restored = track(await openRunnerJournal(origin, machine, root));
    expect(await restored.load("match-1")).toEqual(value);
    await expect(restored.save("match-1", { ...value, digest: "b".repeat(64) })).rejects.toThrow(
      "RUNNER_JOURNAL_INVALID",
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(value);
    await expect(restored.close()).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
  });

  it("uses the configured root and domain-separated, framed origin/machine scopes", async () => {
    const root = await temporaryRoot();
    faults.defaultRoot = root;
    for (const [site, id] of [
      [origin, machine],
      ["a\0b", "c"],
      ["a", "b\0c"],
    ]) {
      const journal = track(await openRunnerJournal(site ?? "", id ?? ""));
      await journal.close();
    }
    const names = await readdir(join(root, "runner-games"));
    expect(names).toHaveLength(3);
    for (const name of names) expect(name).toMatch(/^[a-f0-9]{64}$/);
    const reopened = track(await openRunnerJournal(origin, machine, root));
    await reopened.close();
    expect(await readdir(join(root, "runner-games"))).toEqual(names);
  });

  it("refuses live handles and processes, then reclaims an exactly identified dead owner", async () => {
    const { root, journal } = await fixture();
    await expect(openRunnerJournal(origin, machine, root)).rejects.toThrow("RUNNER_JOURNAL_LOCKED");
    expect((await child(root, true)).stdout).toBe("RUNNER_JOURNAL_LOCKED");
    await journal.close();
    expect((await child(root, false)).stdout).toBe("opened");
    const restored = track(await openRunnerJournal(origin, machine, root));
    await restored.close();
  });

  it("serializes detached snapshots and waits for queued saves before closing", async () => {
    const { root, journal } = await fixture();
    const value = record();
    const offered = structuredClone(value);
    const first = journal.save("match-1", value);
    value.phase = "ready";
    const loaded = journal.load("match-1");
    const second = journal.save("match-1", value);
    value.archive.config.white.name = "caller mutation";
    value.digest = "b".repeat(64);
    const closed = journal.close();
    expect(journal.close()).toBe(closed);
    await Promise.all([first, second, closed]);
    const detached = await loaded;
    expect(detached).toEqual(offered);
    if (detached?.phase === "cancelled") throw new Error("Expected game record");
    if (detached) detached.archive.config.white.name = "returned mutation";
    await expect(journal.load("match-1")).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
    const restored = track(await openRunnerJournal(origin, machine, root));
    expect(await restored.load("match-1")).toEqual({ ...offered, phase: "ready" });
    const again = await restored.load("match-1");
    if (again?.phase === "cancelled") throw new Error("Expected game record");
    if (again) again.digest = "c".repeat(64);
    expect(await restored.load("match-1")).toMatchObject({ digest: offered.digest });
  });

  it.each(["../escape", "/absolute", "a/b", "a\\b", ".", "", "a\n", "x".repeat(129)])(
    "rejects unsafe match ID %j and poisons the handle",
    async (id) => {
      const { root, journal, directory } = await fixture();
      await expect(journal.save(id, record())).rejects.toThrow("RUNNER_JOURNAL_INVALID");
      await expect(journal.load("safe")).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
      await expect(journal.close()).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
      expect(await readdir(directory)).toEqual(["journal.lock"]);
      await expect(openRunnerJournal(origin, machine, root)).rejects.toThrow(
        "RUNNER_JOURNAL_LOCKED",
      );
    },
  );

  it.each([
    (value: RunnerGameRecord) => ({ ...value, digest: "bad" }),
    (value: RunnerGameRecord) => ({ ...value, confirmedPly: -1 }),
    (value: RunnerGameRecord) => ({ ...value, confirmedPly: 0.5 }),
    (value: RunnerGameRecord) => ({ ...value, confirmedPly: 1 }),
    (value: RunnerGameRecord) => ({ ...value, phase: "old-phase" }),
    (value: RunnerGameRecord) => ({ ...value, key: "forbidden-extra-field" }),
    (value: RunnerGameRecord) => ({ ...value, archive: { ...value.archive, turn: undefined } }),
    (value: RunnerGameRecord) => ({
      ...value,
      archive: { ...value.archive, config: { ...value.archive.config, extra: true } },
    }),
    (value: RunnerGameRecord) => {
      value.archive.config.prompt.hash = "f".repeat(64);
      return value;
    },
  ])("rejects malformed or non-current records (%#)", async (change) => {
    const { journal } = await fixture();
    await expect(journal.save("match-1", change(record()) as RunnerGameRecord)).rejects.toThrow(
      "RUNNER_JOURNAL_INVALID",
    );
    await expect(journal.save("match-1", record())).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
  });

  it.each(["{broken", JSON.stringify({ version: 0 }), " ".repeat(MAX_ARCHIVE_BYTES + 1025)])(
    "fails closed on corrupt or oversized disk records (%#)",
    async (contents) => {
      const { root, journal, file } = await fixture();
      await writeFile(file, contents, { mode: 0o600 });
      await expect(journal.load("match-1")).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
      await expect(journal.close()).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
      await expect(openRunnerJournal(origin, machine, root)).rejects.toThrow(
        "RUNNER_JOURNAL_LOCKED",
      );
    },
  );

  it("replays archives rather than trusting forged accepted moves", async () => {
    const { journal, file } = await fixture();
    const value = record();
    submitMove(value.archive, boardAt(value.archive), "e2e4");
    const event = value.archive.events[0];
    if (event?.type !== "attempt") throw new Error("missing test move");
    event.fen = event.before;
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    await expect(journal.load("match-1")).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
  });

  it("accepts the shared canonical archive limit and rejects one byte over it", async () => {
    const { journal } = await fixture();
    const value = recordOfSize(MAX_ARCHIVE_BYTES);
    expect(archiveByteLength(value.archive)).toBe(MAX_ARCHIVE_BYTES);
    await journal.save("match-1", value);
    expect(await journal.load("match-1")).toEqual(value);
    const event = value.archive.events[0];
    if (event?.type !== "tool") throw new Error("missing padding event");
    event.output += "x";
    await expect(journal.save("match-1", value)).rejects.toThrow("RUNNER_JOURNAL_INVALID");
  });

  it("does not silently recreate or change a durably known digest", async () => {
    const { journal, file } = await fixture();
    await journal.save("match-1", record());
    await unlink(file);
    await expect(journal.save("match-1", record())).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
  });

  it.each(["root", "games", "scope", "file"])("rejects a symlink at %s", async (target) => {
    if (process.platform === "win32") return;
    const { root, journal, directory, file } = await fixture();
    await journal.close();
    const outside = await temporaryRoot();
    if (target === "file") {
      const value = join(outside, "value.json");
      await writeFile(value, JSON.stringify(record()), { mode: 0o600 });
      await symlink(value, file);
      const reopened = track(await openRunnerJournal(origin, machine, root));
      await expect(reopened.load("match-1")).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
    } else {
      const path = target === "root" ? root : target === "games" ? dirname(directory) : directory;
      await rm(path, { recursive: true });
      await symlink(outside, path);
      await expect(openRunnerJournal(origin, machine, root)).rejects.toThrow(
        "RUNNER_JOURNAL_STORAGE",
      );
    }
  });

  it.each(["root", "games", "scope", "file"])(
    "rejects public permissions at %s",
    async (target) => {
      if (process.platform === "win32") return;
      const { root, journal, directory, file } = await fixture();
      await journal.save("match-1", record());
      if (target === "file") {
        await chmod(file, 0o644);
        await expect(journal.load("match-1")).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
      } else {
        await journal.close();
        const path = target === "root" ? root : target === "games" ? dirname(directory) : directory;
        await chmod(path, 0o755);
        await expect(openRunnerJournal(origin, machine, root)).rejects.toThrow(
          "RUNNER_JOURNAL_STORAGE",
        );
      }
    },
  );

  it("rejects the wrong owner without fixing permissions or following the path", async () => {
    if (process.platform === "win32") return;
    const { root, journal } = await fixture();
    await journal.close();
    faults.wrongOwner = true;
    await expect(openRunnerJournal(origin, machine, root)).rejects.toThrow(
      "RUNNER_JOURNAL_STORAGE",
    );
  });

  it.each(["write", "sync", "rename", "directorySync"] as const)(
    "poisons and keeps its lock after injected %s failure, cleaning temporary files",
    async (fault) => {
      if (fault === "directorySync" && process.platform === "win32") return;
      const { root, journal, directory, file, lock } = await fixture();
      const original = record();
      await journal.save("match-1", original);
      faults[fault] = true;
      await expect(journal.save("match-1", { ...original, phase: "uncertain" })).rejects.toThrow(
        /^RUNNER_JOURNAL_STORAGE$/,
      );
      faults[fault] = false;
      expect(await readdir(directory)).toEqual(["journal.lock", "match-1.json"]);
      expect(JSON.parse(await readFile(file, "utf8")).phase).toBe(
        fault === "directorySync" ? "uncertain" : "offered",
      );
      await expect(journal.load("match-1")).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
      await expect(journal.close()).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
      expect((await lstat(lock)).isFile()).toBe(true);
      await expect(openRunnerJournal(origin, machine, root)).rejects.toThrow(
        "RUNNER_JOURNAL_LOCKED",
      );
    },
  );

  it("syncs new and existing ancestor entries, refusing a failed parent directory sync", async () => {
    if (process.platform === "win32") return;
    const parent = await temporaryRoot();
    const root = join(parent, "new-root");
    faults.failSyncPath = parent;
    await expect(openRunnerJournal(origin, machine, root)).rejects.toThrow(
      "RUNNER_JOURNAL_STORAGE",
    );
    faults.failSyncPath = undefined;
    const journal = track(await openRunnerJournal(origin, machine, root));
    const [scope] = await readdir(join(root, "runner-games"));
    expect(faults.synced).toContain(parent);
    expect(faults.synced).toContain(root);
    expect(faults.synced).toContain(join(root, "runner-games"));
    expect(faults.synced).toContain(join(root, "runner-games", scope ?? "missing"));
    await journal.close();
  });

  it("failed initialization never publishes partial ownership or strands an acquisition guard", async () => {
    const { root, journal, directory, lock } = await fixture();
    await journal.close();
    faults.sync = true;
    await expect(openRunnerJournal(origin, machine, root)).rejects.toThrow(
      "RUNNER_JOURNAL_STORAGE",
    );
    faults.sync = false;
    expect((await lstat(lock)).isFile()).toBe(true);
    expect(await readdir(directory)).toEqual(["journal.lock", "journal.lock.released"]);
    const restored = track(await openRunnerJournal(origin, machine, root));
    await restored.close();
  });

  it("release is immutable and cannot unlink an active successor", async () => {
    const { root, journal, lock } = await fixture();
    await journal.close();
    const restored = track(await openRunnerJournal(origin, machine, root));
    await journal.close();
    expect((await lstat(lock)).isFile()).toBe(true);
    await expect(openRunnerJournal(origin, machine, root)).rejects.toThrow("RUNNER_JOURNAL_LOCKED");
    await restored.close();
  });

  it("only releases its own lock", async () => {
    const { journal, directory, lock } = await fixture();
    const replacement = join(directory, "replacement");
    await writeFile(replacement, "other process", { mode: 0o600 });
    await rename(replacement, lock);
    await expect(journal.close()).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
    expect(await readFile(lock, "utf8")).toBe("other process");
  });

  it("refuses work after its lock is removed or replaced", async () => {
    const { journal, lock } = await fixture();
    await unlink(lock);
    await expect(journal.save("match-1", record())).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
    await expect(journal.close()).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
  });

  it("sanitizes a read IO failure and retains the poisoned lock", async () => {
    const { root, journal } = await fixture();
    await journal.save("match-1", record());
    faults.read = true;
    await expect(journal.load("match-1")).rejects.toThrow(/^RUNNER_JOURNAL_STORAGE$/);
    faults.read = false;
    await expect(journal.close()).rejects.toThrow("RUNNER_JOURNAL_STORAGE");
    await expect(openRunnerJournal(origin, machine, root)).rejects.toThrow("RUNNER_JOURNAL_LOCKED");
  });

  it("creates a private missing config parent without a recursive symlink traversal", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "missing-parent", "config");
    const journal = track(await openRunnerJournal(origin, machine, root));
    await journal.save("A_9-z", record());
    await journal.close();
    if (process.platform !== "win32") expect((await lstat(dirname(root))).mode & 0o777).toBe(0o700);
  });
});
