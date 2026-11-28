import { hasRole } from "@cockpit-chess/auth/roles";
import { MAX_ARCHIVE_BYTES, type MatchArchive } from "@cockpit-chess/chess";
import { endingSummary, matchEnding } from "@cockpit-chess/chess/ending";
import type { SpectatorEvaluations } from "@cockpit-chess/chess/spectator";
import { Button } from "@cockpit-chess/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@cockpit-chess/ui/components/dialog";
import { toast } from "@cockpit-chess/ui/components/sileo";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { TextareaField, TextField } from "@cockpit-chess/ui/components/text-field";
import { useForm, useStore } from "@tanstack/react-form";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, Download, Upload } from "lucide-react";
import { useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { InlineRetry } from "@/components/inline-retry";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { useAuthSession } from "@/hooks/use-auth-session";
import { useDocumentAdmits } from "@/hooks/use-document-admits";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { useHostedHumanTurn } from "@/hooks/use-hosted-human-turn";
import { useNow } from "@/hooks/use-now";
import { useRunnerControls } from "@/hooks/use-runner-controls";
import { fileDropTargetRef } from "@/lib/file-drop-registry";
import { networkFailureKind } from "@/lib/network-failure";
import { openRouterMoney } from "@/lib/openrouter-connect";
import { isQueryAccessError } from "@/lib/query-access-error";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { formatClock, liveClock } from "./clock";
import { CreateMatchDialog } from "./create-match-dialog";
import { keyExhausted } from "./create-match-form";
import { endingHeadlineLabel } from "./ending-label";
import { replayRefetch } from "./evaluation";
import { GameBoard } from "./game-board";
import {
  checkArchiveFile,
  formatFileSize,
  IMPORT_INITIAL,
  importReducer,
  landLatest,
  pasteToggle,
  readThenClear,
} from "./import-archive";
import { MatchReplay } from "./replay";
import { drawShareCard, lastIllegalSquares, SHARE_HEIGHT, SHARE_WIDTH } from "./share-card";

export function Studio({ onWatch }: { onWatch: (slug: string) => void }) {
  const { t, i18n } = useTranslation("chess");
  const { state } = useAuthSession();
  // No session guard covers this public tab: the account's data shows (and
  // loads) only once the document has recorded this account as its own
  // (docs/auth-and-routing.md § Query cache follows identity).
  const admitted = useDocumentAdmits(
    state.status === "authenticated" ? state.session.user.id : undefined,
  );
  const signedIn = state.status === "authenticated" && admitted;
  const admin = signedIn && hasRole(state.session.user.role ?? "", "admin");
  const { data: info, isPending: infoPending } = useQuery(orpc.chess.info.queryOptions());
  // Users run matches on their own OpenRouter key when the operator allows it.
  const userMatches = Boolean(info?.userMatchesEnabled);
  // A signed-in owner always reaches their own matches (replay, stop, unpublish), even
  // after the operator stops user matches; only creating follows the switch.
  const studio = signedIn;
  const [selected, setSelected] = useState("");
  const {
    data,
    error,
    isPending,
    isError,
    fetchStatus,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    ...orpc.chess.studio.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: 12, cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor,
    }),
    enabled: studio,
    meta: { skipGlobalErrorToast: true },
    refetchInterval: (query) =>
      studio &&
      query.state.data?.pages.some((page) =>
        page.items.some((game) => game.status === "running" || game.status === "queued"),
      )
        ? 5000
        : false,
  });
  const {
    data: keyStatus,
    isPending: keyPending,
    isError: keyError,
    refetch: retryKey,
  } = useQuery({
    ...orpc.openrouter.status.queryOptions(),
    enabled: studio,
    meta: { skipGlobalErrorToast: true },
  });
  const ownKey = keyStatus?.connected && keyStatus.status === "active" ? keyStatus : null;
  const ownRemaining = ownKey
    ? ownKey.limitMicros === null
      ? null
      : (ownKey.limitRemainingMicros ?? ownKey.limitMicros)
    : null;
  const {
    data: detailData,
    error: detailFailure,
    isPending: detailPending,
    isError: detailError,
  } = useQuery({
    ...orpc.chess.inspect.queryOptions({ input: { slug: selected || "not-selected" } }),
    enabled: studio && Boolean(selected),
    meta: { skipGlobalErrorToast: true },
    refetchInterval: replayRefetch,
  });
  const humanTurn = useHostedHumanTurn({
    ownerId: signedIn ? state.session.user.id : undefined,
    slug: selected,
    match: detailData?.archive,
    blocked: !studio || detailError,
  });
  const runner = detailData?.credentialSource === "runner-local";
  const runnerControls = useRunnerControls({
    ownerId: signedIn ? state.session.user.id : undefined,
    slug: selected,
    enabled: studio && runner,
    match: runner ? detailData?.archive : undefined,
    blocked: !studio,
  });
  const playControls = runner
    ? { ...runnerControls, disabled: runnerControls.disabled || detailError }
    : humanTurn;
  const detail =
    isQueryAccessError(detailFailure) ||
    humanTurn.accessDenied ||
    (runner && runnerControls.accessDenied)
      ? undefined
      : detailData;
  const publish = useEntityMutation(orpc.chess.publish.mutationOptions(), {
    invalidateKey: orpc.chess.key(),
    successMessage: t("studio.success"),
  });
  const stop = useEntityMutation(orpc.chess.stop.mutationOptions(), {
    invalidateKey: orpc.chess.key(),
  });
  if (
    state.status === "pending" ||
    (state.status === "authenticated" && !admitted) ||
    (signedIn && infoPending)
  )
    return <Skeleton className="mt-12 h-96" />;
  const settingsLink = (label: string) => (
    <Link
      className="cc-button mt-5"
      to="/$lang/settings/openrouter"
      params={{ lang: i18n.language }}
    >
      {label}
    </Link>
  );
  // What the create area shows: the form, or the one step that unlocks it.
  const createArea = admin ? (
    <>
      {!info?.hostedEnabled && <p className="cc-muted mb-6">{t("studio.disabled")}</p>}
      <div className="cc-hero-actions mb-8">
        <CreateMatchDialog
          disabled={!info?.hostedEnabled}
          limits={info?.limits}
          billingOptions={ownKey ? ["operator", "openrouter"] : ["operator"]}
          ownKeyRemainingMicros={ownRemaining}
          onCreated={setSelected}
        />
        <ImportDialog onImported={setSelected} />
      </div>
    </>
  ) : !userMatches ? (
    <div className="cc-empty mb-8">
      <p>{t("studio.userMatchesOff")}</p>
    </div>
  ) : keyPending ? (
    <Skeleton className="mb-8 h-32" />
  ) : keyError ? (
    <InlineRetry onRetry={() => void retryKey()} message={t("studio.statusLoadFailed")} />
  ) : !keyStatus?.connected ? (
    <div className="cc-empty mb-8">
      <h3>{t("studio.connectTitle")}</h3>
      <p>{t("studio.connectBody")}</p>
      {settingsLink(t("studio.connectAction"))}
    </div>
  ) : !ownKey ? (
    <div className="cc-empty mb-8">
      <h3>{t("studio.reconnectTitle")}</h3>
      <p>
        {t(
          keyStatus.invalidReason === "unreadable"
            ? "studio.unreadableBody"
            : "studio.reconnectBody",
        )}
      </p>
      {settingsLink(t("studio.connectAction"))}
    </div>
  ) : (
    <div className="mb-8">
      <p className="cc-muted mb-2">
        {ownRemaining === null
          ? t("studio.billedToUnlimited")
          : t("studio.billedTo", { remaining: openRouterMoney(i18n.language, ownRemaining) })}
      </p>
      <p className="cc-muted mb-4">{t("studio.rules", { count: info?.dailyLimit ?? 1 })}</p>
      {keyExhausted(ownRemaining) && (
        <p className="cc-error mb-4" role="alert">
          {t("create.keyExhausted", {
            remaining: openRouterMoney(i18n.language, ownRemaining ?? 0),
          })}
        </p>
      )}
      <div className="cc-hero-actions">
        <CreateMatchDialog
          disabled={!userMatches || keyExhausted(ownRemaining)}
          limits={info?.limits}
          billingOptions={["openrouter"]}
          ownKeyRemainingMicros={ownRemaining}
          onCreated={setSelected}
        />
      </div>
    </div>
  );
  return (
    <>
      <div className="cc-page-intro">
        <h1>{t("studio.title")}</h1>
        <p>{t(admin || !studio || !userMatches ? "studio.description" : "studio.userIntro")}</p>
      </div>
      {!studio ? (
        <div className="cc-empty">
          <p>{t(userMatches ? "studio.signInUser" : "studio.signIn")}</p>
          <Link
            className="cc-button mt-5"
            to="/$lang/login"
            params={{ lang: i18n.language }}
            search={{ redirectTo: `/${i18n.language}/?tab=studio` }}
          >
            {t("studio.signInAction")}
          </Link>
        </div>
      ) : (
        <>
          {createArea}
          <section className="mb-8 rounded-md border p-4" aria-label={t("runner.createTitle")}>
            <h2>{t("runner.createTitle")}</h2>
            <p className="cc-muted my-3">{t("runner.createHelp")}</p>
            <div className="cc-hero-actions">
              <CreateMatchDialog runner disabled={false} onCreated={setSelected} />
              <Link className="cc-button" to="/$lang/settings/cli" params={{ lang: i18n.language }}>
                {t("runner.machines")}
              </Link>
            </div>
          </section>
          {/* The previewed game (also where Create and Import land) comes first, so choosing
              one shows it at once; the list follows. */}
          {selected && (detailError || playControls.accessDenied) && (
            <InlineRetry onRetry={() => void playControls.resync()} message={t("studio.error")} />
          )}
          {selected && detailPending && <Skeleton className="h-96" />}
          {selected && detail && (
            <>
              <div className="cc-section-bar">
                <h2>{t("studio.preview")}</h2>
                <ShareCard
                  match={detail.archive}
                  slug={selected}
                  published={detail.published && !detail.hiddenAt}
                  spectator={detail.spectatorEvaluations}
                />
              </div>
              {detail.moderationReason && (
                <section className="mb-4 rounded-md border border-destructive/30 p-4" role="status">
                  <h3 className="font-semibold">
                    {t(detail.hiddenAt ? "moderation.ownerTitle" : "moderation.ownerRestoredTitle")}
                  </h3>
                  <p className="mt-2 text-sm">
                    {t(
                      detail.hiddenAt
                        ? "moderation.ownerExplanation"
                        : "moderation.ownerRestoredExplanation",
                    )}
                  </p>
                  {detail.moderationReason && (
                    <p className="mt-2 text-sm font-medium">
                      {t(`moderation.reasons.${detail.moderationReason}`)}
                    </p>
                  )}
                  {detail.moderationNote && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                      {detail.moderationNote}
                    </p>
                  )}
                  {detail.hiddenAt && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {new Date(detail.hiddenAt).toLocaleString(i18n.language)}
                    </p>
                  )}
                  {Boolean(detail.ModerationActions?.length) && (
                    <details className="mt-3">
                      <summary className="flex min-h-11 cursor-pointer items-center text-sm">
                        {t("moderation.audit")}
                      </summary>
                      <p className="text-xs text-muted-foreground">
                        {t("moderation.ownerHistoryBound")}
                      </p>
                      <ol className="mt-2 divide-y">
                        {detail.ModerationActions.map((action) => (
                          <li key={action.id} className="py-2 text-sm">
                            <p>
                              {t(action.hidden ? "moderation.hidden" : "moderation.restored")} ·{" "}
                              {t(`moderation.reasons.${action.reason}`)} ·{" "}
                              {new Date(action.createdAt).toLocaleString(i18n.language)}
                            </p>
                            <p className="whitespace-pre-wrap break-words">{action.note}</p>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </section>
              )}
              {detail.queuePosition !== null && (
                <p className="cc-muted mb-4" role="status">
                  {t("studio.queuePosition", { position: detail.queuePosition })}
                </p>
              )}
              {(detail.archive.termination === "account-limit" ||
                detail.archive.termination === "credential-revoked") && (
                <p className="cc-error mb-4" role="status">
                  {t(`endingHelp.${detail.archive.termination}`)}{" "}
                  <Link to="/$lang/settings/openrouter" params={{ lang: i18n.language }}>
                    {t(
                      detail.archive.termination === "account-limit"
                        ? "studio.openSettings"
                        : "studio.connectAction",
                    )}
                  </Link>
                </p>
              )}
              {runner && <RunnerMatchPanel controls={runnerControls} />}
              {(detail.archive.source === "hosted" || runner) && playControls.humanSide && (
                <HostedHumanPlay
                  key={`play:${detail.archive.id}`}
                  match={detail.archive}
                  controls={playControls}
                  queued={detail.status === "queued"}
                  stale={detailError}
                  stopPending={
                    runner ? runnerControls.pending || runnerControls.uncertain : stop.isPending
                  }
                  onStop={runner ? runnerControls.stop : () => stop.mutate({ slug: selected })}
                />
              )}
              <MatchReplay
                key={`replay:${detail.archive.id}`}
                match={detail.archive}
                executionSource={runner ? "runner" : detail.archive.source}
                live={detail.archive.status === "running"}
                spectator={{ evaluations: detail.spectatorEvaluations }}
              />
            </>
          )}
          <p className="cc-muted my-4">{t("studio.publicationHint")}</p>
          <QueryBoundary
            query={{ data, error, isPending, isError, fetchStatus, refetch }}
            skeleton={<Skeleton className="h-32" />}
            isEmpty={(result) => !result.pages.some((page) => page.items.length)}
            empty={
              <div className="cc-empty">
                <h3>{t("studio.empty")}</h3>
              </div>
            }
          >
            {(data) => (
              <div className="cc-card-grid">
                {data.pages
                  .flatMap((page) => page.items)
                  .map((game) => (
                    <article
                      className="cc-game-card"
                      key={game.id}
                      aria-current={game.slug === selected ? "true" : undefined}
                    >
                      <span className="cc-pill">
                        {game.published
                          ? t(`arena.status.${game.status}`)
                          : game.status === "queued"
                            ? `${t("arena.status.queued")} · ${t("arena.unpublished")}`
                            : t("arena.unpublished")}
                      </span>
                      <p className="cc-muted">
                        {t(
                          game.source === "runner"
                            ? "runner.selfRun"
                            : game.official
                              ? "studio.officialRecord"
                              : "studio.practiceRecord",
                        )}
                      </p>
                      <h3>{game.title}</h3>
                      <p>
                        {game.whiteName} × {game.blackName}
                      </p>
                      {game.ending && (
                        <p className="cc-card-ending">{endingHeadlineLabel(t, game.ending)}</p>
                      )}
                      {game.oldRules && <p className="cc-card-old-rules">{t("arena.oldRules")}</p>}
                      {game.oldRules && game.moderationReason && (
                        <details className="mt-3 rounded-md border border-destructive/30 p-3">
                          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">
                            {t(
                              game.hiddenAt
                                ? "moderation.ownerTitle"
                                : "moderation.ownerRestoredTitle",
                            )}
                          </summary>
                          <p className="mt-2 text-sm font-medium">
                            {t(`moderation.reasons.${game.moderationReason}`)}
                          </p>
                          {game.moderationNote && (
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                              {game.moderationNote}
                            </p>
                          )}
                          {Boolean(game.ModerationActions?.length) && (
                            <>
                              <h4 className="mt-3 text-sm font-medium">{t("moderation.audit")}</h4>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {t("moderation.ownerHistoryBound")}
                              </p>
                              <ol className="mt-2 divide-y">
                                {game.ModerationActions.map((action) => (
                                  <li key={action.id} className="py-2 text-sm">
                                    <p>
                                      {t(
                                        action.hidden ? "moderation.hidden" : "moderation.restored",
                                      )}{" "}
                                      · {t(`moderation.reasons.${action.reason}`)} ·{" "}
                                      {new Date(action.createdAt).toLocaleString(i18n.language)}
                                    </p>
                                    <p className="whitespace-pre-wrap break-words">{action.note}</p>
                                  </li>
                                ))}
                              </ol>
                            </>
                          )}
                        </details>
                      )}
                      <div className="cc-export-row">
                        {!game.oldRules && (
                          <button type="button" onClick={() => setSelected(game.slug)}>
                            {t("studio.preview")}
                          </button>
                        )}
                        {(game.published || game.status !== "queued") && (
                          <button
                            type="button"
                            disabled={publish.isPending}
                            onClick={() =>
                              publish.mutate({ slug: game.slug, published: !game.published })
                            }
                          >
                            {t(game.published ? "studio.unpublish" : "studio.publish")}
                          </button>
                        )}
                        {["running", "queued"].includes(game.status) &&
                          (game.source === "runner" ? (
                            <RunnerCardStop slug={game.slug} ownerId={state.session.user.id} />
                          ) : (
                            <button
                              type="button"
                              disabled={stop.isPending}
                              onClick={() => stop.mutate({ slug: game.slug })}
                            >
                              {t("studio.stop")}
                            </button>
                          ))}
                        {game.published && !game.hiddenAt && !game.oldRules && (
                          <button type="button" onClick={() => onWatch(game.slug)}>
                            {t("studio.view")}
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
              </div>
            )}
          </QueryBoundary>
          <LoadMore
            onLoadMore={() => void fetchNextPage()}
            hasNextPage={!isQueryAccessError(error) && Boolean(hasNextPage)}
            isFetchingNextPage={isFetchingNextPage}
          />
          {(publish.isError || stop.isError) && (
            <p role="alert" className="cc-error">
              {t("studio.error")}
            </p>
          )}
        </>
      )}
    </>
  );
}

function RunnerCardStop({ slug, ownerId }: { slug: string; ownerId: string }) {
  const { t } = useTranslation("chess");
  const controls = useRunnerControls({ ownerId, slug, enabled: false });
  if (controls.accessDenied) return <p role="alert">{t("runner.denied")}</p>;
  return (
    <>
      <button
        type="button"
        disabled={!controls.online || controls.pending || controls.uncertain}
        onClick={controls.stop}
      >
        {t("studio.stop")}
      </button>
      {controls.uncertain && (
        <button type="button" disabled={!controls.online} onClick={controls.retry}>
          {t("runner.retryCommand")}
        </button>
      )}
      {(controls.commandError || controls.query.isError) && (
        <InlineRetry onRetry={() => void controls.resync()} message={t("runner.controlError")} />
      )}
    </>
  );
}

function RunnerMatchPanel({ controls }: { controls: ReturnType<typeof useRunnerControls> }) {
  const { t, i18n } = useTranslation("chess");
  const now = useNow(true);
  const state = controls.state;
  const active = state && ["queued", "running"].includes(state.status);
  const contact = state?.lastContactAt ? new Date(state.lastContactAt).getTime() : 0;
  const grace = state?.resumeDeadline ? new Date(state.resumeDeadline).getTime() : null;
  const waiting = Boolean(active && state.state !== "offered" && now - contact > 60_000);
  return (
    <section className="mb-6 rounded-md border p-4 space-y-3" aria-label={t("runner.controls")}>
      <p className="cc-pill">{t("runner.selfRun")}</p>
      <p className="cc-muted">{t("runner.localPayer")}</p>
      {controls.query.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : controls.query.isError ? (
        <InlineRetry onRetry={() => void controls.resync()} message={t("runner.controlError")} />
      ) : null}
      {state && (
        <>
          <p role="status" aria-live="polite">
            {t(
              !controls.online
                ? "runner.browserOffline"
                : waiting
                  ? "runner.grace"
                  : `runner.states.${state.state}`,
              {
                remaining: grace === null ? "" : formatClock(Math.max(0, grace - now)),
              },
            )}
          </p>
          {state.state === "declined" && <p>{t("runner.declinedHelp")}</p>}
          {waiting && <p className="cc-muted">{t("runner.clocksContinue")}</p>}
          <div className="cc-hero-actions">
            {active && state.state === "accepted" && (
              <Button
                type="button"
                className="min-h-11"
                onClick={controls.start}
                disabled={
                  !controls.online ||
                  controls.pending ||
                  controls.uncertain ||
                  controls.query.isError ||
                  waiting
                }
              >
                {t("runner.start")}
              </Button>
            )}
            {active && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={controls.stop}
                disabled={!controls.online || controls.pending || controls.uncertain}
              >
                {t("studio.stop")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => void controls.resync()}
            >
              {t("human.resync")}
            </Button>
            {controls.uncertain && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={controls.retry}
                disabled={!controls.online}
              >
                {t("runner.retryCommand")}
              </Button>
            )}
            <Link className="cc-button" to="/$lang/settings/cli" params={{ lang: i18n.language }}>
              {t("runner.machines")}
            </Link>
          </div>
        </>
      )}
      {controls.pending && <p role="status">{t("runner.sending")}</p>}
      {controls.uncertain && <p role="status">{t("runner.uncertain")}</p>}
      {controls.commandError && <p role="alert">{t("runner.controlError")}</p>}
    </section>
  );
}
/** One owner-only play surface; public replay remains read-only. */
function HostedHumanPlay({
  match,
  controls,
  queued,
  stale,
  stopPending,
  onStop,
}: {
  match: MatchArchive;
  controls: ReturnType<typeof useHostedHumanTurn>;
  queued: boolean;
  stale: boolean;
  stopPending: boolean;
  onStop: () => void;
}) {
  const { t, i18n } = useTranslation("chess");
  const running = match.status === "running";
  const now = useNow(running);
  const turn = match.turn;
  const expired = turn.type !== "idle" && now >= Date.parse(turn.deadline);
  const disabled = controls.disabled || expired || stopPending;
  const status = !running
    ? "finished"
    : !controls.online
      ? "offline"
      : stale
        ? "stale"
        : controls.phase === "uncertain"
          ? "uncertain"
          : controls.phase === "pending"
            ? "sending"
            : controls.phase === "acknowledged"
              ? "acknowledged"
              : expired
                ? "expired"
                : queued
                  ? "queued"
                  : turn.type === "human" && controls.disabled
                    ? "stale"
                    : controls.playable
                      ? "yourTurn"
                      : "modelTurn";
  return (
    <section className="cc-baseline-layout mb-8" aria-label={t("human.playTitle")}>
      <div className="cc-board-panel">
        <div className="cc-player">
          <strong>{match.config[controls.humanSide === "b" ? "white" : "black"].name}</strong>
        </div>
        <GameBoard
          match={match}
          onMove={(move) => {
            if (!disabled) controls.submit(move);
          }}
          disabled={disabled}
          flipped={controls.humanSide === "b"}
          lookups
        />
        <div className="cc-player">
          <strong>{t("human.you")}</strong>
          <span>{t(`colors.${controls.humanSide ?? "w"}`)}</span>
        </div>
      </div>
      <div className="cc-lab-instructions min-w-0">
        <p className="cc-pill">{t("human.practice")}</p>
        <h3 className="mt-4">{t("human.playTitle")}</h3>
        <p role="status" aria-live="polite">
          {t(`human.${status}`)}
        </p>
        {running && turn.type !== "idle" && (
          <p className="cc-muted" role="timer" aria-live="off">
            {t("human.deadline", {
              side: t(`colors.${turn.side}`),
              time: new Date(turn.deadline).toLocaleTimeString(i18n.language),
              remaining: formatClock(Math.max(0, Date.parse(turn.deadline) - now)),
            })}
          </p>
        )}
        {match.config.rules.clock && (
          <p className="cc-muted" role="timer" aria-live="off">
            {(["w", "b"] as const)
              .map(
                (side) =>
                  `${t(`colors.${side}`)} ${formatClock(liveClock(match, side, turn.type === "idle" ? "w" : turn.side, now) ?? 0)}`,
              )
              .join(" · ")}
          </p>
        )}
        <p className="cc-field-hint">{t("human.inputHelp")}</p>
        <HostedMoveInput
          key={turn.type === "idle" ? match.events.length : turn.turnId}
          disabled={disabled}
          onSubmit={controls.submit}
        />
        {Boolean(controls.error) && (
          <p className="cc-error" role="alert">
            {t(controls.phase === "uncertain" ? "human.uncertain" : "human.rejected")}
          </p>
        )}
        <div className="cc-hero-actions mt-4">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void controls.resync()}
          >
            {t("human.resync")}
          </Button>
          {running && (
            <>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={disabled}
                onClick={() => controls.submit("resign")}
              >
                {t("human.resign")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={stopPending || !controls.online}
                onClick={onStop}
              >
                {t("studio.stop")}
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
function HostedMoveInput({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (move: string) => void;
}) {
  const { t } = useTranslation("chess");
  const form = useForm({
    defaultValues: { move: "" },
    onSubmit: ({ value }) => {
      if (!disabled) onSubmit(value.move);
    },
  });
  const text = useStore(form.store, (state) => state.values.move);
  const validMove = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(text.trim().toLowerCase());
  return (
    <form
      noValidate
      className="cc-form-grid"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="move">
        {(field) => (
          <TextField
            field={field}
            label={t("human.moveLabel")}
            description={t("human.moveHint")}
            autoComplete="off"
            inputMode="text"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={5}
            disabled={disabled}
          />
        )}
      </form.Field>
      <Button type="submit" className="min-h-11" disabled={disabled || !validMove}>
        {t("human.send")}
      </Button>
    </form>
  );
}

function ImportDialog({ onImported }: { onImported: (slug: string) => void }) {
  const { t, i18n } = useTranslation("chess");
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(importReducer, IMPORT_INITIAL);
  // Read generations: a read that finishes after a newer choice, a paste or a close is ignored.
  const reads = useRef(0);
  const mutation = useEntityMutation(
    orpc.chess.importGame.mutationOptions({
      // The dialog shows the failure inline, beside the archive; a toast would repeat it.
      meta: { skipGlobalErrorToast: true },
      onSuccess: (result) => {
        setOpen(false);
        // The next import starts fresh (reset otherwise runs only on a user close).
        reads.current += 1;
        dispatch({ type: "reset", generation: reads.current });
        form.reset();
        toast.message(t(result.duplicate ? "studio.duplicate" : "studio.imported"));
        onImported(result.slug);
      },
    }),
    { invalidateKey: orpc.chess.key() },
  );
  const form = useForm({
    defaultValues: { json: "" },
    onSubmit: ({ value }) => mutation.mutate(value),
  });
  const json = useStore(form.store, (current) => current.values.json);
  const busy = mutation.isPending;
  const reset = () => {
    reads.current += 1;
    dispatch({ type: "reset", generation: reads.current });
    mutation.reset();
    form.reset();
  };
  async function readFile(file: File | undefined) {
    // While an import is in flight the choice is locked: resetting would drop its pending guard.
    if (!file || busy) return;
    mutation.reset();
    form.resetField("json");
    await landLatest(
      reads,
      () => checkArchiveFile(file),
      (check, generation) => {
        dispatch({ type: "read-done", generation, check });
        form.setFieldValue("json", check.kind === "ok" ? check.json : "");
      },
      (generation) =>
        dispatch({ type: "read-start", generation, name: file.name, size: file.size }),
    );
  }
  const problem = state.problem
    ? t(
        state.problem === "too-large"
          ? "lab.importTooLarge"
          : state.problem === "running"
            ? "studio.importRunning"
            : state.problem === "unsupported"
              ? "arena.oldRulesDescription"
              : "lab.importError",
      )
    : "";
  const chosen = state.chosen;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (mutation.isPending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button className="cc-button cc-button-secondary">
            <Upload size={15} />
            {t("studio.import")}
          </Button>
        }
      />
      <DialogContent className="cc-dialog-content cc-import-dialog sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("studio.archiveTitle")}</DialogTitle>
          <DialogDescription>{t("studio.importDescription")}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
          className="cc-form-grid"
        >
          <div className="cc-import-pick">
            <label
              className="cc-file-drop"
              data-disabled={busy || undefined}
              ref={fileDropTargetRef((files) => void readFile(files[0]))}
            >
              <Upload size={18} aria-hidden="true" />
              <span className="cc-file-drop-text">
                <strong>{t(chosen ? "studio.importChooseAnother" : "studio.importChoose")}</strong>
                <span>{t("studio.importDrop")}</span>
              </span>
              <input
                className="sr-only"
                type="file"
                accept=".json,application/json"
                disabled={busy}
                aria-describedby="cc-import-status"
                onChange={(event) => void readThenClear(event.currentTarget, readFile)}
              />
            </label>
            <div id="cc-import-status" aria-live="polite">
              {chosen && (
                <div className="cc-import-preview">
                  <p className="cc-import-file">
                    {chosen.name} · {formatFileSize(chosen.size, i18n.language)}
                  </p>
                  {chosen.game && !problem && (
                    <>
                      <strong>{chosen.game.config.title}</strong>
                      <p>
                        {chosen.game.config.white.name} × {chosen.game.config.black.name}
                      </p>
                      <p>
                        {endingHeadlineLabel(t, endingSummary(matchEnding(chosen.game)))} ·{" "}
                        {chosen.game.result}
                      </p>
                      <p className="cc-field-hint">{t("studio.importNext")}</p>
                    </>
                  )}
                </div>
              )}
              {problem && (
                <p role="alert" className="cc-error">
                  {problem}
                </p>
              )}
            </div>
          </div>
          <details
            className="cc-settings-section"
            open={state.pasteOpen}
            onToggle={(event) => {
              const next = event.currentTarget.open;
              // Paste and file are alternatives: opening the box drops a chosen file (and its
              // JSON); text pasted earlier stays.
              const effect = pasteToggle(state, next, busy);
              if (!effect.apply) return;
              reads.current += 1;
              dispatch({ type: "paste", open: next, generation: reads.current });
              if (effect.clearJson) {
                mutation.reset();
                form.resetField("json");
              }
            }}
          >
            <summary
              onClick={(event) => {
                // Locked while an import is in flight, like the file button.
                if (busy) event.preventDefault();
              }}
            >
              <span className="cc-section-text">
                <strong>{t("studio.importPaste")}</strong>
                <span>{t("studio.importPasteHint")}</span>
              </span>
              <ChevronDown aria-hidden="true" size={16} className="cc-section-chevron" />
            </summary>
            {/* Mounted only while open: a closed box's textarea would still have a layout box
                (the dialog-fits check measures it). The JSON stays in the form either way. */}
            {state.pasteOpen && (
              <div className="cc-section-body">
                <form.Field
                  name="json"
                  validators={{
                    // Empty is not an error (Import stays disabled); too large is.
                    onChange: ({ value }) =>
                      value.length > MAX_ARCHIVE_BYTES ? t("lab.importTooLarge") : undefined,
                  }}
                >
                  {(field) => (
                    <TextareaField
                      field={field}
                      autoComplete="off"
                      label={t("studio.jsonLabel")}
                      rows={8}
                      disabled={busy}
                      className="cc-import-json"
                    />
                  )}
                </form.Field>
              </div>
            )}
          </details>
          {mutation.isError && (
            <p role="alert" className="cc-error">
              {/* Offline the import fails at once (the offline mutation policy, router.tsx)
                  and says so instead of blaming the file. */}
              {networkFailureKind(mutation.error) ? friendly(mutation.error) : t("lab.importError")}
            </p>
          )}
          <DialogFooter className="cc-import-footer">
            <DialogClose render={<Button variant="ghost" className="min-h-11" />}>
              {t("create.cancel")}
            </DialogClose>
            <Button
              className="cc-button"
              type="submit"
              disabled={busy || !json || json.length > MAX_ARCHIVE_BYTES}
            >
              {t(mutation.isPending ? "studio.pending" : "studio.importSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function ShareCard({
  match,
  slug,
  published,
  spectator,
}: {
  match: MatchArchive;
  slug: string;
  published: boolean;
  spectator: SpectatorEvaluations | null;
}) {
  const { t } = useTranslation("chess");
  const hasIllegal = useMemo(() => lastIllegalSquares(match).length > 0, [match]);
  const [outlineIllegal, setOutlineIllegal] = useState(false);
  function download() {
    const canvas = document.createElement("canvas");
    canvas.width = SHARE_WIDTH;
    canvas.height = SHARE_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const replayUrl = new URL(window.location.href);
    replayUrl.search = new URLSearchParams({ game: slug }).toString();
    replayUrl.hash = "";
    drawShareCard(ctx, match, t, published ? replayUrl.toString() : null, spectator, {
      illegal: hasIllegal && outlineIllegal,
    });
    const anchor = document.createElement("a");
    anchor.download = `cockpit-${match.id}.png`;
    anchor.href = canvas.toDataURL("image/png");
    anchor.click();
  }
  return (
    <div className="cc-share-actions">
      {hasIllegal && (
        <label className="cc-check">
          <input
            type="checkbox"
            checked={outlineIllegal}
            onChange={(event) => setOutlineIllegal(event.currentTarget.checked)}
          />
          {t("studio.shareIllegal")}
        </label>
      )}
      <button className="cc-button cc-button-secondary" type="button" onClick={download}>
        <Download size={15} />
        {t("studio.shareDownload")}
      </button>
    </div>
  );
}
