import {
  beginHostedTurn,
  boardAt,
  createMatch,
  DEFAULT_POSITION,
  type MatchArchive,
  matchStats,
  submitMove,
  validateArchive,
} from "@cockpit-chess/chess";
import type { advanceMatch } from "@cockpit-chess/chess/runner";
import {
  type RunnerMatchConfig,
  type RunnerServerMessage,
  runnerConfigDigest,
  runnerMatchConfigSchema,
  serializeRunnerFrame,
} from "@cockpit-chess/chess/runner-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerClientAction } from "./runner-connection";
import { RunnerGameLoop } from "./runner-game";
import type { RunnerGameRecord, RunnerJournal, RunnerJournalRecord } from "./runner-journal";
import { RunnerLimitController } from "./runner-limits";
import { RunnerPolicy } from "./runner-policy";
import { RunnerSpend } from "./runner-spend";

const { evaluatePosition } = vi.hoisted(() => ({
  evaluatePosition: vi.fn<typeof import("@cockpit-chess/chess/engine").evaluatePosition>(),
}));
// Both common player analysis and the runner's spectator adapter use this boundary.
vi.mock("@cockpit-chess/chess/engine", () => ({ evaluatePosition }));

const model = "test/runner-model";
const matchId = "match_game_1";
const baseUrl = "http://127.0.0.1:8765/v1";
type Input = Exclude<RunnerServerMessage, { type: "welcome" | "heartbeat" | "pong" }>;
type Advance = typeof advanceMatch;
const cleanups: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}

function config(input: Record<string, unknown> = {}): RunnerMatchConfig {
  return runnerMatchConfigSchema.parse({
    white: { name: "Local model", model, protocol: "openai-chat" },
    black: { name: "Local opponent", model, protocol: "openai-chat" },
    rules: { legalMoves: "provided" },
    promptVersion: "1",
    ...input,
  });
}

let nextId = 0;
function message<T extends Input["type"]>(
  type: T,
  payload: Extract<Input, { type: T }>["payload"],
  id = matchId,
): Input {
  return {
    type,
    version: 1,
    generation: 1,
    id: `wire_${++nextId}`,
    seq: nextId,
    ack: 0,
    matchId: id,
    payload,
  } as Input;
}

function offer(settings = config(), id = matchId) {
  return message(
    "offer",
    {
      commandId: `offer_${++nextId}`,
      config: settings,
      configDigest: runnerConfigDigest(settings),
    },
    id,
  );
}
function start(ply = 0, commandId = `start_${++nextId}`) {
  return message("start", { commandId, expectedSeq: ply });
}
function resume(archive: MatchArchive, commandId = `resume_${++nextId}`) {
  const ply = matchStats(archive).moves;
  return message("resume", { commandId, acceptedSeq: ply, ply, fen: boardAt(archive).fen() });
}
function play(match: MatchArchive) {
  submitMove(match, boardAt(match), matchStats(match).moves === 0 ? "e2e4" : "e7e5");
  return match;
}

async function fixture(
  options: {
    advance?: Advance;
    realAdvance?: boolean;
    engine?: boolean;
    models?: string[];
    now?: () => number;
  } = {},
) {
  const records = new Map<string, RunnerJournalRecord>();
  const saves: RunnerJournalRecord[] = [];
  const journal: RunnerJournal = {
    load: vi.fn(async (id) => {
      const record = records.get(id);
      return record ? structuredClone(record) : undefined;
    }),
    save: vi.fn(async (id, record) => {
      const snapshot = structuredClone(record);
      saves.push(snapshot);
      records.set(id, snapshot);
    }),
    close: vi.fn(async () => {}),
  };
  // Skip the ledger constructor's filesystem IO; policy calls these injected methods only.
  const spend = Object.assign(Object.create(RunnerSpend.prototype) as RunnerSpend, {
    reserve: vi.fn<RunnerSpend["reserve"]>(async () => {}),
    settle: vi.fn<RunnerSpend["settle"]>(async () => {}),
    close: vi.fn<RunnerSpend["close"]>(async () => {}),
  });
  const policy = await RunnerPolicy.open(
    { baseUrl, allowModels: options.models ?? [model] },
    { spend, env: {} },
  );
  const controller = new AbortController();
  const sent: RunnerClientAction[] = [];
  const send = vi.fn((action: RunnerClientAction, _signal: AbortSignal) => {
    sent.push(structuredClone(action));
    return true;
  });
  const advance = vi.fn<Advance>(options.advance ?? (async (match) => play(match)));
  const loop = new RunnerGameLoop({
    policy,
    journal,
    engine: options.engine ?? false,
    now: options.now,
    send,
    ...(options.realAdvance ? {} : { advance }),
  });
  cleanups.push(async () => {
    controller.abort();
    await loop.close();
  });
  const handle = (input: Input, signal = controller.signal) => loop.handle(input, signal);
  const record = () => {
    const stored = records.get(matchId);
    if (!stored || stored.phase === "cancelled")
      throw new Error("Missing test game journal record");
    return stored;
  };
  const idle = async (ply: number) => {
    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        type: "snapshot",
        matchId,
        payload: {
          acceptedSeq: ply === 0 ? 0 : ply - 1,
          ply,
          fen: boardAt(record().archive).fen(),
        },
      }),
    );
  };
  return {
    loop,
    policy,
    spend,
    journal,
    records,
    saves,
    controller,
    sent,
    send,
    advance,
    handle,
    record,
    idle,
  };
}

