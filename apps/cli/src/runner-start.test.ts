import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerConnectionOptions } from "./runner-connection";
import {
  completeRunnerClaim,
  type PendingRunnerClaim,
  parseRunnerCeilings,
  type RunnerStartupIO,
  runnerFileStore,
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
  const io: RunnerStartupIO = {
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
  };
  return { io, fetcher, store, connection, connect, controller };
}

afterEach(() => vi.useRealTimers());

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
    expect(output).toContain("$25/match, $100/day, concurrency 8");
    expect(output).not.toContain(secretProof);
    expect(output).not.toContain(credential.credential);
    const options = h.connect.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      url: `${origin.replace("https:", "wss:")}/api/cli/runner/ws`,
      credential: credential.credential,
      hello: {
        models: [],
        engine: false,
        operatingLimits: {
          matchMicros: 1_000_000,
          dayMicros: 10_000_000,
          concurrency: 2,
          revision: 0,
        },
      },
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

  it("rejects offers and every execution/control action, never raising local limits", async () => {
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
        payload: { commandId: "offer-1", configDigest: "a".repeat(64) },
      },
      signal,
    );
    expect(h.connection.send).toHaveBeenLastCalledWith(
      {
        type: "reject",
        matchId: "match-1",
        payload: { commandId: "offer-1", reason: "unsupported" },
      },
      signal,
    );
    await options?.onMessage?.(
      {
        ...envelope,
        type: "limits",
        payload: {
          commandId: "limits-1",
          revision: 100,
          matchMicros: 900_000_000,
          dayMicros: 900_000_000,
          concurrency: 64,
        },
      },
      signal,
    );
    expect(h.connection.send).toHaveBeenLastCalledWith(
      { type: "error", payload: { code: "UNSUPPORTED" } },
      signal,
    );
    expect(options?.hello.operatingLimits).toEqual({
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
    expect(h.connection.send).toHaveBeenLastCalledWith(
      { type: "error", payload: { code: "UNSUPPORTED" } },
      signal,
    );
    h.controller.abort();
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
