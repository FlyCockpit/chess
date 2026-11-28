import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunnerLimitController,
  type RunnerLimitPolicy,
  type RunnerLimitState,
  type RunnerLimitStore,
  type RunnerLimitUpdate,
  runnerLimitFileStore,
} from "./runner-limits";

const hard = { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 };
const update: RunnerLimitUpdate = {
  commandId: "command-1",
  matchMicros: 2_000_000,
  dayMicros: 20_000_000,
  concurrency: 3,
  expectedRevision: 0,
  revision: 1,
};
function memory(initial?: RunnerLimitState) {
  let state = initial ? structuredClone(initial) : undefined;
  const store: RunnerLimitStore = {
    load: vi.fn(async () => (state ? structuredClone(state) : undefined)),
    save: vi.fn(async (value) => {
      state = structuredClone(value);
    }),
    close: vi.fn(async (beforeRelease, afterRelease) => {
      beforeRelease?.();
      afterRelease?.();
    }),
  };
  return { store, state: () => state };
}
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "runner-limit-test-"));
  temporary.push(path);
  return path;
}
function policy(): RunnerLimitPolicy {
  return {
    applyOperatingLimits: vi.fn(),
    restoreOperatingLimits: vi.fn(),
    stopOperatingLimits: vi.fn(),
  };
}