beforeEach(() => {
  nextId = 0;
  evaluatePosition.mockReset().mockImplementation(async (fen) => ({
    engine: "stockfish-19-lite-single",
    fen,
    depth: 1,
    nodes: 1000,
    cp: 12,
    mate: null,
    bestMove: null,
  }));
  // Any accidental provider/catalog request fails; the real-advance test supplies SSE below.
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => {
      throw new Error("Unexpected fetch");
    }),
  );
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("paired runner game loop", () => {
  it("advertises only local policy capabilities and keeps transport IDs separate from archive UUIDs", async () => {
    const f = await fixture();
    expect(f.loop.hello).toEqual({
      models: [{ id: model, protocol: "openai-chat" }],
      engine: false,
      operatingLimits: { ...f.policy.capabilities().operating, revision: 0 },
      hardLimits: { ...f.policy.capabilities().hard },
    });
    await f.handle(offer());
    expect(f.sent).toContainEqual({ type: "accept", matchId, payload: { commandId: "offer_1" } });
    expect(f.record().archive.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.record().archive.id).not.toBe(matchId);
    expect(f.record().archive.config.prompt.version).toBe("1");
    expect(JSON.stringify(f.sent)).not.toContain(baseUrl);
    expect(JSON.stringify(f.loop.hello)).not.toContain("local-inference");
    // Save must detach synchronously: later in-memory phase changes cannot rewrite history.
    expect(f.saves[0]?.phase).toBe("offered");
  });

  it("keeps a large locally allowed catalog within the complete transport frame bound", async () => {
    const models = Array.from({ length: 700 }, (_, index) => `vendor/${"m".repeat(140)}${index}`);
    const f = await fixture({ models });
    const frame = serializeRunnerFrame({
      version: 1,
      generation: Number.MAX_SAFE_INTEGER,
      id: "00000000-0000-4000-8000-000000000000",
      seq: Number.MAX_SAFE_INTEGER,
      ack: Number.MAX_SAFE_INTEGER,
      type: "hello",
      payload: f.loop.hello,
    });
    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(65_536);
    expect(f.loop.hello.models.length).toBeGreaterThan(0);
    expect(f.loop.hello.models.length).toBeLessThanOrEqual(512);
    expect(f.loop.hello.models.every((entry) => models.includes(entry.id))).toBe(true);
  });

  it("shares concurrent close completion and still closes the journal after policy close fails", async () => {
    const f = await fixture();
    vi.mocked(f.spend.close).mockRejectedValueOnce(new Error("synthetic storage detail"));
    const first = f.loop.close();
    expect(f.loop.close()).toBe(first);
    await expect(first).rejects.toThrow("RUNNER_GAME_STORAGE");
    expect(f.journal.close).toHaveBeenCalledOnce();
    // This expected failed handle has already exercised cleanup; do not close it again in afterEach.
    cleanups.pop();
  });

  it("settles an initially terminal board without a model call", async () => {
    const f = await fixture();
    await f.handle(offer(config({ initialFen: "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1" })));
    expect(f.record().phase).toBe("terminal");
    expect(f.sent).toContainEqual({
      type: "event",
      matchId,
      payload: { kind: "completed", result: "1-0", termination: "checkmate" },
    });
    expect(f.advance).not.toHaveBeenCalled();
  });

  it("persists the uncertainty fence before local credentials and advances exactly once per confirmed start", async () => {
    const entered = gate();
    const finish = gate();
    const f = await fixture({
      advance: async (match, options) => {
        expect(f.record().phase).toBe("uncertain");
        expect(matchStats(f.record().archive).moves).toBe(0);
        expect(options?.credentials?.w).toMatchObject({ baseUrl, apiKey: "local-inference" });
        options?.credentials?.w?.beforeDispatch?.();
        entered.release();
        await finish.promise;
        return play(match);
      },
    });
    const localCredentials = f.policy.credentials.bind(f.policy);
    const credentials = vi
      .spyOn(f.policy, "credentials")
      .mockImplementation((authority, player) => {
        expect(f.record().phase).toBe("uncertain");
        return localCredentials(authority, player);
      });
    await f.handle(offer());
    await f.handle(start());
    await entered.promise;
    expect(f.saves.map((item) => item.phase)).toEqual(["offered", "uncertain"]);
    expect(credentials).toHaveBeenCalledTimes(2);
    await f.handle(start(0, "other_start"));
    expect(f.sent.at(-1)).toEqual({ type: "error", payload: { code: "BUSY" } });
    expect(f.advance).toHaveBeenCalledTimes(1);
    finish.release();
    await f.idle(1);
    expect(f.sent.filter((item) => item.type === "move")).toHaveLength(1);
    expect(f.record().confirmedPly).toBe(0);
    await f.handle(start(1));
    expect(f.sent.at(-1)).toEqual({ type: "error", payload: { code: "STALE" } });
    expect(f.advance).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a first resume only after durable reconciliation, then sends its snapshot", async () => {
    const f = await fixture();
    await f.handle(offer());
    const command = resume(f.record().archive, "first_resume");
    const entered = gate();
    const saving = gate();
    const save = vi.mocked(f.journal.save).getMockImplementation();
    if (!save) throw new Error("Missing journal seam");
    vi.mocked(f.journal.save).mockImplementationOnce(async (id, record) => {
      entered.release();
      await saving.promise;
      await save(id, record);
    });
    const before = f.sent.length;
    const handling = f.handle(command);
    await entered.promise;
    expect(f.sent).toHaveLength(before);
    saving.release();
    await handling;
    expect(f.sent.slice(before)).toEqual([
      { type: "ack", payload: { commandId: "first_resume" } },
      {
        type: "snapshot",
        matchId,
        payload: { acceptedSeq: 0, ply: 0, fen: boardAt(f.record().archive).fen() },
      },
    ]);
    expect(f.record()).toMatchObject({ phase: "ready", confirmedPly: 0 });
    const saved = f.saves.length;
    const after = f.sent.length;
    await f.handle(command);
    expect(f.sent.slice(after)).toEqual([{ type: "ack", payload: { commandId: "first_resume" } }]);
    expect(f.saves).toHaveLength(saved);
    expect(f.advance).not.toHaveBeenCalled();
    expect(f.spend.reserve).not.toHaveBeenCalled();
    expect(evaluatePosition).not.toHaveBeenCalled();
  });

  it.each(["same-process", "new-instance"] as const)(
    "rebinds a %s reconnect by fresh offer and acknowledges its durable resume",
    async (mode) => {
      const first = await fixture();
      const settings = config();
      await first.handle(offer(settings));
      await first.handle(resume(first.record().archive, "initial_resume"));
      const archive = structuredClone(first.record().archive);
      first.controller.abort();
      const next = mode === "same-process" ? first : await fixture();
      if (mode === "new-instance") {
        next.records.set(matchId, structuredClone(first.record()));
        await first.loop.close();
      }
      const reconnected = new AbortController();
      const reoffer = { ...offer(settings), generation: 2 };
      const beginning = next.sent.length;
      await next.handle(reoffer, reconnected.signal);
      if (reoffer.type !== "offer") throw new Error("Expected reoffer");
      expect(next.sent.slice(beginning)).toEqual([
        { type: "accept", matchId, payload: { commandId: reoffer.payload.commandId } },
        {
          type: "snapshot",
          matchId,
          payload: { acceptedSeq: 0, ply: 0, fen: boardAt(archive).fen() },
        },
      ]);
      const confirming = { ...resume(archive, "replacement_resume"), generation: 2 };
      const before = next.sent.length;
      await next.handle(confirming, reconnected.signal);
      expect(next.sent.slice(before)).toEqual([
        { type: "ack", payload: { commandId: "replacement_resume" } },
        {
          type: "snapshot",
          matchId,
          payload: { acceptedSeq: 0, ply: 0, fen: boardAt(archive).fen() },
        },
      ]);
      expect(next.record()).toMatchObject({ phase: "ready", confirmedPly: 0 });
      expect(next.record().archive).toEqual(archive);
      expect(first.advance).not.toHaveBeenCalled();
      expect(next.advance).not.toHaveBeenCalled();
      expect(next.spend.reserve).not.toHaveBeenCalled();
      expect(evaluatePosition).not.toHaveBeenCalled();
    },
  );

  it("persists stop-before-offer tombstones before ACK and keeps later offers usable", async () => {
    const f = await fixture();
    const begin = vi.spyOn(f.policy, "beginMatch");
    const entered = gate();
    const released = gate();
    const save = vi.mocked(f.journal.save).getMockImplementation();
    if (!save) throw new Error("Missing journal seam");
    vi.mocked(f.journal.save).mockImplementationOnce(async (id, record) => {
      entered.release();
      await released.promise;
      await save(id, record);
    });
    const command = message("stop", { commandId: "stop_unknown_0" }, "unknown0");
    const handling = f.handle(command);
    await entered.promise;
    expect(f.sent).toEqual([]);
    expect(begin).not.toHaveBeenCalled();
    released.release();
    await handling;
    expect(f.records.get("unknown0")).toEqual({ phase: "cancelled" });
    expect(f.sent).toEqual([{ type: "ack", payload: { commandId: "stop_unknown_0" } }]);
    const saved = f.saves.length;
    await f.handle(command);
    await f.handle(message("stop", { commandId: "repeat_new_id" }, "unknown0"));
    expect(f.saves).toHaveLength(saved);
    for (let index = 1; index < 4; index++)
      await f.handle(message("stop", { commandId: `stop_unknown_${index}` }, `unknown${index}`));
    expect(f.sent.filter((item) => item.type === "ack")).toHaveLength(6);
    expect(begin).not.toHaveBeenCalled();
    await f.handle(offer(config(), "unknown0"));
    expect(f.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "policy" } });
    await f.handle(offer());
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "accept", matchId }));
    expect(begin).toHaveBeenCalledTimes(1);
    expect(f.advance).not.toHaveBeenCalled();
    expect(f.spend.reserve).not.toHaveBeenCalled();
    expect(evaluatePosition).not.toHaveBeenCalled();
  });

  it.each(["ready", "uncertain"] as const)(
    "terminalizes a restored %s record before stop ACK without acquiring execution authority",
    async (phase) => {
      const f = await fixture();
      const settings = config();
      const archive = createMatch(settings);
      f.records.set(matchId, {
        digest: runnerConfigDigest(settings),
        phase,
        confirmedPly: 0,
        archive,
      });
      const begin = vi.spyOn(f.policy, "beginMatch");
      await f.handle(message("stop", { commandId: "restored_stop" }));
      expect(f.record()).toMatchObject({
        digest: runnerConfigDigest(settings),
        phase: "terminal",
        archive: { status: "stopped", termination: "cancelled" },
      });
      expect(f.sent).toEqual([{ type: "ack", payload: { commandId: "restored_stop" } }]);
      expect(begin).not.toHaveBeenCalled();
      await f.handle(offer(settings));
      expect(f.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "policy" } });
      expect(f.advance).not.toHaveBeenCalled();
      expect(f.spend.reserve).not.toHaveBeenCalled();
    },
  );

  it("fences an old-session game and ACKs stop only on the new originating signal", async () => {
    const f = await fixture();
    const begin = vi.spyOn(f.policy, "beginMatch");
    await f.handle(offer());
    f.controller.abort();
    const connection = new AbortController();
    const before = f.sent.length;
    await f.handle(message("stop", { commandId: "offline_stop" }), connection.signal);
    expect(f.record()).toMatchObject({ phase: "terminal", archive: { status: "stopped" } });
    expect(f.sent.slice(before)).toEqual([
      {
        type: "event",
        matchId,
        payload: { kind: "stopped", result: "*", termination: "cancelled" },
      },
      { type: "ack", payload: { commandId: "offline_stop" } },
    ]);
    expect(
      f.send.mock.calls.slice(before).every(([, signal]) => signal === connection.signal),
    ).toBe(true);
    expect(begin).toHaveBeenCalledTimes(1);
    await f.handle(start());
    expect(f.advance).not.toHaveBeenCalled();
    await f.handle(offer(), connection.signal);
    expect(f.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "busy" } });
  });

  it("does not ACK an aborted stop session even when its cancellation becomes durable", async () => {
    const f = await fixture();
    const entered = gate();
    const released = gate();
    const save = vi.mocked(f.journal.save).getMockImplementation();
    if (!save) throw new Error("Missing journal seam");
    vi.mocked(f.journal.save).mockImplementationOnce(async (id, record) => {
      entered.release();
      await released.promise;
      await save(id, record);
    });
    const stopped = f.handle(message("stop", { commandId: "lost_stop_ack" }));
    await entered.promise;
    f.controller.abort();
    released.release();
    await stopped;
    expect(f.sent).toEqual([]);
    expect(f.records.get(matchId)).toEqual({ phase: "cancelled" });
    const current = new AbortController();
    await f.handle(message("stop", { commandId: "lost_stop_ack" }), current.signal);
    expect(f.sent).toEqual([{ type: "ack", payload: { commandId: "lost_stop_ack" } }]);
    expect(f.send.mock.calls.at(-1)?.[1]).toBe(current.signal);
    expect(f.advance).not.toHaveBeenCalled();
  });

  it("keeps an offline stop terminal when old-session work settles late", async () => {
    const entered = gate();
    const released = gate();
    const f = await fixture({
      advance: async (archive) => {
        entered.release();
        await released.promise;
        return play(archive);
      },
    });
    await f.handle(offer());
    await f.handle(start());
    await entered.promise;
    f.controller.abort();
    const current = new AbortController();
    await f.handle(message("stop", { commandId: "stop_old_work" }), current.signal);
    expect(f.record().phase).toBe("terminal");
    expect(f.sent.at(-1)).toEqual({ type: "ack", payload: { commandId: "stop_old_work" } });
    released.release();
    await vi.waitFor(() => expect(f.record().archive.status).toBe("stopped"));
    expect(f.record().phase).toBe("terminal");
    expect(f.sent.some((item) => item.type === "move")).toBe(false);
    await f.handle(offer(), current.signal);
    expect(f.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "busy" } });
    expect(f.advance).toHaveBeenCalledTimes(1);
    expect(f.spend.reserve).not.toHaveBeenCalled();
  });

  it("retains unknown cancellation across a new loop and bounds cancellation memory", async () => {
    const first = await fixture();
    await first.handle(message("stop", { commandId: "before_offer" }));
    const restored = await fixture();
    restored.records.set(matchId, structuredClone(first.records.get(matchId)!));
    const begin = vi.spyOn(restored.policy, "beginMatch");
    await restored.handle(offer());
    expect(restored.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "policy" } });
    await restored.handle(message("stop", { commandId: "restored_unknown_stop" }));
    expect(restored.sent.at(-1)).toEqual({
      type: "ack",
      payload: { commandId: "restored_unknown_stop" },
    });
    for (let index = 0; index < 255; index++)
      await restored.handle(message("stop", { commandId: `cancel_${index}` }, `cancelled${index}`));
    expect(restored.records.size).toBe(256);
    const saved = restored.saves.length;
    await restored.handle(message("stop", { commandId: "over_cancel_capacity" }, "new_overflow"));
    expect(restored.sent.at(-1)).toEqual({ type: "error", payload: { code: "BUSY" } });
    expect(restored.saves).toHaveLength(saved);
    await restored.handle(message("stop", { commandId: "duplicate_at_capacity" }));
    expect(restored.sent.at(-1)).toEqual({
      type: "ack",
      payload: { commandId: "duplicate_at_capacity" },
    });
    expect(begin).not.toHaveBeenCalled();
    expect(restored.advance).not.toHaveBeenCalled();
  });

  it("reserves one terminal stop after normal command capacity without growing on repeats", async () => {
    const f = await fixture();
    await f.handle(offer());
    const archive = structuredClone(f.record().archive);
    // One offer plus4095 distinct normal commands fills the real public loop.
    for (let index = 0; index < 4095; index++) await f.handle(resume(archive, `fill_${index}`));
    const full = f.sent.length;
    await f.handle(resume(archive, "over_normal_capacity"));
    expect(f.sent.slice(full)).toEqual([{ type: "error", payload: { code: "BUSY" } }]);
    expect(f.record().phase).toBe("ready");
    const stop = message("stop", { commandId: "reserved_terminal_stop" });
    await f.handle(stop);
    expect(f.record()).toMatchObject({
      phase: "terminal",
      archive: { status: "stopped", termination: "cancelled" },
    });
    expect(f.sent.at(-1)).toEqual({
      type: "ack",
      payload: { commandId: "reserved_terminal_stop" },
    });
    const saved = f.saves.length;
    const beforeDuplicate = f.sent.length;
    await f.handle(stop);
    expect(f.sent.slice(beforeDuplicate)).toEqual([
      { type: "ack", payload: { commandId: "reserved_terminal_stop" } },
    ]);
    expect(f.saves).toHaveLength(saved);
    await f.handle(message("stop", { commandId: "second_terminal_stop" }));
    expect(f.sent.at(-1)).toEqual({ type: "error", payload: { code: "BUSY" } });
    expect(f.saves).toHaveLength(saved);
    await f.handle(resume(archive, "after_terminal_capacity"));
    expect(f.sent.at(-1)).toEqual({ type: "error", payload: { code: "BUSY" } });
    expect(f.saves).toHaveLength(saved);
    expect(f.advance).not.toHaveBeenCalled();
    expect(f.spend.reserve).not.toHaveBeenCalled();
    expect(evaluatePosition).not.toHaveBeenCalled();
  });

  it("permits one next turn only after resume confirms exact accepted sequence, FEN and ply", async () => {
    const f = await fixture();
    await f.handle(offer());
    await f.handle(start());
    await f.idle(1);
    await f.handle(resume(f.record().archive));
    expect(f.record().confirmedPly).toBe(1);
    await f.handle(start(1));
    await f.idle(2);
    expect(f.advance).toHaveBeenCalledTimes(2);
    expect(matchStats(f.record().archive).moves).toBe(2);
  });

  it("acks a reused command ID without redispatch during flight or after completion", async () => {
    const entered = gate();
    const finish = gate();
    const f = await fixture({
      advance: async (match) => {
        entered.release();
        await finish.promise;
        return play(match);
      },
    });
    await f.handle(offer());
    await f.handle(start(0, "once"));
    await entered.promise;
    await f.handle(start(0, "once"));
    expect(f.sent.at(-1)).toEqual({ type: "ack", payload: { commandId: "once" } });
    await f.handle(start(0, "fresh_in_flight"));
    expect(f.sent.at(-1)).toEqual({ type: "error", payload: { code: "BUSY" } });
    finish.release();
    await f.idle(1);
    await f.handle(resume(f.record().archive));
    await f.handle(start(1, "once"));
    await f.handle(start(1, "fresh_in_flight"));
    await f.idle(2);
    expect(f.advance).toHaveBeenCalledTimes(2);
  });

  it("does not consume a reconciliation command rejected while a model turn is busy", async () => {
    const entered = gate();
    const release = gate();
    const f = await fixture({
      advance: async (archive) => {
        play(archive);
        entered.release();
        await release.promise;
        return archive;
      },
    });
    await f.handle(offer());
    await f.handle(start());
    await entered.promise;
    const expected = createMatch(config());
    play(expected);
    const confirm = resume(expected, "retry_reconciliation");
    await f.handle(confirm);
    expect(f.sent.at(-1)).toEqual({ type: "error", payload: { code: "BUSY" } });
    release.release();
    await f.idle(1);
    await f.handle(confirm);
    expect(f.sent.at(-1)).toEqual({
      type: "snapshot",
      matchId,
      payload: { acceptedSeq: 1, ply: 1, fen: boardAt(expected).fen() },
    });
    await f.handle(start(1));
    await f.idle(2);
    expect(f.advance).toHaveBeenCalledTimes(2);
  });

  it.each(["acceptedSeq", "ply", "fen"] as const)(
    "interrupts lost-ack resume with incorrect %s without replay",
    async (field) => {
      const f = await fixture();
      await f.handle(offer());
      await f.handle(start());
      await f.idle(1);
      const command = resume(f.record().archive);
      if (command.type !== "resume") throw new Error("Expected resume");
      Object.assign(command.payload, { [field]: field === "fen" ? DEFAULT_POSITION : 0 });
      await f.handle(command);
      expect(f.record().phase).toBe("terminal");
      expect(f.sent.at(-1)).toEqual({
        type: "event",
        matchId,
        payload: { kind: "interrupted", result: "*", termination: "interrupted" },
      });
      await f.handle(start(1));
      expect(f.advance).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["offered", "uncertain", "terminal"] as const)(
    "rejects durable %s state without redispatch",
    async (phase) => {
      const f = await fixture();
      const settings = config();
      f.records.set(matchId, {
        digest: runnerConfigDigest(settings),
        phase,
        confirmedPly: 0,
        archive: createMatch(settings),
      });
      await f.handle(offer(settings));
      expect(f.sent).toContainEqual({
        type: "reject",
        matchId,
        payload: { commandId: "offer_1", reason: "policy" },
      });
      expect(f.advance).not.toHaveBeenCalled();
      expect(f.journal.save).not.toHaveBeenCalled();
    },
  );

  it("requires explicit board reconciliation for a ready archive loaded after restart", async () => {
    const f = await fixture();
    const settings = config();
    const archive = createMatch(settings);
    play(archive);
    f.records.set(matchId, {
      digest: runnerConfigDigest(settings),
      phase: "ready",
      confirmedPly: 1,
      archive,
    });
    await f.handle(offer(settings));
    await f.handle(start(1));
    expect(f.advance).not.toHaveBeenCalled();
    expect(f.sent.at(-1)).toEqual({ type: "error", payload: { code: "STALE" } });
    await f.handle(resume(archive));
    await f.handle(start(1));
    await f.idle(2);
    expect(f.advance).toHaveBeenCalledTimes(1);
    expect(f.record().archive.id).toBe(archive.id);
  });

  it("rejects an unknown durable phase without trying to interpret or replay it", async () => {
    const f = await fixture();
    const settings = config();
    const stored: RunnerGameRecord = {
      digest: runnerConfigDigest(settings),
      phase: "uncertain",
      confirmedPly: 0,
      archive: createMatch(settings),
    };
    // Model an unrecognized future/corrupt state returned by the journal boundary.
    Object.assign(stored, { phase: "unknown" });
    f.records.set(matchId, stored);
    await f.handle(offer(settings));
    expect(f.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "policy" } });
    expect(f.advance).not.toHaveBeenCalled();
    expect(f.journal.save).not.toHaveBeenCalled();
  });

  it("rejects a ready record whose archive config disagrees with its envelope digest", async () => {
    const f = await fixture();
    const settings = config();
    f.records.set(matchId, {
      digest: runnerConfigDigest(settings),
      phase: "ready",
      confirmedPly: 0,
      archive: createMatch(config({ title: "Different pinned settings" })),
    });
    await f.handle(offer(settings));
    expect(f.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "policy" } });
    expect(f.advance).not.toHaveBeenCalled();
  });

  it("awaits a durable uncertainty write before obtaining credentials or dispatching", async () => {
    const writing = gate();
    const finish = gate();
    const f = await fixture();
    await f.handle(offer());
    const credentials = vi.spyOn(f.policy, "credentials");
    const save = vi.mocked(f.journal.save).getMockImplementation();
    if (!save) throw new Error("Missing journal seam");
    vi.mocked(f.journal.save).mockImplementationOnce(async (id, record) => {
      writing.release();
      await finish.promise;
      await save(id, record);
    });
    const pending = f.handle(start());
    await writing.promise;
    expect(credentials).not.toHaveBeenCalled();
    expect(f.advance).not.toHaveBeenCalled();
    expect(evaluatePosition).not.toHaveBeenCalled();
    finish.release();
    await pending;
    await f.idle(1);
    expect(f.advance).toHaveBeenCalledTimes(1);
  });

  it("does not call credentials or inference if the uncertainty write fails, and poisons future work", async () => {
    const f = await fixture();
    await f.handle(offer());
    const credentials = vi.spyOn(f.policy, "credentials");
    vi.mocked(f.journal.save).mockRejectedValueOnce(new Error("Synthetic disk failure"));
    await f.handle(start());
    expect(credentials).not.toHaveBeenCalled();
    expect(f.advance).not.toHaveBeenCalled();
    expect(f.record().phase).toBe("offered");
    const count = f.sent.length;
    await f.handle(start());
    await f.handle(offer(config(), "another_game"));
    expect(f.sent).toHaveLength(count);
  });

  it("aborts every active authority when any journal load fails", async () => {
    const entered = gate();
    const finish = gate();
    let activeSignal: AbortSignal | undefined;
    const f = await fixture({
      advance: async (archive, options) => {
        activeSignal = options?.signal;
        entered.release();
        await finish.promise;
        return archive;
      },
    });
    await f.handle(offer());
    await f.handle(start());
    await entered.promise;
    vi.mocked(f.journal.load).mockRejectedValueOnce(new Error("private filesystem detail"));
    await f.handle(offer(config(), "other_match"));
    expect(activeSignal?.aborted).toBe(true);
    expect(f.sent.at(-1)).toEqual({ type: "error", payload: { code: "INVALID" } });
    expect(JSON.stringify(f.sent)).not.toContain("private filesystem detail");
    finish.release();
  });

  it("rejects an offer when its first journal write fails", async () => {
    const f = await fixture();
    vi.mocked(f.journal.save).mockRejectedValueOnce(new Error("Synthetic disk failure"));
    await f.handle(offer());
    expect(f.sent).toEqual([
      { type: "reject", matchId, payload: { commandId: "offer_1", reason: "policy" } },
    ]);
    expect(f.advance).not.toHaveBeenCalled();
  });

  it("does not infer if the connection is lost while the uncertainty fence is being saved", async () => {
    const writing = gate();
    const finish = gate();
    const f = await fixture();
    await f.handle(offer());
    const original = vi.mocked(f.journal.save).getMockImplementation();
    if (!original) throw new Error("Missing journal seam");
    vi.mocked(f.journal.save).mockImplementationOnce(async (id, record) => {
      await original(id, record);
      writing.release();
      await finish.promise;
    });
    const pending = f.handle(start());
    await writing.promise;
    f.controller.abort();
    finish.release();
    await pending;
    expect(f.record().phase).toBe("uncertain");
    expect(f.advance).not.toHaveBeenCalled();
    await f.handle(offer(), new AbortController().signal);
    expect(f.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "busy" } });
  });

  it("aborts an in-flight call after disconnect and refuses a new connection's replay", async () => {
    const entered = gate();
    let inferenceSignal: AbortSignal | undefined;
    const f = await fixture({
      advance: async (match, options) => {
        inferenceSignal = options?.signal;
        entered.release();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return match;
      },
    });
    await f.handle(offer());
    await f.handle(start());
    await entered.promise;
    f.controller.abort();
    await vi.waitFor(() => expect(f.record().phase).toBe("terminal"));
    expect(inferenceSignal?.aborted).toBe(true);
    await f.handle(offer(), new AbortController().signal);
    expect(f.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "busy" } });
    expect(f.advance).toHaveBeenCalledTimes(1);
    expect(f.sent.some((item) => item.type === "move")).toBe(false);
  });

  it("does not publish or replay a completed call if disconnected before its durable result write returns", async () => {
    const writing = gate();
    const finish = gate();
    const f = await fixture();
    await f.handle(offer());
    const save = vi.mocked(f.journal.save).getMockImplementation();
    if (!save) throw new Error("Missing journal seam");
    vi.mocked(f.journal.save).mockImplementation(async (id, record) => {
      await save(id, record);
      if (record.phase === "ready") {
        writing.release();
        await finish.promise;
      }
    });
    await f.handle(start());
    await writing.promise;
    f.controller.abort();
    finish.release();
    // Let the detached runTurn finish after its save resolves; no clocks or IO are pending.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.advance).toHaveBeenCalledTimes(1);
    expect(f.sent.some((item) => item.type === "move")).toBe(false);
    const reconnected = new AbortController();
    await f.handle(offer(), reconnected.signal);
    expect(f.sent.at(-1)).toMatchObject({ type: "snapshot", payload: { ply: 1, acceptedSeq: 0 } });
    await f.handle(start(1), reconnected.signal);
    expect(f.advance).toHaveBeenCalledTimes(1);
    const stale = resume(createMatch(config()));
    await f.handle(stale, reconnected.signal);
    expect(f.record().phase).toBe("terminal");
    expect(f.sent.at(-1)).toEqual({
      type: "event",
      matchId,
      payload: { kind: "interrupted", result: "*", termination: "interrupted" },
    });
  });

  it("stops authority on output backpressure and cannot spend on another turn", async () => {
    const f = await fixture();
    await f.handle(offer());
    f.send.mockImplementation((action) => {
      f.sent.push(action);
      return action.type !== "move";
    });
    await f.handle(start());
    await vi.waitFor(() => expect(f.sent.some((item) => item.type === "move")).toBe(true));
    const after = f.sent.filter((item) => item.type === "snapshot");
    expect(after).toHaveLength(1);
    await f.handle(resume(f.record().archive));
    await f.handle(start(1));
    expect(f.advance).toHaveBeenCalledTimes(1);
    expect(f.spend.reserve).not.toHaveBeenCalled();
  });

  it("does not dispatch when the started event encounters output backpressure", async () => {
    const f = await fixture();
    await f.handle(offer());
    f.send.mockReturnValue(false);
    const credentials = vi.spyOn(f.policy, "credentials");
    await f.handle(start());
    expect(f.record().phase).toBe("uncertain");
    expect(credentials).not.toHaveBeenCalled();
    expect(f.advance).not.toHaveBeenCalled();
    expect(f.spend.reserve).not.toHaveBeenCalled();
  });

  it.each(["stop", "close"] as const)(
    "cancels local work on %s and never redispatches",
    async (operation) => {
      const entered = gate();
      let signal: AbortSignal | undefined;
      const f = await fixture({
        advance: async (archive, options) => {
          signal = options?.signal;
          entered.release();
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return archive;
        },
      });
      await f.handle(offer());
      await f.handle(start());
      await entered.promise;
      if (operation === "close") await f.loop.close();
      else {
        await f.handle(message("stop", { commandId: "cancel" }));
        await vi.waitFor(() => expect(f.record().phase).toBe("terminal"));
        expect(f.sent).toContainEqual({ type: "ack", payload: { commandId: "cancel" } });
      }
      expect(signal?.aborted).toBe(true);
      await f.handle(start());
      expect(f.advance).toHaveBeenCalledTimes(1);
      if (operation === "close") {
        expect(f.journal.close).toHaveBeenCalledTimes(1);
        expect(f.spend.close).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("persists an acknowledged stop racing the completed turn result as a terminal tombstone", async () => {
    const f = await fixture();
    const writing = gate();
    const release = gate();
    const save = vi.mocked(f.journal.save).getMockImplementation();
    if (!save) throw new Error("Missing journal fixture");
    vi.mocked(f.journal.save).mockImplementation(async (id, record) => {
      await save(id, record);
      if (record.phase === "ready" && matchStats(record.archive).moves === 1) {
        writing.release();
        await release.promise;
      }
    });
    await f.handle(offer());
    await f.handle(start());
    await writing.promise;
    const other = f.policy.beginMatch("second_slot", f.controller.signal);
    await f.handle(message("stop", { commandId: "stop_during_result" }));
    expect(f.sent.at(-1)).toEqual({ type: "ack", payload: { commandId: "stop_during_result" } });
    release.release();
    await vi.waitFor(() => expect(f.record().archive.status).toBe("stopped"));
    expect(f.record().phase).toBe("terminal");
    expect(f.sent).toContainEqual({
      type: "event",
      matchId,
      payload: { kind: "stopped", result: "*", termination: "cancelled" },
    });
    expect(f.sent.some((action) => action.type === "move")).toBe(false);
    const replacement = f.policy.beginMatch("freed_slot", f.controller.signal);
    replacement.finish();
    other.finish();
    const restarted = await fixture();
    restarted.records.set(matchId, structuredClone(f.record()));
    await restarted.handle(offer());
    expect(restarted.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "policy" } });
    expect(restarted.advance).not.toHaveBeenCalled();
  });

  it("acknowledges stop only after a durable non-resumable fence, before final loop settlement", async () => {
    const f = await fixture();
    const resultEntered = gate();
    const releaseResult = gate();
    const finalEntered = gate();
    const releaseFinal = gate();
    let writeTail = Promise.resolve();
    vi.mocked(f.journal.save).mockImplementation((id, input) => {
      const record = structuredClone(input);
      const write = writeTail.then(async () => {
        if (record.phase === "ready" && matchStats(record.archive).moves === 1) {
          resultEntered.release();
          await releaseResult.promise;
        }
        if (record.phase === "terminal" && record.archive.status === "stopped") {
          finalEntered.release();
          await releaseFinal.promise;
        }
        f.records.set(id, record);
        f.saves.push(record);
      });
      writeTail = write;
      return write;
    });
    await f.handle(offer());
    await f.handle(start());
    await resultEntered.promise;
    const stopping = f.handle(message("stop", { commandId: "durable_stop" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      f.sent.some((action) => action.type === "ack" && action.payload.commandId === "durable_stop"),
    ).toBe(false);
    releaseResult.release();
    await stopping;
    await finalEntered.promise;
    expect(f.sent.at(-1)).toEqual({ type: "ack", payload: { commandId: "durable_stop" } });
    // Simulate restart from disk now, while the final stopped archive rewrite is still pending.
    expect(f.record().phase).toBe("terminal");
    const restarted = await fixture();
    restarted.records.set(matchId, structuredClone(f.record()));
    await restarted.handle(offer());
    expect(restarted.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "policy" } });
    expect(restarted.advance).not.toHaveBeenCalled();
    releaseFinal.release();
  });

  it("frees terminal match authority when disconnect races terminal-result persistence", async () => {
    const f = await fixture({
      advance: async (archive) => {
        archive.status = "completed";
        archive.result = "0-1";
        archive.termination = "resignation";
        return archive;
      },
    });
    const entered = gate();
    const release = gate();
    const save = vi.mocked(f.journal.save).getMockImplementation();
    if (!save) throw new Error("Missing journal fixture");
    vi.mocked(f.journal.save).mockImplementation(async (id, record) => {
      if (record.phase === "terminal") {
        entered.release();
        await release.promise;
      }
      await save(id, record);
    });
    await f.handle(offer());
    await f.handle(start());
    await entered.promise;
    const other = f.policy.beginMatch("second_slot", f.controller.signal);
    f.controller.abort();
    release.release();
    await vi.waitFor(() => expect(f.record().phase).toBe("terminal"));
    const connected = new AbortController();
    await vi.waitFor(() => {
      const next = f.policy.beginMatch("freed_terminal_slot", connected.signal);
      next.finish();
    });
    other.finish();
    expect(
      f.sent.some((action) => action.type === "event" && action.payload.kind === "completed"),
    ).toBe(false);
    expect(f.record().archive.termination).toBe("resignation");
  });

  it("reconciles and advances while a bounded spectator search is pending, dropping its stale score", async () => {
    const f = await fixture({ engine: true });
    const entered = gate();
    const release = gate();
    evaluatePosition.mockImplementationOnce(async (fen) => {
      entered.release();
      await release.promise;
      return {
        engine: "stockfish-19-lite-single",
        fen,
        depth: 1,
        nodes: 1000,
        cp: 99,
        mate: null,
        bestMove: null,
      };
    });
    await f.handle(offer());
    await f.handle(start());
    await entered.promise;
    const firstFen = boardAt(f.record().archive).fen();
    await f.handle(resume(f.record().archive, "confirm_during_spectator"));
    expect(f.sent.at(-1)).toEqual({
      type: "snapshot",
      matchId,
      payload: { acceptedSeq: 1, ply: 1, fen: firstFen },
    });
    await f.handle(start(1));
    await f.idle(2);
    release.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.advance).toHaveBeenCalledTimes(2);
    expect(
      f.sent.some((action) => action.type === "evaluation" && action.payload.fen === firstFen),
    ).toBe(false);
  });

  it("stops a parked human locally without inference", async () => {
    const f = await fixture();
    await f.handle(offer(config({ white: { name: "Human", model: "human", protocol: "human" } })));
    await f.handle(start());
    expect(f.record().archive.turn.type).toBe("human");
    await f.handle(message("stop", { commandId: "cancel" }));
    expect(f.record().phase).toBe("terminal");
    expect(f.record().archive.termination).toBe("cancelled");
    expect(f.advance).not.toHaveBeenCalled();
  });
});

