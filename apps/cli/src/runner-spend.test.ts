import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recoverRunner } from "./runner-recovery";
import { openRunnerSpend, RunnerSpendError, spendingAuthorityId } from "./runner-spend";

const faults = vi.hoisted(() => ({
  rename: false,
  fenceLink: false,
  directorySync: false,
  wrongOwner: false,
  defaultFile: undefined as string | undefined,
  failSyncPath: undefined as string | undefined,
  syncedDirectories: [] as string[],
}));
vi.mock("./paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths")>();
  return {
    ...actual,
    runnerSpendFile: (id: string) => faults.defaultFile ?? actual.runnerSpendFile(id),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (faults.fenceLink && String(args[1]).endsWith(".blocked"))
        throw new Error("fence unavailable");
      return actual.link(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args);
      if (faults.wrongOwner) Object.defineProperty(stat, "uid", { value: Number(stat.uid) + 1 });
      return stat;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if ((await handle.stat()).isDirectory()) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          const path = String(args[0]);
          faults.syncedDirectories.push(path);
          if (faults.directorySync || faults.failSyncPath === path)
            throw new Error("deliberate directory sync failure");
          await sync();
        };
      }
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename && !String(args[1]).endsWith(".receipt"))
        throw new Error("deliberate test failure with private path");
      return actual.rename(...args);
    },
  };
});

const cleanup: (() => Promise<void>)[] = [];
const authorityId = spendingAuthorityId("synthetic-test-provider-key");

async function fixture(now: () => number = () => 1_000_000, monotonicNow: () => number = () => 0) {
  const root = resolve(".turbo");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "runner-spend-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "authority.json");
  const ledger = await openRunnerSpend({ authorityId, file, now, monotonicNow });
  cleanup.push(() => ledger.close());
  return { directory, file, ledger };
}

async function resolveBeforeReopen(file: string) {
  await expect(openRunnerSpend({ authorityId, file })).rejects.toMatchObject({ code: "UNCERTAIN" });
  const clockMs: number = JSON.parse(await readFile(file, "utf8")).clockMs;
  await recoverRunner({
    authorityId,
    spendFile: file,
    journalRoot: join(file, ".."),
    resolve: true,
    now: () => clockMs,
  });
}

function reservation(requestId = "local-request-1", overrides = {}) {
  return {
    matchId: "local-match-1",
    requestId,
    micros: 10,
    matchLimitMicros: 100,
    dayLimitMicros: 100,
    ...overrides,
  };
}

