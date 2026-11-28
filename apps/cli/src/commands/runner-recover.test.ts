import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../runner-recovery", () => ({ recoverRunner: vi.fn() }));
vi.mock("../runner-policy", async (original) => {
  const actual = await original<typeof import("../runner-policy")>();
  return {
    ...actual,
    localRunnerAuthority: vi.fn(() => "a".repeat(64)),
    readLocalRunnerOptions: vi.fn(async (flags) => ({
      baseUrl: "http://127.0.0.1:9999/v1",
      ...flags,
    })),
  };
});

import { t } from "../chess-i18n";
import { buildProgram } from "../program";
import { localRunnerAuthority, RunnerPolicyError, readLocalRunnerOptions } from "../runner-policy";
import { recoverRunner } from "../runner-recovery";

const result = { version: 1, blocked: false, resolved: false, requests: [], games: [] };
let stdout = "";
beforeEach(() => {
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((value) => {
    stdout += String(value);
    return true;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected network");
    }),
  );
  vi.mocked(recoverRunner).mockResolvedValue(structuredClone(result));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("runner-recover local command", () => {
  it("inspects by default, keeps JSON on stdout, and never fetches a catalog or provider", async () => {
    await buildProgram().parseAsync(["node", "cockpit-chess", "runner-recover", "--json"]);
    expect(recoverRunner).toHaveBeenCalledExactlyOnceWith({
      authorityId: "a".repeat(64),
      resolve: false,
    });
    expect(JSON.parse(stdout)).toEqual(result);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(stdout).not.toContain("a".repeat(64));
  });
  it("prints bounded request and game details for human inspection with terminal controls sanitized", async () => {
    vi.mocked(recoverRunner).mockResolvedValue({
      ...result,
      requests: [
        {
          matchId: "match-1",
          requestId: "request-1\u001b[31m",
          atMs: 123,
          reservedMicros: 70,
          micros: 70,
          settled: false,
        },
      ],
      games: [{ matchId: "match-1", phase: "uncertain" }],
    });
    await buildProgram().parseAsync(["node", "cockpit-chess", "runner-recover"]);
    expect(stdout).toContain("Request request-1 / match match-1");
    expect(stdout).toContain("reserved 70 micros");
    expect(stdout).toContain("Match match-1: uncertain");
    expect(stdout).not.toContain("\u001b");
  });
  it("accepts JSON before the subcommand as well as after it", async () => {
    await buildProgram().parseAsync(["node", "cockpit-chess", "--json", "runner-recover"]);
    expect(JSON.parse(stdout)).toEqual(result);
  });
  it.each([
    ["--json", "json-probe"],
    ["json-probe", "--json"],
  ])("preserves sibling command JSON output for %j", async (...args) => {
    const program = buildProgram();
    const action = vi.fn();
    program.command("json-probe").option("--json").action(action);
    await program.parseAsync(["node", "cockpit-chess", ...args]);
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ json: true }), expect.anything());
  });
  it("explicit confirmation resolves as spent and abandonment without a terminal or interactive prompt", async () => {
    await buildProgram().parseAsync([
      "node",
      "cockpit-chess",
      "runner-recover",
      "--resolve-as-spent",
      "--json",
    ]);
    expect(recoverRunner).toHaveBeenCalledWith({ authorityId: "a".repeat(64), resolve: true });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("merges explicit root flags above file values and subcommand flags above root flags", async () => {
    await buildProgram().parseAsync([
      "node",
      "cockpit-chess",
      "--provider-url",
      "http://127.0.0.1:8000/v1",
      "--max-day-usd",
      "25",
      "runner-recover",
      "--provider-url",
      "http://127.0.0.1:9000/v1",
      "--json",
    ]);
    expect(readLocalRunnerOptions).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:9000/v1",
      maxDayUsd: "25",
    });
    expect(localRunnerAuthority).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:9000/v1",
      maxDayUsd: "25",
    });
  });
  it("uses file options when root flags are absent", async () => {
    await buildProgram().parseAsync(["node", "cockpit-chess", "runner-recover", "--json"]);
    expect(readLocalRunnerOptions).toHaveBeenCalledWith({});
    expect(localRunnerAuthority).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:9999/v1" });
  });
  it("preserves the usage exit code for an invalid explicit root concurrency flag", async () => {
    await expect(
      buildProgram().parseAsync([
        "node",
        "cockpit-chess",
        "--max-concurrency",
        "invalid",
        "runner-recover",
        "--json",
      ]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(recoverRunner).not.toHaveBeenCalled();
    expect(stdout).toBe("");
  });
  it("does not print secrets, provider errors or disk paths on failure", async () => {
    vi.mocked(recoverRunner).mockRejectedValue(new Error("private-key-and-path"));
    await expect(
      buildProgram().parseAsync(["node", "cockpit-chess", "runner-recover", "--json"]),
    ).rejects.toThrow(t("cli:runnerRecoveryFailed"));
    expect(stdout).toBe("");
  });
  it("offers actionable English and Spanish uncertainty and recovery text", () => {
    expect(new RunnerPolicyError("uncertain").message).toContain(
      "runner-recover --resolve-as-spent",
    );
    const spanish = t("cli:runnerUncertain", { lng: "es-MX" });
    expect(spanish).toContain("resultado incierto");
    expect(spanish).toContain("runner-recover --resolve-as-spent");
    expect(t("cli:runnerRecoveryHelp", { lng: "es-MX" })).toContain("sin solicitudes de red");
  });
});
