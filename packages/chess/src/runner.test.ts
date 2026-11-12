import type { AgentLoopOptions, AgentMessage } from "@cockpit-chess/agent-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveByteLength,
  createMatch,
  finishMatch,
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  type MatchEvent,
  matchStats,
  serializeArchive,
  utf8ByteLength,
  validateArchive,
} from "./index";
import {
  ARCHIVE_HEADROOM_BYTES,
  advanceMatch,
  archiveLimitReached,
  endAtArchiveLimit,
  eventEntryBytes,
  MATCH_INTERRUPTED,
  MAX_UNMEASURED_EVENT_BYTES,
  runMatch,
  TERMINAL_BOOKKEEPING_BYTES,
  turnPrompt,
} from "./runner";
import { sharedOutputTokens } from "./tokenizer";

const { runAgentLoop, evaluatePosition } = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  evaluatePosition: vi.fn(),
}));
vi.mock("./engine", () => ({ evaluatePosition }));
vi.mock("@cockpit-chess/agent-runtime", () => ({
  runAgentLoop,
  defineTool: (options: unknown) => options,
}));
const random = { name: "Baseline", model: "random", protocol: "random" as const };
const model = {
  name: "Secret Model Name",
  model: "vendor/secret-model",
  protocol: "openai-chat" as const,
};
const credentials = {
  w: { apiKey: "test-only", inputMicrosPerMillion: 100000, outputMicrosPerMillion: 200000 },
};
beforeEach(() => {
  vi.resetAllMocks();
  evaluatePosition.mockImplementation(async (fen: string) => ({
    engine: "stockfish-19-lite-single",
    fen,
    cp: 20,
    mate: null,
    bestMove: "e2e4",
    depth: 8,
    nodes: 1000,
  }));
});
describe("bounded local and worker match runner", () => {
  it("runs unattended baseline games and validates their archive", async () => {
    const match = createMatch({ white: random, black: random, rules: { maxPlies: 8 } });
    await runMatch(match, { random: () => 0 });
    expect(match).toMatchObject({ status: "completed", termination: "ply-limit" });
    expect(matchStats(match).moves).toBe(8);
    expect(validateArchive(match)).toEqual(match);
  });
  it("hides identities and history in fresh context, with complete position state", () => {
    const match = createMatch({ white: random, black: model, rules: { context: "fresh" } });
    const prompt = turnPrompt(match, "w");
    expect(prompt).not.toContain("secret-model");
    expect(prompt).not.toContain("Secret Model Name");
    expect(prompt).toContain("FEN:");
    expect(prompt).toContain("Draw state:");
    const visible = createMatch({
      white: random,
      black: model,
      rules: { opponentIdentity: "disclosed" },
    });
    expect(turnPrompt(visible, "w")).toContain("vendor/secret-model");
  });
  it("enables prompt caching only for persistent context, keyed per match and side", async () => {
    const reply = async (options: { messages: AgentMessage[] }) => ({
      messages: [
        ...options.messages,
        { id: "m", role: "assistant", parts: [{ type: "text", content: '{"move":"e2e4"}' }] },
      ],
      usage: {},
      stopReason: "completed",
    });
    runAgentLoop.mockImplementation(reply);
    const persistent = createMatch({
      white: model,
      black: random,
      rules: { context: "persistent" },
    });
    await advanceMatch(persistent, { credentials });
    expect(runAgentLoop.mock.calls[0]?.[0]).toMatchObject({
      cache: true,
      cacheKey: `chess-${persistent.id}-w`,
    });
    const fresh = createMatch({ white: model, black: random, rules: { context: "fresh" } });
    await advanceMatch(fresh, { credentials });
    expect(runAgentLoop.mock.calls[1]?.[0]).toMatchObject({ cache: false });
  });
  it("records illegal attempts, supplies retry feedback within the turn, then accepts correction", async () => {
    const match = createMatch({ white: model, black: random, rules: {} });
    runAgentLoop
      .mockImplementationOnce(async (options) => ({
        messages: [
          ...options.messages,
          { id: "bad", role: "assistant", parts: [{ type: "text", content: '{"move":"e2e5"}' }] },
        ],
        usage: {},
        stopReason: "completed",
      }))
      .mockImplementationOnce(async (options) => ({
        messages: [
          ...options.messages,
          { id: "good", role: "assistant", parts: [{ type: "text", content: '{"move":"e2e4"}' }] },
        ],
        usage: {},
        stopReason: "completed",
      }));
    await advanceMatch(match, { credentials });
    expect(matchStats(match)).toMatchObject({ moves: 1, illegalAttempts: 1 });
    expect(JSON.stringify(runAgentLoop.mock.calls[1]?.[0].messages)).toContain("Board unchanged");
    expect(validateArchive(match)).toEqual(match);
  });
  it("clears previous-turn memory in fresh mode and preserves it in persistent mode", async () => {
    const memory = {
      w: [
        {
          id: "old",
          role: "assistant" as const,
          parts: [{ type: "text", content: "OLD_PRIVATE_TURN" }],
        },
      ],
    };
    const response = async (options: { messages: unknown[] }) => ({
      messages: [
        ...options.messages,
        { id: "new", role: "assistant", parts: [{ type: "text", content: '{"move":"e2e4"}' }] },
      ],
      usage: {},
      stopReason: "completed",
    });
    runAgentLoop.mockImplementation(response);
    await advanceMatch(createMatch({ white: model, black: random, rules: { context: "fresh" } }), {
      credentials,
      memory,
    });
    expect(JSON.stringify(runAgentLoop.mock.calls[0]?.[0].messages)).not.toContain(
      "OLD_PRIVATE_TURN",
    );
    await advanceMatch(
      createMatch({ white: model, black: random, rules: { context: "persistent" } }),
      { credentials, memory },
    );
    expect(JSON.stringify(runAgentLoop.mock.calls[1]?.[0].messages)).toContain("OLD_PRIVATE_TURN");
  });
  it("vetoes dispatch before a token or cost allowance would be exceeded", async () => {
    runAgentLoop.mockImplementation(async (options) => {
      const check = await options.onBeforeDispatch({
        messages: options.messages,
        iteration: 0,
        lastDispatchAt: null,
      });
      expect(check?.veto).toBeDefined();
      return { messages: options.messages, usage: {}, stopReason: "vetoed" };
    });
    const tokens = createMatch({ white: model, black: random, rules: { tokenBudget: 256 } });
    await advanceMatch(tokens, { credentials });
    expect(tokens.termination).toBe("token-budget");
    const cost = createMatch({ white: model, black: random, rules: { costBudgetMicros: 100 } });
    await advanceMatch(cost, { credentials });
    expect(cost.termination).toBe("cost-budget");
  });
  it.each([false, true])("records shutdown interruption (in flight: %s)", async (inFlight) => {
    const match = createMatch({ white: model, black: random, rules: {} });
    const controller = new AbortController();
    if (inFlight) {
      runAgentLoop.mockImplementation(async (options) => {
        controller.abort(MATCH_INTERRUPTED);
        return { messages: options.messages, stopReason: "aborted" };
      });
    } else controller.abort(MATCH_INTERRUPTED);
    await advanceMatch(match, { credentials, signal: controller.signal });
    expect(match).toMatchObject({ status: "error", termination: "interrupted", result: "*" });
    expect(validateArchive(match)).toEqual(match);
  });
  it.each(["provider", "evaluation"])(
    "records interruption when shutdown throws during %s",
    async (phase) => {
      const match = createMatch({
        white: model,
        black: random,
        rules: { engineEvaluation: phase === "evaluation" ? "after-move" : "off" },
      });
      const controller = new AbortController();
      const interrupt = () => {
        controller.abort(MATCH_INTERRUPTED);
        throw new Error("Aborted during shutdown");
      };
      runAgentLoop.mockImplementation(async (options) => {
        if (phase === "provider") interrupt();
        return {
          messages: [...options.messages, reply('{"move":"e2e4"}')],
          stopReason: "completed",
        };
      });
      evaluatePosition.mockImplementation(interrupt);
      await advanceMatch(match, { credentials, signal: controller.signal });
      expect(match).toMatchObject({ status: "error", termination: "interrupted", result: "*" });
      expect(validateArchive(match)).toEqual(match);
    },
  );
  it("keeps an in-flight operator stop cancelled", async () => {
    const match = createMatch({ white: model, black: random, rules: {} });
    const controller = new AbortController();
    runAgentLoop.mockImplementation(async (options) => {
      controller.abort();
      return { messages: options.messages, stopReason: "aborted" };
    });
    await advanceMatch(match, { credentials, signal: controller.signal });
    expect(match).toMatchObject({ status: "stopped", termination: "cancelled", result: "*" });
    expect(validateArchive(match)).toEqual(match);
  });
  it.each(["output-truncated", "max-iterations"])(
    "counts %s against the illegal-attempt limit",
    async (stopReason) => {
      const match = createMatch({ white: model, black: random, rules: { maxAttempts: 2 } });
      runAgentLoop.mockImplementation(async (options) => ({
        messages: [...options.messages, reply('{"move":"e2e4"}')],
        stopReason,
      }));
      await advanceMatch(match, { credentials });
      expect(runAgentLoop).toHaveBeenCalledTimes(2);
      expect(matchStats(match)).toMatchObject({ moves: 0, illegalAttempts: 2 });
      expect(match).toMatchObject({
        status: "completed",
        termination: "illegal-forfeit",
        result: "0-1",
      });
      expect(
        match.events
          .filter((event) => event.type === "attempt")
          .every((event) => event.move === "[unparseable]" && event.reason === "unparseable"),
      ).toBe(true);
      expect(validateArchive(match)).toEqual(match);
    },
  );
  it.each(["output-truncated", "max-iterations"])(
    "retries after %s without replaying dangling tool calls",
    async (stopReason) => {
      const match = createMatch({ white: model, black: random, rules: { context: "persistent" } });
      const previous = reply("previous completed turn");
      const memory = { w: [previous] };
      let seed: AgentMessage[] = [];
      runAgentLoop
        .mockImplementationOnce(async (options) => {
          seed = [...options.messages];
          return {
            messages: [
              ...options.messages,
              {
                id: "failed-call",
                role: "assistant",
                parts: [
                  {
                    type: "tool-call",
                    id: "first",
                    name: "board",
                    arguments: "{}",
                    state: "complete",
                  },
                ],
              },
              {
                id: "failed-result",
                role: "user",
                parts: [
                  {
                    type: "tool-result",
                    toolCallId: "first",
                    content: "position",
                    state: "complete",
                  },
                ],
              },
              {
                id: "dangling-call",
                role: "assistant",
                parts: [
                  {
                    type: "tool-call",
                    id: "dangling",
                    name: "board",
                    arguments: '{"representation":',
                    state: "partial",
                  },
                ],
              },
            ],
            stopReason,
          };
        })
        .mockImplementationOnce(async (options) => {
          expect(options.messages.slice(0, -1)).toEqual(seed);
          expect(options.messages.at(-1)).toMatchObject({
            role: "user",
            parts: [{ type: "text", content: expect.stringContaining("Board unchanged") }],
          });
          return {
            messages: [...options.messages, reply('{"move":"e2e4"}')],
            stopReason: "completed",
          };
        });
      await advanceMatch(match, { credentials, memory });
      expect(runAgentLoop).toHaveBeenCalledTimes(2);
      expect(matchStats(match)).toMatchObject({ moves: 1, illegalAttempts: 1 });
      expect(memory.w[0]).toEqual(previous);
      expect(
        memory.w.some((entry) =>
          ["failed-call", "failed-result", "dangling-call"].includes(entry.id),
        ),
      ).toBe(false);
      expect(validateArchive(match)).toEqual(match);
    },
  );
  it("keeps genuine provider failures unscored", async () => {
    const match = createMatch({ white: model, black: random, rules: {} });
    runAgentLoop.mockRejectedValue(new Error("Network unavailable"));
    await advanceMatch(match, { credentials });
    expect(match).toMatchObject({ status: "error", termination: "provider-error", result: "*" });
    expect(matchStats(match).illegalAttempts).toBe(0);
    expect(validateArchive(match)).toEqual(match);
  });
  it("never dispatches after cancellation or for a human turn", async () => {
    const match = createMatch({ white: model, black: random, rules: {} });
    const controller = new AbortController();
    controller.abort();
    await advanceMatch(match, { signal: controller.signal });
    expect(match.termination).toBe("cancelled");
    await advanceMatch(
      createMatch({ white: { ...model, protocol: "human" }, black: random, rules: {} }),
    );
    expect(runAgentLoop).not.toHaveBeenCalled();
  });
});