afterEach(async () => {
  faults.rename = false;
  faults.fenceLink = false;
  faults.directorySync = false;
  faults.wrongOwner = false;
  faults.defaultFile = undefined;
  faults.failSyncPath = undefined;
  faults.syncedDirectories.length = 0;
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

describe("durable runner spending authority", () => {
  it("hashes only key authority without publishing key or tying it to a website", () => {
    expect(authorityId).toMatch(/^[a-f0-9]{64}$/);
    expect(authorityId).not.toContain("synthetic-test-provider-key");
    expect(spendingAuthorityId("same-key")).toBe(spendingAuthorityId("same-key"));
    expect(spendingAuthorityId("other-key")).not.toBe(spendingAuthorityId("same-key"));
    expect(() => spendingAuthorityId("")).toThrow("RUNNER_SPEND_INVALID");
  });

  it("durably combines both sides and website-origin match activity", async () => {
    const { ledger, file } = await fixture();
    await ledger.reserve(reservation("white-attempt", { micros: 45 }));
    await ledger.reserve(reservation("black-attempt", { micros: 45 }));
    await expect(ledger.reserve(reservation("white-retry", { micros: 11 }))).rejects.toMatchObject({
      code: "MATCH_LIMIT",
    });
    // A new website/claim cannot reset the shared key's daily total.
    await expect(
      ledger.reserve(reservation("other-origin-attempt", { matchId: "local-match-2", micros: 11 })),
    ).rejects.toMatchObject({ code: "DAY_LIMIT" });
    const persisted = JSON.parse(await readFile(file, "utf8"));
    expect(persisted.records).toHaveLength(2);
    expect(ledger.snapshot().dayMicros).toBe(90);
    expect(ledger.snapshot().matches.get("local-match-1")).toBe(90);
    expect(await readFile(file, "utf8")).not.toContain("synthetic-test-provider-key");
  });

  it("serializes overlapping requests before accepting a combined bound", async () => {
    const { ledger } = await fixture();
    const results = await Promise.allSettled([
      ledger.reserve(reservation("white", { micros: 60 })),
      ledger.reserve(reservation("black", { micros: 60 })),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(ledger.snapshot().dayMicros).toBe(60);
  });

  it("keeps timeout/failure/unknown reservations and request replay fences across restart", async () => {
    const { ledger, file } = await fixture();
    await ledger.reserve(reservation("locally-generated-unknown-attempt", { micros: 70 }));
    await ledger.close();
    await resolveBeforeReopen(file);
    const restored = await openRunnerSpend({
      authorityId,
      file,
      now: () => 1_000_100,
      monotonicNow: () => 0,
    });
    cleanup.push(() => restored.close());
    await expect(
      restored.reserve(reservation("locally-generated-unknown-attempt")),
    ).rejects.toMatchObject({
      code: "REPLAY",
    });
    await expect(
      restored.reserve(reservation("new-attempt", { micros: 31 })),
    ).rejects.toMatchObject({
      code: "MATCH_LIMIT",
    });
    expect(restored.snapshot().dayMicros).toBe(70);
  });

  it("settles a known response durably to actual cost and frees both match and day capacity", async () => {
    const { ledger, file } = await fixture();
    await ledger.reserve(reservation("known-success", { micros: 100 }));
    await ledger.settle({ requestId: "known-success", micros: 30 });
    expect(ledger.snapshot().dayMicros).toBe(30);
    expect(ledger.snapshot().matches.get("local-match-1")).toBe(30);
    expect(JSON.parse(await readFile(file, "utf8")).records[0]).toMatchObject({
      reservedMicros: 100,
      micros: 30,
      settled: true,
    });
    await ledger.reserve(reservation("next-white-or-black-request", { micros: 70 }));
    expect(ledger.snapshot().dayMicros).toBe(100);
    await ledger.close();
    await resolveBeforeReopen(file);
    const restored = await openRunnerSpend({ authorityId, file, now: () => 1_000_100 });
    cleanup.push(() => restored.close());
    expect(restored.snapshot().dayMicros).toBe(100);
    await restored.settle({ requestId: "known-success", micros: 30 });
    await expect(restored.reserve(reservation("known-success"))).rejects.toMatchObject({
      code: "REPLAY",
    });
  });

  it("serializes settlement with new reservations and preserves exact combined sums", async () => {
    const { ledger } = await fixture();
    await ledger.reserve(reservation("first", { micros: 80 }));
    await Promise.all([
      ledger.settle({ requestId: "first", micros: 20 }),
      ledger.reserve(reservation("second", { micros: 80 })),
    ]);
    expect(ledger.snapshot().dayMicros).toBe(100);
    await Promise.all([
      ledger.settle({ requestId: "second", micros: 10 }),
      ledger.reserve(reservation("third", { matchId: "other-origin-match", micros: 70 })),
    ]);
    expect(ledger.snapshot().dayMicros).toBe(100);
    expect(ledger.snapshot().matches.get("local-match-1")).toBe(30);
  });

  it("only settles known reservations once, with exact-repeat idempotency", async () => {
    const { ledger } = await fixture();
    await ledger.reserve(reservation("known", { micros: 100 }));
    await expect(ledger.settle({ requestId: "missing", micros: 1 })).rejects.toMatchObject({
      code: "INVALID",
    });
    for (const micros of [-1, 0.5, Number.NaN])
      await expect(ledger.settle({ requestId: "known", micros })).rejects.toMatchObject({
        code: "INVALID",
      });
    expect(ledger.snapshot().dayMicros).toBe(100);
    await ledger.settle({ requestId: "known", micros: 40 });
    await ledger.settle({ requestId: "known", micros: 40 });
    expect(ledger.snapshot().dayMicros).toBe(40);
  });

  it("blocks further authority, including restart, when actual cost exceeds its reservation", async () => {
    const { ledger, file } = await fixture();
    await ledger.reserve(reservation("overbound", { micros: 100 }));
    await expect(ledger.settle({ requestId: "overbound", micros: 101 })).rejects.toMatchObject({
      code: "SETTLEMENT",
    });
    await expect(ledger.reserve(reservation("after-overbound"))).rejects.toMatchObject({
      code: "STORAGE",
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      blocked: true,
      records: [{ reservedMicros: 100, micros: 100, settled: false }],
    });
    await ledger.close();
    await expect(openRunnerSpend({ authorityId, file })).rejects.toMatchObject({
      code: "SETTLEMENT",
    });
  });

  it.each([
    { settled: 40, contradictory: 30 },
    { settled: 30, contradictory: 40 },
  ])(
    "blocks a contradictory cost $settled->$contradictory and restores its full hold",
    async ({ settled, contradictory }) => {
      const { ledger, file } = await fixture();
      await ledger.reserve(reservation("contradictory", { micros: 100 }));
      await ledger.settle({ requestId: "contradictory", micros: settled });
      await expect(
        ledger.settle({ requestId: "contradictory", micros: contradictory }),
      ).rejects.toMatchObject({ code: "SETTLEMENT" });
      await expect(ledger.reserve(reservation("after-contradiction"))).rejects.toMatchObject({
        code: "STORAGE",
      });
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        blocked: true,
        records: [{ reservedMicros: 100, micros: 100, settled: false }],
      });
      await ledger.close();
      await expect(openRunnerSpend({ authorityId, file })).rejects.toMatchObject({
        code: "SETTLEMENT",
      });
    },
  );

  it("poisons authority if durable settlement fails, leaving the full reservation on restart", async () => {
    const { ledger, file } = await fixture();
    await ledger.reserve(reservation("settlement-write-failure", { micros: 100 }));
    faults.rename = true;
    await expect(
      ledger.settle({ requestId: "settlement-write-failure", micros: 10 }),
    ).rejects.toMatchObject({ code: "STORAGE" });
    faults.rename = false;
    await expect(
      ledger.reserve(reservation("after-settlement-write-failure")),
    ).rejects.toMatchObject({ code: "STORAGE" });
    await ledger.close();
    await resolveBeforeReopen(file);
    const restored = await openRunnerSpend({ authorityId, file, now: () => 1_000_100 });
    cleanup.push(() => restored.close());
    expect(restored.snapshot().dayMicros).toBe(100);
  });

  it("still durably blocks overbilling if the independent permanent-fence publication fails", async () => {
    const { ledger, file } = await fixture();
    await ledger.reserve(reservation("overbilling", { micros: 100 }));
    faults.fenceLink = true;
    await expect(ledger.settle({ requestId: "overbilling", micros: 101 })).rejects.toMatchObject({
      code: "SETTLEMENT",
    });
    await ledger.close();
    await expect(openRunnerSpend({ authorityId, file })).rejects.toMatchObject({
      code: "SETTLEMENT",
    });
    const inspected = await recoverRunner({
      authorityId,
      spendFile: file,
      journalRoot: join(file, ".."),
      resolve: false,
    });
    expect(inspected.blocked).toBe(true);
    await expect(
      recoverRunner({ authorityId, spendFile: file, journalRoot: join(file, ".."), resolve: true }),
    ).rejects.toThrow("BLOCKED");
  });

  it.each([
    { settled: undefined, contradictory: 101 },
    { settled: 40, contradictory: 30 },
    { settled: 30, contradictory: 40 },
  ])(
    "retains the lock when cost $settled->$contradictory cannot be blocked durably",
    async ({ settled, contradictory }) => {
      const { ledger, file } = await fixture();
      await ledger.reserve(reservation("block-write-failure", { micros: 100 }));
      if (settled !== undefined)
        await ledger.settle({ requestId: "block-write-failure", micros: settled });
      faults.rename = true;
      await expect(
        ledger.settle({ requestId: "block-write-failure", micros: contradictory }),
      ).rejects.toMatchObject({ code: "STORAGE" });
      faults.rename = false;
      await expect(ledger.close()).rejects.toMatchObject({ code: "STORAGE" });
      await expect(openRunnerSpend({ authorityId, file })).rejects.toMatchObject({
        code: "LOCKED",
      });
      expect(JSON.parse(await readFile(file, "utf8")).records[0].micros).toBe(settled ?? 100);
    },
  );

  it("has a rolling 24-hour day rather than a midnight reset", async () => {
    let now = 86_399_999;
    const { ledger } = await fixture(() => now);
    await ledger.reserve(reservation("before-midnight", { micros: 100 }));
    now += 2;
    await expect(
      ledger.reserve(reservation("after-midnight", { matchId: "match-2", micros: 1 })),
    ).rejects.toMatchObject({ code: "DAY_LIMIT" });
    now = 86_399_999 + 86_400_000;
    await ledger.reserve(reservation("after-full-day", { matchId: "match-2", micros: 100 }));
    expect(ledger.snapshot().dayMicros).toBe(100);
  });

  it("holds the high-water clock after rollback and advances with actual monotonic time", async () => {
    let now = 2 * 86_400_000;
    let monotonic = 0;
    const { ledger, file } = await fixture(
      () => now,
      () => monotonic,
    );
    await ledger.reserve(reservation("before-rollback", { micros: 100 }));
    now = 1;
    monotonic = 86_400_000 - 1;
    await expect(
      ledger.reserve(reservation("too-soon", { matchId: "match-2", micros: 1 })),
    ).rejects.toMatchObject({ code: "DAY_LIMIT" });
    await ledger.close();
    await resolveBeforeReopen(file);
    const restored = await openRunnerSpend({
      authorityId,
      file,
      now: () => 1,
      monotonicNow: () => 0,
    });
    cleanup.push(() => restored.close());
    expect(restored.snapshot().dayMicros).toBe(100);
  });

  it("does not let a second process acquire the same authority", async () => {
    const { file } = await fixture();
    const source = `import { openRunnerSpend } from ${JSON.stringify(new URL("./runner-spend.ts", import.meta.url).href)}; try { const ledger = await openRunnerSpend(${JSON.stringify({ authorityId, file })}); await ledger.close(); process.exitCode = 7; } catch (error) { if (error.code !== "LOCKED") process.exitCode = 8; }`;
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      {
        timeout: 15_000,
      },
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("rejects a PID-only legacy record without guessing owner identity", async () => {
    const { ledger, file } = await fixture();
    await ledger.close();
    await writeFile(`${file}.lock`, "999999999\n", { mode: 0o600 });
    await expect(openRunnerSpend({ authorityId, file })).rejects.toMatchObject({ code: "STORAGE" });
  });

  it("refuses an existing shared ledger directory without chmodding it", async () => {
    if (process.platform === "win32") return;
    const { ledger, file, directory } = await fixture();
    await ledger.close();
    await chmod(directory, 0o755);
    await expect(openRunnerSpend({ authorityId, file })).rejects.toMatchObject({ code: "STORAGE" });
    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
  });

  it("refuses a symlinked ledger directory without touching its target", async () => {
    if (process.platform === "win32") return;
    const { ledger, directory } = await fixture();
    await ledger.close();
    const target = join(directory, "target");
    const link = join(directory, "symlink-directory");
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, "sentinel"), "unchanged");
    await symlink(target, link, "dir");
    await expect(
      openRunnerSpend({ authorityId, file: join(link, "spend.json") }),
    ).rejects.toMatchObject({ code: "STORAGE" });
    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("unchanged");
    await expect(readFile(join(target, "spend.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("validates the default app root before creating the authority directory", async () => {
    if (process.platform === "win32") return;
    const { ledger, directory } = await fixture();
    await ledger.close();
    const root = join(directory, "app-root");
    await mkdir(root, { mode: 0o755 });
    faults.defaultFile = join(root, "spend-v1", `${authorityId}.json`);
    await expect(openRunnerSpend({ authorityId })).rejects.toMatchObject({ code: "STORAGE" });
    await expect(lstat(join(root, "spend-v1"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(root, { recursive: true });
    const target = join(directory, "app-root-target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, root, "dir");
    await expect(openRunnerSpend({ authorityId })).rejects.toMatchObject({ code: "STORAGE" });
    await expect(lstat(join(target, "spend-v1"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a directory owned by another uid", async () => {
    if (process.platform === "win32") return;
    const { ledger, file } = await fixture();
    await ledger.close();
    faults.wrongOwner = true;
    await expect(openRunnerSpend({ authorityId, file })).rejects.toMatchObject({ code: "STORAGE" });
  });

  it("syncs every ancestor before lock or authority, including retry after interrupted creation", async () => {
    if (process.platform === "win32") return;
    const { ledger, directory } = await fixture();
    await ledger.close();
    const root = join(directory, "new-app-root");
    const spendDirectory = join(root, "spend-v1");
    const file = join(spendDirectory, `${authorityId}.json`);
    faults.defaultFile = file;
    faults.syncedDirectories.length = 0;
    faults.failSyncPath = directory;
    await expect(openRunnerSpend({ authorityId })).rejects.toMatchObject({ code: "STORAGE" });
    expect(faults.syncedDirectories).toEqual([directory]);
    await expect(lstat(spendDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    faults.syncedDirectories.length = 0;
    faults.failSyncPath = root;
    await expect(openRunnerSpend({ authorityId })).rejects.toMatchObject({ code: "STORAGE" });
    expect(faults.syncedDirectories).toEqual([directory, root]);
    await expect(lstat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });

    faults.syncedDirectories.length = 0;
    faults.failSyncPath = undefined;
    const restored = await openRunnerSpend({ authorityId, now: () => 1_000_000 });
    cleanup.push(() => restored.close());
    expect(faults.syncedDirectories).toEqual([
      directory,
      root,
      spendDirectory,
      spendDirectory,
      spendDirectory,
    ]);
    await restored.reserve(reservation("first-request-after-durable-ancestors"));
    expect(faults.syncedDirectories.at(-1)).toBe(spendDirectory);
    expect(restored.snapshot().dayMicros).toBe(10);
  });

  it("fails closed on corrupt, wrong-authority or publicly-readable stored state", async () => {
    const { ledger, file } = await fixture();
    await ledger.close();
    const contents = await readFile(file, "utf8");
    await writeFile(file, "{broken");
    await expect(openRunnerSpend({ authorityId, file })).rejects.toMatchObject({ code: "STORAGE" });
    await writeFile(file, contents);
    await expect(
      openRunnerSpend({ authorityId: spendingAuthorityId("other"), file }),
    ).rejects.toMatchObject({ code: "STORAGE" });
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      await expect(openRunnerSpend({ authorityId, file })).rejects.toMatchObject({
        code: "STORAGE",
      });
    }
  });

  it("fails closed without exposing disk exceptions when atomic persistence fails", async () => {
    const { ledger, file } = await fixture();
    await ledger.reserve(reservation("known", { micros: 70 }));
    faults.rename = true;
    const failure = await ledger
      .reserve(reservation("failed-write"))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunnerSpendError);
    expect(String(failure)).toBe("RunnerSpendError: RUNNER_SPEND_STORAGE");
    faults.rename = false;
    await expect(ledger.reserve(reservation("after-failed-write"))).rejects.toMatchObject({
      code: "STORAGE",
    });
    await ledger.close();
    await resolveBeforeReopen(file);
    const restored = await openRunnerSpend({ authorityId, file, now: () => 1_000_100 });
    cleanup.push(() => restored.close());
    expect(restored.snapshot().dayMicros).toBe(70);
  });

  it("keeps a post-rename uncertain reservation after directory fsync failure", async () => {
    if (process.platform === "win32") return;
    const { ledger, file } = await fixture();
    faults.directorySync = true;
    await expect(
      ledger.reserve(reservation("unknown-after-rename", { micros: 90 })),
    ).rejects.toMatchObject({ code: "STORAGE" });
    faults.directorySync = false;
    await ledger.close();
    await resolveBeforeReopen(file);
    const restored = await openRunnerSpend({ authorityId, file, now: () => 1_000_100 });
    cleanup.push(() => restored.close());
    expect(restored.snapshot().dayMicros).toBe(90);
    await expect(restored.reserve(reservation("unknown-after-rename"))).rejects.toMatchObject({
      code: "REPLAY",
    });
  });

  it("rejects fractional, overflowing, negative and duplicate authorization", async () => {
    const { ledger } = await fixture();
    for (const micros of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
      await expect(ledger.reserve(reservation("invalid", { micros }))).rejects.toMatchObject({
        code: "INVALID",
      });
    await ledger.reserve(reservation("one-use"));
    await expect(ledger.reserve(reservation("one-use"))).rejects.toMatchObject({ code: "REPLAY" });
    await ledger.close();
    await expect(ledger.reserve(reservation("closed"))).rejects.toMatchObject({ code: "STORAGE" });
  });
});
