import {
  type QueryClient,
  type QueryFunctionContext,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

const unavailableReplay = () =>
  Object.assign(new Error("Replay unavailable"), { code: "NOT_FOUND" });

/** One selection's authority fence. Only a newly authorized transcript can clear a
 * refusal. A lightweight success alone must never revive a cached transcript. */
export function createReplayAuthority(queryClient: QueryClient, slug: string) {
  const transcript = orpc.chess.get.queryOptions({ input: { slug } });
  const visibility = orpc.chessModeration.visibility.queryOptions({ input: { slug } });
  const listeners = new Set<() => void>();
  let generation = 0;
  let denied = false;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const refuse = () => {
    generation += 1;
    // A refused selection stays disabled. Repeated refusals still fence older
    // requests, but must not repeatedly destroy/recreate an active observer.
    if (denied) return;
    denied = true;
    // TanStack cancels synchronously before resolving this promise. Remove the
    // same query immediately so no cached archive survives the refusal.
    void queryClient.cancelQueries({ queryKey: transcript.queryKey, exact: true });
    queryClient.removeQueries({ queryKey: transcript.queryKey, exact: true });
    notify();
  };
  const replayOptions = {
    ...transcript,
    queryFn: async (context: QueryFunctionContext<typeof transcript.queryKey>) => {
      const started = generation;
      try {
        const execute = transcript.queryFn;
        if (typeof execute !== "function") throw unavailableReplay();
        const data = await execute(context);
        if (started !== generation) throw unavailableReplay();
        if (denied) {
          denied = false;
          notify();
        }
        return data;
      } catch (error) {
        // A response from before a refusal can neither authorize nor change the
        // new generation's state, even when its transport ignores cancellation.
        if (started !== generation) throw unavailableReplay();
        if (isQueryAccessError(error)) refuse();
        throw error;
      }
    },
  };
  const visibilityOptions = {
    ...visibility,
    queryFn: async (context: QueryFunctionContext<typeof visibility.queryKey>) => {
      const started = generation;
      try {
        const execute = visibility.queryFn;
        if (typeof execute !== "function") throw unavailableReplay();
        const data = await execute(context);
        if (started !== generation) throw unavailableReplay();
        if (denied) {
          // Restoring visibility requires a new full authorized read. Keep the
          // refusal latched until that request succeeds; never reveal old data.
          void queryClient
            .fetchQuery({ ...replayOptions, staleTime: 0, retry: false })
            .catch(() => {});
        }
        return data;
      } catch (error) {
        if (started !== generation) throw unavailableReplay();
        if (isQueryAccessError(error)) refuse();
        throw error;
      }
    },
  };
  return {
    replayOptions,
    visibilityOptions,
    isDenied: () => denied,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    beforeExport: async () => {
      try {
        await queryClient.cancelQueries({ queryKey: visibility.queryKey, exact: true });
        await queryClient.fetchQuery({
          ...visibilityOptions,
          staleTime: 0,
          retry: false,
          networkMode: "always",
          meta: { skipGlobalErrorToast: true },
        });
        return !denied;
      } catch {
        return false;
      }
    },
  };
}

/** Public replay authority polls independently after score polling stops. */
export function useReplayVisibility(slug: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const authority = useMemo(() => createReplayAuthority(queryClient, slug), [queryClient, slug]);
  const unavailable = useSyncExternalStore(
    authority.subscribe,
    authority.isDenied,
    authority.isDenied,
  );
  const { data, error, refetch } = useQuery({
    ...authority.visibilityOptions,
    enabled,
    staleTime: 0,
    retry: false,
    networkMode: "always",
    refetchInterval: 20_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    meta: { skipGlobalErrorToast: true },
  });
  const version = data?.version;
  useEffect(() => {
    if (!enabled || unavailable || version === undefined) return;
    void queryClient.invalidateQueries({ queryKey: authority.replayOptions.queryKey, exact: true });
  }, [enabled, unavailable, version, queryClient, authority]);
  return {
    unavailable: enabled && unavailable,
    replayOptions: authority.replayOptions,
    error,
    retry: () => void refetch(),
    beforeExport: () => (enabled ? authority.beforeExport() : Promise.resolve(false)),
  };
}
