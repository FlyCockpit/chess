import { beginHostedTurn, createMatch, type MatchArchive } from "@cockpit-chess/chess";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const instance = vi.hoisted(() => ({
  client: undefined as QueryClient | undefined,
  online: true,
  reconnect: undefined as (() => void) | undefined,
  mutationOptions: {} as { retry?: boolean; networkMode?: string },
  mutate: vi.fn<(input: unknown) => Promise<unknown>>(),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => instance.client,
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: instance.client?.getQueryData(queryKey),
  }),
  useMutation: (options: typeof instance.mutationOptions) => {
    instance.mutationOptions = options;
    return { mutateAsync: instance.mutate };
  },
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    chess: {
      move: { mutationOptions: () => ({}) },
      inspect: {
        queryOptions: ({ input }: { input: { slug: string } }) => ({
          queryKey: ["inspect", input.slug],
          queryFn: () => refresh(input.slug),
          retry: false,
        }),
      },
    },
  },
}));
vi.mock("./use-network-status", () => ({ useNetworkStatus: () => instance.online }));
vi.mock("./use-retry-on-reconnect", () => ({
  useRetryOnReconnect: (retry: () => void) => {
    instance.reconnect = retry;
  },
}));

import { useHostedHumanTurn } from "./use-hosted-human-turn";

const refresh = vi.fn<(slug: string) => Promise<{ archive: MatchArchive }>>();
let match: MatchArchive;
function useRender(
  options: { slug?: string; blocked?: boolean; archive?: MatchArchive; ownerId?: string } = {},
) {
  return useHostedHumanTurn({
    slug: options.slug ?? "practice",
    match: options.archive ?? match,
    blocked: options.blocked ?? false,
    ownerId: options.ownerId ?? "owner-a",
  });
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  instance.client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  instance.online = true;
  instance.mutate.mockReset().mockResolvedValue({});
  refresh.mockReset().mockImplementation(async () => ({ archive: match }));
  match = createMatch(
    {
      white: { name: "Human", model: "human", protocol: "human" },
      black: { name: "Model", model: "openai/test", protocol: "openai-chat" },
      rules: {},
    },
    "hosted",
  );
  beginHostedTurn(match);
});

afterEach(() => {
  instance.client?.clear();
});