describe("operating-limit integration", () => {
  it("applies a durable reduction to the real policy, fences a parked human and permits new matches", async () => {
    const f = await fixture();
    let settlement = Promise.resolve();
    const controller = await RunnerLimitController.open({
      hard: f.policy.capabilities().hard,
      terminal: () => {},
      store: {
        load: async () => undefined,
        save: async () => {},
        close: async (before, after) => {
          before?.();
          after?.();
        },
      },
      policy: {
        restoreOperatingLimits: (limits) => f.policy.restoreOperatingLimits(limits),
        applyOperatingLimits: (limits, revision) => {
          f.policy.applyOperatingLimits(limits, revision);
          settlement = f.loop.stopActive();
        },
        stopOperatingLimits: () => f.policy.stopOperatingLimits(),
      },
    });
    await f.handle(offer(config({ white: { name: "Human", model: "human", protocol: "human" } })));
    await f.handle(start());
    const result = await controller.apply({
      commandId: "lower_limits",
      expectedRevision: 0,
      revision: 1,
      matchMicros: 500000,
      dayMicros: 5000000,
      concurrency: 1,
    });
    await settlement;
    expect(result.status).toBe("applied");
    expect(f.policy.capabilities().operating.matchMicros).toBe(500000);
    expect(f.record().phase).toBe("terminal");
    expect(f.record().archive.status).toBe("stopped");
    await f.handle(offer(config(), "new_after_lowering"));
    expect(f.sent.at(-2)).toMatchObject({ type: "accept", matchId: "new_after_lowering" });
    await controller.close();
  });

  it("durably fences a stopped game even if its paid turn is still settling", async () => {
    const entered = gate();
    const release = gate();
    let signal: AbortSignal | undefined;
    const f = await fixture({
      advance: async (archive, options) => {
        signal = options?.signal;
        entered.release();
        await release.promise;
        return archive;
      },
    });
    await f.handle(offer());
    await f.handle(start());
    await entered.promise;
    f.policy.applyOperatingLimits({ matchMicros: 500000, dayMicros: 5000000, concurrency: 1 }, 1);
    await f.loop.stopActive();
    expect(signal?.aborted).toBe(true);
    expect(f.record().phase).toBe("terminal");
    const restarted = await fixture();
    restarted.records.set(matchId, structuredClone(f.record()));
    await restarted.handle(offer());
    expect(restarted.sent.at(-1)).toMatchObject({ type: "reject" });
    expect(restarted.advance).not.toHaveBeenCalled();
    release.release();
  });
});

