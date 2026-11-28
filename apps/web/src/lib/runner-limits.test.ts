import { describe, expect, it } from "vitest";
import {
  exceedsRunnerCeiling,
  raisesRunnerLimits,
  runnerLimitsError,
  runnerLimitValues,
  runnerUsdMicros,
} from "./runner-limits";

describe("browser runner limits", () => {
  it("converts exact decimal dollars and rejects ambiguous or unsafe inputs", () => {
    expect(runnerUsdMicros("1.000001")).toBe(1_000_001);
    expect(runnerUsdMicros("0.000001")).toBe(1);
    for (const invalid of [
      "0",
      "-1",
      "1e2",
      "Infinity",
      "1.0000001",
      " 1",
      "1 ",
      ".5",
      "9999999999.999999",
    ]) {
      expect(runnerUsdMicros(invalid)).toBeUndefined();
    }
  });
  it("validates concurrency and detects mixed raises independently", () => {
    expect(runnerLimitValues({ match: "1", day: "10", concurrency: "2" })).toEqual({
      matchMicros: 1_000_000,
      dayMicros: 10_000_000,
      concurrency: 2,
    });
    for (const concurrency of ["0", "65", "1.5", "1e1"])
      expect(runnerLimitValues({ match: "1", day: "10", concurrency })).toBeUndefined();
    const current = { matchMicros: 1, dayMicros: 10, concurrency: 2 };
    expect(raisesRunnerLimits({ ...current, dayMicros: 9, concurrency: 3 }, current)).toBe(true);
    expect(raisesRunnerLimits({ ...current, matchMicros: 0 }, current)).toBe(false);
    expect(
      exceedsRunnerCeiling({ ...current, concurrency: 9 }, { ...current, concurrency: 8 }),
    ).toBe(true);
    expect(exceedsRunnerCeiling(current, current)).toBe(false);
  });
  it("maps safe error codes without showing raw server messages", () => {
    expect(runnerLimitsError({ code: "CONFLICT", message: "private" })).toBe("conflict");
    expect(runnerLimitsError({ code: "FORBIDDEN" })).toBe("verification");
    expect(runnerLimitsError({ code: "SERVICE_UNAVAILABLE" })).toBe("unavailable");
    expect(runnerLimitsError({ code: "NOT_FOUND" })).toBe("missing");
    expect(runnerLimitsError(new Error("private"))).toBe("failed");
  });
});
