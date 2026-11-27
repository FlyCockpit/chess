import { defaultStringifySearch } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

const { webEnv } = vi.hoisted(() => ({
  webEnv: { VITE_SERVER_URL: "https://api.chess.example" as string | undefined },
}));
vi.mock("@cockpit-chess/env/web", () => ({ env: webEnv }));

import {
  CALLBACK_ERRORS,
  ConnectError,
  callbackNotice,
  connectFailureFor,
  DEFAULT_EXPIRY,
  DEFAULT_LIMIT,
  keyActivityUrl,
  manageKeyUrl,
  openRouterMoney,
  parseOpenRouterSearch,
  startOpenRouterConnect,
} from "./openrouter-connect";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("startOpenRouterConnect", () => {
  it("posts to the configured API origin, like RPC, in a cross-origin deployment", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      json(200, { url: "https://openrouter.ai/auth" }),
    );
    await startOpenRouterConnect({ limitUsd: 10, expiration: "90-days", lang: "en-US" }, { fetch });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.chess.example/api/openrouter/connect");
    webEnv.VITE_SERVER_URL = undefined;
    try {
      await startOpenRouterConnect(
        { limitUsd: 10, expiration: "90-days", lang: "en-US" },
        { fetch },
      );
      expect(fetch.mock.calls[1]?.[0]).toBe("/api/openrouter/connect");
    } finally {
      webEnv.VITE_SERVER_URL = "https://api.chess.example";
    }
  });
  it("posts the choices with the oRPC CSRF header and the session cookie", async () => {
    const fetch = vi.fn(async () => json(200, { url: "https://openrouter.ai/auth?state=x" }));
    const url = await startOpenRouterConnect(
      { limitUsd: 10, expiration: "90-days", lang: "es-MX" },
      { serverUrl: "https://chess.example", fetch },
    );
    expect(url).toBe("https://openrouter.ai/auth?state=x");
    expect(fetch).toHaveBeenCalledWith("https://chess.example/api/openrouter/connect", {
      method: "POST",
      credentials: "include",
      headers: new Headers({ "content-type": "application/json", "x-csrf-token": "orpc" }),
      body: JSON.stringify({ limitUsd: 10, expiration: "90-days", lang: "es-MX" }),
    });
  });
  it("sends no limit as null", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      json(200, { url: "https://openrouter.ai/auth" }),
    );
    await startOpenRouterConnect({ limitUsd: null, expiration: "never", lang: "en-US" }, { fetch });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      limitUsd: null,
      expiration: "never",
      lang: "en-US",
    });
  });
  it.each([
    [401, "x", "signIn"],
    [403, "unverified", "forbidden"],
    [403, "two-factor", "twoFactor"],
    [403, "disabled", "unavailable"],
    [403, "forbidden", "failed"],
    [429, "x", "rateLimited"],
    [503, "unavailable", "unavailable"],
    [500, "x", "failed"],
  ] as const)("maps HTTP %i %s to %s", async (status, code, reason) => {
    const fetch = vi.fn(async () => json(status, { error: code }));
    await expect(
      startOpenRouterConnect({ limitUsd: 10, expiration: "90-days", lang: "en-US" }, { fetch }),
    ).rejects.toMatchObject({ reason });
  });
  it("never follows a non-http URL or a malformed answer", async () => {
    for (const body of [{ url: "javascript:alert(1)" }, { url: 42 }, {}, "nope"]) {
      const fetch = vi.fn(async () => json(200, body));
      const failure = await startOpenRouterConnect(
        { limitUsd: 10, expiration: "90-days", lang: "en-US" },
        { fetch },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConnectError);
      expect((failure as ConnectError).reason).toBe("failed");
    }
  });
  it("reads a network failure as failed", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("offline");
    });
    await expect(
      startOpenRouterConnect({ limitUsd: 10, expiration: "90-days", lang: "en-US" }, { fetch }),
    ).rejects.toMatchObject({ reason: "failed" });
  });
});