describe("evaluation and terminal backpressure", () => {
  it("stops further dispatch after an evaluation send fails", async () => {
    const f = await fixture({ engine: true });
    f.send.mockImplementation((action) => {
      f.sent.push(structuredClone(action));
      return action.type !== "evaluation";
    });
    await f.handle(offer());
    await f.handle(start());
    await vi.waitFor(() =>
      expect(f.sent.some((action) => action.type === "evaluation")).toBe(true),
    );
    await f.handle(resume(f.record().archive));
    await f.handle(start(1));
    expect(f.advance).toHaveBeenCalledTimes(1);
  });
  it("retains a terminal tombstone when completion cannot be sent", async () => {
    const f = await fixture({
      advance: async (archive) => {
        archive.status = "completed";
        archive.result = "0-1";
        archive.termination = "resignation";
        return archive;
      },
    });
    f.send.mockImplementation((action) => {
      f.sent.push(structuredClone(action));
      return action.type !== "event" || action.payload.kind === "started";
    });
    await f.handle(offer());
    await f.handle(start());
    await vi.waitFor(() => expect(f.record().phase).toBe("terminal"));
    await f.handle(offer());
    await f.handle(start());
    expect(f.advance).toHaveBeenCalledTimes(1);
    expect(f.record().archive.termination).toBe("resignation");
  });
});

