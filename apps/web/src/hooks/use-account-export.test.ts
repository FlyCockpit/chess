import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  epoch: 1,
  replaced: false,
  quarantined: false,
  reject: vi.fn(),
  listener: undefined as (() => void) | undefined,
  effect: undefined as (() => undefined | (() => void)) | undefined,
  states: [] as unknown[],
}));
vi.mock("@cockpit-chess/env/web", () => ({ env: { VITE_SERVER_URL: "https://api.example" } }));
vi.mock("@/lib/document-identity", () => ({
  documentIdentityEpoch: () => fixture.epoch,
  isDocumentReplaced: () => fixture.replaced,
  isDocumentQuarantined: () => fixture.quarantined,
  guardIdentityResponse: async (response: Response) => response,
  reportSessionRejected: fixture.reject,
  withExpectedIdentity: (headers: HeadersInit) =>
    new Headers({ ...Object.fromEntries(new Headers(headers)), "X-Expected-User": "owner" }),
  subscribeDocumentIdentity: (listener: () => void) => {
    fixture.listener = listener;
    return () => {
      fixture.listener = undefined;
    };
  },
}));
vi.mock("@/lib/explicit-sign-out", () => ({ signOutAndLeave: vi.fn() }));
vi.mock("react", () => ({
  useEffect: (effect: () => undefined | (() => void)) => {
    fixture.effect = effect;
  },
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(value: T) => [
    value,
    (next: T) => {
      fixture.states.push(next);
    },
  ],
}));
const { fetchAccountExport, useAccountExport } = await import("./use-account-export");
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.epoch = 1;
  fixture.replaced = false;
  fixture.quarantined = false;
  fixture.states = [];
  fixture.listener = undefined;
  fixture.effect = undefined;
  fetcher = vi
    .fn()
    .mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("account export browser transport", () => {
  it("sends cookie and CSRF/identity headers without an alternate owner", async () => {
    const signal = new AbortController().signal;
    const blob = await fetchAccountExport("json", signal);
    expect(await blob.text()).toBe("{}");
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example/api/account/export?format=json");
    expect(request.credentials).toBe("include");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-csrf-token")).toBe("orpc");
    expect(request.headers.get("X-Expected-User")).toBe("owner");
    expect(request.signal).toBe(signal);
    expect(request.body).toBeUndefined();
  });
  it.each([
    [401, "reauth"],
    [412, "reauth"],
    [429, "rateLimit"],
    [403, "forbidden"],
    [413, "tooLarge"],
    [503, "unavailable"],
  ])("maps status %s to actionable issue %s", async (status, issue) => {
    fetcher.mockResolvedValue(new Response("{}", { status: Number(status) }));
    await expect(fetchAccountExport("json", new AbortController().signal)).rejects.toMatchObject({
      issue,
    });
    expect(fixture.reject).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });
  it("drops bytes when the identity changes while the body is being read", async () => {
    fetcher.mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => {
        fixture.epoch++;
        return new Blob(["private"]);
      },
    });
    await expect(fetchAccountExport("json", new AbortController().signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
  it("does not begin a request from a replaced document", async () => {
    fixture.replaced = true;
    await expect(fetchAccountExport("json", new AbortController().signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps benign identity notifications and clears a cancelled pending state", async () => {
    let requestSignal: AbortSignal | undefined;
    fetcher.mockImplementation(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          requestSignal = init.signal ?? undefined;
          requestSignal?.addEventListener("abort", () =>
            reject(new DOMException("Cancelled", "AbortError")),
          );
        }),
    );
    const state = useAccountExport("en-US");
    const cleanup = fixture.effect?.();
    const download = state.download("json");
    fixture.listener?.();
    expect(requestSignal?.aborted).toBe(false);
    fixture.epoch++;
    fixture.listener?.();
    await download;
    expect(requestSignal?.aborted).toBe(true);
    expect(fixture.states.at(-1)).toBeNull();
    expect(fixture.states).not.toContain("unavailable");
    cleanup?.();
  });
  it("releases delayed object URLs when the section unmounts", async () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    const click = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:export", revokeObjectURL: revoke });
    vi.stubGlobal("document", { createElement: () => ({ click }) });
    const state = useAccountExport("en-US");
    const cleanup = fixture.effect?.();
    await state.download("json");
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    cleanup?.();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:export");
    expect(vi.getTimerCount()).toBe(0);
  });
});
