import {
  applyUci,
  Chess,
  type Color,
  type EngineEvaluation,
  exportPgn,
  type MatchArchive,
  type MatchEvent,
  matchStats,
} from "@cockpit-chess/chess";
import { CodeSnippet } from "@cockpit-chess/ui/components/code-snippet";
import { CopyField } from "@cockpit-chess/ui/components/copy-field";
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Download,
  FlipVertical2,
  Pause,
  Play,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReplayClock } from "@/hooks/use-replay-clock";
import { ChessBoard } from "./chess-board";
import { EvalBar, EvalGraph } from "./eval-bar";
import {
  evaluationSeries,
  graphCursor,
  graphSeries,
  moveNumber,
  pointForPosition,
  toolEvaluation,
} from "./evaluation";
import { VideoExportDialog } from "./video/video-export-dialog";

/** The second line under a player's name: the model id, only when it says something new. */
function modelLine(player: { name: string; model: string }) {
  return player.model.trim() && player.model !== player.name ? player.model : null;
}

function PlayerRow({ player, side }: { player: { name: string; model: string }; side: Color }) {
  const { t } = useTranslation("chess");
  const detail = modelLine(player);
  return (
    <div className="cc-player">
      <span className={side === "w" ? "cc-avatar cc-avatar-light" : "cc-avatar"}>
        {side === "w" ? "♔" : "♚"}
      </span>
      <div>
        <strong>{player.name}</strong>
        {detail && <span>{detail}</span>}
      </div>
      <span className="cc-side-label">{t(`colors.${side}`)}</span>
    </div>
  );
}

type Remark = { index: number; side: Color; move: number; label: string; comment: string };
/** Every non-empty remark, tied to the attempt it came with. Rendered as text only. */
function remarksOf(match: MatchArchive): Remark[] {
  const remarks: Remark[] = [];
  let plies = 0;
  for (const [index, event] of match.events.entries()) {
    if (event.type !== "attempt") continue;
    const move = moveNumber(match.config.initialFen, plies);
    if (event.comment.trim())
      remarks.push({
        index,
        side: event.side,
        move,
        label: event.accepted && event.san ? event.san : event.move,
        comment: event.comment,
      });
    if (event.accepted) plies += 1;
  }
  return remarks;
}

type ReplayFrame = { fen: string; turn: Color; lastMove: string | undefined };
type IndexedEvaluation = { index: number; value: EngineEvaluation };
type ReplayIndex = {
  initial: ReplayFrame;
  frames: ReplayFrame[];
  evaluationsByFen: Map<string, IndexedEvaluation[]>;
  failure: { index: number; error: unknown } | undefined;
};

/**
 * One pass over the archive with one Chess instance. Mirrors `boardAt`: the
 * board is replayed from accepted attempts only (stored `attempt.fen` is not
 * trusted), and a replay failure surfaces at the same indices `boardAt` would
 * throw for.
 */
function buildReplayIndex(match: MatchArchive): ReplayIndex {
  const chess = new Chess(match.config.initialFen);
  const initial: ReplayFrame = { fen: chess.fen(), turn: chess.turn(), lastMove: undefined };
  const frames: ReplayFrame[] = [];
  const evaluationsByFen = new Map<string, IndexedEvaluation[]>();
  let lastMove: string | undefined;
  let failure: ReplayIndex["failure"];
  for (const [index, entry] of match.events.entries()) {
    if (entry.type === "attempt" && entry.accepted) {
      try {
        applyUci(chess, entry.move);
      } catch (error) {
        failure = { index, error };
        break;
      }
      lastMove = entry.move;
    }
    frames.push({ fen: chess.fen(), turn: chess.turn(), lastMove });
    const value =
      entry.type === "evaluation"
        ? entry.evaluation
        : entry.type === "tool" && entry.name === "engine_eval"
          ? toolEvaluation(entry.output)
          : undefined;
    if (value) {
      const list = evaluationsByFen.get(value.fen);
      if (list) list.push({ index, value });
      else evaluationsByFen.set(value.fen, [{ index, value }]);
    }
  }
  return { initial, frames, evaluationsByFen, failure };
}

function frameAt(replay: ReplayIndex, index: number): ReplayFrame {
  if (replay.failure && index >= replay.failure.index) throw replay.failure.error;
  return index < 0 ? replay.initial : (replay.frames[index] ?? replay.initial);
}