describe("runner offer validation", () => {
  it.each([
    "digest",
    "model",
    "protocol",
    "prompt",
    "url",
    "hard",
    "player-url",
    "missing-prompt",
  ] as const)(
    "rejects an offer with mismatched or injected %s before saving or inferring",
    async (change) => {
      const f = await fixture();
      const command = offer();
      if (command.type !== "offer") throw new Error("Expected offer");
      if (change === "digest") command.payload.configDigest = "0".repeat(64);
      if (change === "model" || change === "protocol") {
        if (change === "model") command.payload.config.white.model = "test/not-allowed";
        else command.payload.config.white.protocol = "anthropic";
        command.payload.configDigest = runnerConfigDigest(command.payload.config);
      }
      if (change === "prompt") Object.assign(command.payload.config, { promptVersion: "2" });
      if (change === "url")
        Object.assign(command.payload, { baseUrl: "https://untrusted.example/v1" });
      if (change === "hard") Object.assign(command.payload, { hard: { matchMicros: 999999999 } });
      if (change === "player-url")
        Object.assign(command.payload.config.white, { baseUrl: "https://untrusted.example/v1" });
      if (change === "missing-prompt")
        Reflect.deleteProperty(command.payload.config, "promptVersion");
      await f.handle(command);
      expect(f.sent.some((item) => item.type === "accept")).toBe(false);
      expect(f.sent.at(-1)).toMatchObject(
        change === "digest" || change === "model" || change === "protocol"
          ? { type: "reject", payload: { reason: "policy" } }
          : { type: "error", payload: { code: "INVALID" } },
      );
      expect(f.journal.save).not.toHaveBeenCalled();
      expect(f.advance).not.toHaveBeenCalled();
      expect(f.spend.reserve).not.toHaveBeenCalled();
    },
  );

  it.each(["tool", "after-move", "both"] as const)(
    "rejects player engine rule %s when local engine is unavailable",
    async (engineEvaluation) => {
      const f = await fixture();
      await f.handle(offer(config({ rules: { engineEvaluation } })));
      expect(f.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "unsupported" } });
      expect(f.journal.save).not.toHaveBeenCalled();
      expect(evaluatePosition).not.toHaveBeenCalled();
    },
  );

  it.each(["two-humans", "persistent-human"])("rejects unsupported %s rules", async (kind) => {
    const f = await fixture();
    const human = { name: "Human", model: "human", protocol: "human" };
    await f.handle(
      offer(
        config({
          white: human,
          ...(kind === "two-humans" ? { black: human } : { rules: { context: "persistent" } }),
        }),
      ),
    );
    expect(f.sent.at(-1)).toMatchObject({ type: "reject", payload: { reason: "unsupported" } });
    expect(f.advance).not.toHaveBeenCalled();
  });

  it("accepts engine-off rules without engine and evaluates only the spectator lane when available", async () => {
    const f = await fixture({ engine: true });
    await f.handle(offer());
    await f.handle(start());
    await f.idle(1);
    expect(evaluatePosition).toHaveBeenCalledTimes(1);
    expect(evaluatePosition).toHaveBeenCalledWith(boardAt(f.record().archive).fen(), {
      nodes: 10000,
      signal: expect.any(AbortSignal),
      lane: "spectators",
    });
    expect(f.sent).toContainEqual({
      type: "evaluation",
      matchId,
      payload: {
        fen: boardAt(f.record().archive).fen(),
        ply: 1,
        nodes: 10000,
        score: { cp: 12 },
        purpose: "spectator",
      },
    });
  });

  it("keeps a confirmed move playable when optional spectator analysis is unavailable", async () => {
    const f = await fixture({ engine: true });
    evaluatePosition.mockRejectedValue(new Error("Synthetic unavailable engine"));
    await f.handle(offer());
    await f.handle(start());
    await f.idle(1);
    expect(f.record().phase).toBe("ready");
    expect(f.record().archive.status).toBe("running");
    expect(f.sent.some((item) => item.type === "evaluation")).toBe(false);
    expect(f.sent.some((item) => item.type === "event" && item.payload.kind !== "started")).toBe(
      false,
    );
    await f.handle(resume(f.record().archive));
    await f.handle(start(1));
    await f.idle(2);
    expect(f.advance).toHaveBeenCalledTimes(2);
  });
});

