import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../runner-start", () => ({ runRunnerStartup: vi.fn(async () => {}) }));
// Keep command parsing real while excluding unrelated companion IO and import-time assets.
vi.mock("./auth", () => ({
  registerAuth: (p: import("commander").Command) => p.command("login").action(() => {}),
}));
vi.mock("./chess", () => ({
  registerChess: (p: import("commander").Command) => p.command("chess").action(() => {}),
}));
vi.mock("./config", () => ({
  registerConfig: (p: import("commander").Command) => p.command("config").action(() => {}),
}));
vi.mock("./update", () => ({
  registerUpdate: (p: import("commander").Command) => p.command("update").action(() => {}),
}));

import { buildProgram } from "../program";
import { runRunnerStartup } from "../runner-start";

afterEach(() => vi.clearAllMocks());
describe("default program action", () => {
  it("uses process.argv when parseAsync itself is called without arguments", async () => {
    const previous = process.argv;
    try {
      process.argv = ["node", "cockpit-chess"];
      await buildProgram().parseAsync();
      expect(runRunnerStartup).toHaveBeenCalledExactlyOnceWith({});
    } finally {
      process.argv = previous;
    }
  });
  it("starts a runner on the exact no-argument executable invocation", async () => {
    await buildProgram().parseAsync(["node", "cockpit-chess"]);
    expect(runRunnerStartup).toHaveBeenCalledExactlyOnceWith({});
  });
  it("passes explicit resume and local ceiling flags", async () => {
    await buildProgram().parseAsync([
      "node",
      "cockpit-chess",
      "--resume",
      "machine-1",
      "--server",
      "https://runner.example",
      "--max-match-usd",
      "30",
      "--max-day-usd",
      "120",
      "--max-concurrency",
      "12",
    ]);
    expect(runRunnerStartup).toHaveBeenCalledExactlyOnceWith({
      resume: "machine-1",
      server: "https://runner.example",
      maxMatchUsd: "30",
      maxDayUsd: "120",
      maxConcurrency: "12",
    });
  });
  it("passes only explicitly selected local provider options", async () => {
    await buildProgram().parseAsync([
      "node",
      "cockpit-chess",
      "--provider-url",
      "http://127.0.0.1:8000/v1",
      "--allow-model",
      "local/one",
      "local/two",
      "--max-day-usd",
      "12",
    ]);
    expect(runRunnerStartup).toHaveBeenCalledExactlyOnceWith({
      providerUrl: "http://127.0.0.1:8000/v1",
      allowModel: ["local/one", "local/two"],
      maxDayUsd: "12",
    });
  });
  it.each(["login", "chess", "config", "update"])(
    "preserves explicit %s without starting a runner",
    async (command) => {
      await buildProgram().parseAsync(["node", "cockpit-chess", command]);
      expect(runRunnerStartup).not.toHaveBeenCalled();
    },
  );
  it("does not start a runner for an unknown command", async () => {
    const program = buildProgram().configureOutput({ writeErr: () => {} });
    await expect(program.parseAsync(["node", "cockpit-chess", "typo"])).rejects.toThrow();
    expect(runRunnerStartup).not.toHaveBeenCalled();
  });
  it.each(["--help", "--version"])("does not start a runner for %s", async (flag) => {
    const program = buildProgram().configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await expect(program.parseAsync(["node", "cockpit-chess", flag])).rejects.toMatchObject({
      exitCode: 0,
    });
    expect(runRunnerStartup).not.toHaveBeenCalled();
  });
});
