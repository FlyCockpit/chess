import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../config";
import { registerAuth } from "./auth";

vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}));
vi.mock("../output", () => ({ info: vi.fn(), printResult: vi.fn() }));

beforeEach(() => {
  vi.mocked(saveConfig).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["fetch", "body"])(
  "forgets only the selected server after a stalled revoke %s",
  async (phase) => {
    vi.useFakeTimers();
    vi.mocked(loadConfig).mockResolvedValue({
      credentials: {
        "https://app": { kind: "session", value: "test-session" },
        "https://other": { kind: "session", value: "other-test-session" },
      },
    });
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        signal = init?.signal;
        if (phase === "fetch") return new Promise<Response>(() => {});
        return new Response(new ReadableStream());
      }),
    );
    const program = new Command().option("--server <url>");
    registerAuth(program);
    const result = program.parseAsync(["--server", "https://app", "logout"], { from: "user" });
    await vi.advanceTimersByTimeAsync(9999);
    expect(signal?.aborted).toBe(false);
    expect(saveConfig).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(signal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(saveConfig).toHaveBeenCalledExactlyOnceWith({
      credentials: { "https://other": { kind: "session", value: "other-test-session" } },
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("forgets an API key without calling the network", async () => {
  vi.mocked(loadConfig).mockResolvedValue({
    credentials: { "https://app": { kind: "api-key", value: "test-api-key" } },
  });
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  const program = new Command().option("--server <url>");
  registerAuth(program);
  await program.parseAsync(["--server", "https://app", "logout"], { from: "user" });
  expect(saveConfig).toHaveBeenCalledExactlyOnceWith({});
  expect(fetchMock).not.toHaveBeenCalled();
});
