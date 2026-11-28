import type { AppRouterClient } from "@cockpit-chess/api/routers/index";
import { boardAt, type MatchArchive } from "@cockpit-chess/chess";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";
import { useNetworkStatus } from "./use-network-status";
import { useRetryOnReconnect } from "./use-retry-on-reconnect";

type RunnerState = Awaited<ReturnType<AppRouterClient["chess"]["runnerStatus"]>>;
type CommandInput = Parameters<AppRouterClient["chess"]["stopRunner"]>[0];
type MoveInput = Parameters<AppRouterClient["chess"]["moveRunner"]>[0];
type Command = { kind: "start" | "stop"; input: CommandInput } | { kind: "move"; input: MoveInput };
type Submission = Command & {
  phase: "pending" | "acknowledged" | "uncertain" | "rejected";
  refreshed?: boolean;
  error?: unknown;
};

function refused(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    ["BAD_REQUEST", "CONFLICT", "TOO_MANY_REQUESTS"].includes(String(error.code))
  );
}

/** Browser controls only talk to the protected server. Commands are retained in
 * the identity cache across Studio/card remounts, and only an explicit retry
 * resends an uncertain command with its original ID and exact payload. */
export function useRunnerControls({
  ownerId,
  slug,
  enabled,
  match,
  blocked = false,
}: {
  ownerId: string | undefined;
  slug: string;
  enabled: boolean;
  match?: MatchArchive;
  blocked?: boolean;
}) {
  const online = useNetworkStatus();
  const client = useQueryClient();
  const statusOptions = orpc.chess.runnerStatus.queryOptions({ input: { slug: slug || "none" } });
  const query = useQuery({
    ...statusOptions,
    enabled: enabled && !!ownerId && !!slug && !blocked,
    staleTime: 0,
    meta: { skipGlobalErrorToast: true },
    refetchInterval: 2000,
  });
  const inputKey = ["runner-control", ownerId ?? "", slug] as const;
  const { data: entry } = useQuery<Submission>({
    queryKey: inputKey,
    queryFn: skipToken,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const options = {
    retry: false,
    networkMode: "always" as const,
    meta: { skipGlobalErrorToast: true },
  };
  const start = useMutation({ ...orpc.chess.startRunner.mutationOptions(), ...options });
  const stop = useMutation({ ...orpc.chess.stopRunner.mutationOptions(), ...options });
  const move = useMutation({ ...orpc.chess.moveRunner.mutationOptions(), ...options });
  const accessDenied = isQueryAccessError(query.error) || isQueryAccessError(entry?.error);
  const state = accessDenied ? undefined : query.data;
  const unsettled = entry?.phase === "pending" || entry?.phase === "uncertain";
  const locked =
    unsettled ||
    (entry?.phase === "acknowledged" &&
      (!state || state.revision <= entry.input.expectedRevision)) ||
    (entry?.phase === "rejected" && !entry.refreshed);

  async function resync() {
    if (!online || !ownerId || !slug || blocked) return;
    const inspect = orpc.chess.inspect.queryOptions({ input: { slug } });
    await Promise.all([
      client.cancelQueries({ queryKey: statusOptions.queryKey, exact: true }),
      client.cancelQueries({ queryKey: inspect.queryKey, exact: true }),
    ]);
    await Promise.allSettled([
      client.invalidateQueries({ queryKey: orpc.chess.key() }),
      client.fetchQuery({ ...inspect, staleTime: 0, meta: { skipGlobalErrorToast: true } }),
      client.fetchQuery({ ...statusOptions, staleTime: 0 }).then(() => {
        client.setQueryData<Submission>(inputKey, (current) =>
          current?.phase === "rejected" ||
          (current?.phase === "uncertain" && isQueryAccessError(current.error))
            ? {
                ...current,
                phase: "rejected",
                refreshed: true,
                error: isQueryAccessError(current.error) ? undefined : current.error,
              }
            : current,
        );
      }),
    ]);
  }
  useRetryOnReconnect(() => {
    if (enabled || client.getQueryData(inputKey)) void resync();
  }, !online);

  function dispatch(command: Command) {
    if (!ownerId || !slug || blocked || !online || accessDenied) return;
    // Synchronous lock covers duplicate events and other observers of this game.
    const previous = client.getQueryData<Submission>(inputKey);
    if (previous?.phase === "pending") return;
    const submission: Submission = {
      ...command,
      phase: "pending",
      error: undefined,
      refreshed: undefined,
    };
    client.setQueryData(inputKey, submission);
    const settle = (phase: Submission["phase"], error?: unknown) => {
      client.setQueryData<Submission>(inputKey, (current) =>
        current?.input.commandId === command.input.commandId
          ? { ...current, phase, error }
          : current,
      );
    };
    const request =
      command.kind === "move"
        ? move.mutateAsync(command.input)
        : command.kind === "start"
          ? start.mutateAsync(command.input)
          : stop.mutateAsync(command.input);
    void request
      .then(
        (value) => {
          client.setQueryData<RunnerState>(statusOptions.queryKey, (current) =>
            !current || value.revision >= current.revision ? value : current,
          );
          settle("acknowledged");
        },
        (error: unknown) => settle(refused(error) ? "rejected" : "uncertain", error),
      )
      .then(resync);
  }

  async function control(kind: "start" | "stop") {
    if (!ownerId || !slug || blocked || !online || accessDenied) return;
    const previous = client.getQueryData<Submission>(inputKey);
    if (previous?.phase === "pending" || previous?.phase === "uncertain") return;
    // Card Stop deliberately fetches authority on demand; no machine capabilities
    // or stale card revision may authorize a command. Fetches never retry writes.
    try {
      const fresh = await client.fetchQuery({ ...statusOptions, staleTime: 0 });
      if (
        !["queued", "running"].includes(fresh.status) ||
        (kind === "start" && fresh.state !== "accepted")
      )
        return;
      const current = client.getQueryData<Submission>(inputKey);
      if (
        current?.phase === "pending" ||
        current?.phase === "uncertain" ||
        (current?.phase === "acknowledged" && fresh.revision <= current.input.expectedRevision)
      )
        return;
      dispatch({
        kind,
        input: { slug, commandId: crypto.randomUUID(), expectedRevision: fresh.revision },
      });
    } catch {
      // The exact status query owns its inline error/access-denial state.
    }
  }

  const humanSide =
    match?.config.white.protocol === "human"
      ? "w"
      : match?.config.black.protocol === "human"
        ? "b"
        : undefined;
  const turn = match?.turn;
  const playable = Boolean(
    state?.state === "running" &&
      state.status === "running" &&
      !!state.resumeDeadline &&
      new Date(state.resumeDeadline).getTime() > Date.now() &&
      !!state.lastContactAt &&
      Date.now() - new Date(state.lastContactAt).getTime() < 60_000 &&
      match?.source === "local" &&
      match.status === "running" &&
      turn?.type === "human" &&
      state.turn.type === "human" &&
      turn.turnId === state.turn.turnId &&
      turn.expectedSeq === state.turn.expectedSeq &&
      turn.expectedSeq === match.events.length &&
      turn.side === humanSide &&
      boardAt(match).turn() === humanSide &&
      boardAt(match).fen() === state.fen &&
      match.events.filter((event) => event.type === "attempt" && event.accepted).length ===
        state.acceptedSeq,
  );
  const disabled =
    !ownerId || blocked || !online || accessDenied || query.isError || !playable || !!locked;

  function submit(raw: string) {
    const value = raw.trim().toLowerCase();
    if (
      disabled ||
      !state ||
      turn?.type !== "human" ||
      Date.now() >= Date.parse(turn.deadline) ||
      !/^(?:[a-h][1-8][a-h][1-8][qrbn]?|resign)$/.test(value)
    )
      return;
    const previous = client.getQueryData<Submission>(inputKey);
    if (
      previous?.phase === "pending" ||
      previous?.phase === "uncertain" ||
      (previous?.phase === "acknowledged" && state.revision <= previous.input.expectedRevision)
    )
      return;
    dispatch({
      kind: "move",
      input: {
        slug,
        commandId: crypto.randomUUID(),
        expectedRevision: state.revision,
        expectedSeq: state.acceptedSeq,
        fen: state.fen,
        move: value,
      },
    });
  }

  return {
    state,
    query,
    online,
    accessDenied,
    humanSide,
    playable,
    disabled,
    error: entry?.error,
    phase: locked ? entry?.phase : undefined,
    pending: entry?.phase === "pending",
    uncertain: entry?.phase === "uncertain",
    commandError: entry?.phase === "rejected",
    start: () => void control("start"),
    stop: () => void control("stop"),
    submit,
    resync,
    retry: () => {
      const current = client.getQueryData<Submission>(inputKey);
      if (current?.phase === "uncertain") dispatch(current);
    },
  };
}
