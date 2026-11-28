import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runnerConfigDigest, runnerMatchConfigSchema } from "@cockpit-chess/chess/runner-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerConnection, type RunnerConnectionOptions } from "./runner-connection";
import * as engineModule from "./runner-engine";
import type { RunnerGameLoop } from "./runner-game";
import * as journalModule from "./runner-journal";
import { type RunnerLimitState, runnerLimitFileStore } from "./runner-limits";
import * as policyModule from "./runner-policy";
import { RunnerPolicy, readLocalRunnerOptions } from "./runner-policy";
import {
  completeRunnerClaim,
  initializeRunnerExecution,
  localRunnerOverrides,
  type PendingRunnerClaim,
  parseRunnerCeilings,
  type RunnerExecution,
  type RunnerStartupIO,
  runnerFileStore,
  runRunnerStartup,
  startRunner,
  terminalClaimant,
} from "./runner-start";

const origin = "https://runner.example.com";
const secretProof = "a".repeat(64);
const token = "b".repeat(64);
const startTime = Date.parse("2026-11-27T12:00:00Z");
const claim = {
  claimId: "claim-1",
  claimToken: token,
  expiresAt: new Date(startTime + 600_000).toISOString(),
  pollIntervalMs: 2000,
};
const owner = {
  claimant: { email: "owner@example.com" },
  controlPath: "/en-US/settings/cli" as const,
};
const credential = {
  machineId: "machine-1",
  credential: "test-runner-secret",
  expiresAt: new Date(startTime + 3_600_000).toISOString(),
  ...owner,
};
const limitMessage = {
  version: 1 as const,
  generation: 1,
  id: "limit-frame",
  seq: 1,
  ack: 0,
  type: "limits" as const,
  payload: {
    commandId: "limit-command",
    expectedRevision: 0,
    revision: 1,
    matchMicros: 2_000_000,
    dayMicros: 20_000_000,
    concurrency: 3,
  },
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function harness(responses: (Response | Error)[] = []) {
  let time = startTime;
  const controller = new AbortController();
  const connection = { start: vi.fn(), stop: vi.fn(), send: vi.fn(() => true) };
  const fetcher = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected request");
    return next;
  });
  const store = {
    savePending: vi.fn(async (_value: PendingRunnerClaim) => {}),
    saveCredential: vi.fn(async () => {}),
    loadCredential: vi.fn(async () => undefined as typeof credential | undefined),
    removePending: vi.fn(async () => {}),
  };
  const connect = vi.fn((_options: RunnerConnectionOptions) => connection);
  const hardLimits = { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 };
  const limitPolicy = {
    restoreOperatingLimits: vi.fn(),
    applyOperatingLimits: vi.fn(),
    stopOperatingLimits: vi.fn(),
  };
  const game = {
    hello: {
      hardLimits,
      models: [{ id: "test/local-model", protocol: "openai-chat" as const }],
      engine: true,
      operatingLimits: {
        matchMicros: 1_000_000,
        dayMicros: 10_000_000,
        concurrency: 2,
        revision: 0,
      },
    },
    handle: vi.fn<RunnerGameLoop["handle"]>(async () => {}),
  };
  const execution: RunnerExecution = {
    hardLimits,
    limitPolicy,
    settleLimits: vi.fn(async () => {}),
    startupNotice: vi.fn(
      () =>
        "Local price-checked ceilings: USD 25.00 per match, USD 100.00 per rolling 24 hours, 8 concurrent. Operating limits: USD 1.00 per match, USD 10.00 per rolling 24 hours, 2 concurrent.",
    ),
    open: vi.fn(async () => game),
    close: vi.fn(async () => {}),
  };
  const initialize = vi.fn<RunnerStartupIO["initialize"]>(async (flags) => {
    const hard = parseRunnerCeilings(flags);
    execution.hardLimits = hard;
    game.hello.hardLimits = hard;
    game.hello.operatingLimits = {
      matchMicros: Math.min(1_000_000, hard.matchMicros),
      dayMicros: Math.min(10_000_000, hard.dayMicros),
      concurrency: Math.min(2, hard.concurrency),
      revision: 0,
    };
    return execution;
  });
  const io: RunnerStartupIO = {
    initialize,
    fetch: fetcher,
    now: () => time,
    sleep: vi.fn(async (ms) => {
      time += ms;
    }),
    makeProof: vi.fn(() => secretProof),
    terminal: vi.fn(),
    store,
    connect,
    signal: controller.signal,
    limitsStore: async () => ({
      load: async () => undefined,
      save: async () => {},
      close: async (beforeRelease, afterRelease) => {
        beforeRelease?.();
        afterRelease?.();
      },
    }),
  };
  return {
    io,
    fetcher,
    store,
    connection,
    connect,
    controller,
    initialize,
    execution,
    game,
    limitPolicy,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runner startup", () => {
  it("creates a fresh claim, persists before exchange, prints only private links/identity and connects E2", async () => {
    const h = harness([
      json(claim),
      json({ status: "pending" }),
      json({ status: "claimed", ...owner }),
      json(credential),
    ]);
    await startRunner(origin, {}, h.io);
    expect(h.store.savePending).toHaveBeenCalledTimes(2);
    expect(h.store.savePending.mock.invocationCallOrder[0]).toBeLessThan(
      h.fetcher.mock.invocationCallOrder[0] ?? 0,
    );
    expect(h.store.savePending.mock.calls[1]?.[0]).toMatchObject({
      origin,
      proof: secretProof,
      claimId: "claim-1",
    });
    expect(h.store.saveCredential).toHaveBeenCalledWith(origin, credential);
    expect(h.store.saveCredential.mock.invocationCallOrder[0]).toBeLessThan(
      h.store.removePending.mock.invocationCallOrder[0] ?? 0,
    );
    const output = vi.mocked(h.io.terminal).mock.calls.flat().join("\n");
    expect(output).toContain(`${origin}/en-US/runner/claim#runner-claim=${token}`);
    expect(output).toContain("owner@example.com");
    expect(output).toContain(`${origin}/en-US/settings/cli`);
    expect(output).toContain("USD 25.00 per match, USD 100.00 per rolling 24 hours, 8 concurrent");
    expect(h.initialize).toHaveBeenCalledExactlyOnceWith({}, h.controller.signal);
    expect(h.initialize.mock.invocationCallOrder[0]).toBeLessThan(
      h.store.savePending.mock.invocationCallOrder[0] ?? 0,
    );
    expect(vi.mocked(h.io.terminal).mock.calls[0]?.[0]).toBe(h.execution.startupNotice());
    expect(h.execution.open).toHaveBeenCalledWith(
      origin,
      credential.machineId,
      expect.any(Function),
      h.controller.signal,
    );
    expect(output).not.toContain(secretProof);
    expect(output).not.toContain(credential.credential);
    const options = h.connect.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      url: `${origin.replace("https:", "wss:")}/api/cli/runner/ws`,
      credential: credential.credential,
      hello: expect.any(Function),
    });
    expect(h.connection.start).toHaveBeenCalledOnce();
    for (const [url, init] of h.fetcher.mock.calls) {
      expect(String(url)).toMatch(
        /^https:\/\/runner.example.com\/api\/cli\/runner\/(begin|poll|exchange)$/,
      );
      expect(init).toMatchObject({
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        method: "POST",
      });
      expect(init?.headers).not.toHaveProperty("Authorization");
    }
    h.controller.abort();
    expect(h.connection.stop).toHaveBeenCalledOnce();
  });

  it("retries lost poll/exchange responses with the same proof and no second begin", async () => {
    const h = harness([
      json(claim),
      new TypeError(secretProof),
      json({ status: "claimed", ...owner }),
      new TypeError(credential.credential),
      json(credential),
    ]);
    await startRunner(origin, {}, h.io);
    expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/begin"))).toHaveLength(1);
    expect(h.fetcher.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)))).toEqual(
      Array(4).fill({ claimId: "claim-1", proof: secretProof }),
    );
    expect(h.io.terminal).not.toHaveBeenCalledWith(expect.stringContaining(secretProof));
    h.controller.abort();
  });

  it("can finish a persisted pending run without a new proof or claim", async () => {
    const h = harness([json({ status: "claimed", ...owner }), json(credential)]);
    await expect(
      completeRunnerClaim(
        { origin, proof: secretProof, claimId: "claim-1", deadline: startTime + 600_000 },
        h.io,
      ),
    ).resolves.toEqual(credential);
    expect(h.io.makeProof).not.toHaveBeenCalled();
    expect(h.fetcher.mock.calls.every(([url]) => !String(url).endsWith("/begin"))).toBe(true);
  });

  it("allows begin response latency without extending the client's ten-minute deadline", async () => {
    const h = harness();
    h.fetcher
      .mockImplementationOnce(async () => {
        await h.io.sleep(100);
        return json({ ...claim, expiresAt: new Date(startTime + 600_100).toISOString() });
      })
      .mockResolvedValueOnce(json({ status: "claimed", ...owner }))
      .mockResolvedValueOnce(json(credential));
    await startRunner(origin, {}, h.io);
    expect(h.store.savePending.mock.calls[1]?.[0].deadline).toBe(startTime + 600_000);
    h.controller.abort();
  });

  it("retries a lost exchange response body with the same proof", async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("body disconnected"));
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const h = harness([
      json(claim),
      json({ status: "claimed", ...owner }),
      broken,
      json(credential),
    ]);
    await startRunner(origin, {}, h.io);
    expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/exchange"))).toHaveLength(
      2,
    );
    expect(h.fetcher.mock.calls.slice(2).map(([, init]) => JSON.parse(String(init?.body)))).toEqual(
      Array(2).fill({ claimId: "claim-1", proof: secretProof }),
    );
    h.controller.abort();
  });

  it.each([429, 503])("retries HTTP %i while preserving the proof", async (status) => {
    const h = harness([
      json(claim),
      json({}, status),
      json({ status: "claimed", ...owner }),
      json({}, status),
      json(credential),
    ]);
    await startRunner(origin, {}, h.io);
    expect(h.io.sleep).toHaveBeenCalledTimes(2);
    expect(h.store.saveCredential).toHaveBeenCalledOnce();
    h.controller.abort();
  });

  it("never retries an ambiguous begin response or exposes the transport error", async () => {
    const h = harness([new TypeError(secretProof)]);
    await expect(startRunner(origin, {}, h.io)).rejects.toThrow(/Runner startup failed/);
    expect(h.fetcher).toHaveBeenCalledOnce();
    expect(h.store.savePending).toHaveBeenCalledOnce();
    expect(h.io.terminal).not.toHaveBeenCalledWith(expect.stringContaining(secretProof));
  });

  it("does not create proof or perform network IO after cancellation", async () => {
    const h = harness();
    h.controller.abort();
    await expect(startRunner(origin, {}, h.io)).rejects.toThrow();
    expect(h.io.makeProof).not.toHaveBeenCalled();
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    new Response("{}", { headers: { "content-type": "text/plain" } }),
    new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "16385" },
    }),
    new Response("not json", { headers: { "content-type": "application/json" } }),
  ])("fails closed on non-JSON, excessive declared length or malformed JSON", async (response) => {
    const h = harness([response]);
    await expect(startRunner(origin, {}, h.io)).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledOnce();
  });

  it("resumes only the explicit machine at this origin without begin, poll, or proof creation", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    await startRunner(origin, { resume: "machine-1" }, h.io);
    expect(h.store.loadCredential).toHaveBeenCalledWith(origin, "machine-1");
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.io.makeProof).not.toHaveBeenCalled();
    expect(h.io.terminal).not.toHaveBeenCalledWith(expect.stringContaining("runner-claim="));
    h.controller.abort();
  });

  it.each([
    undefined,
    { ...credential, machineId: "other" },
    { ...credential, expiresAt: new Date(startTime).toISOString() },
  ])("refuses missing, mismatched or expired resume without creating a link", async (stored) => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(stored);
    await expect(startRunner(origin, { resume: "machine-1" }, h.io)).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("delegates game execution and routes operating limits to the local controller", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    await startRunner(
      origin,
      { resume: "machine-1", maxMatchUsd: "0.5", maxDayUsd: "2", maxConcurrency: "1" },
      h.io,
    );
    const options = h.connect.mock.calls[0]?.[0];
    const signal = new AbortController().signal;
    const envelope = { version: 1 as const, generation: 1, id: "cmd", seq: 1, ack: 0 };
    await options?.onMessage?.(
      {
        ...envelope,
        type: "offer",
        matchId: "match-1",
        payload: {
          commandId: "offer-1",
          config: runnerMatchConfigSchema.parse({
            white: { name: "White", model: "test/local-model", protocol: "openai-chat" },
            black: { name: "Black", model: "random", protocol: "random" },
            rules: {},
            promptVersion: "1",
          }),
          configDigest: runnerConfigDigest(
            runnerMatchConfigSchema.parse({
              white: { name: "White", model: "test/local-model", protocol: "openai-chat" },
              black: { name: "Black", model: "random", protocol: "random" },
              rules: {},
              promptVersion: "1",
            }),
          ),
        },
      },
      signal,
    );
    expect(h.game.handle).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "offer", matchId: "match-1" }),
      signal,
    );
    await options?.onMessage?.(
      {
        ...envelope,
        type: "limits",
        payload: {
          commandId: "limits-1",
          revision: 100,
          expectedRevision: 99,
          matchMicros: 900_000_000,
          dayMicros: 900_000_000,
          concurrency: 64,
        },
      },
      signal,
    );
    expect(h.game.handle).toHaveBeenCalledTimes(1);
    expect(h.connection.send).toHaveBeenLastCalledWith(
      {
        type: "limits-result",
        payload: expect.objectContaining({ status: "rejected", reason: "stale", revision: 100 }),
      },
      signal,
    );
    const hello = typeof options?.hello === "function" ? options.hello() : options?.hello;
    expect(hello?.operatingLimits).toEqual({
      matchMicros: 500_000,
      dayMicros: 2_000_000,
      concurrency: 1,
      revision: 0,
    });
    await options?.onMessage?.(
      {
        ...envelope,
        type: "start",
        matchId: "match-1",
        payload: { commandId: "start-1", expectedSeq: 0 },
      },
      signal,
    );
    expect(h.game.handle).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "start" }),
      signal,
    );
    const send = vi.mocked(h.execution.open).mock.calls[0]?.[2];
    const action = { type: "error" as const, payload: { code: "UNSUPPORTED" as const } };
    expect(send?.(action, signal)).toBe(true);
    expect(h.connection.send).toHaveBeenLastCalledWith(action, signal);
    h.controller.abort();
  });

  it("prints restored active limits after resume instead of leaving the default notice authoritative", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    h.io.limitsStore = async () => ({
      load: async () => ({
        version: 1,
        stopped: false,
        receipts: [],
        operatingLimits: {
          matchMicros: 2000000,
          dayMicros: 20000000,
          concurrency: 3,
          revision: 4,
        },
      }),
      save: async () => {},
      close: async (before, after) => {
        before?.();
        after?.();
      },
    });
    h.limitPolicy.restoreOperatingLimits.mockImplementationOnce(() => {
      vi.mocked(h.execution.startupNotice).mockReturnValue(
        "Restored limits: USD2/match, USD20/day, concurrency3.",
      );
    });
    const runner = await startRunner(origin, { resume: "machine-1" }, h.io);
    const notices = vi.mocked(h.io.terminal).mock.calls.map(([notice]) => notice);
    expect(notices[0]).toContain("Operating limits: USD 1.00");
    expect(notices).toContain("Restored limits: USD2/match, USD20/day, concurrency3.");
    expect(
      notices.indexOf("Restored limits: USD2/match, USD20/day, concurrency3."),
    ).toBeGreaterThan(0);
    const hello = h.connect.mock.calls[0]?.[0].hello;
    const capabilities = typeof hello === "function" ? hello() : hello;
    expect(capabilities?.operatingLimits).toMatchObject({ matchMicros: 2000000, revision: 4 });
    runner.stop();
    await runner.closed;
  });

  it("applies an operating command once and replays its ACK without changing local ceilings", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    const runner = await startRunner(origin, { resume: "machine-1" }, h.io);
    const options = h.connect.mock.calls[0]?.[0];
    const signal = new AbortController().signal;
    const command = {
      version: 1 as const,
      generation: 1,
      id: "frame-1",
      seq: 1,
      ack: 0,
      type: "limits" as const,
      payload: {
        commandId: "limits-1",
        expectedRevision: 0,
        revision: 1,
        matchMicros: 2_000_000,
        dayMicros: 20_000_000,
        concurrency: 3,
      },
    };
    await options?.onMessage?.(command, signal);
    await options?.onMessage?.(command, signal);
    expect(h.connection.send).toHaveBeenCalledTimes(2);
    expect(h.connection.send.mock.calls[0]).toEqual(h.connection.send.mock.calls[1]);
    expect(h.connection.send).toHaveBeenLastCalledWith(
      {
        type: "limits-result",
        payload: expect.objectContaining({
          status: "applied",
          revision: 1,
          hardLimits: { matchMicros: 25_000_000, dayMicros: 100_000_000, concurrency: 8 },
        }),
      },
      signal,
    );
    const hello = typeof options?.hello === "function" ? options.hello() : options?.hello;
    expect(hello?.models).toEqual(h.game.hello.models);
    expect(hello?.engine).toBe(true);
    expect(hello?.operatingLimits).toMatchObject({ matchMicros: 2_000_000, revision: 1 });
    expect(h.limitPolicy.applyOperatingLimits).toHaveBeenCalledExactlyOnceWith(
      { matchMicros: 2_000_000, dayMicros: 20_000_000, concurrency: 3 },
      1,
    );
    runner.stop();
    await runner.closed;
  });

  it("restores durable revisions before opening games using the resolved policy ceilings", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    const hard = { matchMicros: 7_000_000, dayMicros: 30_000_000, concurrency: 4 };
    const restored = { matchMicros: 3_000_000, dayMicros: 15_000_000, concurrency: 3, revision: 7 };
    h.execution.hardLimits = hard;
    // These are the resolved file values, independently of the legacy parser defaults.
    h.initialize.mockResolvedValue(h.execution);
    h.io.limitsStore = async () => ({
      load: async () => ({ version: 1, stopped: false, receipts: [], operatingLimits: restored }),
      save: async () => {},
      close: async (beforeRelease, afterRelease) => {
        beforeRelease?.();
        afterRelease?.();
      },
    });
    const runner = await startRunner(origin, { resume: "machine-1" }, h.io);
    expect(h.limitPolicy.restoreOperatingLimits).toHaveBeenCalledExactlyOnceWith(restored);
    expect(h.limitPolicy.restoreOperatingLimits.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(h.execution.open).mock.invocationCallOrder[0] ?? 0,
    );
    const hello = h.connect.mock.calls[0]?.[0].hello;
    expect(typeof hello === "function" ? hello() : hello).toMatchObject({
      hardLimits: hard,
      operatingLimits: restored,
    });
    runner.stop();
    await runner.closed;
  });

  it("rejects above-ceiling commands without changing the policy or clamping the request", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    const runner = await startRunner(origin, { resume: "machine-1" }, h.io);
    const signal = new AbortController().signal;
    const update = {
      ...limitMessage,
      payload: { ...limitMessage.payload, matchMicros: 26_000_000 },
    };
    const options = h.connect.mock.calls[0]?.[0];
    await options?.onMessage?.(update, signal);
    expect(h.limitPolicy.applyOperatingLimits).not.toHaveBeenCalled();
    expect(h.connection.send).toHaveBeenCalledExactlyOnceWith(
      {
        type: "limits-result",
        payload: expect.objectContaining({
          status: "rejected",
          reason: "ceiling",
          revision: 1,
          operatingLimits: expect.objectContaining({ revision: 0, matchMicros: 1_000_000 }),
          hardLimits: h.execution.hardLimits,
        }),
      },
      signal,
    );
    expect(h.io.terminal).toHaveBeenCalledWith(expect.stringContaining("$26/match"));
    runner.stop();
    await runner.closed;
  });

  it("waits for limit settlement before ACK or game cleanup and suppresses a cancelled ACK", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    let settle = () => {};
    vi.mocked(h.execution.settleLimits).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const runner = await startRunner(origin, { resume: "machine-1" }, h.io);
    const options = h.connect.mock.calls[0]?.[0];
    const session = new AbortController();
    const pending = options?.onMessage?.(limitMessage, session.signal);
    await vi.waitFor(() => expect(h.execution.settleLimits).toHaveBeenCalledOnce());
    expect(h.limitPolicy.applyOperatingLimits).toHaveBeenCalledOnce();
    expect(h.connection.send).not.toHaveBeenCalled();
    session.abort();
    const finishing = options?.onTerminal?.();
    h.controller.abort();
    expect(h.limitPolicy.stopOperatingLimits).toHaveBeenCalledOnce();
    expect(h.execution.close).not.toHaveBeenCalled();
    settle();
    await pending;
    await finishing;
    await expect(runner.closed).rejects.toThrow(/^Runner startup failed/);
    expect(h.execution.close).toHaveBeenCalledOnce();
    expect(h.connection.send).not.toHaveBeenCalled();
  });

  it("retains the limits lock and abort listener through game cleanup and a late local stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-game-drain-"));
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    h.io.limitsStore = (server, machine) => runnerLimitFileStore(server, machine, root);
    let drain = () => {};
    vi.mocked(h.execution.close).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          drain = resolve;
        }),
    );
    const remove = vi.spyOn(h.controller.signal, "removeEventListener");
    const runner = await startRunner(origin, { resume: "machine-1" }, h.io);
    const options = h.connect.mock.calls[0]?.[0];
    try {
      const finishing = options?.onTerminal?.();
      await vi.waitFor(() => expect(h.execution.close).toHaveBeenCalledOnce());
      expect(remove).not.toHaveBeenCalled();
      await expect(runnerLimitFileStore(origin, "machine-1", root)).rejects.toThrow();
      h.controller.abort();
      expect(h.limitPolicy.stopOperatingLimits).toHaveBeenCalledOnce();
      expect(remove).not.toHaveBeenCalled();
      await expect(runnerLimitFileStore(origin, "machine-1", root)).rejects.toThrow();
      drain();
      await finishing;
      await expect(runner.closed).rejects.toThrow(/^Runner startup failed/);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      const store = await runnerLimitFileStore(origin, "machine-1", root);
      try {
        expect(await store.load()).toMatchObject({ stopped: true });
      } finally {
        await store.close();
      }
      // A caller holding the old lifetime cannot write after unlock.
      runner.stop();
      expect(h.limitPolicy.stopOperatingLimits).toHaveBeenCalledOnce();
    } finally {
      drain();
      await options?.onTerminal?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps cancellation live during release preparation and persists it before synchronous unlock", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    let state: RunnerLimitState | undefined;
    let prepare = () => {};
    let unlocked = false;
    const remove = vi.spyOn(h.controller.signal, "removeEventListener");
    const close = vi.fn(async (beforeRelease?: () => void, afterRelease?: () => void) => {
      if (close.mock.calls.length === 1)
        await new Promise<void>((resolve) => {
          prepare = resolve;
        });
      expect(h.execution.close).toHaveBeenCalledOnce();
      expect(remove).not.toHaveBeenCalled();
      beforeRelease?.();
      expect(state?.stopped).toBe(true);
      unlocked = true;
      afterRelease?.();
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    });
    h.io.limitsStore = async () => ({
      load: async () => state,
      save: async (next) => {
        state = structuredClone(next);
      },
      close,
    });
    const runner = await startRunner(origin, { resume: "machine-1" }, h.io);
    const options = h.connect.mock.calls[0]?.[0];
    const finishing = options?.onTerminal?.();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(unlocked).toBe(false);
    h.controller.abort();
    expect(h.limitPolicy.stopOperatingLimits).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    prepare();
    await finishing;
    await expect(runner.closed).rejects.toThrow(/^Runner startup failed/);
    expect(close).toHaveBeenCalledTimes(2);
    expect(unlocked).toBe(true);
    expect(state).toMatchObject({ stopped: true, operatingLimits: { revision: 0 } });
  });

  it.each([false, true])(
    "terminal shutdown drains writes and keeps cancellation live until unlock (cancel: %s)",
    async (cancelDuringDrain) => {
      const root = await mkdtemp(join(tmpdir(), "runner-start-terminal-"));
      const h = harness();
      h.store.loadCredential.mockResolvedValue(credential);
      let block = false;
      let release: (() => void) | undefined;
      h.io.limitsStore = async (origin, machine) => {
        const store = await runnerLimitFileStore(origin, machine, root);
        return {
          ...store,
          save: async (state) => {
            await store.save(state);
            if (block) {
              block = false;
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            }
          },
        };
      };
      await startRunner(origin, { resume: "machine-1" }, h.io);
      const options = h.connect.mock.calls[0]?.[0];
      if (!options?.onTerminal) throw new Error("missing terminal cleanup");
      const controller = new AbortController();
      try {
        block = true;
        const pending = options.onMessage?.(
          {
            version: 1,
            generation: 1,
            id: "terminal-frame",
            seq: 1,
            ack: 0,
            type: "limits",
            payload: {
              commandId: "terminal-limit",
              expectedRevision: 0,
              revision: 1,
              matchMicros: 2_000_000,
              dayMicros: 20_000_000,
              concurrency: 3,
            },
          },
          controller.signal,
        );
        await vi.waitFor(() => expect(release).toBeTypeOf("function"));
        controller.abort();
        let finished = false;
        const finishing = Promise.resolve(options.onTerminal()).then(() => {
          finished = true;
        });
        await Promise.resolve();
        expect(finished).toBe(false);
        if (cancelDuringDrain) h.controller.abort();
        await expect(runnerLimitFileStore(origin, "machine-1", root)).rejects.toThrow();
        release?.();
        await pending;
        await finishing;
        expect(h.connection.send).not.toHaveBeenCalled();
        const resumed = await runnerLimitFileStore(origin, "machine-1", root);
        const state = await resumed.load();
        expect(state).toMatchObject({
          stopped: cancelDuringDrain,
          operatingLimits: {
            revision: cancelDuringDrain ? 0 : 1,
            matchMicros: cancelDuringDrain ? 1_000_000 : 2_000_000,
          },
        });
        await resumed.close();
      } finally {
        release?.();
        await options.onTerminal();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("records an explicit stop before terminal cleanup can release a pending-write lock", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    let state: RunnerLimitState | undefined;
    let block = false;
    let release: (() => void) | undefined;
    const close = vi.fn(async (beforeRelease?: () => void, afterRelease?: () => void) => {
      beforeRelease?.();
      afterRelease?.();
    });
    h.io.limitsStore = async () => ({
      load: async () => state,
      save: async (next) => {
        state = structuredClone(next);
        if (block) {
          block = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      close,
    });
    const runner = await startRunner(origin, { resume: "machine-1" }, h.io);
    const options = h.connect.mock.calls[0]?.[0];
    h.connection.stop.mockImplementation(() => {
      void options?.onTerminal?.();
    });
    block = true;
    const pending = options?.onMessage?.(
      {
        version: 1,
        generation: 1,
        id: "pending-frame",
        seq: 1,
        ack: 0,
        type: "limits",
        payload: {
          commandId: "pending-limit",
          expectedRevision: 0,
          revision: 1,
          matchMicros: 2_000_000,
          dayMicros: 20_000_000,
          concurrency: 3,
        },
      },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    runner.stop();
    expect(close).not.toHaveBeenCalled();
    release?.();
    await pending;
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(state).toMatchObject({ stopped: true, operatingLimits: { revision: 0 } });
  });

  it.each([
    { ...claim, extra: "bad" },
    { ...claim, claimToken: "not-hex" },
    { ...claim, pollIntervalMs: 1 },
    { ...claim, expiresAt: new Date(startTime + 600_001).toISOString() },
    { ...claim, expiresAt: new Date(startTime).toISOString() },
    { ...claim, claimId: "../escape" },
  ])("strictly rejects malformed begin data %j", async (data) => {
    const h = harness([json(data)]);
    await expect(startRunner(origin, {}, h.io)).rejects.toThrow();
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.io.terminal).not.toHaveBeenCalledWith(expect.stringContaining("runner-claim="));
  });

  it.each([404, 410, 302, 401])("fails closed on HTTP %i without retrying", async (status) => {
    const h = harness([json(claim), json({}, status)]);
    await expect(startRunner(origin, {}, h.io)).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.store.removePending).not.toHaveBeenCalled();
  });

  it.each([
    { ...credential, controlPath: "https://evil.example" },
    { ...credential, credential: "bad\r\nheader" },
    { ...credential, claimant: { email: "owner@example.com", token: "unexpected" } },
    { ...credential, expiresAt: "yesterday" },
  ])("rejects malformed exchange without saving a credential", async (data) => {
    const h = harness([json(claim), json({ status: "claimed", ...owner }), json(data)]);
    await expect(startRunner(origin, {}, h.io)).rejects.toThrow();
    expect(h.store.saveCredential).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("bounds pending polling to ten minutes and preserves proof", async () => {
    const h = harness();
    h.fetcher.mockImplementation(async () => json({ status: "pending" }));
    await expect(
      completeRunnerClaim(
        { origin, proof: secretProof, claimId: "claim-1", deadline: startTime + 600_000 },
        h.io,
      ),
    ).rejects.toThrow(/expired/);
    expect(h.fetcher).toHaveBeenCalledTimes(300);
    expect(h.io.now()).toBe(startTime + 600_000);
    expect(h.store.removePending).not.toHaveBeenCalled();
  });

  it("does not discard proof or connect when credential persistence fails", async () => {
    const h = harness([json(claim), json({ status: "claimed", ...owner }), json(credential)]);
    h.store.saveCredential.mockRejectedValue(new Error(secretProof));
    await expect(startRunner(origin, {}, h.io)).rejects.toThrow(/Runner startup failed/);
    expect(h.store.removePending).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("bounds bodies even without content-length", async () => {
    const h = harness([
      new Response(`{"data":"${"x".repeat(16_384)}"}`, {
        headers: { "content-type": "application/json" },
      }),
    ]);
    await expect(startRunner(origin, {}, h.io)).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out fetch even if the injected transport ignores abort", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.fetcher.mockImplementation(() => new Promise(() => {}));
    const operation = expect(startRunner(origin, {}, h.io)).rejects.toThrow(
      /Runner startup failed/,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await operation;
    expect(h.store.savePending).toHaveBeenCalledOnce();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("stops a stalled response body within the same deadline", async () => {
    vi.useFakeTimers();
    const h = harness([
      new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/json" },
      }),
    ]);
    const operation = expect(startRunner(origin, {}, h.io)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await operation;
  });

  it("uses fresh proofs on independent fresh invocations", async () => {
    const h = harness([
      json(claim),
      json({ status: "claimed", ...owner }),
      json(credential),
      json(claim),
      json({ status: "claimed", ...owner }),
      json(credential),
    ]);
    vi.mocked(h.io.makeProof)
      .mockReturnValueOnce("c".repeat(64))
      .mockReturnValueOnce("d".repeat(64));
    await startRunner(origin, {}, h.io);
    await startRunner(origin, {}, h.io);
    const begins = h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/begin"));
    expect(begins.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { proof: "c".repeat(64) },
      { proof: "d".repeat(64) },
    ]);
    h.controller.abort();
  });
});

describe("executable startup lifecycle", () => {
  const resume = { resume: "machine-1" };
  const sessionSignal = new AbortController().signal;

  it("does not pair when local initialization fails and hides provider details", async () => {
    const h = harness();
    h.initialize.mockRejectedValue(new Error("private-key http://private-provider /private/path"));
    await expect(startRunner(origin, {}, h.io)).rejects.toMatchObject({
      name: "CliError",
      message: expect.stringMatching(/^Runner startup failed/),
    });
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.store.savePending).not.toHaveBeenCalled();
    expect(h.io.makeProof).not.toHaveBeenCalled();
  });

  it("closes the opened policy after a pairing failure exactly once", async () => {
    const h = harness([new Error("private-provider-error")]);
    await expect(startRunner(origin, {}, h.io)).rejects.toThrow(/^Runner startup failed/);
    expect(h.execution.close).toHaveBeenCalledOnce();
    expect(h.execution.open).not.toHaveBeenCalled();
  });

  it("closes initialization if cancellation arrives while it is opening", async () => {
    const h = harness();
    h.initialize.mockImplementationOnce(async () => {
      h.controller.abort();
      return h.execution;
    });
    await expect(startRunner(origin, {}, h.io)).rejects.toThrow(/^Runner startup failed/);
    expect(h.execution.close).toHaveBeenCalledOnce();
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it.each(["open", "connect", "start"] as const)(
    "cleans up once after %s fails without leaking details",
    async (phase) => {
      const h = harness();
      h.store.loadCredential.mockResolvedValue(credential);
      const fail = () => {
        throw new Error("private provider key and local path");
      };
      if (phase === "open") vi.mocked(h.execution.open).mockImplementationOnce(async () => fail());
      else if (phase === "connect") h.connect.mockImplementationOnce(fail);
      else h.connection.start.mockImplementationOnce(fail);
      await expect(startRunner(origin, resume, h.io)).rejects.toThrow(/^Runner startup failed/);
      expect(h.execution.close).toHaveBeenCalledOnce();
      if (phase === "start") expect(h.connection.stop).toHaveBeenCalledOnce();
    },
  );

  it.each(["load", "save"] as const)(
    "closes acquired handles once if limit %s fails",
    async (phase) => {
      const h = harness();
      h.store.loadCredential.mockResolvedValue(credential);
      const fail = async () => {
        throw new Error("private limits path");
      };
      const close = vi.fn(async (beforeRelease?: () => void, afterRelease?: () => void) => {
        beforeRelease?.();
        afterRelease?.();
      });
      h.io.limitsStore = async () => ({
        load: phase === "load" ? fail : async () => undefined,
        save: phase === "save" ? fail : async () => {},
        close,
      });
      await expect(startRunner(origin, resume, h.io)).rejects.toThrow(/^Runner startup failed/);
      expect(close).toHaveBeenCalledOnce();
      expect(h.execution.close).toHaveBeenCalledOnce();
      expect(h.execution.open).not.toHaveBeenCalled();
      expect(h.limitPolicy.stopOperatingLimits).toHaveBeenCalledOnce();
    },
  );

  it("waits for partially opened execution after cancellation before closing handles", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    let complete = () => {};
    vi.mocked(h.execution.open).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return h.game;
    });
    const close = vi.fn(async (beforeRelease?: () => void, afterRelease?: () => void) => {
      beforeRelease?.();
      afterRelease?.();
    });
    h.io.limitsStore = async () => ({ load: async () => undefined, save: async () => {}, close });
    const starting = expect(startRunner(origin, resume, h.io)).rejects.toThrow(
      /^Runner startup failed/,
    );
    await vi.waitFor(() => expect(h.execution.open).toHaveBeenCalledOnce());
    h.controller.abort();
    expect(h.limitPolicy.stopOperatingLimits).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(h.execution.close).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    complete();
    await starting;
    expect(h.execution.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("awaits game settlement on abort and makes stop idempotent", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    let settle = () => {};
    vi.mocked(h.execution.close).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const runner = await startRunner(origin, resume, h.io);
    let finished = false;
    void runner.closed.then(() => {
      finished = true;
    });
    h.controller.abort();
    runner.stop();
    await vi.waitFor(() => expect(h.execution.close).toHaveBeenCalledOnce());
    expect(h.connection.stop).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    settle();
    await runner.closed;
    expect(finished).toBe(true);
  });

  it("settles and releases local execution when transport reports stopped", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    const runner = await startRunner(origin, resume, h.io);
    await h.connect.mock.calls[0]?.[0].onState?.("stopped", sessionSignal);
    await expect(runner.closed).rejects.toThrow(/^Runner startup failed/);
    expect(h.connection.stop).toHaveBeenCalledOnce();
    expect(h.execution.close).toHaveBeenCalledOnce();
    expect(h.connection.stop.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(h.execution.close).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("stops and closes on credential expiry", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.store.loadCredential.mockResolvedValue({
      ...credential,
      expiresAt: new Date(startTime + 1000).toISOString(),
    });
    h.io.now = () => startTime + (Date.now() - clockStart);
    const clockStart = Date.now();
    const runner = await startRunner(origin, resume, h.io);
    await vi.advanceTimersByTimeAsync(1000);
    await runner.closed;
    expect(h.connection.stop).toHaveBeenCalledOnce();
    expect(h.execution.close).toHaveBeenCalledOnce();
  });

  it("does not end a long-lived credential at the Node timer maximum", async () => {
    vi.useFakeTimers();
    const h = harness();
    const clockStart = Date.now();
    h.io.now = () => startTime + (Date.now() - clockStart);
    h.store.loadCredential.mockResolvedValue({
      ...credential,
      expiresAt: new Date(startTime + 2_147_483_647 + 1000).toISOString(),
    });
    const runner = await startRunner(origin, resume, h.io);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(h.connection.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await runner.closed;
    expect(h.execution.close).toHaveBeenCalledOnce();
  });

  it("keeps execution open across transient disconnect and cleans up on terminal stopped", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    const runner = await startRunner(origin, resume, h.io);
    const state = h.connect.mock.calls[0]?.[0].onState;
    await state?.("disconnected", sessionSignal);
    expect(h.execution.close).not.toHaveBeenCalled();
    await state?.("connecting", sessionSignal);
    await state?.("connected", sessionSignal);
    expect(h.execution.close).not.toHaveBeenCalled();
    await state?.("stopped", sessionSignal);
    await expect(runner.closed).rejects.toThrow(/^Runner startup failed/);
    expect(h.connection.stop).toHaveBeenCalledOnce();
    expect(h.execution.close).toHaveBeenCalledOnce();
  });

  it.each([4400, 4401, 4409])(
    "settles local execution after the real E2 terminal close %i",
    async (code) => {
      const h = harness();
      h.store.loadCredential.mockResolvedValue(credential);
      let sockets = 0;
      h.io.connect = (options) =>
        new RunnerConnection({
          ...options,
          sleep: async () => {},
          socketFactory: () => {
            sockets++;
            return {
              bufferedAmount: 0,
              send: () => {},
              close: () => {},
              subscribe: (events) => {
                queueMicrotask(() => events.close(code));
                return () => {};
              },
            };
          },
        });
      const runner = await startRunner(origin, resume, h.io);
      await expect(runner.closed).rejects.toThrow(/^Runner startup failed/);
      expect(sockets).toBe(code === 4409 ? 4 : 1);
      expect(h.execution.close).toHaveBeenCalledOnce();
    },
  );

  it("settles local execution when the real E2 exhausts transport retries", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    let attempts = 0;
    h.io.connect = (options) =>
      new RunnerConnection({
        ...options,
        sleep: async () => {},
        random: () => 0,
        socketFactory: () => {
          attempts++;
          throw new Error("private transport detail");
        },
      });
    const runner = await startRunner(origin, resume, h.io);
    await expect(runner.closed).rejects.toThrow(/^Runner startup failed/);
    expect(attempts).toBe(11);
    expect(h.execution.close).toHaveBeenCalledOnce();
  });

  it("reports cleanup failures through a fixed CliError", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    vi.mocked(h.execution.close).mockRejectedValue(new Error("private path"));
    const runner = await startRunner(origin, resume, h.io);
    h.controller.abort();
    await expect(runner.closed).rejects.toThrow(/^Runner startup failed/);
    expect(h.execution.close).toHaveBeenCalledOnce();
  });

  it("keeps the root action and signal listeners alive until cleanup settles", async () => {
    const h = harness();
    h.store.loadCredential.mockResolvedValue(credential);
    let settle = () => {};
    vi.mocked(h.execution.close).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    let finished = false;
    const running = runRunnerStartup(resume, {
      isPrivateTerminal: () => true,
      origin: async () => origin,
      io: h.io,
    });
    void running.then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(h.connection.start).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    process.emit("SIGTERM");
    expect(h.connection.stop).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(finished).toBe(false);
    await vi.waitFor(() => expect(h.execution.close).toHaveBeenCalledOnce());
    settle();
    await running;
    expect(finished).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });

  it("refuses nonprivate terminals before local initialization or pairing", async () => {
    const h = harness();
    await expect(
      runRunnerStartup(
        {},
        { isPrivateTerminal: () => false, origin: async () => origin, io: h.io },
      ),
    ).rejects.toMatchObject({ name: "CliError", exitCode: 2 });
    expect(h.initialize).not.toHaveBeenCalled();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});

describe("local execution initialization", () => {
  function localIO() {
    const localOptions = {
      baseUrl: "http://127.0.0.1:8000/v1",
      allowModels: ["local/model"],
      maxMatchUsd: "0.5",
      maxDayUsd: "2",
      maxConcurrent: 1,
    };
    const readOptions = vi
      .spyOn(policyModule, "readLocalRunnerOptions")
      .mockResolvedValue(localOptions);
    const closePolicy = vi.fn(async () => {});
    const capabilities = {
      models: ["local/model"],
      hard: { matchMicros: 500_000, dayMicros: 2_000_000, concurrency: 1 },
      operating: { matchMicros: 500_000, dayMicros: 2_000_000, concurrency: 1 },
      revision: 0,
    };
    const openPolicy = vi.spyOn(RunnerPolicy, "open");
    vi.mocked(openPolicy, { partial: true }).mockResolvedValue({
      capabilities: () => capabilities,
      journalScope: () => "a".repeat(64),
      startupNotice: () => "resolved policy notice",
      applyOperatingLimits: vi.fn(),
      restoreOperatingLimits: vi.fn(),
      stopOperatingLimits: vi.fn(),
      close: closePolicy,
    });
    const closeJournal = vi.fn(async () => {});
    const journal = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
      close: closeJournal,
      inspect: vi.fn<NonNullable<journalModule.RunnerJournal["inspect"]>>(async () => []),
    };
    const openJournal = vi.spyOn(journalModule, "openRunnerJournal").mockResolvedValue(journal);
    const probe = vi.spyOn(engineModule, "probeRunnerEngine").mockResolvedValue(true);
    return {
      readOptions,
      localOptions,
      openPolicy,
      closePolicy,
      closeJournal,
      journal,
      openJournal,
      probe,
    };
  }

  it("refuses a journal without inventory before engine, execution or pairing authority", async () => {
    const h = localIO();
    const { inspect: _inspect, ...withoutInventory } = h.journal;
    h.openJournal.mockResolvedValue(withoutInventory);
    await expect(initializeRunnerExecution({}, new AbortController().signal)).rejects.toMatchObject(
      { code: "storage" },
    );
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.closeJournal).toHaveBeenCalledOnce();
    expect(h.closePolicy).toHaveBeenCalledOnce();
  });

  it("requires successful inventory and refuses uncertain metadata before engine activation", async () => {
    const h = localIO();
    h.journal.inspect.mockResolvedValue([{ matchId: "uncertain-match", phase: "uncertain" }]);
    await expect(initializeRunnerExecution({}, new AbortController().signal)).rejects.toMatchObject(
      { code: "uncertain" },
    );
    expect(h.journal.inspect).toHaveBeenCalledOnce();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.closeJournal).toHaveBeenCalledOnce();
    expect(h.closePolicy).toHaveBeenCalledOnce();
  });

  it("resolves file options once, opens policy with the signal and derives hello locally", async () => {
    const h = localIO();
    const signal = new AbortController().signal;
    const execution = await initializeRunnerExecution(
      { providerUrl: "http://127.0.0.1:8000/v1", allowModel: ["local/model"] },
      signal,
    );
    expect(h.readOptions).toHaveBeenCalledExactlyOnceWith({
      baseUrl: "http://127.0.0.1:8000/v1",
      allowModels: ["local/model"],
    });
    expect(h.openPolicy).toHaveBeenCalledExactlyOnceWith(h.localOptions, { signal });
    expect(h.journal.inspect).toHaveBeenCalledOnce();
    expect(execution.startupNotice()).toBe("resolved policy notice");
    expect(h.openJournal).toHaveBeenCalledOnce();
    const game = await execution.open(origin, "machine-1", () => true, signal);
    expect(h.openJournal).toHaveBeenCalledExactlyOnceWith(
      "local-spending-authority",
      "a".repeat(64),
      join(homedir(), ".cockpit-chess"),
    );
    expect(JSON.stringify(game.hello)).not.toContain("a".repeat(64));
    expect(h.probe).toHaveBeenCalledExactlyOnceWith(signal);
    expect(game.hello).toEqual({
      models: [{ id: "local/model", protocol: "openai-chat" }],
      engine: true,
      hardLimits: { matchMicros: 500_000, dayMicros: 2_000_000, concurrency: 1 },
      operatingLimits: { matchMicros: 500_000, dayMicros: 2_000_000, concurrency: 1, revision: 0 },
    });
    expect(JSON.stringify(game.hello)).not.toMatch(/127\.0\.0\.1|baseUrl|credential|apiKey/);
    await Promise.all([execution.close(), execution.close()]);
    expect(h.closePolicy).toHaveBeenCalledOnce();
    expect(h.closeJournal).toHaveBeenCalledOnce();
  });

  it("keeps the same journal for a new claim, machine and website using the same local authority", async () => {
    const h = localIO();
    const signal = new AbortController().signal;
    const first = await initializeRunnerExecution({}, signal);
    await first.open(origin, "machine-1", () => true, signal);
    await first.close();
    const second = await initializeRunnerExecution({}, signal);
    await second.open("https://another.example", "machine-2", () => true, signal);
    await second.close();
    expect(h.openJournal).toHaveBeenCalledTimes(2);
    expect(h.openJournal.mock.calls[0]).toEqual(h.openJournal.mock.calls[1]);
    expect(h.openJournal.mock.calls[1]?.[2]).toBe(join(homedir(), ".cockpit-chess"));
  });

  it.each(["journal", "probe", "game", "policy-close", "journal-close"])(
    "releases each acquired handle once when %s fails",
    async (phase) => {
      const h = localIO();
      if (phase === "journal") h.openJournal.mockRejectedValue(new Error("local path"));
      if (phase === "probe") h.probe.mockRejectedValue(new Error("engine path"));
      if (phase === "game")
        vi.mocked(h.openPolicy, { partial: true }).mockResolvedValue({
          journalScope: () => "a".repeat(64),
          capabilities: vi
            .fn()
            .mockReturnValueOnce({
              hard: { matchMicros: 500_000, dayMicros: 2_000_000, concurrency: 1 },
            })
            .mockImplementation(() => {
              throw new Error("bad capability");
            }),
          startupNotice: () => "safe notice",
          close: h.closePolicy,
        });
      if (phase === "policy-close") h.closePolicy.mockRejectedValue(new Error("ledger path"));
      if (phase === "journal-close") h.closeJournal.mockRejectedValue(new Error("journal path"));
      if (phase === "journal") {
        await expect(initializeRunnerExecution({}, new AbortController().signal)).rejects.toThrow();
        expect(h.closePolicy).toHaveBeenCalledOnce();
        expect(h.closeJournal).not.toHaveBeenCalled();
        return;
      }
      const execution = await initializeRunnerExecution({}, new AbortController().signal);
      const opened = execution.open(origin, "machine-1", () => true, new AbortController().signal);
      if (phase === "policy-close" || phase === "journal-close") await opened;
      else await expect(opened).rejects.toThrow();
      if (phase === "policy-close" || phase === "journal-close")
        await expect(execution.close()).rejects.toThrow();
      else await execution.close();
      await execution.close().catch(() => {});
      expect(h.closePolicy).toHaveBeenCalledOnce();
      expect(h.closeJournal).toHaveBeenCalledTimes(phase === "journal" ? 0 : 1);
    },
  );

  it("keeps file configuration when flags are absent and overrides only explicit fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runner-options-"));
    try {
      const file = join(dir, "runner-policy.json");
      const config = {
        baseUrl: "http://127.0.0.1:8000/v1",
        allowModels: ["local/file"],
        maxMatchUsd: "7",
        maxDayUsd: "20",
        maxConcurrent: 3,
      };
      await writeFile(file, JSON.stringify(config));
      expect(localRunnerOverrides({ server: origin, resume: "machine-1" })).toEqual({});
      expect(await readLocalRunnerOptions(localRunnerOverrides({}), file)).toEqual(config);
      expect(
        await readLocalRunnerOptions(
          localRunnerOverrides({
            maxDayUsd: "40",
            maxConcurrency: "4",
            providerUrl: "http://localhost:9000/v1",
            allowModel: ["local/flag"],
          }),
          file,
        ),
      ).toEqual({
        ...config,
        maxDayUsd: "40",
        maxConcurrent: 4,
        baseUrl: "http://localhost:9000/v1",
        allowModels: ["local/flag"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("local limits and terminal identity", () => {
  it("uses immutable local defaults and integer micros", () => {
    expect(parseRunnerCeilings({})).toEqual({
      matchMicros: 25_000_000,
      dayMicros: 100_000_000,
      concurrency: 8,
    });
    expect(Object.isFrozen(parseRunnerCeilings({}))).toBe(true);
    expect(parseRunnerCeilings({ maxMatchUsd: "1.000001" }).matchMicros).toBe(1_000_001);
  });
  it.each(["0", "-1", "NaN", "Infinity", "1e3", "0.0000001", "9007199254740991", "1\n", "1.2x"])(
    "rejects invalid money %s",
    (value) => {
      expect(() => parseRunnerCeilings({ maxMatchUsd: value })).toThrow();
    },
  );
  it.each(["0", "65", "Infinity", "2.5", "-1"])("rejects invalid concurrency %s", (value) => {
    expect(() => parseRunnerCeilings({ maxConcurrency: value })).toThrow();
  });
  it("strips controls, OSC/CSI and bidi from claimant email", () => {
    expect(
      terminalClaimant("\x1b]0;evil\x07\x1b[31mowner\r\n\t\x00\x9f\u202e@example.com\x1b[0m"),
    ).toBe("owner@example.com");
  });
});

describe("private per-origin runner files", () => {
  it("atomically persists proof and credentials as 0600, without config or origin crossover", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runner-start-"));
    try {
      const store = runnerFileStore(dir);
      const pending = {
        origin,
        proof: secretProof,
        deadline: startTime + 600_000,
        claimId: "claim-1",
      };
      await store.savePending(pending);
      await store.saveCredential(origin, credential);
      expect(await store.loadCredential(origin, "machine-1")).toEqual(credential);
      expect(await store.loadCredential("https://other.example", "machine-1")).toBeUndefined();
      const [serverDir] = await readdir(join(dir, "runner-runs"));
      const path = join(dir, "runner-runs", serverDir ?? "missing");
      const files = await readdir(path);
      expect(files).toHaveLength(2);
      expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
      for (const name of files) {
        if (process.platform !== "win32")
          expect((await stat(join(path, name))).mode & 0o777).toBe(0o600);
      }
      const pendingFile = files.find((file) => file.startsWith("pending-"));
      expect(JSON.parse(await readFile(join(path, pendingFile ?? "missing"), "utf8"))).toEqual(
        pending,
      );
      await store.removePending(pending);
      expect(await readdir(path)).toEqual(["machine-1.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
