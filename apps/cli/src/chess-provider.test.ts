import { createMatch } from "@cockpit-chess/chess";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertEngineSupported,
  isCompiledBinary,
  localCredentials,
  ProviderConfigError,
  providerReady,
  resetCatalogCache,
  resolveApiKey,
} from "./chess-provider";

const player = { name: "Model", model: "vendor/model", protocol: "openai-chat" as const };
const match = () => createMatch({ white: player, black: player, rules: {} });
afterEach(() => {
  resetCatalogCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("localCredentials", () => {
  it("does no network or credential work for human and random games", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const game = createMatch({
      white: { ...player, protocol: "human" },
      black: { ...player, protocol: "random" },
      rules: {},
    });
    expect(await localCredentials(game)).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires encrypted remote endpoints and rejects credentials embedded in URLs", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const baseUrl of [
      "http://remote.example/v1",
      "https://user:password@remote.example",
      "https://remote.example?api_key=secret",
    ]) {
      await expect(localCredentials(match(), { baseUrl })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("supports keyless local inference without invented remote price quotes", async () => {
    vi.stubEnv("OPENAI_API_KEY", "must-not-leak");
    vi.stubEnv("COCKPIT_CHESS_PROVIDER_KEY", undefined);
    const result = await localCredentials(match(), { baseUrl: "http://127.0.0.1:8000/v1" });
    expect(result.w).toMatchObject({
      apiKey: "local-inference",
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
  });
  it("uses catalog prices and keeps the provider credential in the local return value", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-only");
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "vendor/model", pricing: { prompt: "0.000001", completion: "0.000002" } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    expect((await localCredentials(match())).w).toMatchObject({
      inputMicrosPerMillion: 1000000,
      outputMicrosPerMillion: 2000000,
      anthropicAuth: "bearer",
    });
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });
  it("refuses paid remote dispatch without known prices", async () => {
    vi.stubEnv("COCKPIT_CHESS_PROVIDER_KEY", "test-only");
    await expect(
      localCredentials(match(), { baseUrl: "https://remote.example/v1" }),
    ).rejects.toThrow();
  });
  it("rejects negative prices from flags or the catalog", async () => {
    vi.stubEnv("COCKPIT_CHESS_PROVIDER_KEY", "test-only");
    await expect(
      localCredentials(match(), {
        baseUrl: "https://remote.example/v1",
        inputPrice: "-1",
        outputPrice: "1",
      }),
    ).rejects.toBeInstanceOf(ProviderConfigError);
    vi.stubEnv("OPENROUTER_API_KEY", "test-only");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "vendor/model", pricing: { prompt: "-1", completion: "-1" } }],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(localCredentials(match())).rejects.toBeInstanceOf(ProviderConfigError);
  });
  it("surfaces a key-free configuration error when the routed key is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    vi.stubEnv("COCKPIT_CHESS_PROVIDER_KEY", undefined);
    const error = await localCredentials(match(), { baseUrl: "https://remote.example/v1" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderConfigError);
    expect(String(error)).not.toContain("test-only");
  });
  it("fetches the catalog once per process and refetches after a failure", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-only");
    const catalog = () =>
      new Response(
        JSON.stringify({
          data: [{ id: "vendor/model", pricing: { prompt: "0", completion: "0" } }],
        }),
        { status: 200 },
      );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce(catalog());
    vi.stubGlobal("fetch", fetch);
    await expect(localCredentials(match())).rejects.toBeInstanceOf(ProviderConfigError);
    await localCredentials(match());
    await localCredentials(match());
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("combines the caller's abort signal with the catalog timeout", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-only");
    const fetch = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(init.signal.reason)),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = localCredentials(match(), {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
describe("resolveApiKey", () => {
  const env = {
    OPENROUTER_API_KEY: "openrouter",
    OPENAI_API_KEY: "openai",
    ANTHROPIC_API_KEY: "anthropic",
  };
  const key = (
    url: string,
    extra: Record<string, string> = {},
    protocol = "openai-chat" as const,
  ) => resolveApiKey(new URL(url), protocol, { ...env, ...extra });
  it("sends each vendor key only to that vendor's host", () => {
    expect(key("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(key("https://api.openai.com/v1")).toBe("openai");
    expect(key("https://api.anthropic.com/v1")).toBe("anthropic");
    expect(resolveApiKey(new URL("https://api.anthropic.com/v1"), "anthropic", env)).toBe(
      "anthropic",
    );
  });
  it("gives loopback and other hosts only COCKPIT_CHESS_PROVIDER_KEY", () => {
    expect(key("http://127.0.0.1:8000/v1")).toBeUndefined();
    expect(key("http://localhost:8000/v1")).toBeUndefined();
    expect(key("https://remote.example/v1")).toBeUndefined();
    expect(key("https://openrouter.ai.evil.example/v1")).toBeUndefined();
    expect(key("http://[::1]:8000/v1", { COCKPIT_CHESS_PROVIDER_KEY: "own" })).toBe("own");
    expect(key("https://remote.example/v1", { COCKPIT_CHESS_PROVIDER_KEY: "own" })).toBe("own");
    expect(key("https://api.openai.com/v1", { COCKPIT_CHESS_PROVIDER_KEY: "own" })).toBe("openai");
  });
  it("never resolves a key for non-model players", () => {
    expect(resolveApiKey(new URL("https://openrouter.ai/api/v1"), "random", env)).toBeUndefined();
  });
  it("reports readiness from the routed key, not any key", () => {
    expect(providerReady(undefined, { OPENAI_API_KEY: "openai" })).toBe(false);
    expect(providerReady(undefined, { OPENROUTER_API_KEY: "openrouter" })).toBe(true);
    expect(providerReady("http://127.0.0.1:8000/v1", {})).toBe(true);
    expect(providerReady("https://remote.example/v1", env)).toBe(false);
    expect(providerReady("http://remote.example/v1", { COCKPIT_CHESS_PROVIDER_KEY: "own" })).toBe(
      false,
    );
  });
});
describe("compiled-binary engine guard", () => {
  it("detects Bun's embedded module filesystem", () => {
    expect(isCompiledBinary("file:///$bunfs/root/cockpit-chess", true)).toBe(true);
    expect(isCompiledBinary("file:///B:/~BUN/root/cockpit-chess.exe", true)).toBe(true);
    expect(isCompiledBinary("file:///home/me/apps/cli/src/chess-provider.ts", true)).toBe(false);
    expect(isCompiledBinary("file:///$bunfs/root/cockpit-chess", false)).toBe(false);
  });
  it("rejects engine rules only in a compiled binary", () => {
    const rules = (engineEvaluation: "off" | "tool" | "after-move" | "both") => ({
      rules: { ...match().config.rules, engineEvaluation },
    });
    expect(() => assertEngineSupported(rules("off"), true)).not.toThrow();
    for (const mode of ["tool", "after-move", "both"] as const) {
      expect(() => assertEngineSupported(rules(mode), true)).toThrow(ProviderConfigError);
      expect(() => assertEngineSupported(rules(mode), false)).not.toThrow();
    }
  });
});