describe("shared tokens, anonymous commentary and engine assistance", () => {
  it("accounts with the shared encoding independently of reported provider tokens", async () => {
    runAgentLoop.mockImplementation(async (options) => {
      await options.onBeforeDispatch({ messages: options.messages });
      const messages = [
        ...options.messages,
        { id: "reply", role: "assistant", parts: [{ type: "text", content: '{"move":"e2e4"}' }] },
      ];
      await options.onMessagesChange(messages);
      await options.onUsage({ inputTokens: 99999, outputTokens: 99999 });
      return { messages, stopReason: "completed" };
    });
    const match = createMatch({
      white: model,
      black: random,
      rules: { tokenAccounting: "cl100k_base", tokenBudget: 4096 },
    });
    await advanceMatch(match, { credentials });
    expect(matchStats(match)).toMatchObject({ moves: 1, inputTokens: 99999, outputTokens: 99999 });
    expect(matchStats(match).sharedInputTokens).toBeGreaterThan(0);
    expect(matchStats(match).sharedOutputTokens).toBeGreaterThan(0);
    expect(validateArchive(match)).toEqual(match);
  });
  it("aborts on streamed shared-budget exhaustion and never accepts the over-budget move", async () => {
    runAgentLoop.mockImplementation(async (options) => {
      await options.onBeforeDispatch({ messages: options.messages });
      const messages = [
        ...options.messages,
        {
          id: "reply",
          role: "assistant",
          parts: [{ type: "text", content: "word ".repeat(5000) }],
        },
      ];
      await options.onMessagesChange(messages);
      expect(options.abortSignal.aborted).toBe(true);
      return { messages: options.messages, stopReason: "aborted" };
    });
    const match = createMatch({
      white: model,
      black: random,
      rules: { tokenAccounting: "cl100k_base", tokenBudget: 4096 },
    });
    await advanceMatch(match, { credentials });
    expect(match).toMatchObject({ termination: "token-budget", result: "0-1" });
    expect(matchStats(match).moves).toBe(0);
    expect(matchStats(match).sharedOutputTokens).toBeGreaterThan(4096);
    expect(validateArchive(match)).toEqual(match);
  });
  it("retains anonymous trash talk while redacting configured model identities", async () => {
    runAgentLoop.mockImplementation(async (options) => ({
      messages: [
        ...options.messages,
        {
          id: "reply",
          role: "assistant",
          parts: [
            {
              type: "text",
              content: JSON.stringify({
                move: "e2e4",
                comment: "vendor/secret-model says your king is next.",
              }),
            },
          ],
        },
      ],
      stopReason: "completed",
    }));
    const match = createMatch({
      white: model,
      black: random,
      rules: { opponentIdentity: "hidden", trashTalk: true },
    });
    await advanceMatch(match, { credentials });
    const prompt = turnPrompt(match, "b");
    expect(prompt).toContain("your king is next");
    expect(prompt).not.toContain("vendor/secret-model");
    expect(validateArchive(match)).toEqual(match);
  });
  it("limits actual engine calls per turn and records tool results", async () => {
    runAgentLoop.mockImplementation(async (options) => {
      const tool = options.tools.find((entry: { name: string }) => entry.name === "engine_eval");
      for (let i = 0; i < 3; i++) await tool.execute({}, new AbortController().signal);
      return {
        messages: [
          ...options.messages,
          { id: "reply", role: "assistant", parts: [{ type: "text", content: '{"move":"e2e4"}' }] },
        ],
        stopReason: "completed",
      };
    });
    const match = createMatch({ white: model, black: random, rules: { engineEvaluation: "tool" } });
    await advanceMatch(match, { credentials });
    expect(evaluatePosition).toHaveBeenCalledTimes(2);
    expect(match.events.filter((event) => event.type === "tool")).toHaveLength(3);
    expect(validateArchive(match)).toEqual(match);
  });
  it("records post-move evaluations even after the final accepted move", async () => {
    const match = createMatch({
      white: random,
      black: random,
      rules: { maxPlies: 2, engineEvaluation: "after-move" },
    });
    await runMatch(match, { random: () => 0 });
    expect(match.events.filter((event) => event.type === "evaluation")).toHaveLength(2);
    expect(match.status).toBe("completed");
    expect(validateArchive(match)).toEqual(match);
    const forged = structuredClone(match);
    const last = forged.events.at(-1);
    if (last?.type === "evaluation") last.evaluation.fen = "invented";
    expect(() => validateArchive(forged)).toThrow("evaluation");
  });
});

