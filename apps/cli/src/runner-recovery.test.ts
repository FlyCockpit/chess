import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boardAt } from "@cockpit-chess/chess";
import { afterEach, describe, expect, it } from "vitest";
import { openRunnerJournal } from "./runner-journal";
import { runnerLimitFileStore } from "./runner-limits";
import { ownerIsDead, processIdentity, RunnerLock } from "./runner-lock";
import { recoverRunner } from "./runner-recovery";
import { openRunnerSpend, spendingAuthorityId } from "./runner-spend";

const authorityId = spendingAuthorityId("local-inference");
const children: ChildProcess[] = [];
const roots: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "cp-runrecover-"));
  roots.push(root);
  return root;
}
function child(mode: string, root: string) {
  const handle = spawn(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx/esm"),
      fileURLToPath(new URL("./runner-recovery-process.fixture.ts", import.meta.url)),
      mode,
      root,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { HOME: root, COCKPIT_CHESS_CONFIG_DIR: join(root, "config"), LC_ALL: "C" },
    },
  );
  children.push(handle);
  let stdout = "";
  let stderr = "";
  handle.stdout?.on("data", (b) => {
    stdout += b.toString();
  });
  handle.stderr?.on("data", (b) => {
    stderr += b.toString();
  });
  const done = new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    handle.once("error", reject);
    handle.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  async function ready() {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`fixture not ready: ${stdout} ${stderr}`)),
        10_000,
      );
      const check = () => {
        if (stdout.includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      };
      handle.stdout?.on("data", check);
      void done.then(() => {
        clearTimeout(timer);
        if (!stdout.includes("READY")) reject(new Error(`fixture exited: ${stdout} ${stderr}`));
      });
      check();
    });
  }
  return { handle, done, ready };
}
async function killed(mode: string, root: string) {
  const p = child(mode, root);
  await p.ready();
  p.handle.kill("SIGKILL");
  expect((await p.done).signal).toBe("SIGKILL");
}
const ledgerFile = (root: string) =>
  join(root, ".cockpit-chess", "spend-v1", `${authorityId}.json`);
const spendOptions = (root: string) => ({ authorityId, file: ledgerFile(root) });
const recoveryOptions = (root: string) => ({
  authorityId,
  spendFile: ledgerFile(root),
  journalRoot: join(root, ".cockpit-chess"),
});

