import { boardAt, createMatch, submitMove } from "@cockpit-chess/chess";
import { CopyField } from "@cockpit-chess/ui/components/copy-field";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ClientOnly } from "@tanstack/react-router";
import {
  ArrowDownRight,
  ArrowRight,
  FlaskConical,
  Radio,
  ShieldCheck,
  Terminal,
  Trophy,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { WideContent } from "@/components/wide-content";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { isQueryAccessError } from "@/lib/query-access-error";
import { sessionHintQueryOptions } from "@/lib/session-hint";
import { orpc } from "@/utils/orpc";
import { endingHeadlineLabel } from "./ending-label";
import { replayRefetch } from "./evaluation";
import { HeroBoard } from "./hero-board";
import { LocalLab } from "./local-lab";
import { MatchReplay } from "./replay";

// Studio reads the Better Auth session; lazy + ClientOnly keeps the auth client
// out of the public landing chunk. The fallback mirrors Studio's pending skeleton.
const Studio = lazy(() => import("./studio").then((module) => ({ default: module.Studio })));
const studioFallback = <Skeleton className="mt-12 h-96" />;
// Admin-only leaderboard curation; lazy for the same reason as Studio (auth client).
const OfficialToggle = lazy(() =>
  import("./official-toggle").then((module) => ({ default: module.OfficialToggle })),
);
export type ArenaTab = "arena" | "leaderboard" | "lab" | "methodology" | "studio";

function demoGame(white: string, black: string, model: string, title: string) {
  const match = createMatch(
    {
      title,
      white: { name: white, model, protocol: "random" },
      black: { name: black, model, protocol: "random" },
      rules: {},
    },
    "demo",
  );
  const chess = boardAt(match);
  for (const move of ["e2e5", "e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"])
    submitMove(match, chess, move);
  return match;
}
export function ArenaPage({
  tab,
  slug,
  onNavigate,
}: {
  tab: ArenaTab;
  slug?: string;
  onNavigate: (tab: ArenaTab, slug?: string) => void;
}) {
  const { t } = useTranslation("chess");
  return (
    <div className="cc-app">
      {tab === "arena" && <Arena slug={slug} onNavigate={onNavigate} />}
      {tab === "leaderboard" && <Leaderboard />}
      {tab === "lab" && (
        <>
          <Intro title={t("lab.title")} description={t("lab.description")} />
          <LocalLab />
          <div className="cc-rule-card mt-8">
            <Terminal size={24} />
            <h2>{t("lab.cliTitle")}</h2>
            <p>{t("lab.cliDescription")}</p>
            <CopyField value={t("lab.cliCommand")} copyLabel={t("lab.cliTitle")} />
          </div>
        </>
      )}
      {tab === "methodology" && <Methodology />}
      {tab === "studio" && (
        <ClientOnly fallback={studioFallback}>
          <Suspense fallback={studioFallback}>
            <Studio onWatch={(game) => onNavigate("arena", game)} />
          </Suspense>
        </ClientOnly>
      )}
    </div>
  );
}
function Intro({ title, description }: { title: string; description: string }) {
  return (
    <div className="cc-page-intro">
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
function Arena({
  slug,
  onNavigate,
}: {
  slug?: string;
  onNavigate: (tab: ArenaTab, slug?: string) => void;
}) {
  const { t } = useTranslation("chess");
  const [demo] = useState(() =>
    demoGame(t("arena.white"), t("arena.black"), t("arena.model"), t("arena.demoTitle")),
  );
  const {
    data: list,
    error: listError,
    isPending,
    isError,
    fetchStatus: listFetchStatus,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    orpc.chess.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor, limit: 9 }),
      initialPageParam: undefined,
      meta: { skipGlobalErrorToast: true },
      getNextPageParam: (page) => page.nextCursor,
      refetchInterval: (query) =>
        query.state.data?.pages.some((page) =>
          page.items.some((game) => game.status === "running" || game.status === "queued"),
        )
          ? 10000
          : 60000,
    }),
  );
  const {
    data: selectedData,
    error: selectedError,
    isPending: pendingGame,
    isError: gameError,
    fetchStatus: gameFetchStatus,
    refetch: retryGame,
  } = useQuery({
    ...orpc.chess.get.queryOptions({ input: { slug: slug ?? "not-selected" } }),
    enabled: Boolean(slug),
    meta: { skipGlobalErrorToast: true },
    // An unknown or unpublished slug stays that way: say so at once instead of retrying.
    retry: (failures, error) => !isQueryAccessError(error) && failures < 3,
    refetchInterval: replayRefetch,
  });
  const online = useNetworkStatus();
  const listPaused = isPending && listFetchStatus === "paused";
  const selected = isQueryAccessError(selectedError) ? undefined : selectedData;
  // Only a probably-signed-in visitor loads the admin toggle (and its auth client).
  const { data: signedInHint } = useQuery(sessionHintQueryOptions());
  const games = isQueryAccessError(listError)
    ? []
    : (list?.pages.flatMap((page) => page.items) ?? []);
  const current = selected?.archive ?? demo;
  const oldRulesGame = selected && !selected.archive ? selected : undefined;
  // Offline, TanStack pauses a first load (`fetchStatus: "paused"`) instead of failing it: say
  // so where the skeleton would sit, with Try again. It loads by itself on reconnect.
  // docs/design-system.md § Offline and network failures
  const gamePaused = pendingGame && gameFetchStatus === "paused";
  const gameRetry = (
    <button className="cc-error" type="button" onClick={() => void retryGame()}>
      {gamePaused || !online ? t("arena.offlineRetry") : t("arena.gameRetry")}
    </button>
  );
  const replay = (
    <>
      {slug && gameError && selected && gameRetry}
      {slug && pendingGame && !gamePaused ? (
        <Skeleton className="h-96" />
      ) : slug && isQueryAccessError(selectedError) ? (
        <div className="cc-empty" role="status">
          <h3>{t("arena.gameNotFound")}</h3>
          <p>{t("arena.gameNotFoundDescription")}</p>
          <button type="button" className="cc-button mt-5" onClick={() => onNavigate("arena")}>
            {t("arena.all")}
          </button>
        </div>
      ) : slug && (gamePaused || !selected) ? (
        gameRetry
      ) : oldRulesGame ? (
        <div className="cc-empty" role="status">
          <h3>{oldRulesGame.title}</h3>
          <p>{t("arena.oldRules")}</p>
          <p>{t("arena.oldRulesDescription")}</p>
          <button type="button" className="cc-button mt-5" onClick={() => onNavigate("arena")}>
            {t("arena.all")}
          </button>
        </div>
      ) : (
        <MatchReplay
          key={selected?.id ?? "demonstration"}
          match={current}
          live={current.status === "running"}
          spectator={selected ? { evaluations: selected.spectatorEvaluations } : undefined}
        />
      )}
      {selected?.source === "hosted" && signedInHint === true && (
        <ClientOnly fallback={null}>
          <Suspense fallback={null}>
            <OfficialToggle slug={selected.slug} official={selected.official} />
          </Suspense>
        </ClientOnly>
      )}
    </>
  );
  return (
    <>
      {!slug && (
        <section className="cc-hero">
          <div>
            <div className="cc-eyebrow">
              <span className="cc-live-dot" />
              {t("hero.eyebrow")}
            </div>
            <h1>{t("hero.title")}</h1>
            <p>{t("hero.description")}</p>
            <div className="cc-hero-actions">
              <a href="#arena-board" className="cc-button">
                {t("hero.watch")}
                <ArrowDownRight size={16} />
              </a>
              <button
                type="button"
                className="cc-button cc-button-secondary"
                onClick={() => onNavigate("lab")}
              >
                <FlaskConical size={15} />
                {t("hero.experiment")}
              </button>
            </div>
            <div className="cc-hero-note">
              <ShieldCheck size={13} />
              {t("hero.note")}
            </div>
          </div>
          <HeroBoard fen={boardAt(demo, 5).fen()} />
        </section>
      )}
      <div className="cc-section-bar" id="arena-board">
        <div>
          <h2>{t("arena.title")}</h2>
          <p>{t("arena.description")}</p>
        </div>
        <span className="cc-pill">
          <Radio size={12} />
          {slug ? t("arena.published") : t("arena.demo")}
        </span>
      </div>
      {/* An open game comes first, right under the section bar, so a deep link or a card click
          shows it at once; the other games follow. Without one, the list leads and the
          demonstration follows. */}
      {slug && replay}
      {(isError || listPaused) && (
        <button className="cc-error" type="button" onClick={() => void refetch()}>
          {listPaused || !online ? t("arena.offlineRetry") : t("arena.retry")}
        </button>
      )}
      {isPending && !listPaused ? (
        <div className="cc-card-grid">
          {[1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-28" />
          ))}
        </div>
      ) : (
        games.length > 0 && (
          <div className="cc-card-grid">
            {games.map((game) => {
              const body = (
                <>
                  <span className="cc-pill">{t(`arena.status.${game.status}`)}</span>
                  <h3>{game.title}</h3>
                  <p>
                    {game.whiteName} <span aria-hidden="true">×</span> {game.blackName}
                  </p>
                  {game.ending && (
                    <p className="cc-card-ending">{endingHeadlineLabel(t, game.ending)}</p>
                  )}
                  <div className="cc-rule-tags mt-4">
                    <span>{t(`context.${game.contextMode}`)}</span>
                    <span>{t(game.official ? "arena.official" : "arena.local")}</span>
                  </div>
                </>
              );
              // An old-rules game has no replay to open: a plain card that says so.
              return game.oldRules ? (
                <article key={game.id} className="cc-game-card cc-game-card-old">
                  {body}
                  <p className="cc-card-old-rules">{t("arena.oldRules")}</p>
                </article>
              ) : (
                <button
                  type="button"
                  key={game.id}
                  className="cc-game-card"
                  aria-current={game.slug === slug ? "true" : undefined}
                  onClick={() => onNavigate("arena", game.slug)}
                >
                  {body}
                </button>
              );
            })}
          </div>
        )
      )}
      <LoadMore
        onLoadMore={() => void fetchNextPage()}
        hasNextPage={!isQueryAccessError(listError) && Boolean(hasNextPage)}
        isFetchingNextPage={isFetchingNextPage}
      />
      {!slug && replay}
      {!slug && (
        <div className="cc-demo-notice">
          <span>{t("arena.demoNote")}</span>
          <button type="button" onClick={() => onNavigate("methodology")}>
            {t("nav.methodology")} <ArrowRight size={12} className="inline" />
          </button>
        </div>
      )}
    </>
  );
}
function Leaderboard() {
  const { t } = useTranslation("chess");
  const { data, error, isPending, isError, fetchStatus, refetch } = useQuery({
    ...orpc.chess.leaderboard.queryOptions({ input: { limit: 100 } }),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <>
      <Intro title={t("leaderboard.title")} description={t("leaderboard.description")} />
      <QueryBoundary
        query={{ data, error, isPending, isError, fetchStatus, refetch }}
        skeleton={<Skeleton className="h-64" />}
        isEmpty={(result) => result.items.length === 0}
        empty={
          <div className="cc-empty">
            <Trophy size={32} className="mx-auto mb-4 opacity-50" />
            <h3>{t("leaderboard.empty")}</h3>
            <p>{t("leaderboard.emptyDescription")}</p>
          </div>
        }
      >
        {(data) => (
          <>
            <WideContent>
              <table className="cc-table">
                <thead>
                  <tr>
                    {[
                      "leaderboard.model",
                      "leaderboard.ruleset",
                      "stats.games",
                      "stats.score",
                      "stats.rejected",
                    ].map((key) => (
                      <th
                        key={key}
                        className={key === "leaderboard.ruleset" ? "cc-lb-rules" : undefined}
                      >
                        {t(key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr key={`${row.model}:${row.protocol}:${row.rulesKey}`}>
                      <td>
                        <strong>{row.model}</strong>
                        <p className="cc-muted">
                          {row.protocol === "openai-chat" ||
                          row.protocol === "openai-responses" ||
                          row.protocol === "anthropic"
                            ? t(`create.protocols.${row.protocol}`)
                            : row.protocol}
                        </p>
                        {/* Phones show the ruleset here instead of in its own column. */}
                        <div className="cc-lb-rules-inline">
                          <RulesetLabel rulesKey={row.rulesKey} moveFormat={row.moveFormat} />
                        </div>
                      </td>
                      <td className="cc-lb-rules">
                        <RulesetLabel rulesKey={row.rulesKey} moveFormat={row.moveFormat} />
                      </td>
                      <td>{row.games}</td>
                      <td>{Math.round((100 * (row.wins + row.draws / 2)) / row.games)}%</td>
                      <td>
                        {row.illegalAttempts}
                        {row.truncatedAttempts > 0 && (
                          <p className="cc-muted">
                            {t("leaderboard.truncated", { count: row.truncatedAttempts })}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </WideContent>
            <p className="cc-muted mt-6">
              {t("leaderboard.note", { limit: data.windowLimit, count: data.sampleSize })}
            </p>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
/**
 * A ruleset is identified by a 16-hex hash of its rules (no name in the data): the
 * first 8 characters on screen, the whole key in the title (on hover) and, for a
 * screen reader, in the text itself.
 */
function RulesetLabel({ rulesKey, moveFormat }: { rulesKey: string; moveFormat: string | null }) {
  const { t } = useTranslation("chess");
  return (
    <>
      <abbr className="cc-lb-key" title={rulesKey}>
        <span aria-hidden="true">{rulesKey.slice(0, 8)}</span>
        <span className="sr-only">{rulesKey}</span>
      </abbr>
      {(moveFormat === "strict" || moveFormat === "lenient") && (
        <p className="cc-muted">{t(`moveFormats.${moveFormat}`)}</p>
      )}
    </>
  );
}
function Methodology() {
  const { t } = useTranslation("chess");
  return (
    <>
      <Intro title={t("methodology.title")} description={t("methodology.intro")} />
      <div className="cc-rules-grid">
        {(["legal", "context", "identity", "budget", "rank", "privacy"] as const).map(
          (key, index) => (
            <article className="cc-rule-card" key={key}>
              <span className="cc-eyebrow">{String(index + 1).padStart(2, "0")}</span>
              <h2>{t(`methodology.${key}Title`)}</h2>
              <p>{t(`methodology.${key}Body`)}</p>
            </article>
          ),
        )}
      </div>
    </>
  );
}