function evaluationAt(replay: ReplayIndex, fen: string, index: number) {
  const list = replay.evaluationsByFen.get(fen);
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item && item.index <= index) return item.value;
  }
  return undefined;
}

const TimelineRow = memo(function TimelineRow({
  entry,
  index,
  current,
  last,
  onSelect,
}: {
  entry: MatchEvent;
  index: number;
  current: boolean;
  last: boolean;
  onSelect: (target: number | null) => void;
}) {
  const { t } = useTranslation("chess");
  return (
    <li>
      <button
        type="button"
        className={`${current ? "cc-current-event" : ""} ${entry.type === "attempt" && !entry.accepted ? "cc-rejected-event" : ""}`}
        onClick={() => onSelect(last ? null : index)}
      >
        <span className="cc-event-num">{String(index + 1).padStart(2, "0")}</span>
        <span>
          {entry.type === "attempt" ? (
            <>
              {entry.accepted ? entry.san : t("replay.illegal", { move: entry.move })}
              {entry.comment && <small>{entry.comment}</small>}
              {entry.normalizedFrom !== undefined && (
                <small title={entry.normalizedFrom}>{t("replay.normalized")}</small>
              )}
            </>
          ) : entry.type === "tool" ? (
            t("replay.tool", { name: entry.name })
          ) : (
            t(`events.${entry.type}`)
          )}
        </span>
        <span className="cc-event-side">
          {entry.type === "evaluation" ? t("engine.observer") : t(`colors.${entry.side}`)}
        </span>
      </button>
    </li>
  );
});