describe("owner hosted turn submission", () => {
  it("keeps pending and uncertain locks in the identity cache across new Studio mounts, cleared only with that cache", async () => {
    instance.mutate.mockRejectedValue(new TypeError("lost response"));
    useRender().submit("e2e4");
    expect(
      instance.client?.getQueryData(["hosted-human-input", "owner-a", "practice"]),
    ).toMatchObject({ phase: "pending" });
    // A new hook invocation has no shared React refs/state; only QueryClient survives.
    useRender().submit("d2d4");
    expect(instance.mutate).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(useRender().phase).toBe("uncertain"));
    useRender().submit("d2d4");
    expect(instance.mutate).toHaveBeenCalledOnce();
    expect(useRender({ ownerId: "owner-b" }).phase).toBeUndefined();
    instance.client?.clear();
    expect(useRender().phase).toBeUndefined();
  });

  it("refreshes the submitted slug after selection changes and cannot clear its denial with another match's read", async () => {
    const request = deferred();
    instance.mutate.mockReturnValue(request.promise);
    refresh.mockImplementation(async (slug) => {
      if (slug === "practice") throw new Error("A unavailable");
      return { archive: match };
    });
    useRender().submit("e2e4");
    useRender({ slug: "other" });
    request.reject({ code: "FORBIDDEN" });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith("practice"));
    await useRender({ slug: "other" }).resync();
    expect(refresh).toHaveBeenCalledWith("other");
    expect(useRender().accessDenied).toBe(true);
    refresh.mockImplementation(async () => ({ archive: match }));
    await useRender().resync();
    expect(useRender().accessDenied).toBe(false);
  });
  it("sends exact authoritative CAS identity and blocks two events in the same render", async () => {
    const request = deferred();
    instance.mutate.mockReturnValue(request.promise);
    const controls = useRender();
    controls.submit(" E2E4 ");
    controls.submit("d2d4");
    useRender().submit("resign");
    expect(instance.mutate).toHaveBeenCalledOnce();
    expect(instance.mutate).toHaveBeenCalledWith({
      slug: "practice",
      move: "e2e4",
      turnId: match.turn.type === "human" ? match.turn.turnId : "",
      expectedSeq: match.events.length,
    });
    expect(useRender().phase).toBe("pending");
    request.resolve({});
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(useRender().phase).toBe("acknowledged");
    useRender().submit("d2d4");
    expect(instance.mutate).toHaveBeenCalledOnce();
    expect(instance.mutationOptions).toMatchObject({ retry: false, networkMode: "always" });
  });

  it.each([new TypeError("network error"), { code: "SERVICE_UNAVAILABLE" }])(
    "never replays an uncertain result on resync/reconnect, even with the same fresh snapshot: %o",
    async (error) => {
      instance.mutate.mockRejectedValue(error);
      useRender().submit("e2e4");
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      expect(useRender().phase).toBe("uncertain");
      await useRender().resync();
      instance.reconnect?.();
      useRender().submit("e2e4");
      useRender().submit("resign");
      expect(instance.mutate).toHaveBeenCalledOnce();
      // Selecting another match and returning keeps the original turn locked.
      useRender({ slug: "other" });
      expect(useRender().disabled).toBe(true);
      match.turn = { type: "idle" };
      beginHostedTurn(match);
      expect(useRender().disabled).toBe(false);
    },
  );

  it("keeps a server refusal locked until a successful read, then allows a new deliberate choice", async () => {
    instance.mutate.mockRejectedValue({ code: "CONFLICT" });
    refresh.mockRejectedValue(new Error("offline"));
    useRender().submit("e2e4");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    useRender().submit("d2d4");
    expect(instance.mutate).toHaveBeenCalledOnce();
    refresh.mockImplementation(async () => ({ archive: match }));
    await useRender().resync();
    expect(useRender().disabled).toBe(false);
    useRender().submit("d2d4");
    expect(instance.mutate).toHaveBeenCalledTimes(2);
  });

  it.each(["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"])(
    "hides cached private controls after %s and restores only after successful owner read",
    async (code) => {
      refresh.mockRejectedValue(new Error("offline"));
      instance.mutate.mockRejectedValue({ code });
      useRender().submit("e2e4");
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      expect(useRender().accessDenied).toBe(true);
      refresh.mockImplementation(async () => ({ archive: match }));
      await useRender().resync();
      expect(useRender().accessDenied).toBe(false);
    },
  );

  it("does not unlock a still-pending request even if a newer turn has already been polled", () => {
    instance.mutate.mockReturnValue(new Promise(() => {}));
    useRender().submit("e2e4");
    match.turn = { type: "idle" };
    beginHostedTurn(match);
    useRender().submit("d2d4");
    expect(instance.mutate).toHaveBeenCalledOnce();
  });

  it("blocks offline, failed reads, wrong turns, non-hosted, finished, expired and invalid input", () => {
    instance.online = false;
    useRender().submit("e2e4");
    instance.online = true;
    useRender({ blocked: true }).submit("e2e4");
    useRender().submit("e2e4\nresign");
    const original = structuredClone(match);
    match.source = "local";
    useRender().submit("e2e4");
    match = structuredClone(original);
    match.status = "completed";
    useRender().submit("e2e4");
    match = structuredClone(original);
    if (match.turn.type !== "human") throw new Error("human fixture");
    match.turn.side = "b";
    useRender().submit("e2e4");
    match = structuredClone(original);
    if (match.turn.type !== "human") throw new Error("human fixture");
    match.turn.deadline = new Date(Date.now() - 1).toISOString();
    useRender().submit("e2e4");
    match.turn.expectedSeq += 1;
    useRender().submit("e2e4");
    expect(instance.mutate).not.toHaveBeenCalled();
  });

  it.each(["a7a8n", "resign"])("uses the same guarded path for %s", (move) => {
    useRender().submit(move);
    expect(instance.mutate).toHaveBeenCalledWith(expect.objectContaining({ move }));
  });
});
