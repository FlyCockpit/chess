import { type MatchArchive, matchConfigSchema } from "@cockpit-chess/chess";
import { describe, expect, it, vi } from "vitest";
import { ProviderConfigError } from "../chess-provider";
import { runSeries } from "./chess";

const config = matchConfigSchema.parse({
  white: { name: "A", model: "vendor/a", protocol: "openai-chat" },
  black: { name: "B", model: "vendor/b", protocol: "openai-chat" },
  rules: {},
});
const base = { config, out: "/nonexistent", swapColors: true, provider: {} };

describe("runSeries", () => {
  it("resolves credentials before writing and once per colour layout", async () => {
    const order: string[] = [];
    const credentials = vi.fn(async () => {
      order.push("credentials");
      return {};
    });
    const write = vi.fn(async () => {
      order.push("write");
    });
    const run = vi.fn(async (match: MatchArchive) => {
      match.status = "completed";
      match.result = "1-0";
      return match;
    });
    const series = await runSeries({
      ...base,
      count: 4,
      signal: new AbortController().signal,
      credentials,
      write,
      run: run as never,
    });
    expect(order[0]).toBe("credentials");
    expect(credentials).toHaveBeenCalledTimes(2);
    expect(series.results).toHaveLength(4);
    expect(series.error).toBeUndefined();
  });
  it("stops at the first failure, keeps earlier results and records the failed game", async () => {
    const writes: MatchArchive[] = [];
    let call = 0;
    const series = await runSeries({
      ...base,
      count: 3,
      signal: new AbortController().signal,
      credentials: async () => ({}),
      write: async (_file, match) => {
        writes.push(structuredClone(match));
      },
      run: (async (match: MatchArchive) => {
        call += 1;
        if (call === 2) throw new Error("secret-bearing upstream detail");
        match.status = "completed";
        return match;
      }) as never,
    });
    expect(series.results).toHaveLength(2);
    expect(series.results[1]).toMatchObject({ result: "*", termination: "provider-error" });
    expect(writes.at(-1)?.status).not.toBe("running");
    expect(series.error).toBeDefined();
    expect(series.error).not.toContain("secret");
  });
  it("writes nothing when credentials cannot be resolved and reports the reason", async () => {
    const write = vi.fn();
    const series = await runSeries({
      ...base,
      count: 2,
      signal: new AbortController().signal,
      credentials: async () => {
        throw new ProviderConfigError("Configure the provider API key");
      },
      write,
    });
    expect(write).not.toHaveBeenCalled();
    expect(series).toEqual({ results: [], error: "Configure the provider API key" });
  });
});
