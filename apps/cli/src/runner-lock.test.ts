import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  missingStat: false,
  deniedStat: false,
  machine: undefined as string | undefined,
  status: undefined as string | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === "/etc/machine-id" && faults.machine !== undefined) {
        if (faults.machine === "ENOENT" || faults.machine === "EACCES")
          throw Object.assign(new Error("machine unavailable"), { code: faults.machine });
        return faults.machine;
      }
      if (String(args[0]) === "/proc/self/status" && faults.status !== undefined)
        return faults.status;
      if (
        String(args[0]) === `/proc/${process.pid}/stat` &&
        (faults.missingStat || faults.deniedStat)
      ) {
        throw Object.assign(new Error("identity unavailable"), {
          code: faults.missingStat ? "ENOENT" : "EACCES",
        });
      }
      return actual.readFile(...args);
    },
  };
});

import { ownerIsDead, processIdentity, RunnerLock } from "./runner-lock";
import { openRunnerSpend, spendingAuthorityId } from "./runner-spend";

const roots: string[] = [];
afterEach(async () => {
  faults.missingStat = false;
  faults.deniedStat = false;
  faults.machine = undefined;
  faults.status = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe.skipIf(process.platform !== "linux")("native Linux identity failure boundaries", () => {
  it("procfs ENOENT does not prove a live process dead: actual signal-zero check fences acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-runrecover-identity-"));
    roots.push(root);
    const lock = await RunnerLock.acquire(join(root, "owner.lock"));
    faults.missingStat = true;
    // A procfs visibility/mount fault can report ENOENT while the PID still exists.
    await expect(processIdentity(process.pid)).rejects.toThrow();
    await expect(RunnerLock.acquire(join(root, "owner.lock"))).rejects.toThrow("STORAGE");
    expect((await readdir(root)).filter((name) => name.endsWith(".next"))).toEqual([]);
    faults.missingStat = false;
    await lock.check();
    await lock.release();
  });
  it("permission failure never becomes death evidence", async () => {
    faults.deniedStat = true;
    await expect(processIdentity(process.pid)).rejects.toMatchObject({ code: "EACCES" });
  });
  it("different live PID namespaces and unreadable owner probes fail closed", async () => {
    const current = await processIdentity(process.pid);
    if (!current) throw new Error("identity unavailable");
    await expect(ownerIsDead({ ...current, scope: "pid:[1]" }, current)).rejects.toThrow("STORAGE");
    await expect(
      ownerIsDead(current, current, async () => {
        throw new Error("unreadable");
      }),
    ).rejects.toThrow("unreadable");
  });
  it.each(["", "ENOENT"])(
    "missing machine-id %s uses boot-scoped identity, never cross-boot proof",
    async (machine) => {
      faults.machine = machine;
      const current = await processIdentity(process.pid);
      expect(current?.machine).toBe(`boot:${current?.boot}`);
      if (!current) throw new Error("missing identity");
      await expect(
        ownerIsDead({ ...current, boot: "11111111-2222-3333-4444-555555555555" }, current),
      ).rejects.toThrow("STORAGE");
      expect(await ownerIsDead(current, current)).toBe(false);
    },
  );
  it.each(["0".repeat(32), "f".repeat(32), "malformed", "EACCES"])(
    "bad/unreadable machine-id %s refuses",
    async (machine) => {
      faults.machine = machine;
      await expect(processIdentity(process.pid)).rejects.toThrow();
    },
  );
  it.each([`NSpid:\t999999 ${process.pid}\n`, "Name:\tnode\n", "NSpid:\t999999\n"])(
    "procfs view %s cannot reach numeric identity",
    async (status) => {
      faults.status = status;
      await expect(processIdentity(process.pid)).rejects.toThrow("STORAGE");
    },
  );
  it.each(["linux", "darwin", "win32"] as const)(
    "%s machine/boot sentinels never prove death",
    async (platform) => {
      const linux = await processIdentity(process.pid);
      if (!linux) throw new Error("missing identity");
      const base = {
        ...linux,
        platform,
        birth: platform === "darwin" ? "Sat Nov 28 00:00:00 2026" : linux.birth,
        scope: platform === "linux" ? linux.scope : "system",
        machine:
          platform === "linux"
            ? "123456789abcdef0123456789abcdef0"
            : "12345678-1234-1234-1234-123456789abc",
      };
      for (const sentinel of ["0", "f"]) {
        const id =
          platform === "linux"
            ? sentinel.repeat(32)
            : `${sentinel.repeat(8)}-${sentinel.repeat(4)}-${sentinel.repeat(4)}-${sentinel.repeat(4)}-${sentinel.repeat(12)}`;
        await expect(
          ownerIsDead(
            { ...base, machine: id },
            { ...base, machine: id, boot: "11111111-2222-3333-4444-555555555555" },
          ),
        ).rejects.toThrow("STORAGE");
        const boot = `${sentinel.repeat(8)}-${sentinel.repeat(4)}-${sentinel.repeat(4)}-${sentinel.repeat(4)}-${sentinel.repeat(12)}`;
        await expect(ownerIsDead({ ...base, boot }, base)).rejects.toThrow("STORAGE");
      }
    },
  );
  it("Darwin equal coarse birth always remains locked; a different birth proves predecessor dead", async () => {
    const base = {
      platform: "darwin" as const,
      pid: 123,
      birth: "Sat Nov 28 00:00:00 2026",
      boot: "11111111-2222-3333-4444-555555555555",
      machine: "12345678-1234-1234-1234-123456789abc",
      scope: "system",
    };
    expect(await ownerIsDead(base, base, async () => ({ ...base }))).toBe(false);
    expect(
      await ownerIsDead(base, base, async () => ({ ...base, birth: "Sat Nov 28 00:00:01 2026" })),
    ).toBe(true);
  });
  it("a SIGKILL after durable violation intent preserves the block even before the ledger rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-runrecover-block-intent-"));
    roots.push(root);
    const options = {
      authorityId: spendingAuthorityId("synthetic-intent-proof"),
      file: join(root, "spend.json"),
    };
    const spend = await openRunnerSpend(options);
    await spend.reserve({
      matchId: "match-1",
      requestId: "request-1",
      micros: 100,
      matchLimitMicros: 100,
      dayLimitMicros: 100,
    });
    await spend.settle({ requestId: "request-1", micros: 40 });
    await spend.close();
    const script = `import {RunnerLock} from ${JSON.stringify(new URL("./runner-lock.ts", import.meta.url).href)}; const lock = await RunnerLock.acquire(${JSON.stringify(`${options.file}.lock`)}); await lock.fence(); process.kill(process.pid, "SIGKILL");`;
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          createRequire(import.meta.url).resolve("tsx/esm"),
          "--input-type=module",
          "-e",
          script,
        ],
        { timeout: 10_000, env: { HOME: root, LC_ALL: "C" } },
      ),
    ).rejects.toMatchObject({ signal: "SIGKILL" });
    expect(JSON.parse(await readFile(options.file, "utf8")).blocked).toBe(false);
    await expect(openRunnerSpend(options)).rejects.toMatchObject({ code: "SETTLEMENT" });
    const recovery = await openRunnerSpend({ ...options, recovery: true });
    expect(recovery.recoverySnapshot()).toMatchObject({
      blocked: true,
      records: [{ micros: 40, reservedMicros: 100, settled: true }],
    });
    await expect(recovery.resolveUncertain()).rejects.toMatchObject({ code: "SETTLEMENT" });
    await recovery.close();
  });
  it("candidate GC preserves live empty initialization and published successor while collecting prior-boot empty residue", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-runrecover-candidate-"));
    roots.push(root);
    const path = join(root, "owner.lock");
    let initialized = () => {};
    let resume = () => {};
    const entered = new Promise<void>((resolve) => {
      initialized = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const first = RunnerLock.acquire(path, {
      opened: async () => {
        initialized();
        await gate;
      },
    });
    const outcome = first.then(
      () => "ACQUIRED",
      (error: unknown) => String(error),
    );
    try {
      await entered;
      const [candidate] = (await readdir(root)).filter((name) => name.startsWith("cp-candidate-"));
      if (!candidate) throw new Error("candidate missing");
      expect(Buffer.byteLength(candidate)).toBeLessThanOrEqual(255);
      expect((await lstat(join(root, candidate))).size).toBe(0);
      const current = await processIdentity(process.pid);
      if (!current) throw new Error("identity unavailable");
      const old = candidate.replace(
        current.boot.replaceAll("-", ""),
        "11111111222233334444555555555555",
      );
      await writeFile(join(root, old), "", { mode: 0o600 });
      const winner = await RunnerLock.acquire(path);
      // No partial metadata is needed to prove stable-machine/different-boot death.
      if (current.machine.startsWith("boot:")) expect((await lstat(join(root, old))).size).toBe(0);
      else await expect(lstat(join(root, old))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(join(root, candidate))).size).toBe(0);
      resume();
      expect(await outcome).toContain("LOCKED");
      await winner.check();
      await winner.release();
      expect((await readdir(root)).filter((name) => name.startsWith("cp-candidate-"))).toEqual(
        current.machine.startsWith("boot:") ? [old] : [],
      );
    } finally {
      resume();
      await outcome;
    }
  });
  it("synchronous cancellation guard runs before publishing release and cannot free authority when it throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "cp-runrecover-release-"));
    roots.push(root);
    const lock = await RunnerLock.acquire(join(root, "owner.lock"));
    expect(() =>
      lock.releaseSync(() => {
        throw new Error("retry cancellation");
      }),
    ).toThrow("retry cancellation");
    await expect(RunnerLock.acquire(join(root, "owner.lock"))).rejects.toThrow("LOCKED");
    await lock.check();
    await lock.release();
    const successor = await RunnerLock.acquire(join(root, "owner.lock"));
    await successor.check();
    await successor.release();
  });
});