const reply = (content: string): AgentMessage => ({
  id: crypto.randomUUID(),
  role: "assistant",
  parts: [{ type: "text", content }],
});
/** A provider stand-in that plays the first legal move listed in its prompt. */
const legalPlayer =
  ({ usage = true }: { usage?: boolean } = {}) =>
  async (options: {
    messages: Array<{ parts: Array<{ content?: string }> }>;
    onBeforeDispatch: (ctx: unknown) => Promise<{ veto?: unknown } | undefined>;
    onUsage: (usage: { inputTokens: number; outputTokens: number }) => void;
  }) => {
    const check = await options.onBeforeDispatch({ messages: options.messages });
    if (check?.veto) return { messages: options.messages, stopReason: "vetoed" };
    if (usage) options.onUsage({ inputTokens: 40, outputTokens: 10 });
    const prompt = options.messages.at(-1)?.parts[0]?.content ?? "";
    const move = /Legal UCI moves: (\S+)/.exec(prompt)?.[1] ?? "0000";
    return {
      messages: [...options.messages, reply(JSON.stringify({ move }))],
      stopReason: "completed",
    };
  };
/** Drops wall-clock fields, which legitimately differ between runs. */
/**
 * Pads an archive with replay-valid tool events (White, ply 0) until its canonical
 * form is exactly `target` bytes.
 */
