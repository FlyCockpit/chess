import type { AppRouterClient } from "@cockpit-chess/api/routers/index";
import { beginHostedTurn, boardAt, createMatch, type MatchArchive } from "@cockpit-chess/chess";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Snapshot = Awaited<ReturnType<AppRouterClient["chess"]["runnerStatus"]>>;
const instance = vi.hoisted(() => ({
  client: undefined as QueryClient | undefined,
  online: true,
  queryError: undefined as unknown,
  reconnect: undefined as (() => void) | undefined,
  enabled: [] as unknown[],
  options: [] as unknown[],
  start: vi.fn<(input: unknown) => Promise<unknown>>(),
  stop: vi.fn<(input: unknown) => Promise<unknown>>(),
  move: vi.fn<(input: unknown) => Promise<unknown>>(),
  refresh: vi.fn<(slug: string) => Promise<Snapshot>>(),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => instance.client,
  useQuery: ({ queryKey, enabled }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    instance.enabled.push(enabled);
    return {
      data: instance.client?.getQueryData(queryKey),
      error: queryKey[0] === "runner" ? instance.queryError : undefined,
      isError: queryKey[0] === "runner" && !!instance.queryError,
    };
  },
  useMutation: (options: { kind: "start" | "stop" | "move" }) => {
    instance.options.push(options);
    return { mutateAsync: instance[options.kind] };
  },
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    chess: {
      key: () => ["chess"],
      inspect: {
        queryOptions: ({ input }: { input: { slug: string } }) => ({
          queryKey: ["inspect", input.slug],
        }),
      },
      runnerStatus: {
        queryOptions: ({ input }: { input: { slug: string } }) => ({
          queryKey: ["runner", input.slug],
          queryFn: () => instance.refresh(input.slug),
          retry: false,
        }),
      },
      startRunner: { mutationOptions: () => ({ kind: "start" }) },
      stopRunner: { mutationOptions: () => ({ kind: "stop" }) },
      moveRunner: { mutationOptions: () => ({ kind: "move" }) },
    },
  },
}));
vi.mock("./use-network-status", () => ({ useNetworkStatus: () => instance.online }));
vi.mock("./use-retry-on-reconnect", () => ({
  useRetryOnReconnect: (fn: () => void) => {
    instance.reconnect = fn;
  },
}));

import { useRunnerControls } from "./use-runner-controls";