export function downloadGame(match: MatchArchive, format: "json" | "pgn") {
  const blob = new Blob([format === "json" ? JSON.stringify(match, null, 2) : exportPgn(match)], {
    type: format === "json" ? "application/json" : "application/x-chess-pgn",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `cockpit-${match.id}.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}
export function MatchReplay({ match, live = false }: { match: MatchArchive; live?: boolean }) {
  const { t, i18n } = useTranslation("chess");
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const lastIndex = match.events.length - 1;
  const index = cursor === null ? lastIndex : Math.min(cursor, lastIndex);
  // Reaching the last event resumes live-follow (cursor === null) instead of
  // pinning a number that stops tracking new events.
  const seek = (target: number) => setCursor(target >= lastIndex ? null : target);
  useReplayClock(playing, () => {
    if (index >= lastIndex) setPlaying(false);
    else seek(index + 1);
  });
  const selectEvent = useCallback((target: number | null) => {
    setCursor(target);
    setPlaying(false);
  }, []);
  const replay = useMemo(() => buildReplayIndex(match), [match]);
  const stats = useMemo(() => matchStats(match), [match]);
  const series = useMemo(() => evaluationSeries(match), [match]);
  const graph = useMemo(() => graphSeries(series), [series]);
  const remarks = useMemo(() => remarksOf(match), [match]);
  const sideStats = useMemo(
    () =>
      match.config.rules.tokenAccounting === "cl100k_base"
        ? ([
            ["w", matchStats(match, "w")],
            ["b", matchStats(match, "b")],
          ] as const)
        : [],
    [match],
  );
  const rulesJson = useMemo(
    () =>
      JSON.stringify(
        {
          white: match.config.white.protocol,
          black: match.config.black.protocol,
          ...match.config.rules,
        },
        null,
        2,
      ),
    [match.config],
  );
  const currency = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 6,
      }),
    [i18n.language],
  );
  const frame = frameAt(replay, index);
  // The bar shows only an evaluation of the very position on the board; the
  // graph cursor marks the latest evaluation reached so far.
  const evalPoint = pointForPosition(series, index, frame.fen);
  const graphPoint = graphCursor(graph, evalPoint, index);
  const showEval = series.length > 0;
  const commentary = match.config.rules.trashTalk;
  const currentRemark = commentary
    ? remarks.filter((remark) => remark.index <= index).at(-1)
    : undefined;
  const event = match.events[index];
  const evaluation = evaluationAt(replay, frame.fen, index);
  const score = evaluation
    ? evaluation.mate !== null
      ? t("engine.mate", { moves: evaluation.mate })
      : `${(evaluation.cp ?? 0) > 0 ? "+" : ""}${((evaluation.cp ?? 0) / 100).toFixed(2)}`
    : "";
  return (
    <div className="cc-replay-grid">
      <section className="cc-board-panel">
        <PlayerRow
          player={flipped ? match.config.white : match.config.black}
          side={flipped ? "w" : "b"}
        />
        <div className={showEval ? "cc-board-row" : undefined}>
          {showEval && <EvalBar point={evalPoint} flipped={flipped} />}
          <div className="cc-board-cell">
            <ChessBoard fen={frame.fen} flipped={flipped} lastMove={frame.lastMove} />
          </div>
        </div>
        <PlayerRow
          player={flipped ? match.config.black : match.config.white}
          side={flipped ? "b" : "w"}
        />
        {currentRemark && (
          <button
            type="button"
            className={`cc-remark-bubble cc-remark-${currentRemark.side}`}
            onClick={() =>
              selectEvent(currentRemark.index === lastIndex ? null : currentRemark.index)
            }
          >
            <span className="cc-remark-meta">
              {t(`colors.${currentRemark.side}`)} ·{" "}
              {t("replay.remarkMove", { move: currentRemark.move, san: currentRemark.label })}
            </span>
            <span className="cc-remark-text">{currentRemark.comment}</span>
          </button>
        )}
        <div className="cc-replay-controls">
          <button
            type="button"
            aria-label={t("replay.first")}
            onClick={() => {
              setCursor(-1);
              setPlaying(false);
            }}
          >
            <ChevronFirst size={18} />
          </button>
          <button
            type="button"
            aria-label={t("replay.previous")}
            disabled={index < 0}
            onClick={() => {
              setCursor(Math.max(-1, index - 1));
              setPlaying(false);
            }}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            aria-label={t(playing ? "replay.pause" : "replay.play")}
            onClick={() => {
              if (index >= lastIndex) setCursor(-1);
              setPlaying(!playing);
            }}
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button
            type="button"
            aria-label={t("replay.next")}
            disabled={index >= lastIndex}
            onClick={() => {
              seek(index + 1);
              setPlaying(false);
            }}
          >
            <ChevronRight size={18} />
          </button>
          <button
            type="button"
            aria-label={t("replay.latest")}
            onClick={() => {
              setCursor(null);
              setPlaying(false);
            }}
          >
            <ChevronLast size={18} />
          </button>
          <span className="cc-replay-counter">
            {t("replay.event", { current: index + 1, total: match.events.length })}
          </span>
          <button type="button" aria-label={t("replay.flip")} onClick={() => setFlipped(!flipped)}>
            <FlipVertical2 size={18} />
          </button>
        </div>
        <input
          className="cc-scrubber"
          type="range"
          min={-1}
          max={Math.max(-1, lastIndex)}
          value={index}
          aria-label={t("replay.scrub")}
          onChange={(e) => {
            seek(Number(e.target.value));
            setPlaying(false);
          }}
        />
        {series.length > 0 ? (
          <EvalGraph
            series={graph}
            current={graphPoint}
            onSelect={(target) => selectEvent(target >= lastIndex ? null : target)}
          />
        ) : (
          <p className="cc-muted cc-eval-note">
            {t(
              match.config.rules.engineEvaluation === "off"
                ? "replay.evalUnavailable"
                : "replay.evalNone",
            )}
          </p>
        )}
      </section>
      <aside className="cc-match-sidebar">
        <div className="cc-section-heading">
          <span className={live && cursor === null ? "cc-live-dot" : "cc-dot"} />
          {t(live && cursor === null ? "replay.live" : "replay.recorded")}
          <span className="cc-pill">{match.result}</span>
        </div>
        <h2>{match.config.title}</h2>
        <p className="cc-muted">{t(`termination.${match.termination}`)}</p>
        <div className="cc-rule-tags">
          <span>{t(`context.${match.config.rules.context}`)}</span>
          <span>{t(`identity.${match.config.rules.opponentIdentity}`)}</span>
          <span>{t(`tools.${match.config.rules.legalMoves}`)}</span>
          <span>{t(`accounting.${match.config.rules.tokenAccounting}`)}</span>
          <span>{t(`engineModes.${match.config.rules.engineEvaluation}`)}</span>
          <span>{t(commentary ? "replay.commentaryOn" : "replay.commentaryOff")}</span>
        </div>
        {evaluation && (
          <div className="cc-engine-summary">
            <strong>
              {evaluation.mate === 0
                ? t("engine.checkmate", { side: t(`colors.${frame.turn}`) })
                : t("engine.whiteScore", { score })}
            </strong>
            <p>{t("engine.details", { depth: evaluation.depth, nodes: evaluation.nodes })}</p>
          </div>
        )}
        {sideStats.map(([side, shared]) => (
          <p key={side} className="cc-muted mb-2 text-xs">
            {t(`colors.${side}`)} ·{" "}
            {t("replay.sharedSpend", {
              input: shared.sharedInputTokens,
              output: shared.sharedOutputTokens,
              limit: match.config.rules.tokenBudget,
            })}
          </p>
        ))}
        <p className="cc-muted mb-4 text-xs">
          {t("replay.spend", {
            cost:
              stats.costMicros === null
                ? t("replay.unknownCost")
                : currency.format(stats.costMicros / 1000000),
            reserved: stats.reservedTokens,
          })}
        </p>
        <details className="cc-muted mb-4 text-xs">
          <summary className="cursor-pointer py-3">{t("replay.rules")}</summary>
          <CodeSnippet code={rulesJson} copyLabel={t("replay.copyRules")} />
        </details>
        <div className="cc-mini-stats">
          <div>
            <strong>{stats.moves}</strong>
            <span>{t("stats.plies")}</span>
          </div>
          <div>
            <strong>{stats.illegalAttempts}</strong>
            <span>{t("stats.rejected")}</span>
          </div>
          <div>
            <strong>{stats.inputTokens + stats.outputTokens}</strong>
            <span>{t("stats.tokens")}</span>
          </div>
        </div>
        {event?.type === "tool" && (
          <details className="cc-muted mb-4 text-xs">
            <summary className="cursor-pointer py-3">{t("replay.toolDetails")}</summary>
            <CodeSnippet
              code={`${event.input}\n${event.output}`}
              copyLabel={t("replay.copyTool")}
            />
          </details>
        )}
        {commentary && (
          <section className="cc-commentary" aria-labelledby={`${match.id}-talk`}>
            <h3 id={`${match.id}-talk`}>{t("replay.commentaryTitle")}</h3>
            <p className="cc-muted text-xs">{t("replay.commentaryNote")}</p>
            {remarks.length === 0 ? (
              <p className="cc-muted text-xs">{t("replay.commentaryEmpty")}</p>
            ) : (
              <ol>
                {remarks.map((remark) => (
                  <li key={remark.index}>
                    <button
                      type="button"
                      className={`cc-remark cc-remark-${remark.side} ${remark === currentRemark ? "cc-current-remark" : ""}`}
                      onClick={() => selectEvent(remark.index === lastIndex ? null : remark.index)}
                    >
                      <span className="cc-remark-meta">
                        <span aria-hidden="true" className={`cc-swatch cc-swatch-${remark.side}`} />
                        {t(`colors.${remark.side}`)} ·{" "}
                        {t("replay.remarkMove", { move: remark.move, san: remark.label })}
                      </span>
                      <span className="cc-remark-text">{remark.comment}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
        <div className="cc-event-caption" aria-live="polite">
          {event?.type === "attempt"
            ? event.accepted
              ? t("replay.accepted", { move: event.san })
              : t("replay.rejected", { move: event.move })
            : event
              ? t(`events.${event.type}`)
              : t("replay.initial")}
        </div>
        <ol className="cc-timeline">
          {match.events.map((entry, i) => (
            <TimelineRow
              key={entry.seq}
              entry={entry}
              index={i}
              current={i === index}
              last={i === lastIndex}
              onSelect={selectEvent}
            />
          ))}
        </ol>
        <div className="cc-export-row">
          <button type="button" onClick={() => downloadGame(match, "json")}>
            <Download size={15} />
            {t("replay.json")}
          </button>
          <button type="button" onClick={() => downloadGame(match, "pgn")}>
            {t("replay.pgn")}
          </button>
          <VideoExportDialog match={match} />
        </div>
        <CopyField value={frame.fen} copyLabel={t("replay.fen")} />
      </aside>
    </div>
  );
}
