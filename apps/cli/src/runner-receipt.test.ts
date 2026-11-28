import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({ operation: "", classified: 0, published: false }));
vi.mock("./runner-pricing", async (original) => {
  const actual = await original<typeof import("./runner-pricing")>();
  return {
    ...actual,
    classifyFinancialInput: (...args: Parameters<typeof actual.classifyFinancialInput>) => {
      faults.classified++;
      return actual.classifyFinancialInput(...args);
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const staging = String(args[0]).endsWith(".receipt.pending");
      if (staging && faults.operation === "open") throw new Error("capture open fault");
      const h = await actual.open(...args);
      const write = h.writeFile.bind(h);
      const sync = h.sync.bind(h);
      h.writeFile = async (...parameters: Parameters<typeof h.writeFile>) => {
        if (staging && faults.operation === "write") {
          await write("{partial");
          throw new Error("capture write fault");
        }
        return write(...parameters);
      };
      h.sync = async () => {
        if (staging && faults.operation === "sync") throw new Error("capture sync fault");
        if (faults.operation === "directory" && faults.published && (await h.stat()).isDirectory())
          throw new Error("capture directory fault");
        return sync();
      };
      return h;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const receipt = String(args[1]).endsWith(".receipt");
      if (
        (receipt && faults.operation === "publish") ||
        (!receipt && faults.operation === "ledger")
      )
        throw new Error("publication fault");
      await actual.rename(...args);
      if (receipt) faults.published = true;
    },
  };
});

import { openRunnerSpend, spendingAuthorityId } from "./runner-spend";

