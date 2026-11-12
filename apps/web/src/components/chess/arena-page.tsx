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
import { ConsentPreferencesButton } from "@/components/consent/consent-preferences-button";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { WideContent } from "@/components/wide-content";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";
import { ChessBoard } from "./chess-board";
import { LocalLab } from "./local-lab";
import { MatchReplay } from "./replay";

// Studio reads the Better Auth session; lazy + ClientOnly keeps the auth client
// out of the public landing chunk. The fallback mirrors Studio's pending skeleton.
const Studio = lazy(() => import("./studio").then((module) => ({ default: module.Studio })));
const studioFallback = <Skeleton className="mt-12 h-96 bg-white/5" />;
export type ArenaTab = "arena" | "leaderboard" | "lab" | "methodology" | "studio";

function demoGame(white: string, black: string, model: string, title: string) {
  const match = createMatch(
    {
      title,
      white: { name: white, model, protocol: "random" },
      black: { name: black, model, protocol: "random" },
      rules: { maxPlies: 20 },
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
      <footer className="cc-footer">
        <div>
          <p>{t("footer")}</p>
          <p>{t("aiDisclosure")}</p>
        </div>
        <ConsentPreferencesButton />
      </footer>
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
    refetch: retryGame,
  } = useQuery({
    ...orpc.chess.get.queryOptions({ input: { slug: slug ?? "not-selected" } }),
    enabled: Boolean(slug),
    meta: { skipGlobalErrorToast: true },
    refetchInterval: (query) => (query.state.data?.archive.status === "running" ? 2000 : false),
  });
  const selected = isQueryAccessError(selectedError) ? undefined : selectedData;
  const games = isQueryAccessError(listError)
    ? []
    : (list?.pages.flatMap((page) => page.items) ?? []);
  const current = selected?.archive ?? demo;
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
          <div className="cc-hero-board">
            <ChessBoard fen={boardAt(demo, 5).fen()} />
            <div className="cc-hero-sticker">{t("hero.live")}</div>
          </div>
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
      {isError && (
        <button className="cc-error" type="button" onClick={() => void refetch()}>
          {t("arena.retry")}
        </button>
      )}
      {isPending ? (
        <div className="cc-card-grid">
          {[1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-28 bg-white/5" />
          ))}
        </div>
      ) : (
        games.length > 0 && (
          <div className="cc-card-grid">
            {games.map((game) => (
              <button
                type="button"
                key={game.id}
                className="cc-game-card"
                onClick={() => onNavigate("arena", game.slug)}
              >
                <span className="cc-pill">{t(`arena.status.${game.status}`)}</span>
                <h3>{game.title}</h3>
                <p>
                  {game.whiteName} <span aria-hidden="true">×</span> {game.blackName}
                </p>
                <div className="cc-rule-tags mt-4">
                  <span>{t(`context.${game.contextMode}`)}</span>
                  <span>{t(game.official ? "arena.official" : "arena.local")}</span>
                </div>
              </button>
            ))}
          </div>
        )
      )}
      <LoadMore
        onLoadMore={() => void fetchNextPage()}
        hasNextPage={!isQueryAccessError(listError) && Boolean(hasNextPage)}
        isFetchingNextPage={isFetchingNextPage}
      />
      {slug && gameError && selected && (
        <button className="cc-error" type="button" onClick={() => void retryGame()}>
          {t("arena.retry")}
        </button>
      )}
      {slug && pendingGame ? (
        <Skeleton className="h-96 bg-white/5" />
      ) : slug && (!selected || isQueryAccessError(selectedError)) ? (
        <button className="cc-error" type="button" onClick={() => void retryGame()}>
          {t("arena.retry")}
        </button>
      ) : (
        <MatchReplay
          key={selected?.id ?? "demonstration"}
          match={current}
          live={current.status === "running"}
        />
      )}
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
  const { data, error, isPending, isError, refetch } = useQuery({
    ...orpc.chess.leaderboard.queryOptions({ input: { limit: 100 } }),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <>
      <Intro title={t("leaderboard.title")} description={t("leaderboard.description")} />
      <QueryBoundary
        query={{ data, error, isPending, isError, refetch }}
        skeleton={<Skeleton className="h-64 bg-white/5" />}
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
                      <th key={key}>{t(key)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr key={`${row.model}:${row.protocol}:${row.rulesKey}`}>
                      <td>
                        <strong>{row.model}</strong>
                        <p className="cc-muted">{row.protocol}</p>
                      </td>
                      <td>
                        {row.rulesKey}
                        {(row.moveFormat === "strict" || row.moveFormat === "lenient") && (
                          <p className="cc-muted">{t(`moveFormats.${row.moveFormat}`)}</p>
                        )}
                      </td>
                      <td>{row.games}</td>
                      <td>{Math.round((100 * (row.wins + row.draws / 2)) / row.games)}%</td>
                      <td>{row.illegalAttempts}</td>
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
