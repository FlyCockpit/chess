import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, toCliError } from "./api";
import { ExitCode } from "./exit";
import { REQUEST_TIMEOUT_MS } from "./network";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RPC deadlines", () => {
  it.each(["fetch", "body"])("bounds a stalled %s including body consumption", async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        signal = init?.signal;
        if (phase === "fetch") return new Promise<Response>(() => {});
        return new Response(new ReadableStream());
      }),
    );
    const call = createApiClient("https://app", undefined)
      .logout()
      .catch((error: unknown) => {
        throw toCliError(error, "https://app");
      });
    const rejected = expect(call).rejects.toMatchObject({
      message: "Could not reach https://app: timed out",
      exitCode: ExitCode.Failure,
    });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves RPC decoding and credential headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ json: { revoked: true } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createApiClient("https://app", { kind: "session", value: "test-session" }).logout(),
    ).resolves.toEqual({ revoked: true });
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    if (request instanceof Request)
      expect(request.headers.get("authorization")).toBe("Bearer test-session");
  });
});

// The binary must never bundle server code. Imports from @cockpit-chess/api are
// allowed only as `import type` (erased at build time); anything else would
// pull Prisma, auth, and env validation into a file shipped to users.
it("imports @cockpit-chess/api only as types", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(import.meta.dirname);
  const offenders = files.filter((file) =>
    /^\s*import\s+(?!type\b)[^;]*from\s+["']@cockpit-chess\/(api|auth|db|env)/m.test(
      readFileSync(file, "utf8"),
    ),
  );
  expect(offenders).toEqual([]);
});