let archive: MatchArchive;
let snapshot: Snapshot;
function useRender(
  options: {
    ownerId?: string;
    slug?: string;
    blocked?: boolean;
    enabled?: boolean;
    match?: MatchArchive;
  } = {},
) {
  return useRunnerControls({
    ownerId: "owner",
    slug: "local-game",
    enabled: true,
    match: archive,
    ...options,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  instance.client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  instance.online = true;
  instance.queryError = undefined;
  instance.options = [];
  instance.enabled = [];
  archive = createMatch(
    {
      white: { name: "Human", model: "human", protocol: "human" },
      black: { name: "Model", model: "test/model", protocol: "openai-chat" },
      rules: {},
    },
    "local",
  );
  beginHostedTurn(archive);
  snapshot = {
    id: archive.id,
    slug: "local-game",
    status: "running",
    state: "running",
    revision: 4,
    acceptedSeq: 0,
    fen: boardAt(archive).fen(),
    ply: 0,
    lastContactAt: new Date(),
    resumeDeadline: new Date(Date.now() + 120_000),
    turn: archive.turn,
    result: "*",
    termination: "playing",
    verification: "self-run",
  };
  instance.client.setQueryData(["runner", "local-game"], snapshot);
  instance.refresh.mockReset().mockImplementation(async () => snapshot);
  for (const fn of [instance.start, instance.stop, instance.move])
    fn.mockReset().mockImplementation(async () => ({ ...snapshot, revision: 5 }));
});
afterEach(() => instance.client?.clear());

describe("protected runner controls", () => {
  it("submits one human move with authoritative revision/ply/FEN and never hosted move", async () => {
    const pending = deferred<unknown>();
    instance.move.mockReturnValue(pending.promise);
    const controls = useRender();
    expect(controls.disabled).toBe(false);
    controls.submit(" E2E4 ");
    controls.submit("d2d4");
    useRender().submit("resign");
    expect(instance.move).toHaveBeenCalledOnce();
    expect(instance.move).toHaveBeenCalledWith({
      slug: "local-game",
      commandId: expect.any(String),
      expectedRevision: 4,
      expectedSeq: 0,
      fen: snapshot.fen,
      move: "e2e4",
    });
    expect(instance.start).not.toHaveBeenCalled();
    expect(instance.stop).not.toHaveBeenCalled();
    expect(useRender().pending).toBe(true);
    pending.resolve({ ...snapshot, revision: 5 });
    await vi.waitFor(() => expect(useRender().pending).toBe(false));
    expect(instance.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ retry: false, networkMode: "always" })]),
    );
  });
  it("never automatically repeats a lost command; deliberate retry retains exact input across remount/reconnect", async () => {
    instance.move.mockRejectedValue(new TypeError("lost response"));
    useRender().submit("e2e4");
    await vi.waitFor(() => expect(useRender().uncertain).toBe(true));
    const first = instance.move.mock.calls[0]?.[0];
    await useRender().resync();
    instance.reconnect?.();
    useRender().submit("d2d4");
    useRender().stop();
    expect(instance.move).toHaveBeenCalledOnce();
    expect(instance.stop).not.toHaveBeenCalled();
    useRender().retry();
    expect(instance.move).toHaveBeenCalledTimes(2);
    expect(instance.move.mock.calls[1]?.[0]).toEqual(first);
    useRender().retry();
    expect(instance.move).toHaveBeenCalledTimes(2);
  });
  it("routes card Stop for newly offered runner to stopRunner after reading its current revision", async () => {
    snapshot = { ...snapshot, status: "queued", state: "offered", revision: 1 };
    const request = deferred<unknown>();
    instance.stop.mockReturnValue(request.promise);
    const control = useRender({ enabled: false });
    control.stop();
    control.stop();
    await vi.waitFor(() => expect(instance.stop).toHaveBeenCalledOnce());
    expect(instance.refresh).toHaveBeenCalledWith("local-game");
    expect(instance.stop).toHaveBeenCalledWith({
      slug: "local-game",
      commandId: expect.any(String),
      expectedRevision: 1,
    });
    expect(instance.start).not.toHaveBeenCalled();
    expect(instance.move).not.toHaveBeenCalled();
    request.resolve({ ...snapshot, status: "stopped", state: "stopped", revision: 2 });
  });
  it("only starts an accepted game, and binds start's original receipt for explicit retries", async () => {
    snapshot = { ...snapshot, status: "queued", state: "offered" };
    useRender().start();
    await vi.waitFor(() => expect(instance.refresh).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(instance.client?.getQueryState(["runner", "local-game"])?.fetchStatus).toBe("idle"),
    );
    expect(instance.start).not.toHaveBeenCalled();
    snapshot = { ...snapshot, state: "accepted", revision: 8 };
    instance.start.mockRejectedValue({ code: "SERVICE_UNAVAILABLE" });
    useRender().start();
    await vi.waitFor(() => expect(useRender().uncertain).toBe(true));
    const first = instance.start.mock.calls[0]?.[0];
    useRender().retry();
    expect(instance.start.mock.calls[1]?.[0]).toEqual(first);
  });
  it.each([
    "fen",
    "seq",
    "turn",
    "grace",
    "contact",
    "source",
    "model",
    "offline",
    "denied",
    "blocked",
    "owner",
  ])("refuses unsafe or stale human input: %s", (reason) => {
    if (reason === "fen") snapshot.fen = snapshot.fen.replace(" w ", " b ");
    if (reason === "seq") snapshot.acceptedSeq = 1;
    if (reason === "turn") snapshot.turn = { type: "idle" };
    if (reason === "grace") snapshot.resumeDeadline = new Date(Date.now() - 1);
    if (reason === "contact") snapshot.lastContactAt = new Date(Date.now() - 61_000);
    if (reason === "source") archive.source = "hosted";
    if (reason === "model") snapshot.state = "accepted";
    if (reason === "offline") instance.online = false;
    if (reason === "denied") instance.queryError = { code: "FORBIDDEN" };
    instance.client?.setQueryData(["runner", "local-game"], snapshot);
    const controls = useRender({
      blocked: reason === "blocked",
      ...(reason === "owner" ? { ownerId: undefined } : {}),
    });
    expect(controls.disabled).toBe(true);
    controls.submit("e2e4");
    expect(instance.move).not.toHaveBeenCalled();
  });
  it("preserves a promotion or resignation exactly", async () => {
    const pending = deferred<unknown>();
    instance.move.mockReturnValue(pending.promise);
    useRender().submit("e7e8q");
    expect(instance.move).toHaveBeenCalledWith(expect.objectContaining({ move: "e7e8q" }));
    instance.client?.removeQueries({ queryKey: ["runner-control"] });
    useRender().submit("resign");
    expect(instance.move).toHaveBeenLastCalledWith(expect.objectContaining({ move: "resign" }));
    pending.resolve({ ...snapshot, revision: 5 });
  });
  it("keeps uncertain state scoped by owner/game, then drops it with the document cache", async () => {
    instance.move.mockRejectedValue(new TypeError("lost"));
    useRender().submit("e2e4");
    await vi.waitFor(() => expect(useRender().uncertain).toBe(true));
    expect(useRender({ ownerId: "other" }).uncertain).toBe(false);
    expect(useRender({ slug: "other" }).uncertain).toBe(false);
    instance.client?.clear();
    expect(useRender().uncertain).toBe(false);
  });
  it("refreshes the submitted game after selection changes; access failures hide authoritative state", async () => {
    const request = deferred<unknown>();
    instance.move.mockReturnValue(request.promise);
    instance.refresh.mockRejectedValue({ code: "FORBIDDEN" });
    useRender().submit("e2e4");
    useRender({ slug: "other" });
    request.reject({ code: "FORBIDDEN" });
    await vi.waitFor(() => expect(instance.refresh).toHaveBeenCalledWith("local-game"));
    expect(useRender().accessDenied).toBe(true);
    expect(useRender().state).toBeUndefined();
    useRender().retry();
    expect(instance.move).toHaveBeenCalledOnce();
  });
});

it("requires a fresh successful read after an explicit refusal before allowing another human choice", async () => {
  instance.move.mockRejectedValue({ code: "CONFLICT" });
  instance.refresh.mockRejectedValue(new Error("offline"));
  useRender().submit("e2e4");
  await vi.waitFor(() => expect(useRender().commandError).toBe(true));
  expect(useRender().disabled).toBe(true);
  useRender().submit("d2d4");
  expect(instance.move).toHaveBeenCalledOnce();
  instance.refresh.mockResolvedValue(snapshot);
  await useRender().resync();
  expect(useRender().disabled).toBe(false);
  useRender().submit("d2d4");
  expect(instance.move).toHaveBeenCalledTimes(2);
});
