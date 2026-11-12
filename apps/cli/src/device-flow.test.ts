import { afterEach, describe, expect, it, vi } from "vitest";

import { pollForToken, requestDeviceCode } from "./device-flow";
import { CliError, ExitCode } from "./exit";
import { REQUEST_TIMEOUT_MS } from "./network";

afterEach(() => vi.useRealTimers());

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deps(responses: Response[]) {
  let clock = 0;
  const fetchMock = vi.fn(async () => responses.shift() ?? json(500, {}));
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  return { fetch: fetchMock as unknown as typeof fetch, sleep, now: () => clock, fetchMock };
}

const code = {
  deviceCode: "dev",
  userCode: "ABCD-EFGH",
  verificationUri: "https://app/device",
  verificationUriComplete: "https://app/device?user_code=ABCD-EFGH",
  expiresInSeconds: 60,
  intervalSeconds: 5,
};

describe("requestDeviceCode", () => {
  it.each(["fetch", "body"])("bounds a stalled %s while requesting a code", async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal;
      if (phase === "fetch") return new Promise<Response>(() => {});
      return new Response(new ReadableStream());
    });
    const result = requestDeviceCode("https://app", {
      fetch: fetchMock,
      sleep: async () => {},
      now: Date.now,
    });
    const rejected = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends the CLI client id and maps the RFC 8628 response", async () => {
    const d = deps([
      json(200, {
        device_code: "dev",
        user_code: "ABCD-EFGH",
        verification_uri: "https://app/device",
        verification_uri_complete: "https://app/device?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      }),
    ]);
    const result = await requestDeviceCode("https://app", d);
    expect(result.userCode).toBe("ABCD-EFGH");
    const [url, init] = d.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app/api/auth/device/code");
    expect(JSON.parse(String(init.body))).toEqual({ client_id: "cockpit-chess-cli" });
  });

  it("fails clearly when the server refuses", async () => {
    await expect(
      requestDeviceCode("https://app", deps([json(400, { error: "invalid_client" })])),
    ).rejects.toThrow(/did not start a login/);
  });
});

describe("pollForToken", () => {
  it.each(["fetch", "body"])(
    "bounds a stalled %s by the code's remaining lifetime",
    async (phase) => {
      vi.useFakeTimers();
      let signal: AbortSignal | null | undefined;
      const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
        signal = init?.signal;
        if (phase === "fetch") return new Promise<Response>(() => {});
        return new Response(new ReadableStream());
      });
      const result = pollForToken(
        "https://app",
        { ...code, expiresInSeconds: 6 },
        {
          fetch: fetchMock,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: Date.now,
        },
      );
      const rejected = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(5999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not dispatch a poll after sleeping through expiry", async () => {
    const d = deps([]);
    await expect(
      pollForToken("https://app", { ...code, expiresInSeconds: 2 }, d),
    ).rejects.toMatchObject({
      exitCode: ExitCode.Unauthenticated,
      message: expect.stringMatching(/expired/),
    });
    expect(d.sleep).toHaveBeenCalledWith(2000);
    expect(d.fetchMock).not.toHaveBeenCalled();
  });

  it("waits through pending and slow_down, then returns the token", async () => {
    const d = deps([
      json(400, { error: "authorization_pending" }),
      json(400, { error: "slow_down" }),
      json(200, { access_token: "session-token", token_type: "Bearer" }),
    ]);
    await expect(pollForToken("https://app", code, d)).resolves.toBe("session-token");
    expect(d.sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 5000, 10000]);
  });

  it("maps a denial to the unauthenticated exit code", async () => {
    const error = await pollForToken(
      "https://app",
      code,
      deps([json(400, { error: "access_denied" })]),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(ExitCode.Unauthenticated);
  });

  it("gives up when the code expires", async () => {
    const pending = Array.from({ length: 20 }, () => json(400, { error: "authorization_pending" }));
    await expect(pollForToken("https://app", code, deps(pending))).rejects.toThrow(/expired/);
  });
});
