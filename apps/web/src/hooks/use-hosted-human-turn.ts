import { boardAt, type MatchArchive } from "@cockpit-chess/chess";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";
import { useNetworkStatus } from "./use-network-status";
import { useRetryOnReconnect } from "./use-retry-on-reconnect";

type Submission = {
  turnId: string;
  expectedSeq: number;
  phase: "pending" | "acknowledged" | "uncertain" | "rejected";
  refreshed?: boolean;
  error?: unknown;
};

/** Only explicit server refusals prove the move did not commit. Transport/5xx
 * errors can happen after commit (including while waking the worker). */
function refused(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["BAD_REQUEST", "CONFLICT", "TOO_MANY_REQUESTS"].includes(String(error.code));
}

/** Owner Studio input only. The document query cache keeps one lock per owner
 * and match across tab/remounts; the existing identity boundary clears it along
 * with private data. It stores no move to replay. */
export function useHostedHumanTurn({
  ownerId,
  slug,
  match,
  blocked,
}: {
  ownerId: string | undefined;
  slug: string;
  match: MatchArchive | undefined;
  blocked: boolean;
}) {
  const online = useNetworkStatus();
  const queryClient = useQueryClient();
  const inputKey = ["hosted-human-input", ownerId ?? "", slug] as const;
  const { data: entry } = useQuery<Submission>({
    queryKey: inputKey,
    queryFn: skipToken,
    gcTime: Number.POSITIVE_INFINITY,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const move = useMutation({
    ...orpc.chess.move.mutationOptions(),
    retry: false,
    // Never leave a move paused for reconnect. The app's offline policy also
    // refuses offline writes; this surface additionally disables input offline.
    networkMode: "always",
    meta: { skipGlobalErrorToast: true },
  });
  const turn = match?.turn;
  const sameTurn =
    turn?.type === "human" &&
    entry?.turnId === turn.turnId &&
    entry?.expectedSeq === turn.expectedSeq;
  const locked =
    entry?.phase === "pending" || (sameTurn && !(entry.phase === "rejected" && entry.refreshed));
  const accessDenied = isQueryAccessError(entry?.error);
  const humanSide =
    match?.config.white.protocol === "human"
      ? "w"
      : match?.config.black.protocol === "human"
        ? "b"
        : undefined;
  const playable = Boolean(
    match?.source === "hosted" &&
      match.status === "running" &&
      turn?.type === "human" &&
      turn.side === humanSide &&
      turn.expectedSeq === match.events.length &&
      boardAt(match).turn() === humanSide,
  );
  const unavailable =
    !ownerId || blocked || !online || accessDenied || !playable || Boolean(locked);

  async function resync() {
    // Always read the captured slug's exact query, never a mutable selected-game
    // observer. Cancel a pre-action read before fetching the authoritative state.
    // An unchanged read cannot prove a lost write never arrived: uncertain
    // submissions stay locked for that exact turn.
    if (!online || !ownerId || !slug) return;
    const options = orpc.chess.inspect.queryOptions({ input: { slug } });
    try {
      await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
      await queryClient.fetchQuery({
        ...options,
        staleTime: 0,
        meta: { skipGlobalErrorToast: true },
      });
      queryClient.setQueryData<Submission>(inputKey, (current) => {
        if (!current || current.phase === "pending") return current;
        if (isQueryAccessError(current.error))
          return { ...current, phase: "rejected", refreshed: true, error: undefined };
        return current.phase === "rejected" ? { ...current, refreshed: true } : current;
      });
    } catch {
      // The exact inspect query renders the error and keeps cached content on
      // transient failures. Access errors hide private content in Studio.
    }
  }
  useRetryOnReconnect(() => void resync(), !online);

  function submit(input: string) {
    const raw = input.trim().toLowerCase();
    if (
      unavailable ||
      !match ||
      turn?.type !== "human" ||
      Date.now() >= Date.parse(turn.deadline) ||
      !/^(?:[a-h][1-8][a-h][1-8][qrbn]?|resign)$/.test(raw)
    )
      return;
    // The cache write is synchronous: another event or a newly mounted Studio
    // sees the lock before mutateAsync dispatches any HTTP request.
    const previous = queryClient.getQueryData<Submission>(inputKey);
    if (
      previous?.phase === "pending" ||
      (previous?.turnId === turn.turnId &&
        previous.expectedSeq === turn.expectedSeq &&
        !(previous.phase === "rejected" && previous.refreshed))
    )
      return;
    const submission: Submission = {
      turnId: turn.turnId,
      expectedSeq: turn.expectedSeq,
      phase: "pending",
    };
    queryClient.setQueryData(inputKey, submission);
    const settle = (phase: Submission["phase"], error?: unknown) => {
      queryClient.setQueryData<Submission>(inputKey, (current) =>
        current?.turnId === submission.turnId && current.expectedSeq === submission.expectedSeq
          ? { ...current, phase, error }
          : current,
      );
    };
    void move
      .mutateAsync({ slug, move: raw, turnId: turn.turnId, expectedSeq: turn.expectedSeq })
      .then(
        () => settle("acknowledged"),
        (error: unknown) => settle(refused(error) ? "rejected" : "uncertain", error),
      )
      .then(resync);
  }

  return {
    submit,
    resync,
    online,
    humanSide,
    accessDenied,
    playable,
    disabled: unavailable,
    phase: locked ? entry?.phase : undefined,
    error: sameTurn || entry?.phase === "pending" ? entry?.error : undefined,
  };
}
