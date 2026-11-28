import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  get: vi.fn<(slug: string) => Promise<{ archive: string }>>(),
  visibility: vi.fn<(slug: string) => Promise<{ version: number }>>(),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    chess: {
      get: {
        queryOptions: ({ input }: { input: { slug: string } }) => ({
          queryKey: ["get", input.slug],
          queryFn: () => state.get(input.slug),
        }),
      },
    },
    chessModeration: {
      visibility: {
        queryOptions: ({ input }: { input: { slug: string } }) => ({
          queryKey: ["visibility", input.slug],
          queryFn: () => state.visibility(input.slug),
        }),
      },
    },
  },
}));

import { createReplayAuthority, useReplayVisibility } from "./use-replay-visibility";

let client: QueryClient;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  state.get.mockReset().mockResolvedValue({ archive: "authorized transcript" });
  state.visibility.mockReset().mockResolvedValue({ version: 0 });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  client.clear();
});
const deferred = <T>() => {
  let resolve: (data: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
const ignoreFailure = async (request: Promise<unknown>) => {
  try {
    await request;
  } catch {}
};
let renderedHook: ReturnType<typeof useReplayVisibility> | undefined;
function Harness() {
  renderedHook = useReplayVisibility("finished", true);
  return null;
}

describe("public replay authority", () => {
  it("configures a bounded independent poll after score polling stops, including focus and background", () => {
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Harness)));
    const options = client.getQueryCache().find({ queryKey: ["visibility", "finished"] })?.options;
    expect(options).toMatchObject({
      enabled: true,
      refetchInterval: 20_000,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: "always",
      retry: false,
      networkMode: "always",
    });
    expect(renderedHook?.unavailable).toBe(false);
  });

  it.each(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"])(
    "evicts and latches a transcript %s across later network failures",
    async (code) => {
      const authority = createReplayAuthority(client, "selected");
      const observer = new QueryObserver(client, authority.replayOptions);
      cleanups.push(observer.subscribe(() => {}));
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data).toEqual({ archive: "authorized transcript" }),
      );
      client.setQueryData(["get", "other"], { archive: "other" });
      state.get.mockRejectedValueOnce({ code });
      await ignoreFailure(observer.refetch());
      expect(authority.isDenied()).toBe(true);
      expect(client.getQueryData(["get", "selected"])).toBeUndefined();
      expect(client.getQueryData(["get", "other"])).toEqual({ archive: "other" });
      state.get.mockRejectedValueOnce(new Error("transcript offline"));
      state.visibility.mockRejectedValueOnce(new Error("visibility offline"));
      await ignoreFailure(client.fetchQuery(authority.replayOptions));
      await ignoreFailure(client.fetchQuery(authority.visibilityOptions));
      expect(authority.isDenied()).toBe(true);
      expect(client.getQueryData(["get", "selected"])).toBeUndefined();
    },
  );

  it("rejects an older transcript completion after a visibility denial even when transport ignores cancellation", async () => {
    const authority = createReplayAuthority(client, "selected");
    client.setQueryData(["get", "selected"], { archive: "previously loaded" });
    const old = deferred<{ archive: string }>();
    state.get.mockReturnValueOnce(old.promise);
    const request = ignoreFailure(client.fetchQuery({ ...authority.replayOptions, staleTime: 0 }));
    state.visibility.mockRejectedValueOnce({ code: "NOT_FOUND" });
    await ignoreFailure(client.fetchQuery(authority.visibilityOptions));
    expect(authority.isDenied()).toBe(true);
    old.resolve({ archive: "late forbidden transcript" });
    await request;
    await Promise.resolve();
    expect(authority.isDenied()).toBe(true);
    expect(client.getQueryData(["get", "selected"])).toBeUndefined();
  });

  it("does not clear denial or start recovery from a stale lightweight success", async () => {
    const authority = createReplayAuthority(client, "selected");
    await client.fetchQuery(authority.replayOptions);
    const oldVisibility = deferred<{ version: number }>();
    state.visibility.mockReturnValueOnce(oldVisibility.promise);
    const old = ignoreFailure(client.fetchQuery(authority.visibilityOptions));
    state.get.mockRejectedValueOnce({ code: "NOT_FOUND" });
    await ignoreFailure(client.fetchQuery({ ...authority.replayOptions, staleTime: 0 }));
    oldVisibility.resolve({ version: 0 });
    await old;
    expect(authority.isDenied()).toBe(true);
    expect(state.get).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(["get", "selected"])).toBeUndefined();
  });

  it("restores access only after a newly authorized transcript succeeds", async () => {
    const authority = createReplayAuthority(client, "selected");
    state.get.mockRejectedValueOnce({ code: "NOT_FOUND" });
    await ignoreFailure(client.fetchQuery(authority.replayOptions));
    const fresh = deferred<{ archive: string }>();
    state.get.mockReturnValueOnce(fresh.promise);
    await client.fetchQuery({ ...authority.visibilityOptions, staleTime: 0 });
    expect(authority.isDenied()).toBe(true);
    expect(client.getQueryData(["get", "selected"])).toBeUndefined();
    expect(await authority.beforeExport()).toBe(false);
    expect(authority.isDenied()).toBe(true);
    fresh.resolve({ archive: "newly authorized transcript" });
    await vi.waitFor(() => expect(authority.isDenied()).toBe(false));
    expect(client.getQueryData(["get", "selected"])).toEqual({
      archive: "newly authorized transcript",
    });
  });

  it("revalidates each export and refuses transient failures without dropping content that was never denied", async () => {
    const authority = createReplayAuthority(client, "selected");
    await client.fetchQuery(authority.replayOptions);
    expect(await authority.beforeExport()).toBe(true);
    state.visibility.mockRejectedValueOnce(new Error("offline"));
    expect(await authority.beforeExport()).toBe(false);
    expect(client.getQueryData(["get", "selected"])).toEqual({ archive: "authorized transcript" });
    state.visibility.mockRejectedValueOnce({ code: "NOT_FOUND" });
    expect(await authority.beforeExport()).toBe(false);
    expect(state.visibility).toHaveBeenCalledTimes(3);
    expect(authority.isDenied()).toBe(true);
    expect(client.getQueryData(["get", "selected"])).toBeUndefined();
  });

  it("does not let a different selection clear a refusal", async () => {
    const denied = createReplayAuthority(client, "hidden");
    const other = createReplayAuthority(client, "other");
    state.get.mockRejectedValueOnce({ code: "NOT_FOUND" });
    await ignoreFailure(client.fetchQuery(denied.replayOptions));
    expect(await other.beforeExport()).toBe(true);
    await client.fetchQuery(other.replayOptions);
    expect(denied.isDenied()).toBe(true);
    expect(other.isDenied()).toBe(false);
  });
  it("keeps a terminally refused QueryObserver disabled without eviction or fetch loops", async () => {
    state.get.mockRejectedValue({ code: "NOT_FOUND" });
    const authority = createReplayAuthority(client, "hidden");
    const observer = new QueryObserver(client, { ...authority.replayOptions, retry: false });
    const removed = vi.spyOn(client, "removeQueries");
    const changed = vi.fn(() =>
      observer.setOptions({
        ...authority.replayOptions,
        retry: false,
        enabled: !authority.isDenied(),
      }),
    );
    cleanups.push(authority.subscribe(changed));
    cleanups.push(observer.subscribe(() => {}));
    await vi.waitFor(() => expect(authority.isDenied()).toBe(true));
    await ignoreFailure(client.fetchQuery(authority.replayOptions));
    await ignoreFailure(client.fetchQuery(authority.replayOptions));
    expect(state.get).toHaveBeenCalledTimes(3);
    expect(removed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    expect(observer.getCurrentResult().fetchStatus).toBe("idle");
    expect(client.getQueryData(["get", "hidden"])).toBeUndefined();
    removed.mockRestore();
  });
});