afterEach(async () => {
  await Promise.all(
    children.splice(0).map((p) => {
      if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        p.once("close", () => resolve());
        p.kill("SIGKILL");
      });
    }),
  );
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")(
  "real-process crash recovery",
  { timeout: 20_000 },
  () => {
    it("SIGKILL ready journal and empty ledger: resumes saved board and human turn without repeated inference", async () => {
      const root = await directory();
      await killed("ready", root);
      const result = await child("resume", root).done;
      expect(result.stderr).toBe("");
      expect(result.code, result.stdout).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.calls).toBe(0);
      expect(output.sent).toContainEqual(expect.objectContaining({ type: "accept" }));
      expect(output.sent).toContainEqual(
        expect.objectContaining({ type: "move", payload: expect.objectContaining({ ply: 3 }) }),
      );
      expect(boardAt(output.record.archive).get("f3")).toMatchObject({ type: "n", color: "w" });
    });

    it("real offer -> accept -> SIGKILL resumes a fresh ready game without inference", async () => {
      const root = await directory();
      await killed("offer-accepted", root);
      const result = await child("resume", root).done;
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.calls).toBe(0);
      expect(output.sent).toContainEqual(expect.objectContaining({ type: "accept" }));
      expect(output.sent).toContainEqual(
        expect.objectContaining({ type: "move", payload: expect.objectContaining({ ply: 1 }) }),
      );
      expect(boardAt(output.record.archive).get("f3")).toMatchObject({ type: "n", color: "w" });
    });

    it("SIGKILL uncertain paid call: refuses, inspect retains hold, resolve abandons before reopening and preserves accounting/replay", async () => {
      const root = await directory();
      await killed("paid", root);
      await expect(openRunnerSpend(spendOptions(root))).rejects.toMatchObject({
        code: "UNCERTAIN",
      });
      const before = JSON.parse(await readFile(ledgerFile(root), "utf8"));
      const inspected = await recoverRunner({ ...recoveryOptions(root), resolve: false });
      expect(inspected.requests).toEqual(
        before.records.map((record: object) =>
          Object.fromEntries(Object.entries(record).filter(([key]) => key !== "context")),
        ),
      );
      expect(inspected.games).toEqual([{ matchId: "match-1", phase: "uncertain" }]);
      await expect(openRunnerSpend(spendOptions(root))).rejects.toMatchObject({
        code: "UNCERTAIN",
      });
      await recoverRunner({ ...recoveryOptions(root), resolve: true });
      const after = JSON.parse(await readFile(ledgerFile(root), "utf8"));
      expect(after.records).toEqual(before.records.map((r: object) => ({ ...r, settled: true })));
      const journal = await openRunnerJournal(
        "local-spending-authority",
        authorityId,
        join(root, ".cockpit-chess"),
      );
      expect(await journal.load("match-1")).toMatchObject({
        phase: "terminal",
        archive: { status: "error" },
      });
      await journal.close();
      const ledger = await openRunnerSpend(spendOptions(root));
      expect(ledger.snapshot().dayMicros).toBe(70);
      expect(ledger.snapshot().matches.get("match-1")).toBe(70);
      await expect(
        ledger.reserve({
          matchId: "match-1",
          requestId: "request-1",
          micros: 1,
          matchLimitMicros: 100,
          dayLimitMicros: 100,
        }),
      ).rejects.toMatchObject({ code: "REPLAY" });
      await expect(
        ledger.reserve({
          matchId: "match-1",
          requestId: "new",
          micros: 31,
          matchLimitMicros: 100,
          dayLimitMicros: 100,
        }),
      ).rejects.toMatchObject({ code: "MATCH_LIMIT" });
      await expect(
        ledger.reserve({
          matchId: "other-match",
          requestId: "other-new",
          micros: 31,
          matchLimitMicros: 100,
          dayLimitMicros: 100,
        }),
      ).rejects.toMatchObject({ code: "DAY_LIMIT" });
      await ledger.close();
      await recoverRunner({ ...recoveryOptions(root), resolve: true });
      expect(JSON.parse(await readFile(ledgerFile(root), "utf8")).records).toEqual(after.records);
    });

    it.each(["paid", "unpaid"])(
      "real startup refuses %s uncertainty with actionable translated copy, local command inspects/resolves, then startup resumes",
      async (mode) => {
        const root = await directory();
        await killed(mode, root);
        const refused = await child("startup", root).done;
        expect(refused.code).toBe(1);
        expect(refused.stdout).toContain("runner-recover --resolve-as-spent");
        const inspected = await child("inspect", root).done;
        expect(inspected.code, inspected.stdout).toBe(0);
        expect(JSON.parse(inspected.stdout)).toMatchObject({ resolved: false, blocked: false });
        const resolved = await child("resolve", root).done;
        expect(resolved.code, resolved.stdout).toBe(0);
        expect(JSON.parse(resolved.stdout).resolved).toBe(true);
        expect((await child("startup", root).done).stdout).toBe("INITIALIZED\n");
      },
    );

    it("a true overbilling block survives process death, inspect and repeated explicit recovery attempts", async () => {
      const root = await directory();
      await killed("blocked", root);
      const before = JSON.parse(await readFile(ledgerFile(root), "utf8"));
      expect((await recoverRunner({ ...recoveryOptions(root), resolve: false })).blocked).toBe(
        true,
      );
      for (let i = 0; i < 2; i++)
        await expect(recoverRunner({ ...recoveryOptions(root), resolve: true })).rejects.toThrow(
          "BLOCKED",
        );
      await expect(openRunnerSpend(spendOptions(root))).rejects.toMatchObject({
        code: "SETTLEMENT",
      });
      const after = JSON.parse(await readFile(ledgerFile(root), "utf8"));
      expect(after.records).toEqual(before.records);
      expect(after.blocked).toBe(true);
    });

    it.each(["financial-first", "financial-lower", "financial-higher"])(
      "%s accepted invalid evidence survives BOTH denied publications, SIGKILL and repeated resolve",
      async (mode) => {
        const root = await directory();
        await killed(mode, root);
        await chmod(join(ledgerFile(root), ".."), 0o700);
        const before = JSON.parse(await readFile(ledgerFile(root), "utf8")).records;
        expect(JSON.parse(await readFile(ledgerFile(root), "utf8")).blocked).toBe(false);
        expect(
          (await readdir(join(ledgerFile(root), ".."))).some((name) => name.endsWith(".blocked")),
        ).toBe(false);
        await expect(openRunnerSpend(spendOptions(root))).rejects.toMatchObject({
          code: "SETTLEMENT",
        });
        for (let i = 0; i < 2; i++) {
          const inspected = await recoverRunner({ ...recoveryOptions(root), resolve: false });
          expect(inspected.blocked).toBe(true);
          expect(inspected.requests).toEqual(
            before.map((record: object) => ({
              ...Object.fromEntries(Object.entries(record).filter(([key]) => key !== "context")),
              micros: 100,
              settled: false,
            })),
          );
          await expect(recoverRunner({ ...recoveryOptions(root), resolve: true })).rejects.toThrow(
            "BLOCKED",
          );
        }
        expect(JSON.parse(await readFile(ledgerFile(root), "utf8")).records).toEqual(
          before.map((record: object) => ({ ...record, micros: 100, settled: false })),
        );
      },
    );

    it.each(["financial-safe", "financial-capture-crash", "financial-rejected"])(
      "%s keeps the original unknown full hold through explicit recovery",
      async (mode) => {
        const root = await directory();
        if (mode === "financial-capture-crash")
          expect((await child(mode, root).done).signal).toBe("SIGKILL");
        else await killed(mode, root);
        await chmod(join(ledgerFile(root), ".."), 0o700);
        await expect(openRunnerSpend(spendOptions(root))).rejects.toMatchObject({
          code: "UNCERTAIN",
        });
        const inspected = await recoverRunner({ ...recoveryOptions(root), resolve: false });
        expect(inspected).toMatchObject({
          blocked: false,
          requests: [{ requestId: "request-1", micros: 100, reservedMicros: 100, settled: false }],
        });
        await recoverRunner({ ...recoveryOptions(root), resolve: true });
        const spend = await openRunnerSpend(spendOptions(root));
        expect(spend.snapshot().dayMicros).toBe(100);
        await spend.close();
      },
    );

    it("fully settled receipt/checkpoint plus SIGKILL reopens normally at actual amount", async () => {
      const root = await directory();
      await killed("financial-settled", root);
      const spend = await openRunnerSpend(spendOptions(root));
      expect(spend.snapshot().dayMicros).toBe(10);
      await spend.close();
      expect((await recoverRunner({ ...recoveryOptions(root), resolve: false })).requests).toEqual(
        [],
      );
    });

    it("an unreadable owner record fails closed at the real filesystem boundary without stealing a live owner", async () => {
      const root = await directory();
      const owner = child("lock", root);
      await owner.ready();
      const file = join(root, "test.lock");
      await chmod(file, 0o000);
      const refused = await child("lock", root).done;
      expect(refused.code).toBe(1);
      expect(refused.stdout).toContain("STORAGE");
      expect((await readdir(root)).some((name) => name.endsWith(".next"))).toBe(false);
      await chmod(file, 0o600);
      expect((await child("lock", root).done).stdout).toContain("LOCKED");
    });

    it("SIGKILL during recovery leaves abandonment durable and unsettled spend recoverable idempotently", async () => {
      const root = await directory();
      await killed("paid", root);
      expect((await child("recover-crash", root).done).signal).toBe("SIGKILL");
      await expect(openRunnerSpend(spendOptions(root))).rejects.toMatchObject({
        code: "UNCERTAIN",
      });
      const inspected = await recoverRunner({ ...recoveryOptions(root), resolve: false });
      expect(inspected.games).toEqual([{ matchId: "match-1", phase: "terminal" }]);
      expect(inspected.requests).toHaveLength(1);
      await recoverRunner({ ...recoveryOptions(root), resolve: true });
      const ledger = await openRunnerSpend(spendOptions(root));
      expect(ledger.snapshot().dayMicros).toBe(70);
      await ledger.close();
    });

    it("journal uncertainty before dispatch has a local recovery path even with no unsettled spend", async () => {
      const root = await directory();
      await killed("unpaid", root);
      const state = await recoverRunner({ ...recoveryOptions(root), resolve: false });
      expect(state.requests).toEqual([]);
      expect(state.games).toHaveLength(1);
      await recoverRunner({ ...recoveryOptions(root), resolve: true });
      const journal = await openRunnerJournal(
        "local-spending-authority",
        authorityId,
        join(root, ".cockpit-chess"),
      );
      expect(await journal.load("match-1")).toMatchObject({ phase: "terminal" });
      await journal.close();
    });

    it.each(["spend", "journal", "limits"])(
      "two concurrent %s restarts elect exactly one; live owner is never reclaimed",
      async (surface) => {
        const root = await directory();
        await killed(surface, root);
        const contenders = [child(surface, root), child(surface, root)];
        const loser = await Promise.race(contenders.map((p) => p.done));
        expect(loser.code).toBe(1);
        expect(loser.stdout).toContain("LOCKED");
        await Promise.race(
          contenders.map((p) => p.ready().catch(() => new Promise<never>(() => {}))),
        );
        const other = await child(surface, root).done;
        expect(other.code).toBe(1);
        expect(other.stdout).toContain("LOCKED");
      },
    );

    it("SIGKILL operating-limits owner is reclaimed while a live one remains exclusive", async () => {
      const root = await directory();
      const live = child("limits", root);
      await live.ready();
      await expect(runnerLimitFileStore("https://example.test", "machine-1", root)).rejects.toThrow(
        "LOCKED",
      );
      live.handle.kill("SIGKILL");
      await live.done;
      const store = await runnerLimitFileStore("https://example.test", "machine-1", root);
      expect(await store.load()).toBeUndefined();
      await store.close();
    });

    it.each(["candidate-open", "pre-publication", "publication"])(
      "SIGKILL at %s leaves authority recoverable without partial publication",
      async (phase) => {
        const root = await directory();
        expect((await child(phase, root).done).signal).toBe("SIGKILL");
        const lock = await RunnerLock.acquire(join(root, "test.lock"));
        await lock.release();
        expect((await readdir(root)).filter((name) => name.startsWith("cp-candidate-"))).toEqual(
          [],
        );
        expect((await readdir(root)).filter((name) => name.endsWith(".next"))).toHaveLength(
          phase === "publication" ? 1 : 0,
        );
      },
    );

    it("a stalled dead-owner observer cannot remove or bypass an active successor after two handoffs", async () => {
      const root = await directory();
      await killed("lock", root);
      let resume = () => {};
      let observed = () => {};
      const pause = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const stale = RunnerLock.acquire(join(root, "test.lock"), {
        observed: async (generation) => {
          if (generation === 0) {
            observed();
            await pause;
          }
        },
      });
      const outcome = stale.then(
        () => "ACQUIRED",
        (error: unknown) => String(error),
      );
      await Promise.race([
        reached,
        outcome.then((result) => {
          throw new Error(`failed before observation: ${result}`);
        }),
      ]);
      const first = await RunnerLock.acquire(join(root, "test.lock"));
      await first.release();
      const successor = await RunnerLock.acquire(join(root, "test.lock"));
      resume();
      expect(await outcome).toContain("LOCKED");
      await successor.check();
      await successor.release();
    });

    it("PID reuse and prior boot are reclaimed, foreign machine and unreadable evidence fail closed; PID-only records rejected", async () => {
      const current = await processIdentity(process.pid);
      if (!current) throw new Error("identity unavailable");
      expect(
        await ownerIsDead({ ...current, birth: String(BigInt(current.birth) + 1n) }, current),
      ).toBe(true);
      expect(await ownerIsDead({ ...current, boot: randomUUID() }, current)).toBe(true);
      await expect(ownerIsDead({ ...current, machine: "f".repeat(32) }, current)).rejects.toThrow(
        "STORAGE",
      );
      await expect(
        ownerIsDead(current, current, async () => {
          throw new Error("unreadable");
        }),
      ).rejects.toThrow("unreadable");
      for (const previous of [
        { ...current, birth: String(BigInt(current.birth) + 1n) },
        { ...current, boot: randomUUID() },
      ]) {
        const root = await directory();
        await writeFile(
          join(root, "test.lock"),
          JSON.stringify({ ...previous, version: 2, token: randomUUID() }),
          { mode: 0o600 },
        );
        const lock = await RunnerLock.acquire(join(root, "test.lock"));
        await lock.release();
      }
      const root = await directory();
      await writeFile(join(root, "test.lock"), `${process.pid}\n`, { mode: 0o600 });
      await expect(RunnerLock.acquire(join(root, "test.lock"))).rejects.toThrow("STORAGE");
    });
  },
);