function padArchive(match: MatchArchive, target: number) {
  const filler = (output: string): Extract<MatchEvent, { type: "tool" }> => ({
    type: "tool",
    seq: match.events.length,
    at: "2026-11-12T00:00:00.000Z",
    side: "w",
    ply: 0,
    name: "board",
    input: "{}",
    output,
  });
  // Bulk-fill from one probe of the per-event overhead, then fine-tune exactly; measuring
  // the 2 MB archive per event would make this quadratic.
  const start = archiveByteLength(match);
  match.events.push(filler(""));
  const overhead = archiveByteLength(match) - start;
  match.events.pop();
  const bulk = Math.floor((target - start) / (15_000 + overhead + 16)) - 1;
  for (let i = 0; i < bulk; i += 1) match.events.push(filler("x".repeat(15_000)));
  for (;;) {
    const remaining = target - archiveByteLength(match);
    if (remaining === 0) break;
    if (remaining < 0) throw new Error("archive already larger than the target");
    const roomy = match.events.find(
      (event) => event.type === "tool" && event.output.length + remaining <= 16_000,
    );
    if (roomy?.type === "tool") {
      roomy.output += "x".repeat(remaining);
      continue;
    }
    const event = filler("");
    match.events.push(event);
    const room = target - archiveByteLength(match);
    if (room < 0) throw new Error("no room to pad to the exact target");
    event.output = "x".repeat(Math.min(room, 15_000));
  }
}
const strip = (match: ReturnType<typeof createMatch>) =>
  match.events.map(({ at: _at, ...event }) =>
    event.type === "timing" ? { ...event, elapsedMs: 0 } : event,
  );

describe("inference clock independent of provider usage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses the cumulative allowance across legal usage-less turns", async () => {
    runAgentLoop.mockImplementation(async (options: AgentLoopOptions) => {
      await options.onBeforeDispatch?.({
        messages: options.messages,
        iteration: 0,
        lastDispatchAt: null,
      });
      const allowance = options.timeoutMs ?? 0;
      await vi.advanceTimersByTimeAsync(Math.min(700, allowance));
      const prompt = options.messages.at(-1)?.parts[0];
      const move =
        prompt?.type === "text" && typeof prompt.content === "string"
          ? /Legal UCI moves: (\S+)/.exec(prompt.content)?.[1]
          : "0000";
      return {
        messages: [...options.messages, reply(JSON.stringify({ move }))],
        stopReason: allowance < 700 ? "timeout" : "completed",
      };
    });
    const match = createMatch({
      white: model,
      black: random,
      rules: { timeBudgetMs: 1000, turnTimeoutMs: 1000, legalMoves: "provided" },
    });
    await runMatch(match, { credentials, random: () => 0 });
    expect(match).toMatchObject({ termination: "timeout", result: "0-1" });
    expect(runAgentLoop.mock.calls.map(([options]) => options.timeoutMs)).toEqual([1000, 300]);
    expect(
      match.events.filter((event) => event.type === "timing").map((event) => event.elapsedMs),
    ).toEqual([700, 300]);
    expect(match.events.some((event) => event.type === "usage")).toBe(false);
    const stats = matchStats(match, "w");
    expect(stats).toMatchObject({ elapsedMs: 1000, moves: 1, costMicros: null });
    expect(stats.committedTokens).toBe(stats.reservedTokens);
    expect(stats.committedCostMicros).toBe(stats.reservedCostMicros);
    expect(turnPrompt(match, "w")).toContain("Remaining time milliseconds: 0");
    expect(validateArchive(JSON.parse(JSON.stringify(match)))).toEqual(match);
  });

  it.each(["completed", "failure", "aborted"])(
    "records the full attempt once with multiple usage reports on %s",
    async (outcome) => {
      runAgentLoop.mockImplementation(async (options: AgentLoopOptions) => {
        await options.onBeforeDispatch?.({
          messages: options.messages,
          iteration: 0,
          lastDispatchAt: null,
        });
        await vi.advanceTimersByTimeAsync(100);
        await options.onUsage?.({ inputTokens: 40, outputTokens: 10 });
        await vi.advanceTimersByTimeAsync(100);
        await options.onUsage?.({ inputTokens: 20, outputTokens: 5 });
        await vi.advanceTimersByTimeAsync(100);
        if (outcome === "failure") throw new Error("provider failed after usage");
        return {
          messages: [...options.messages, reply('{"move":"e2e4"}')],
          stopReason: outcome,
        };
      });
      const match = createMatch({
        white: model,
        black: random,
        rules: { engineEvaluation: "after-move" },
      });
      const evaluate = evaluatePosition.getMockImplementation();
      evaluatePosition.mockImplementation(async (fen: string) => {
        await vi.advanceTimersByTimeAsync(500);
        return evaluate?.(fen);
      });
      await advanceMatch(match, { credentials });
      expect(match.events.filter((event) => event.type === "timing")).toHaveLength(1);
      expect(matchStats(match, "w")).toMatchObject({
        elapsedMs: 300,
        inputTokens: 60,
        outputTokens: 15,
      });
      expect(evaluatePosition).toHaveBeenCalledTimes(outcome === "completed" ? 1 : 0);
      expect(validateArchive(match)).toEqual(match);
    },
  );

  it("records each rejected inference attempt before its retry", async () => {
    let attempt = 0;
    runAgentLoop.mockImplementation(async (options: AgentLoopOptions) => {
      await vi.advanceTimersByTimeAsync(200);
      attempt += 1;
      return {
        messages: [
          ...options.messages,
          reply(JSON.stringify({ move: attempt === 1 ? "e2e5" : "e2e4" })),
        ],
        stopReason: "completed",
      };
    });
    const match = createMatch({ white: model, black: random, rules: {} });
    await advanceMatch(match, { credentials });
    expect(matchStats(match, "w")).toMatchObject({ elapsedMs: 400, moves: 1, illegalAttempts: 1 });
    expect(match.events.map((event) => event.type)).toEqual([
      "timing",
      "attempt",
      "timing",
      "attempt",
    ]);
    expect(validateArchive(match)).toEqual(match);
  });
});