describe("the callback's result", () => {
  it("reads connected and every known error, anything else as unknown", () => {
    expect(callbackNotice({ connected: "1" })).toEqual({ kind: "connected" });
    for (const code of CALLBACK_ERRORS)
      expect(callbackNotice({ error: code })).toEqual({ kind: "error", code });
    expect(callbackNotice({ error: "weird" })).toEqual({ kind: "error", code: "unknown" });
    expect(callbackNotice({ connected: "1", error: "denied" })).toEqual({
      kind: "error",
      code: "denied",
    });
    expect(callbackNotice({})).toBeNull();
  });
  it("keeps only the two short search values the callback sends", () => {
    expect(parseOpenRouterSearch({ connected: "1", code: "secret", state: "s" })).toEqual({
      connected: 1,
    });
    expect(parseOpenRouterSearch({ error: "denied" })).toEqual({ error: "denied" });
    expect(parseOpenRouterSearch({ error: "<script>", connected: "yes" })).toEqual({});
  });
});

it("links OpenRouter's own key and activity pages by the key's hash", () => {
  const hash = "a".repeat(64);
  expect(manageKeyUrl(hash)).toBe(`https://openrouter.ai/keys/${hash}`);
  expect(keyActivityUrl(hash)).toBe(`https://openrouter.ai/logs?api_key_hash=${hash}`);
});

it("suggests a $10 limit and a 90-day expiry", () => {
  expect(DEFAULT_LIMIT).toBe(10);
  expect(DEFAULT_EXPIRY).toBe("90-days");
  expect(connectFailureFor(404)).toBe("unavailable");
});

it("serializes callback search without an extra redirect", () => {
  expect(defaultStringifySearch(parseOpenRouterSearch({ connected: "1" }))).toBe("?connected=1");
  expect(defaultStringifySearch(parseOpenRouterSearch({ error: "denied" }))).toBe("?error=denied");
});

it.each([
  ["en-US", "$10.00", "<$0.01"],
  ["es-MX", "USD 10.00", "<USD 0.01"],
])("formats key money in %s", (locale, normal, tiny) => {
  expect(openRouterMoney(locale, 10_000_000)).toBe(normal);
  expect(openRouterMoney(locale, 1)).toBe(tiny);
});

it.each([
  ["600", 600],
  ["0", undefined],
  ["1.5", undefined],
  ["garbage", undefined],
  ["9007199254740992", undefined],
])("validates Retry-After %s", async (header, seconds) => {
  const fetch = vi.fn(
    async () => new Response("{}", { status: 429, headers: { "Retry-After": header } }),
  );
  await expect(
    startOpenRouterConnect({ limitUsd: 10, expiration: "90-days", lang: "en-US" }, { fetch }),
  ).rejects.toMatchObject({ reason: "rateLimited", retryAfterSeconds: seconds });
});

describe("OpenRouter document identity", () => {
  it("sends the baseline and parks a conflicting cookie write before any error UI", async () => {
    const { observeDocumentIdentity, resetDocumentIdentityForTests } = await import(
      "./document-identity"
    );
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    vi.stubGlobal("document", { documentElement: { style: { setProperty: vi.fn() } } });
    resetDocumentIdentityForTests(() => undefined);
    observeDocumentIdentity("old-owner");
    const transport = vi.fn<typeof fetch>(async () => json(409, { code: "IDENTITY_CHANGED" }));
    const error = vi.fn();
    const success = vi.fn();
    try {
      void startOpenRouterConnect(
        { limitUsd: 10, expiration: "90-days", lang: "en-US" },
        { fetch: transport },
      ).then(success, error);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get("X-Expected-User")).toBe(
        "old-owner",
      );
      expect(reload).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
      expect(success).not.toHaveBeenCalled();
    } finally {
      resetDocumentIdentityForTests(() => undefined);
      vi.unstubAllGlobals();
    }
  });
});