const roots: string[] = [];
const authorityId = spendingAuthorityId("receipt-test-only");
afterEach(async () => {
  faults.operation = "";
  faults.classified = 0;
  faults.published = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cp-receipt-"));
  roots.push(root);
  const options = {
    authorityId,
    file: join(root, "spend.json"),
    now: () => 1_000_000,
    monotonicNow: () => 0,
  };
  const ledger = await openRunnerSpend(options);
  await ledger.reserve({
    matchId: "match",
    requestId: "request",
    micros: 100,
    matchLimitMicros: 100,
    dayLimitMicros: 100,
    context: { kind: "usage", protocol: "openai-chat", tariff: { model: "test/model" } },
  });
  faults.classified = 0;
  faults.published = false;
  return { ledger, options };
}
async function record(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}
async function rewriteReceipt(file: string, mutate: (body: Record<string, unknown>) => void) {
  const envelope = await record(`${file}.receipt`);
  const body = JSON.parse(envelope.body);
  mutate(body);
  envelope.body = JSON.stringify(body);
  envelope.digest = createHash("sha256").update(envelope.body).digest("hex");
  await writeFile(`${file}.receipt`, JSON.stringify(envelope));
}
describe("bounded financial acceptance receipts", () => {
  it.each(["open", "write", "sync", "publish", "directory"])(
    "%s capture failure executes no classifier and preserves full hold",
    async (operation) => {
      const { ledger, options } = await fixture();
      faults.operation = operation;
      await expect(
        ledger.captureUsage({ requestId: "request", usage: { cost: "0.000101" } }),
      ).rejects.toMatchObject({ code: "STORAGE" });
      expect(faults.classified).toBe(0);
      faults.operation = "";
      expect((await record(options.file)).records[0]).toMatchObject({
        micros: 100,
        settled: false,
      });
      await ledger.close();
      if (operation === "directory") {
        // Publication became visible, but its acknowledgement failed. Replay still
        // treats the complete committed evidence conservatively, never ignores it.
        await expect(openRunnerSpend(options)).rejects.toMatchObject({ code: "SETTLEMENT" });
      } else {
        await expect(openRunnerSpend(options)).rejects.toMatchObject({ code: "UNCERTAIN" });
        const recovery = await openRunnerSpend({ ...options, recovery: true });
        expect(recovery.recoverySnapshot()).toMatchObject({
          blocked: false,
          records: [{ micros: 100, settled: false }],
        });
        await recovery.resolveUncertain();
        await recovery.close();
      }
    },
  );
  it("safe accepted receipt with failed ledger reduction never invents a refund during replay/resolve", async () => {
    const { ledger, options } = await fixture();
    faults.operation = "ledger";
    await expect(
      ledger.captureUsage({ requestId: "request", usage: { cost: "0.000010" } }),
    ).rejects.toMatchObject({ code: "STORAGE" });
    expect(faults.classified).toBe(1);
    faults.operation = "";
    await ledger.close();
    await expect(openRunnerSpend(options)).rejects.toMatchObject({ code: "UNCERTAIN" });
    const recovery = await openRunnerSpend({ ...options, recovery: true });
    const before = recovery.recoverySnapshot().records;
    expect(before[0]).toMatchObject({
      micros: 100,
      settled: false,
      atMs: 1_000_000,
      requestId: "request",
    });
    await recovery.resolveUncertain();
    await recovery.close();
    const reopened = await openRunnerSpend(options);
    expect(reopened.snapshot().dayMicros).toBe(100);
    await reopened.close();
  });
  it("safe checkpoint survives receipt retention/reopen and exact repeats use bounded names", async () => {
    const { ledger, options } = await fixture();
    for (let i = 0; i < 8; i++)
      await ledger.captureUsage({ requestId: "request", usage: { cost: "0.000010" } });
    expect((await record(options.file)).checkpoint.sequence).toBe(8);
    await ledger.close();
    const reopened = await openRunnerSpend(options);
    expect(reopened.snapshot().dayMicros).toBe(10);
    await reopened.captureUsage({ requestId: "request", usage: { cost: "0.000010" } });
    await reopened.close();
  });
  it("numeric API cannot bypass original production tariff context", async () => {
    const { ledger } = await fixture();
    await expect(ledger.settle({ requestId: "request", micros: 0 })).rejects.toMatchObject({
      code: "INVALID",
    });
    expect(faults.classified).toBe(0);
    expect(ledger.snapshot().dayMicros).toBe(100);
    await ledger.close();
  });
  it("caller mutation after submission cannot replace accepted usage", async () => {
    const { ledger } = await fixture();
    const usage = { cost: "0.000010" };
    const result = ledger.captureUsage({ requestId: "request", usage });
    usage.cost = "0";
    await result;
    expect(ledger.snapshot().dayMicros).toBe(10);
    await ledger.close();
  });
  it.each(["oversize", "getter", "deep"])(
    "%s input is rejected before capture/classification",
    async (kind) => {
      const { ledger } = await fixture();
      const usage =
        kind === "oversize"
          ? { cost: "1".repeat(70_000) }
          : kind === "getter"
            ? {
                get cost() {
                  throw new Error("must not execute");
                },
              }
            : Array(20)
                .fill(0)
                .reduce<unknown>((value) => [value], 0);
      await expect(ledger.captureUsage({ requestId: "request", usage })).rejects.toMatchObject({
        code: "INVALID",
      });
      expect(faults.classified).toBe(0);
      expect(ledger.snapshot().dayMicros).toBe(100);
      await ledger.close();
    },
  );
  it.each(["sequence", "digest", "missing", "torn", "prior"])(
    "%s committed/checkpoint mismatch refuses normal AND recovery",
    async (kind) => {
      const { ledger, options } = await fixture();
      await ledger.captureUsage({ requestId: "request", usage: { cost: "0.000010" } });
      await ledger.close();
      if (kind === "missing") await unlink(`${options.file}.receipt`);
      else if (kind === "torn") await writeFile(`${options.file}.receipt`, "{partial");
      else if (kind === "digest") {
        const state = await record(options.file);
        state.checkpoint.digest = "a".repeat(64);
        await writeFile(options.file, JSON.stringify(state));
      } else
        await rewriteReceipt(options.file, (body) => {
          if (kind === "sequence") body.sequence = 42;
          else body.prior = { ...(body.prior as object), atMs: 123 };
        });
      for (const recovery of [false, true])
        await expect(openRunnerSpend({ ...options, recovery })).rejects.toMatchObject({
          code: "STORAGE",
        });
    },
  );
  it("partial uncommitted next slot cannot change the prior successful checkpoint", async () => {
    const { ledger, options } = await fixture();
    await ledger.captureUsage({ requestId: "request", usage: { cost: "0.000010" } });
    await ledger.close();
    await writeFile(`${options.file}.receipt.pending`, "{partial", { mode: 0o600 });
    const reopened = await openRunnerSpend(options);
    expect(reopened.snapshot().dayMicros).toBe(10);
    await reopened.captureUsage({ requestId: "request", usage: { cost: "0.000010" } });
    await reopened.close();
  });
  it("old local ledger format is refused at the same authority path", async () => {
    const { ledger, options } = await fixture();
    await ledger.close();
    const state = await record(options.file);
    state.version = 1;
    delete state.checkpoint;
    await writeFile(options.file, JSON.stringify(state));
    await expect(openRunnerSpend(options)).rejects.toMatchObject({ code: "STORAGE" });
  });
});