describe("common human turns and real model runner", () => {
  it("preserves the common engine-error outcome when required player evaluation fails", async () => {
    const f = await fixture({ engine: true });
    evaluatePosition.mockRejectedValue(new Error("Synthetic unavailable engine"));
    await f.handle(
      offer(
        config({
          white: { name: "Human", model: "human", protocol: "human" },
          rules: { engineEvaluation: "after-move" },
        }),
      ),
    );
    await f.handle(start());
    await f.handle(message("human-move", { commandId: "human_e4", expectedSeq: 0, uci: "e2e4" }));
    await vi.waitFor(() => expect(f.record().phase).toBe("terminal"));
    expect(f.record().archive.termination).toBe("engine-error");
    expect(matchStats(f.record().archive).moves).toBe(1);
    expect(f.sent).toContainEqual({
      type: "event",
      matchId,
      payload: { kind: "interrupted", result: "*", termination: "engine-error" },
    });
    expect(f.advance).not.toHaveBeenCalled();
  });

  it("begins a durable human turn on start; illegal input leaves the archive and timer unchanged", async () => {
    const f = await fixture();
    const settings = config({ white: { name: "Human", model: "human", protocol: "human" } });
    await f.handle(offer(settings));
    await f.handle(start());
    const archive = structuredClone(f.record().archive);
    expect(archive.turn).toMatchObject({ type: "human", side: "w" });
    expect(f.record().phase).toBe("ready");
    expect(f.advance).not.toHaveBeenCalled();
    const saveCount = f.saves.length;
    await f.handle(message("human-move", { commandId: "illegal", expectedSeq: 0, uci: "e2e5" }));
    expect(f.sent.at(-1)).toEqual({ type: "error", payload: { code: "INVALID" } });
    expect(f.record().archive).toEqual(archive);
    expect(f.saves).toHaveLength(saveCount);
    expect(f.advance).not.toHaveBeenCalled();
  });

  it.each(["after-move", "both"] as const)(
    "persists a late human timeout without invalid %s player analysis",
    async (engineEvaluation) => {
      let now = Date.parse("2026-11-27T12:00:00.000Z");
      const f = await fixture({ engine: true, now: () => now });
      const save = vi.mocked(f.journal.save).getMockImplementation();
      if (!save) throw new Error("Missing journal fixture");
      vi.mocked(f.journal.save).mockImplementation(async (id, record) => {
        if (record.phase === "cancelled") throw new Error("Expected human game record");
        validateArchive(record.archive);
        if (record.phase === "uncertain") now += 1001;
        await save(id, record);
      });
      await f.handle(
        offer(
          config({
            white: { name: "Human", model: "human", protocol: "human" },
            rules: { engineEvaluation, turnTimeoutMs: 1000 },
          }),
        ),
      );
      await f.handle(start());
      const other = f.policy.beginMatch("other_live_game", f.controller.signal);
      await f.handle(
        message("human-move", { commandId: "late_human", expectedSeq: 0, uci: "e2e4" }),
      );
      await vi.waitFor(() => expect(f.record().phase).toBe("terminal"));
      expect(f.record().archive.termination).toBe("move-timeout");
      expect(f.record().archive.events.some((event) => event.type === "evaluation")).toBe(false);
      expect(() => validateArchive(f.record().archive)).not.toThrow();
      expect(f.sent).toContainEqual({
        type: "event",
        matchId,
        payload: { kind: "completed", result: "0-1", termination: "move-timeout" },
      });
      expect(f.sent.some((action) => action.type === "move")).toBe(false);
      expect(
        evaluatePosition.mock.calls.every(([, options]) => options?.lane === "spectators"),
      ).toBe(true);
      expect(() => other.assertLive()).not.toThrow();
      other.finish();
      expect(f.advance).not.toHaveBeenCalled();
    },
  );

  it("plays human then model through real advanceMatch and policy-authorized HTTP without network", async () => {
    const f = await fixture({ realAdvance: true });
    const settings = config({ white: { name: "Human", model: "human", protocol: "human" } });
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${baseUrl}/chat/completions`);
      expect(request.redirect).toBe("error");
      expect(f.record().phase).toBe("uncertain");
      expect(matchStats(f.record().archive).moves).toBe(1);
      expect(f.spend.reserve).toHaveBeenCalledTimes(1);
      expect(f.spend.reserve).toHaveBeenCalledWith(expect.objectContaining({ matchId, micros: 0 }));
      bodies.push(JSON.parse(await request.text()));
      const base = { id: "reply", object: "chat.completion.chunk", created: 0, model };
      const events = [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: '{"move":"e7e5"}' },
              finish_reason: null,
            },
          ],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    vi.stubGlobal("fetch", fetch);
    await f.handle(offer(settings));
    await f.handle(start());
    await f.handle(message("human-move", { commandId: "human_e4", expectedSeq: 0, uci: "e2e4" }));
    await f.idle(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.record().archive.turn.type).toBe("idle");
    expect(f.sent.filter((item) => item.type === "move")).toEqual([
      {
        type: "move",
        matchId,
        payload: { uci: "e2e4", ply: 1, fen: boardAt(f.record().archive).fen() },
      },
    ]);
    await f.handle(start(1));
    expect(fetch).not.toHaveBeenCalled();
    await f.handle(resume(f.record().archive));
    await f.handle(start(1));
    await f.idle(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toMatchObject({
      model,
      prompt_cache_key: `chess-${f.record().archive.id}-b`,
    });
    expect(f.record().archive.events.filter((item) => item.type === "attempt")).toEqual([
      expect.objectContaining({ accepted: true, move: "e2e4" }),
      expect.objectContaining({ accepted: true, move: "e7e5" }),
    ]);
    expect(f.sent.filter((item) => item.type === "move")).toHaveLength(2);
    expect(evaluatePosition).not.toHaveBeenCalled();
    expect(JSON.stringify(f.record())).not.toContain("local-inference");
  });

  it("uses common player evaluation after a human move with a separate spectator lane", async () => {
    const f = await fixture({ engine: true });
    await f.handle(
      offer(
        config({
          white: { name: "Human", model: "human", protocol: "human" },
          rules: { engineEvaluation: "after-move", engineNodes: 1000 },
        }),
      ),
    );
    await f.handle(start());
    await f.handle(message("human-move", { commandId: "human_e4", expectedSeq: 0, uci: "e2e4" }));
    await f.idle(1);
    expect(evaluatePosition.mock.calls.map((call) => call[1]?.lane ?? "players")).toEqual([
      "players",
      "spectators",
    ]);
    expect(
      f.sent.filter((item) => item.type === "evaluation").map((item) => item.payload.purpose),
    ).toEqual(expect.arrayContaining(["spectator", "player"]));
    expect(f.advance).not.toHaveBeenCalled();
  });

  it("restores a common parked human turn only after reconciliation", async () => {
    const f = await fixture();
    const settings = config({ white: { name: "Human", model: "human", protocol: "human" } });
    const archive = createMatch(settings);
    beginHostedTurn(archive);
    f.records.set(matchId, {
      digest: runnerConfigDigest(settings),
      phase: "ready",
      confirmedPly: 0,
      archive,
    });
    await f.handle(offer(settings));
    await f.handle(
      message("human-move", { commandId: "before_resume", expectedSeq: 0, uci: "e2e4" }),
    );
    expect(matchStats(f.record().archive).moves).toBe(0);
    await f.handle(resume(archive));
    await f.handle(
      message("human-move", { commandId: "after_resume", expectedSeq: 0, uci: "e2e4" }),
    );
    await f.idle(1);
    expect(f.record().archive.turn.type).toBe("idle");
    expect(f.advance).not.toHaveBeenCalled();
  });
});