describe("local runner operating limits", () => {
  it("persists before applying or acknowledging, and advertises only safe values", async () => {
    const storage = memory();
    const authority = policy();
    const terminal = vi.fn();
    const controls = await RunnerLimitController.open({
      hard,
      store: storage.store,
      terminal,
      policy: authority,
    });
    const result = await controls.apply(update);
    expect(result).toMatchObject({
      status: "applied",
      reason: "applied",
      revision: 1,
      hardLimits: hard,
    });
    expect(storage.store.save).toHaveBeenCalledTimes(2);
    expect(vi.mocked(storage.store.save).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(authority.applyOperatingLimits).mock.invocationCallOrder[0] ?? 0,
    );
    expect(controls.snapshot()).toEqual({
      operatingLimits: {
        matchMicros: 2_000_000,
        dayMicros: 20_000_000,
        concurrency: 3,
        revision: 1,
      },
      hardLimits: hard,
    });
    expect(terminal).toHaveBeenCalledWith(expect.stringContaining("revision 1"));
    expect(terminal).toHaveBeenCalledWith(expect.stringContaining("$25/match"));
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("baseUrl");
    await controls.close();
  });

  it.each([
    { matchMicros: hard.matchMicros + 1 },
    { dayMicros: hard.dayMicros + 1 },
    { concurrency: hard.concurrency + 1 },
  ])("rejects excess %j without clamping or changing revision", async (excess) => {
    const storage = memory();
    const authority = policy();
    const terminal = vi.fn();
    const controls = await RunnerLimitController.open({
      hard,
      store: storage.store,
      terminal,
      policy: authority,
    });
    const result = await controls.apply({ ...update, ...excess });
    expect(result).toMatchObject({
      status: "rejected",
      reason: "ceiling",
      operatingLimits: { revision: 0 },
    });
    expect(authority.applyOperatingLimits).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledWith(expect.stringContaining("above the local ceiling"));
    await controls.close();
  });

  it("rejects injected hard/provider fields before touching state", async () => {
    const storage = memory();
    const controls = await RunnerLimitController.open({
      hard,
      store: storage.store,
      terminal: vi.fn(),
    });
    for (const extra of [
      { hardLimits: hard },
      { baseUrl: "https://evil.example" },
      { apiKey: "must-not-send" },
      { allowModels: ["evil/model"] },
    ]) {
      await expect(controls.apply({ ...update, ...extra })).rejects.toThrow();
    }
    expect(storage.store.save).toHaveBeenCalledTimes(1);
    await controls.close();
  });

  it("serializes concurrent revisions and rejects a conflicting id", async () => {
    const controls = await RunnerLimitController.open({
      hard,
      store: memory().store,
      terminal: vi.fn(),
    });
    const [first, stale] = await Promise.all([
      controls.apply(update),
      controls.apply({ ...update, commandId: "concurrent", matchMicros: 3_000_000 }),
    ]);
    expect(first.status).toBe("applied");
    expect(stale.reason).toBe("stale");
    expect((await controls.apply({ ...update, matchMicros: 4_000_000 })).reason).toBe("stale");
    expect(controls.snapshot().operatingLimits.matchMicros).toBe(2_000_000);
    await controls.close();
  });

  it("replays a lost ACK across reconnect and process restart without applying twice", async () => {
    const storage = memory();
    const authority = policy();
    const terminal = vi.fn();
    const first = await RunnerLimitController.open({
      hard,
      store: storage.store,
      terminal,
      policy: authority,
    });
    const applied = await first.apply(update);
    expect(await first.apply(update)).toEqual(applied);
    expect(authority.applyOperatingLimits).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(2);
    await first.close();
    const resumedPolicy = policy();
    const resumed = await RunnerLimitController.open({
      hard,
      store: memory(storage.state()).store,
      terminal,
      policy: resumedPolicy,
    });
    expect(resumedPolicy.restoreOperatingLimits).toHaveBeenCalledWith(applied.operatingLimits);
    expect(await resumed.apply(update)).toEqual(applied);
    expect(resumedPolicy.applyOperatingLimits).not.toHaveBeenCalled();
    await resumed.close();
  });

  it("keeps refusals idempotent and allows a new command at the same current revision", async () => {
    const storage = memory();
    const controls = await RunnerLimitController.open({
      hard,
      store: storage.store,
      terminal: vi.fn(),
    });
    const bad = { ...update, matchMicros: hard.matchMicros + 1 };
    const refusal = await controls.apply(bad);
    expect(await controls.apply(bad)).toEqual(refusal);
    expect((await controls.apply(update)).reason).toBe("stale");
    expect((await controls.apply({ ...update, commandId: "fixed" })).status).toBe("applied");
    await controls.close();
  });

  it("replays a lost ACK with locally raised startup ceilings without reapplying the command", async () => {
    const storage = memory();
    const controls = await RunnerLimitController.open({
      hard,
      store: storage.store,
      terminal: vi.fn(),
    });
    const original = await controls.apply(update);
    await controls.close();
    const raisedHard = { matchMicros: 50_000_000, dayMicros: 500_000_000, concurrency: 16 };
    const authority = policy();
    const resumed = await RunnerLimitController.open({
      hard: raisedHard,
      store: memory(storage.state()).store,
      terminal: vi.fn(),
      policy: authority,
    });
    const replay = await resumed.apply(update);
    expect(replay).toEqual({ ...original, hardLimits: raisedHard });
    expect(replay.hardLimits).toEqual(resumed.snapshot().hardLimits);
    expect(authority.applyOperatingLimits).not.toHaveBeenCalled();
    expect(resumed.snapshot().operatingLimits).toEqual(original.operatingLimits);
    await resumed.close();
  });

  it("makes a local stop durable and refuses every later raise", async () => {
    const storage = memory();
    const authority = policy();
    const controls = await RunnerLimitController.open({
      hard,
      store: storage.store,
      terminal: vi.fn(),
      policy: authority,
    });
    await controls.stop();
    expect((await controls.apply(update)).reason).toBe("stopped");
    expect(authority.applyOperatingLimits).not.toHaveBeenCalled();
    await controls.close();
    const resumed = await RunnerLimitController.open({
      hard,
      store: memory(storage.state()).store,
      terminal: vi.fn(),
    });
    expect((await resumed.apply({ ...update, commandId: "later" })).reason).toBe("stopped");
    await resumed.close();
  });

  it("stops locally when persistence fails, without acknowledging an applied limit", async () => {
    const storage = memory();
    const authority = policy();
    const controls = await RunnerLimitController.open({
      hard,
      store: storage.store,
      terminal: vi.fn(),
      policy: authority,
    });
    vi.mocked(storage.store.save).mockRejectedValue(new Error("secret path"));
    const result = await controls.apply(update);
    expect(result).toMatchObject({
      status: "rejected",
      reason: "storage",
      operatingLimits: { revision: 0 },
    });
    expect(authority.applyOperatingLimits).not.toHaveBeenCalled();
    expect(authority.stopOperatingLimits).toHaveBeenCalled();
    await expect(controls.close()).rejects.toThrow("RUNNER_LIMIT_STORAGE");
    expect(storage.store.close).not.toHaveBeenCalled();
  });

  it("does not revive a local stop that races a durable change", async () => {
    const storage = memory();
    const authority = policy();
    const controls = await RunnerLimitController.open({
      hard,
      store: storage.store,
      terminal: vi.fn(),
      policy: authority,
    });
    let release: (() => void) | undefined;
    vi.mocked(storage.store.save).mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = controls.apply(update);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const stop = controls.stop();
    release?.();
    expect((await pending).status).toBe("rejected");
    await stop;
    expect(authority.applyOperatingLimits).not.toHaveBeenCalled();
    expect(storage.state()?.stopped).toBe(true);
    await controls.close();
  });

  it.each(["ceiling", "stale"])(
    "preserves a concurrent stop while persisting a %s refusal, including after restart",
    async (reason) => {
      const root = await directory();
      const fileStore = await runnerLimitFileStore("https://runner.example", "refusal-race", root);
      const store = { ...fileStore, save: vi.fn(fileStore.save), close: vi.fn(fileStore.close) };
      const controls = await RunnerLimitController.open({ hard, store, terminal: vi.fn() });
      let release: (() => void) | undefined;
      store.save.mockImplementationOnce(async (state) => {
        await fileStore.save(state);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const refused = {
        ...update,
        ...(reason === "ceiling"
          ? { matchMicros: hard.matchMicros + 1 }
          : { expectedRevision: 7, revision: 8 }),
      };
      const pending = controls.apply(refused);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const stopped = controls.stop();
      const closed = controls.close();
      expect(store.close).not.toHaveBeenCalled();
      release?.();
      expect((await pending).reason).toBe(reason);
      await stopped;
      await closed;
      const resumed = await RunnerLimitController.open({
        hard,
        store: await runnerLimitFileStore("https://runner.example", "refusal-race", root),
        terminal: vi.fn(),
      });
      expect((await resumed.apply({ ...update, commandId: "must-stay-stopped" })).reason).toBe(
        "stopped",
      );
      await resumed.close();
    },
  );

  it("a same-tick close followed by stop durably fences cancellation before unlocking", async () => {
    const root = await directory();
    const controls = await RunnerLimitController.open({
      hard,
      store: await runnerLimitFileStore("https://runner.example", "close-first", root),
      terminal: vi.fn(),
    });
    const released = vi.fn();
    const closing = controls.close(released);
    const stopping = controls.stop();
    await Promise.all([closing, stopping]);
    expect(released).toHaveBeenCalledOnce();
    const resumed = await RunnerLimitController.open({
      hard,
      store: await runnerLimitFileStore("https://runner.example", "close-first", root),
      terminal: vi.fn(),
    });
    expect((await resumed.apply(update)).reason).toBe("stopped");
    await resumed.close();
  });

  it("rechecks cancellation after asynchronous release preparation and before the final atomic unlock", async () => {
    const root = await directory();
    const fileStore = await runnerLimitFileStore("https://runner.example", "release-race", root);
    let release: (() => void) | undefined;
    let block = true;
    const close = vi.fn<RunnerLimitStore["close"]>(async (before, after) => {
      if (block) {
        block = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await fileStore.close(before, after);
    });
    const controls = await RunnerLimitController.open({
      hard,
      store: { ...fileStore, close },
      terminal: vi.fn(),
    });
    const released = vi.fn();
    const closing = controls.close(released);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const stopping = controls.stop();
    expect(released).not.toHaveBeenCalled();
    await expect(
      runnerLimitFileStore("https://runner.example", "release-race", root),
    ).rejects.toThrow();
    release?.();
    await Promise.all([closing, stopping]);
    expect(close).toHaveBeenCalledTimes(2);
    expect(released).toHaveBeenCalledOnce();
    const resumed = await RunnerLimitController.open({
      hard,
      store: await runnerLimitFileStore("https://runner.example", "release-race", root),
      terminal: vi.fn(),
    });
    expect((await resumed.apply(update)).reason).toBe("stopped");
    await resumed.close();
  });

  it("refuses a stop after complete release instead of claiming an unpersisted cancellation", async () => {
    const root = await directory();
    const controls = await RunnerLimitController.open({
      hard,
      store: await runnerLimitFileStore("https://runner.example", "already-closed", root),
      terminal: vi.fn(),
    });
    await controls.close();
    await expect(controls.stop()).rejects.toThrow("RUNNER_LIMIT_CLOSED");
    const resumed = await RunnerLimitController.open({
      hard,
      store: await runnerLimitFileStore("https://runner.example", "already-closed", root),
      terminal: vi.fn(),
    });
    expect((await resumed.apply(update)).status).toBe("applied");
    await resumed.close();
  });

  it("keeps the lock and release callback intact when release preparation fails", async () => {
    const root = await directory();
    const fileStore = await runnerLimitFileStore("https://runner.example", "release-failed", root);
    const controls = await RunnerLimitController.open({
      hard,
      store: {
        ...fileStore,
        close: async () => {
          throw new Error("unavailable");
        },
      },
      terminal: vi.fn(),
    });
    const released = vi.fn();
    await expect(controls.close(released)).rejects.toThrow("RUNNER_LIMIT_STORAGE");
    expect(released).not.toHaveBeenCalled();
    await expect(
      runnerLimitFileStore("https://runner.example", "release-failed", root),
    ).rejects.toThrow();
    await expect(controls.stop()).rejects.toThrow("RUNNER_LIMIT_CLOSED");
    await fileStore.close();
  });

  it("fails closed on unknown/invalid saved shapes and values above a newly lowered local ceiling", async () => {
    for (const loaded of [
      { version: 0 },
      {
        version: 1,
        operatingLimits: { ...hard, revision: 1 },
        stopped: false,
        receipts: [],
        baseUrl: "bad",
      },
      {
        version: 1,
        operatingLimits: { ...hard, matchMicros: hard.matchMicros + 1, revision: 1 },
        stopped: false,
        receipts: [],
      },
    ]) {
      const storage = memory();
      vi.mocked(storage.store.load).mockResolvedValue(loaded);
      await expect(
        RunnerLimitController.open({ hard, store: storage.store, terminal: vi.fn() }),
      ).rejects.toThrow("RUNNER_LIMIT_STORAGE");
      expect(storage.store.close).toHaveBeenCalledOnce();
    }
  });

  it("bounds receipts and stops instead of forgetting a command outcome", async () => {
    const storage = memory();
    const controls = await RunnerLimitController.open({
      hard,
      store: storage.store,
      terminal: vi.fn(),
    });
    for (let index = 0; index < 128; index++) {
      await controls.apply({
        ...update,
        commandId: `bad-${index}`,
        matchMicros: hard.matchMicros + 1,
      });
    }
    const overflow = await controls.apply(update);
    expect(overflow.reason).toBe("storage");
    expect(await controls.apply(update)).toEqual(overflow);
    expect(controls.snapshot().operatingLimits.revision).toBe(0);
    expect(storage.state()?.receipts).toHaveLength(129);
    expect(storage.state()?.stopped).toBe(true);
    await controls.close();
    const resumed = await RunnerLimitController.open({
      hard,
      store: memory(storage.state()).store,
      terminal: vi.fn(),
    });
    expect(await resumed.apply(update)).toEqual(overflow);
    expect((await resumed.apply({ ...update, commandId: "after-capacity" })).reason).toBe(
      "stopped",
    );
    await resumed.close();
  });
});

describe("private operating limit store", () => {
  it("persists receipts and holds one process lock per origin/machine", async () => {
    const root = await directory();
    const store = await runnerLimitFileStore("https://runner.example", "machine-1", root);
    await expect(
      runnerLimitFileStore("https://runner.example", "machine-1", root),
    ).rejects.toThrow();
    const controls = await RunnerLimitController.open({ hard, store, terminal: vi.fn() });
    const result = await controls.apply(update);
    const path = join(root, "runner-limits-v1");
    const files = await readdir(path);
    expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(1);
    expect(
      await readFile(join(path, files.find((file) => file.endsWith(".json")) ?? ""), "utf8"),
    ).not.toContain("credential");
    await controls.close();
    const resumed = await RunnerLimitController.open({
      hard,
      store: await runnerLimitFileStore("https://runner.example", "machine-1", root),
      terminal: vi.fn(),
    });
    expect(await resumed.apply(update)).toEqual(result);
    await resumed.close();
  });

  it("refuses symlinked app directories and broadly readable state", async () => {
    if (process.platform === "win32") return;
    const root = await directory();
    const target = await directory();
    await symlink(target, join(root, "runner-limits-v1"));
    await expect(runnerLimitFileStore("https://runner.example", "machine", root)).rejects.toThrow();
    const second = await directory();
    const store = await runnerLimitFileStore("https://runner.example", "machine", second);
    const controls = await RunnerLimitController.open({ hard, store, terminal: vi.fn() });
    await controls.close();
    const directoryPath = join(second, "runner-limits-v1");
    const file = (await readdir(directoryPath)).find((name) => name.endsWith(".json"));
    if (!file) throw new Error("missing file");
    await chmod(join(directoryPath, file), 0o644);
    await expect(
      RunnerLimitController.open({
        hard,
        store: await runnerLimitFileStore("https://runner.example", "machine", second),
        terminal: vi.fn(),
      }),
    ).rejects.toThrow("RUNNER_LIMIT_STORAGE");
    await writeFile(join(directoryPath, file), "{}", { mode: 0o600 });
  });
});