describe("settlement, persistence, replay reuse and archive limits", () => {
  it("keeps a finished game's outcome when the post-move evaluation fails", async () => {
    evaluatePosition
      .mockImplementationOnce(async (fen: string) => ({
        engine: "stockfish-19-lite-single",
        fen,
        cp: 0,
        mate: null,
        bestMove: null,
        depth: 1,
        nodes: 1000,
      }))
      .mockRejectedValueOnce(new Error("engine down"));
    const match = createMatch({
      white: random,
      black: random,
      rules: { maxPlies: 2, engineEvaluation: "after-move" },
    });
    await runMatch(match, { random: () => 0 });
    expect(match).toMatchObject({ status: "completed", termination: "ply-limit" });
    expect(validateArchive(match)).toEqual(match);
    evaluatePosition.mockRejectedValueOnce(new Error("engine down"));
    const running = createMatch({
      white: random,
      black: random,
      rules: { engineEvaluation: "after-move" },
    });
    await advanceMatch(running, { random: () => 0 });
    expect(running).toMatchObject({ status: "error", termination: "engine-error" });
  });
  it("settles reservations to reported usage instead of forfeiting on spent reservations", async () => {
    const probe = createMatch({ white: model, black: random, rules: { legalMoves: "provided" } });
    runAgentLoop.mockImplementation(legalPlayer());
    await advanceMatch(probe, { credentials });
    const reserve = probe.events.find((event) => event.type === "reservation");
    if (reserve?.type !== "reservation") throw new Error("Fixture missing");
    const rules = {
      legalMoves: "provided" as const,
      maxPlies: 8,
      tokenBudget: Math.floor(reserve.tokens * 1.5),
    };
    const settled = createMatch({ white: model, black: random, rules });
    await runMatch(settled, { credentials, random: () => 0 });
    expect(settled).toMatchObject({ status: "completed", termination: "ply-limit" });
    const stats = matchStats(settled, "w");
    expect(stats.reservedTokens).toBeGreaterThan(rules.tokenBudget);
    expect(stats.committedTokens).toBe(4 * 50);
    expect(stats.costMicros).not.toBeNull();
    expect(validateArchive(settled)).toEqual(settled);
    // A dispatch that never reports usage keeps its full reservation, and cost is unknown.
    runAgentLoop.mockImplementation(legalPlayer({ usage: false }));
    const unknown = createMatch({ white: model, black: random, rules });
    await runMatch(unknown, { credentials, random: () => 0 });
    expect(unknown).toMatchObject({ termination: "token-budget", result: "0-1" });
    expect(matchStats(unknown, "w")).toMatchObject({ moves: 1, costMicros: null });
    expect(matchStats(unknown, "w").committedTokens).toBe(matchStats(unknown, "w").reservedTokens);
    expect(validateArchive(unknown)).toEqual(unknown);
  });
  it("persists an accepted move once and each rejected retry once", async () => {
    runAgentLoop.mockImplementation(legalPlayer());
    const onUpdate = vi.fn();
    const match = createMatch({ white: model, black: random, rules: { legalMoves: "provided" } });
    await advanceMatch(match, { credentials, onUpdate });
    // One pre-dispatch reservation persist, then one at turn end.
    expect(onUpdate).toHaveBeenCalledTimes(2);
    onUpdate.mockClear();
    runAgentLoop.mockReset();
    runAgentLoop
      .mockImplementationOnce(async (options) => ({
        messages: [...options.messages, reply('{"move":"e2e5"}')],
        stopReason: "completed",
      }))
      .mockImplementationOnce(async (options) => ({
        messages: [...options.messages, reply('{"move":"e2e4"}')],
        stopReason: "completed",
      }));
    await advanceMatch(createMatch({ white: model, black: random, rules: {} }), {
      credentials,
      onUpdate,
    });
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });
  it("accepts replies with extra keys and long comments, truncating the comment", async () => {
    runAgentLoop.mockImplementation(async (options) => ({
      messages: [
        ...options.messages,
        reply(JSON.stringify({ move: "e2e4", comment: "x".repeat(600), reasoning: "centre" })),
      ],
      stopReason: "completed",
    }));
    const match = createMatch({ white: model, black: random, rules: { trashTalk: true } });
    await advanceMatch(match, { credentials });
    const attempt = match.events.find((event) => event.type === "attempt");
    expect(attempt).toMatchObject({ move: "e2e4", accepted: true, comment: "x".repeat(500) });
    expect(validateArchive(match)).toEqual(match);
  });
  it("produces identical archives whether or not turns reuse one replayed board", async () => {
    const play = async (reuse: boolean) => {
      let seed = 7;
      const random = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      runAgentLoop.mockImplementation(legalPlayer());
      const match = createMatch({
        white: model,
        black: { name: "Baseline", model: "random", protocol: "random" },
        rules: { maxPlies: 30, legalMoves: "provided", engineEvaluation: "after-move" },
      });
      const options = { credentials, random };
      if (reuse) await runMatch(match, options);
      else while (match.status === "running") await advanceMatch(match, options);
      return match;
    };
    const reused = await play(true);
    const replayed = await play(false);
    expect(strip(reused)).toEqual(strip(replayed));
    expect({ ...reused, id: "", createdAt: "", events: [] }).toEqual({
      ...replayed,
      id: "",
      createdAt: "",
      events: [],
    });
    expect(matchStats(reused).moves).toBeGreaterThan(10);
    expect(validateArchive(reused)).toEqual(reused);
  });
  it("ends the game unscored at the archive byte limit from a tool, a dispatch or an attempt", async () => {
    runAgentLoop.mockImplementation(async (options) => {
      const check = await options.onBeforeDispatch({ messages: options.messages });
      if (check?.veto) return { messages: options.messages, stopReason: "vetoed" };
      const tool = options.tools.find((entry: { name: string }) => entry.name === "board");
      for (let i = 0; i < 50; i++) tool.execute({ representation: "ascii" });
      options.onUsage({ inputTokens: 1, outputTokens: 1 });
      expect(options.abortSignal.aborted).toBe(true);
      return { messages: options.messages, stopReason: "aborted" };
    });
    // The 50 board outputs (~300 bytes each) cannot all fit above the headroom.
    const viaTool = createMatch({ white: model, black: random, rules: {} });
    padArchive(viaTool, MAX_ARCHIVE_BYTES - ARCHIVE_HEADROOM_BYTES - 5_000);
    await advanceMatch(viaTool, { credentials });
    expect(viaTool).toMatchObject({ status: "error", result: "*", termination: "event-limit" });
    expect(viaTool.events.some((event) => event.type === "tool")).toBe(true);
    expect(archiveByteLength(viaTool)).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
    expect(validateArchive(viaTool)).toEqual(viaTool);
    // No room at the pre-attempt check: the turn ends before any dispatch.
    const vetoed = createMatch({ white: model, black: random, rules: {} });
    padArchive(vetoed, MAX_ARCHIVE_BYTES - ARCHIVE_HEADROOM_BYTES + 1);
    runAgentLoop.mockClear();
    await advanceMatch(vetoed, { credentials });
    expect(vetoed).toMatchObject({ status: "error", termination: "event-limit" });
    expect(runAgentLoop).not.toHaveBeenCalled();
    expect(vetoed.events.some((event) => event.type === "reservation")).toBe(false);
    expect(archiveByteLength(vetoed)).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
    expect(validateArchive(vetoed)).toEqual(vetoed);
    // The random baseline checks before moving too.
    const baseline = createMatch({ white: random, black: random, rules: {} });
    padArchive(baseline, MAX_ARCHIVE_BYTES - ARCHIVE_HEADROOM_BYTES + 1);
    const before = baseline.events.length;
    await advanceMatch(baseline, { random: () => 0 });
    expect(baseline).toMatchObject({ status: "error", termination: "event-limit" });
    expect(baseline.events).toHaveLength(before);
  });
  it("vetoes the next dispatch once a turn's own events have used the room above the headroom", async () => {
    let dispatches = 0;
    let vetoed = false;
    runAgentLoop.mockImplementation(async (options) => {
      // A tool-free loop whose every dispatch records a reservation and a usage report.
      for (;;) {
        const check = await options.onBeforeDispatch({ messages: options.messages });
        if (check?.veto) {
          vetoed = true;
          return { messages: options.messages, stopReason: "vetoed" };
        }
        dispatches += 1;
        options.onUsage({ inputTokens: 1, outputTokens: 1 });
      }
    });
    const match = createMatch({ white: model, black: random, rules: { maxDispatches: 12 } });
    padArchive(match, MAX_ARCHIVE_BYTES - ARCHIVE_HEADROOM_BYTES - 1_000);
    await advanceMatch(match, { credentials });
    expect(vetoed).toBe(true);
    expect(dispatches).toBeGreaterThan(0);
    expect(match).toMatchObject({ status: "error", result: "*", termination: "event-limit" });
    expect(archiveByteLength(match)).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
    expect(validateArchive(match)).toEqual(match);
  });
  it("plays a long game to the archive limit, and every snapshot stays importable", async () => {
    let seed = 11;
    const randomSource = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const player = legalPlayer();
    runAgentLoop.mockImplementation(async (options) => {
      // Inspect the board before every move, as tool-using models do.
      const tool = options.tools.find((entry: { name: string }) => entry.name === "board");
      tool.execute({ representation: "ascii" });
      tool.execute({ representation: "pieces" });
      if (options.abortSignal.aborted) return { messages: options.messages, stopReason: "aborted" };
      return player(options);
    });
    const match = createMatch({
      white: model,
      black: random,
      rules: { maxPlies: 600, legalMoves: "provided", engineEvaluation: "after-move" },
    });
    padArchive(match, MAX_ARCHIVE_BYTES - ARCHIVE_HEADROOM_BYTES - 40_000);
    const padded = match.events.length;
    let largest = 0;
    await runMatch(match, {
      credentials,
      random: randomSource,
      onUpdate: (snapshot) => {
        largest = Math.max(largest, archiveByteLength(snapshot));
      },
    });
    expect(match).toMatchObject({ status: "error", result: "*", termination: "event-limit" });
    expect(matchStats(match).moves).toBeGreaterThan(10);
    expect(match.events.length).toBeGreaterThan(padded);
    expect(largest).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
    expect(archiveByteLength(match)).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
    // Exactly what the CLI writes, `replay` and `upload` read, and the server imports.
    const file = serializeArchive(match);
    expect(utf8ByteLength(file)).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
    expect(validateArchive(JSON.parse(file))).toEqual(match);
  });
  it("ends a human game at the limit through the helper the CLI move handler calls", () => {
    const human = { name: "Human", model: "human", protocol: "human" as const };
    const match = createMatch({ white: human, black: random, rules: {} });
    padArchive(match, MAX_ARCHIVE_BYTES - ARCHIVE_HEADROOM_BYTES);
    expect(endAtArchiveLimit(match)).toBe(false);
    expect(match.status).toBe("running");
    padArchive(match, MAX_ARCHIVE_BYTES - ARCHIVE_HEADROOM_BYTES + 1);
    expect(endAtArchiveLimit(match)).toBe(true);
    expect(match).toMatchObject({ status: "error", result: "*", termination: "event-limit" });
    expect(validateArchive(match)).toEqual(match);
  });
  it("bounds every unmeasured event and fits terminal bookkeeping in the headroom", () => {
    // Schema-maximal values whose every character JSON escapes to six bytes.
    const worst = (length: number) => "\u0001".repeat(length);
    const at = "2026-11-12T00:00:00.000Z";
    const base = { seq: 9_999_999, at, side: "w" as const, ply: 9_999 };
    const big = Number.MAX_SAFE_INTEGER;
    const unmeasured: MatchEvent[] = [
      { ...base, type: "reservation", dispatch: big, tokens: big, costMicros: big },
      {
        ...base,
        type: "shared-usage",
        encoding: "cl100k_base",
        inputTokens: big,
        outputTokens: big,
      },
      {
        ...base,
        type: "usage",
        dispatch: big,
        inputTokens: big,
        outputTokens: big,
        costMicros: big,
      },
      {
        ...base,
        type: "usage",
        dispatch: big,
        inputTokens: big,
        outputTokens: big,
        costMicros: big,
      },
      { ...base, type: "timing", elapsedMs: big },
      {
        ...base,
        type: "attempt",
        move: worst(256),
        accepted: false,
        before: worst(160),
        fen: worst(160),
        san: worst(32),
        reason: "unparseable",
        comment: worst(500),
        normalizedFrom: worst(256),
      },
      {
        ...base,
        type: "evaluation",
        purpose: "after-move",
        evaluation: {
          engine: "stockfish-19-lite-single",
          fen: worst(160),
          depth: big,
          nodes: big,
          cp: -big,
          mate: -big,
          bestMove: "a7a8q",
        },
      },
    ];
    const match = createMatch({ white: model, black: random, rules: { maxAttempts: 10 } });
    padArchive(match, MAX_ARCHIVE_BYTES - ARCHIVE_HEADROOM_BYTES);
    // The last state every check accepts.
    expect(archiveLimitReached(match)).toBe(false);
    for (const event of unmeasured) {
      const before = archiveByteLength(match);
      match.events.push(event);
      expect(archiveByteLength(match) - before).toBeLessThanOrEqual(MAX_UNMEASURED_EVENT_BYTES);
    }
    // The running estimate the per-turn meter uses is exact for append-only events.
    const entries = match.events.reduce((sum, event) => sum + eventEntryBytes(event), 0);
    expect(archiveByteLength({ ...match, events: [] }) + entries + 2).toBe(
      archiveByteLength(match),
    );
    // The longest terminal state: every enum at its longest value.
    finishMatch(match, "1/2-1/2", "illegal-forfeit", "completed");
    expect(archiveByteLength(match)).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
    expect(TERMINAL_BOOKKEEPING_BYTES).toBeGreaterThan(
      `"status": "completed"`.length +
        `"result": "1/2-1/2"`.length +
        `"termination": "illegal-forfeit"`.length,
    );
  });
  it("records the exact shared output count even when streamed counts were deferred", async () => {
    const streamed = reply("short analysis then a move");
    runAgentLoop.mockImplementation(async (options) => {
      await options.onBeforeDispatch({ messages: options.messages });
      await options.onMessagesChange([...options.messages, streamed]);
      // The runtime hands back only the seed messages, as an aborted dispatch may.
      return { messages: options.messages, stopReason: "aborted" };
    });
    const match = createMatch({
      white: model,
      black: random,
      rules: { tokenAccounting: "cl100k_base" },
    });
    await advanceMatch(match, { credentials });
    expect(match.termination).toBe("cancelled");
    expect(matchStats(match).sharedOutputTokens).toBe(sharedOutputTokens([streamed]));
    expect(matchStats(match).sharedOutputTokens).toBeGreaterThan(0);
  });
});
describe("strict and lenient move formats", () => {
  const firstAttempt = async (
    content: string,
    moveFormat: "strict" | "lenient",
    initialFen?: string,
  ) => {
    runAgentLoop.mockImplementation(async (options) => ({
      messages: [...options.messages, reply(content)],
      stopReason: "completed",
    }));
    const match = createMatch({
      white: model,
      black: random,
      rules: { moveFormat, maxAttempts: 1, trashTalk: true },
      ...(initialFen ? { initialFen } : {}),
    });
    await advanceMatch(match, { credentials });
    expect(validateArchive(match)).toEqual(match);
    return match.events.find((event) => event.type === "attempt");
  };
  const prose = 'I will open with the king pawn.\n```json\n{"move":"e2e4","comment":"hi"}\n```';
  it("strict rejects prose around a fenced reply and SAN exactly as before", async () => {
    expect(await firstAttempt(prose, "strict")).toMatchObject({
      move: "[unparseable]",
      accepted: false,
      reason: "unparseable",
    });
    const san = await firstAttempt('{"move":"e4"}', "strict");
    expect(san).toMatchObject({ move: "e4", accepted: false, reason: "unparseable" });
    expect(san).not.toHaveProperty("normalizedFrom");
    for (const content of ["e4!", "Nf3!?", "e2-e4", "0-0", "a8Q"]) {
      const event = await firstAttempt(content, "strict");
      expect(event).toMatchObject({ accepted: false, reason: "unparseable" });
      expect(event).not.toHaveProperty("normalizedFrom");
    }
    expect(await firstAttempt('```json\n{"move":"e2e4"}\n```', "strict")).toMatchObject({
      move: "e2e4",
      accepted: true,
    });
  });
  it("lenient extracts the last fenced block or bare object after prose", async () => {
    expect(await firstAttempt(prose, "lenient")).toMatchObject({
      move: "e2e4",
      accepted: true,
      comment: "hi",
      normalizedFrom: "e2e4",
    });
    const bare = 'Thinking {about} it... {"move":"d2d4"} and {"move":"g1f3","comment":"{x}"}';
    expect(await firstAttempt(bare, "lenient")).toMatchObject({
      move: "g1f3",
      accepted: true,
      comment: "{x}",
      normalizedFrom: "g1f3",
    });
    const exact = await firstAttempt('{"move":"e2e4"}', "lenient");
    expect(exact).toMatchObject({ move: "e2e4", accepted: true });
    expect(exact).not.toHaveProperty("normalizedFrom");
  });
  it("lenient converts legal move variants to UCI and records canonical SAN", async () => {
    // [model reply, expected UCI, canonical SAN, position]
    const cases: Array<[string, string, string, string?]> = [
      ['{"move":"e4"}', "e2e4", "e4"],
      ['{"move":" e4! "}', "e2e4", "e4"],
      ["e4!", "e2e4", "e4"],
      ["Nf3", "g1f3", "Nf3"],
      ["Nf3!?", "g1f3", "Nf3"],
      ["e2-e4", "e2e4", "e4"],
      [
        'Take it: {"move":"exd5"}',
        "e4d5",
        "exd5",
        "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
      ],
      ['{"move":"O-O"}', "e1g1", "O-O", "4k3/8/8/8/8/8/8/4K2R w K - 0 1"],
      ["0-0", "e1g1", "O-O", "4k3/8/8/8/8/8/8/4K2R w K - 0 1"],
      ['{"move":"e8=Q"}', "e7e8q", "e8=Q", "8/4P3/8/8/8/8/k7/4K3 w - - 0 1"],
      ["a8Q", "a7a8q", "a8=Q", "8/P7/7k/8/8/8/8/4K3 w - - 0 1"],
    ];
    for (const [content, uci, san, fen] of cases)
      expect(await firstAttempt(content, "lenient", fen)).toMatchObject({
        move: uci,
        accepted: true,
        // Annotations and alternate spellings are replaced with safe canonical SAN.
        normalizedFrom: san,
      });
  });
  it.each(["strict", "lenient"] as const)(
    "never archives unparseable identity prose in %s mode",
    async (format) => {
      for (const content of [
        "I am vendor/secret-model and have no move",
        '{"move":"I am vendor/secret-model"}',
        'preface {"move":"I am vendor/secret-model"}',
      ]) {
        const event = await firstAttempt(content, format);
        expect(event).toMatchObject({
          move: "[unparseable]",
          accepted: false,
          reason: "unparseable",
        });
        expect(JSON.stringify(event)).not.toContain("secret-model");
        expect(event).not.toHaveProperty("normalizedFrom");
      }
    },
  );
  it("lenient still rejects illegal SAN and garbage as before", async () => {
    const illegal = await firstAttempt('{"move":"Ke2"}', "lenient");
    expect(illegal).toMatchObject({ move: "Ke2", accepted: false, reason: "unparseable" });
    expect(illegal).not.toHaveProperty("normalizedFrom");
    const garbage = await firstAttempt("no idea {not json}", "lenient");
    expect(garbage).toMatchObject({
      move: "[unparseable]",
      accepted: false,
      reason: "unparseable",
    });
    expect(garbage).not.toHaveProperty("normalizedFrom");
    const long = `${"x".repeat(300)} {"move":"e2e5"}`;
    const extracted = await firstAttempt(long, "lenient");
    expect(extracted).toMatchObject({ move: "e2e5", accepted: false, reason: "illegal" });
    expect(extracted?.type === "attempt" && extracted.normalizedFrom).toBe("e2e5");
  });
});
