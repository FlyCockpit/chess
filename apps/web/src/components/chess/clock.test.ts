import { createMatch, finishMatch, type MatchArchive, type MatchEvent } from "@cockpit-chess/chess";
import { describe, expect, it } from "vitest";
import { clockAt, formatClock, liveClock } from "./clock";

const model = { name: "Model", model: "m", protocol: "openai-chat" as const };
const T0 = Date.parse("2026-11-26T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
/** Appends an event of `type` at `ms` after T0 (fields beyond the base are per type). */
function push(match: MatchArchive, ms: number, event: Record<string, unknown>) {
  match.events.push({
    seq: match.events.length,
    at: at(ms),
    side: "w",
    ply: 0,
    ...event,
  } as MatchEvent);
}
const timed = () => {
  const match = createMatch({
    white: model,
    black: model,
    rules: { clock: { w: 300_000, b: 120_000 }, turnTimeoutMs: 60_000 },
  });
  match.createdAt = at(0);
  return match;
};

describe("replay clocks", () => {
  it("charges each side's recorded time up to the cursor", () => {
    const match = timed();
    push(match, 4_000, { type: "timing", elapsedMs: 4_000 });
    push(match, 9_000, { type: "timing", side: "b", elapsedMs: 5_000 });
    expect(clockAt(match, "w", -1)).toBe(300_000);
    expect(clockAt(match, "w", 0)).toBe(296_000);
    expect(clockAt(match, "b", 0)).toBe(120_000);
    expect(clockAt(match, "b", 1)).toBe(115_000);
    expect(clockAt(createMatch({ white: model, black: model, rules: {} }), "w", 0)).toBeNull();
  });
  it("counts a live attempt from its start; later tool events never refund time", () => {
    const match = timed();
    push(match, 4_000, { type: "timing", elapsedMs: 4_000 });
    // Between turns nothing is charged and nothing ticks.
    expect(liveClock(match, "w", "w", T0 + 5_500)).toBe(296_000);
    // White's next attempt starts (its reservation) and calls a tool mid-turn.
    push(match, 6_000, { type: "reservation", dispatch: 0, tokens: 100, costMicros: 1 });
    push(match, 9_000, { type: "tool", name: "board", input: "{}", output: "x" });
    expect(liveClock(match, "w", "w", T0 + 10_000)).toBe(292_000);
    expect(liveClock(match, "w", "w", T0 + 12_000)).toBe(290_000);
    // The side not to move shows its recorded clock; a finished game does not tick.
    expect(liveClock(match, "b", "w", T0 + 12_000)).toBe(120_000);
    finishMatch(match, "0-1", "timeout");
    expect(liveClock(match, "w", "w", T0 + 500_000)).toBe(296_000);
  });
  it("starts a model's clock at its own reservation, in the runner's event order", () => {
    const match = timed();
    // Black's attempt ends: timing, then its accepted move, then a post-move evaluation.
    push(match, 4_000, { type: "timing", side: "b", elapsedMs: 4_000 });
    push(match, 4_010, { type: "attempt", side: "b", move: "e7e5", accepted: true });
    push(match, 5_000, { type: "evaluation", side: "w", purpose: "after-move" });
    // The runner's own work before White's reservation is not White's time.
    expect(liveClock(match, "w", "w", T0 + 8_000)).toBe(300_000);
    push(match, 8_000, { type: "reservation", side: "w", dispatch: 0, tokens: 1, costMicros: 1 });
    expect(liveClock(match, "w", "w", T0 + 11_000)).toBe(297_000);
    // A rejected attempt: charged, then the retry's reservation restarts the count.
    push(match, 12_000, { type: "timing", side: "w", elapsedMs: 4_000 });
    push(match, 12_010, { type: "attempt", side: "w", move: "a1a8", accepted: false });
    expect(liveClock(match, "w", "w", T0 + 14_000)).toBe(296_000);
    push(match, 14_000, { type: "reservation", side: "w", dispatch: 1, tokens: 1, costMicros: 1 });
    expect(liveClock(match, "w", "w", T0 + 15_000)).toBe(295_000);
  });
  it("does not tick for a queued match; a human's turn runs from the last event", () => {
    const queued = timed();
    expect(liveClock(queued, "w", "w", T0 + 600_000)).toBe(300_000);
    // A human's opening move counts from the game's creation (the companion arms it then).
    const opening = createMatch({
      white: { name: "You", model: "human", protocol: "human" },
      black: model,
      rules: { clock: { w: 60_000, b: 60_000 }, turnTimeoutMs: 30_000 },
    });
    opening.createdAt = at(0);
    expect(liveClock(opening, "w", "w", T0 + 20_000)).toBe(40_000);
    const human = createMatch({
      white: { name: "You", model: "human", protocol: "human" },
      black: model,
      rules: { clock: { w: 60_000, b: 60_000 }, turnTimeoutMs: 30_000 },
    });
    human.createdAt = at(0);
    push(human, 2_000, { type: "timing", side: "b", elapsedMs: 2_000 });
    expect(liveClock(human, "w", "w", T0 + 12_000)).toBe(50_000);
    expect(liveClock(human, "w", "w", T0 + 900_000)).toBe(0);
  });
  it("formats like a chess clock", () => {
    expect(formatClock(600_000)).toBe("10:00");
    expect(formatClock(3_900_000)).toBe("1:05:00");
    expect(formatClock(9_340)).toBe("0:09.3");
    expect(formatClock(0)).toBe("0:00.0");
  });
  it("counts a hosted human clock from the authoritative turn start, not the last event or creation", () => {
    const match = createMatch(
      {
        white: { name: "Human", model: "human", protocol: "human" },
        black: model,
        rules: { clock: { w: 60_000, b: 60_000 } },
      },
      "hosted",
    );
    match.createdAt = at(0);
    expect(liveClock(match, "w", "w", T0 + 15_000)).toBe(60_000);
    // Queueing and unrelated spectator activity never spend the human clock.
    match.turn = {
      type: "human",
      side: "w",
      turnId: crypto.randomUUID(),
      expectedSeq: 0,
      startedAt: at(20_000),
      deadline: at(60_000),
    };
    expect(liveClock(match, "w", "w", T0 + 25_000)).toBe(55_000);
    push(match, 30_000, { type: "timing", elapsedMs: 10_000 });
    match.turn = { ...match.turn, startedAt: at(30_000), expectedSeq: 1 };
    expect(liveClock(match, "w", "w", T0 + 32_000)).toBe(48_000);
    expect(liveClock(match, "b", "w", T0 + 32_000)).toBe(60_000);
    match.turn = { type: "idle" };
    expect(liveClock(match, "w", "w", T0 + 50_000)).toBe(50_000);
  });
});
