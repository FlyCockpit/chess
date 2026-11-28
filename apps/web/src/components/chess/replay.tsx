import {
  applyUci,
  Chess,
  type Color,
  type EngineEvaluation,
  type MatchArchive,
  type MatchEvent,
  MODEL_PROTOCOLS,
  matchStats,
  type Player,
} from "@cockpit-chess/chess";
import { endingSummary, type MatchEnding, matchEnding } from "@cockpit-chess/chess/ending";
import { exportPgn } from "@cockpit-chess/chess/pgn";
import type { SpectatorEvaluations } from "@cockpit-chess/chess/spectator";
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
import { useNow } from "@/hooks/use-now";
import { useReplayClock } from "@/hooks/use-replay-clock";
import { boardIllegal, ILLEGAL_MS, rejectedAt, UNREADABLE_MS } from "./board-motion";
import { ChessBoard } from "./chess-board";
import { clockAt, formatClock, liveClock } from "./clock";
import {
  endingDetailLabel,
  endingHeadlineLabel,
  endingLabel,
  remarkToneLabel,
  replyCapLabel,
  sideSpendLabel,
  timeControlLabel,
} from "./ending-label";

/** Hosted model players spend against a budget; random and human players do not. */
const isModelPlayer = (player: Player) =>
  (MODEL_PROTOCOLS as readonly string[]).includes(player.protocol);

import { EvalBar, EvalGraph } from "./eval-bar";
import {
  evaluationSeries,
  graphCursor,
  graphSeries,
  moveNumber,
  pointForPosition,
  toolEvaluation,
} from "./evaluation";
import { describeLookup, type LegalLookup, overlayAt, turnAction } from "./legal-lookup";
import { LookupNote, lookupLabel } from "./lookup-note";
import { type PlaybackSource, useBoardPlayback } from "./use-board-playback";
import { VideoExportDialog } from "./video/video-export-dialog";

/** The second line under a player's name: the model id, only when it says something new. */
function modelLine(player: { name: string; model: string }) {
  return player.model.trim() && player.model !== player.name ? player.model : null;
}

type Remark = {
  index: number;
  side: Color;
  move: number;
  label: string;
  comment: string;
  /** The remark came with a rejected attempt: the move it names was not played. */
  rejected: boolean;
};

/**
 * One remark: the chat bubble beside its player and each chat-log entry are this same
 * component. Untrusted model text, rendered as plain text only.
 */
function RemarkButton({
  remark,
  className,
  onSelect,
}: {
  remark: Remark;
  className: string;
  onSelect: (remark: Remark) => void;
}) {
  const { t } = useTranslation("chess");
  return (
    <button
      type="button"
      className={`${className} cc-remark-${remark.side}`}
      onClick={() => onSelect(remark)}
    >
      <span className="cc-remark-meta">
        <span aria-hidden="true" className={`cc-swatch cc-swatch-${remark.side}`} />
        {t(`colors.${remark.side}`)} ·{" "}
        {t("replay.remarkMove", { move: remark.move, san: remark.label })}
        {remark.rejected && (
          <>
            {" · "}
            <span className="cc-remark-rejected">{t("replay.remarkRejected")}</span>
          </>
        )}
      </span>
      <span className="cc-remark-text">{remark.comment}</span>
    </button>
  );
}

/**
 * A player's row: name, model, clock (timed games), and, when remarks are on, a slot
 * of fixed height for the side's chat bubble, on the board's outer edge so a bubble
 * never covers a square or moves the board.
 */
function PlayerRow({
  player,
  side,
  position,
  clock,
  ticking,
  bubbles,
  remark,
  onRemark,
  flash,
}: {
  player: { name: string; model: string };
  side: Color;
  position: "top" | "bottom";
  clock: number | null;
  ticking: boolean;
  bubbles: boolean;
  remark: Remark | undefined;
  onRemark: (remark: Remark) => void;
  /** The event of a reply from this side that could not be read: the row flashes red. */
  flash?: number;
}) {
  const { t } = useTranslation("chess");
  const detail = modelLine(player);
  const slot = bubbles && (
    <div className={`cc-bubble-slot cc-bubble-slot-${position}`} aria-live="polite">
      {remark && (
        <RemarkButton
          key={remark.index}
          remark={remark}
          className="cc-remark-bubble"
          onSelect={onRemark}
        />
      )}
    </div>
  );
  return (
    <div className={`cc-player-block cc-player-${position}`}>
      {position === "top" && slot}
      <div className="cc-player">
        {flash !== undefined && <span key={flash} aria-hidden="true" className="cc-player-flash" />}
        <span className={side === "w" ? "cc-avatar cc-avatar-light" : "cc-avatar"}>
          {side === "w" ? "♔" : "♚"}
        </span>
        <div>
          <strong>{player.name}</strong>
          {detail && <span>{detail}</span>}
        </div>
        {clock !== null && (
          <span
            className={`cc-clock ${ticking ? "cc-clock-running" : ""} ${clock === 0 ? "cc-clock-flagged" : ""}`}
            role="timer"
            aria-label={t("replay.clockLabel", {
              side: t(`colors.${side}`),
              time: formatClock(clock),
            })}
          >
            {formatClock(clock)}
          </span>
        )}
        <span className="cc-side-label">{t(`colors.${side}`)}</span>
      </div>
      {position === "bottom" && slot}
    </div>
  );
}
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
        rejected: !event.accepted,
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
  /** Each `legal_moves` call, read from the position it was made in. */
  lookups: Map<number, LegalLookup>;
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
  const lookups = new Map<number, LegalLookup>();
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
    const lookup = describeLookup(chess, entry);
    if (lookup) lookups.set(index, lookup);
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
  return { initial, frames, evaluationsByFen, lookups, failure };
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
  lookup,
  index,
  current,
  last,
  onSelect,
}: {
  entry: MatchEvent;
  lookup: LegalLookup | undefined;
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
              {entry.accepted
                ? entry.san
                : entry.reason === "truncated"
                  ? t("replay.cutOff")
                  : t("replay.illegal", { move: entry.move })}
              {entry.comment && <small>{entry.comment}</small>}
              {entry.normalizedFrom !== undefined && (
                <small title={entry.normalizedFrom}>{t("replay.normalized")}</small>
              )}
            </>
          ) : lookup ? (
            lookupLabel(t, lookup)
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

/** PGN `[Site]`: this instance's public origin; a loopback lab has none, so the default applies. */
function pgnSite(origin = location.origin) {
  const host = new URL(origin).hostname;
  return /^(localhost|127(?:\.\d+){3}|\[::1\])$/.test(host) ? undefined : origin;
}
export function downloadGame(
  match: MatchArchive,
  format: "json" | "pgn",
  describeEnding?: (ending: MatchEnding) => string,
) {
  const text =
    format === "json"
      ? JSON.stringify(match, null, 2)
      : exportPgn(match, { site: pgnSite(), describeEnding });
  const blob = new Blob([text], {
    type: format === "json" ? "application/json" : "application/x-chess-pgn",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `cockpit-${match.id}.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}
/** Why a game shows no evaluation bar. */
function evaluationNote(
  match: MatchArchive,
  spectator: { evaluations: SpectatorEvaluations | null; available?: boolean } | undefined,
) {
  if (spectator?.available === false) return "replay.evalNoEngine";
  if (match.status === "running") return "replay.evalWaiting";
  return "replay.evalPending";
}

export function MatchReplay({
  match: original,
  anonymized = false,
  live = false,
  spectator,
}: {
  match: MatchArchive;
  anonymized?: boolean;
  live?: boolean;
  /**
   * Spectator-only engine scores (`chess.get` / `chess.inspect`, the local lab's
   * state). `available: false` means no engine can produce them here.
   */
  spectator?: { evaluations: SpectatorEvaluations | null; available?: boolean };
}) {
  const { t, i18n } = useTranslation("chess");
  const match = useMemo(() => {
    if (!anonymized) return original;
    const player = (value: Player): Player => {
      const name =
        value.protocol === "human"
          ? t("replay.deletedUser")
          : value.protocol === "random"
            ? t("lab.random")
            : value.model === "Unknown model"
              ? t("replay.unknownModel")
              : value.name;
      return {
        ...value,
        name,
        model: value.model === "Unknown model" ? t("replay.unknownModel") : value.model,
      };
    };
    return {
      ...original,
      config: {
        ...original.config,
        title: t("replay.deletedUser"),
        white: player(original.config.white),
        black: player(original.config.black),
      },
    };
  }, [anonymized, original, t]);
  const [cursor, setCursor] = useState<number | null>(null);
  // The scrubber moved the cursor last: the board snaps instead of animating a step.
  const [scrubbed, setScrubbed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [flipped, setFlipped] = useState(false);
  // With remarks on, the chat log is what most viewers come for; the move list is one tab away.
  const [tab, setTab] = useState<"moves" | "chat">(
    match.config.rules.remarks === "off" ? "moves" : "chat",
  );
  const lastIndex = match.events.length - 1;
  const index = cursor === null ? lastIndex : Math.min(cursor, lastIndex);
  // Reaching the last event resumes live-follow (cursor === null) instead of
  // pinning a number that stops tracking new events.
  const seek = (target: number, scrub = false) => {
    setScrubbed(scrub);
    setCursor(target >= lastIndex ? null : target);
  };
  const shownEvent = match.events[index];
  // Autoplay leaves a rejected attempt on screen until its motion has played.
  const autoplayDelay =
    shownEvent?.type === "attempt" && !shownEvent.accepted
      ? Math.max(700, (shownEvent.reason === "illegal" ? ILLEGAL_MS : UNREADABLE_MS) + 400)
      : 700;
  useReplayClock(
    playing,
    () => {
      if (index >= lastIndex) setPlaying(false);
      else seek(index + 1);
    },
    autoplayDelay,
  );
  const replay = useMemo(() => buildReplayIndex(match), [match]);
  const source = useMemo<PlaybackSource>(
    () => ({
      events: match.events,
      fenAt: (at) => frameAt(replay, at).fen,
      holds: (at) => {
        const lookup = replay.lookups.get(at);
        return !!lookup?.square && !!lookup.piece;
      },
    }),
    [match.events, replay],
  );
  const stats = useMemo(() => matchStats(match), [match]);
  const series = useMemo(
    () => evaluationSeries(match, spectator?.evaluations),
    [match, spectator?.evaluations],
  );
  const graph = useMemo(() => graphSeries(series), [series]);
  const remarks = useMemo(() => remarksOf(match), [match]);
  const sideStats = useMemo(
    () =>
      [
        ["w", matchStats(match, "w")],
        ["b", matchStats(match, "b")],
      ] as const,
    [match],
  );
  const rulesJson = useMemo(
    () =>
      JSON.stringify(
        {
          white: match.config.white.protocol,
          black: match.config.black.protocol,
          ...match.config.rules,
          prompt: {
            version: match.config.prompt.version,
            hash: match.config.prompt.hash,
            promptApplied: match.config.prompt.promptApplied,
          },
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
  const count = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const frame = frameAt(replay, index);
  // The board catches up with `index` one animated step at a time (single steps and
  // autoplay; new events of a followed game play in order, the poll that ends it
  // included); everything else follows `index` at once.
  const playback = useBoardPlayback(index, cursor === null, source, scrubbed);
  const finishPlayback = playback.finish;
  const selectEvent = useCallback(
    (target: number | null) => {
      setScrubbed(false);
      setCursor(target);
      setPlaying(false);
      // Asking for the latest event mid catch-up shows it now.
      if (target === null) finishPlayback();
    },
    [finishPlayback],
  );
  const boardIndex = Math.min(playback.shown, lastIndex);
  const boardFrame = frameAt(replay, boardIndex);
  const boardFinished = match.termination !== "playing" && boardIndex === lastIndex;
  // The bar shows only an evaluation of the very position on the board; the
  // graph cursor marks the latest evaluation reached so far.
  const evalPoint = pointForPosition(series, boardIndex, boardFrame.fen);
  const graphPoint = graphCursor(graph, evalPoint, boardIndex);
  const showEval = series.length > 0;
  const tone = match.config.rules.remarks;
  const commentary = tone !== "off";
  const movesHidden = commentary && tab !== "moves";
  const describeEnding = useCallback(
    (ending: MatchEnding) => endingLabel(t, i18n.language, ending),
    [t, i18n.language],
  );
  const structuredEnding = useMemo(() => matchEnding(match), [match]);
  const ending = describeEnding(structuredEnding);
  const currentRemark = commentary
    ? remarks.filter((remark) => remark.index <= index).at(-1)
    : undefined;
  const selectRemark = useCallback(
    (remark: Remark) => selectEvent(remark.index === lastIndex ? null : remark.index),
    [selectEvent, lastIndex],
  );
  const timed = clockAt(match, "w", -1) !== null;
  const following = live && cursor === null && match.status === "running";
  const now = useNow(timed && following);
  const clockOf = (side: Color) =>
    following ? liveClock(match, side, frame.turn, now) : clockAt(match, side, index);
  // The result, in plain words, once the replay reaches the end of a finished game.
  const finished = match.termination !== "playing" && index === lastIndex;
  const summary = endingSummary(structuredEnding);
  const outcome =
    structuredEnding.kind === "draw"
      ? "draw"
      : match.result === "1-0"
        ? "w"
        : match.result === "0-1"
          ? "b"
          : "unscored";
  const boardOverlay = boardFinished
    ? undefined
    : overlayAt(match.events, replay.lookups, boardIndex);
  // A rejected attempt stays outlined until the side's next attempt or accepted move.
  const rejected = useMemo(() => {
    const mark = rejectedAt(match.events, source.fenAt, boardIndex);
    return mark ? { mark, board: boardIllegal(t, mark) } : null;
  }, [boardIndex, source, match.events, t]);
  const mark = rejected?.mark;
  const flashSide = mark?.kind === "unreadable" ? mark.side : undefined;
  const top: Color = flipped ? "w" : "b";
  const bottom: Color = flipped ? "b" : "w";
  const row = (side: Color, position: "top" | "bottom") => (
    <PlayerRow
      player={side === "w" ? match.config.white : match.config.black}
      side={side}
      position={position}
      clock={clockOf(side)}
      ticking={following && frame.turn === side}
      bubbles={commentary}
      remark={currentRemark?.side === side ? currentRemark : undefined}
      onRemark={selectRemark}
      flash={flashSide === side ? mark?.index : undefined}
    />
  );
  const event = match.events[index];
  // Gone once the game is over: the final position shows without a stale lookup.
  const overlay = finished ? undefined : overlayAt(match.events, replay.lookups, index);
  // The turn's latest action: the caption, the note under the board and the tool
  // details keep naming a lookup over the bookkeeping recorded after it.
  const action = finished ? index : (turnAction(match.events, index) ?? index);
  const lookup = replay.lookups.get(action);
  const toolEvent = match.events[action];
  const evaluation = evaluationAt(replay, frame.fen, index);
  const score = evaluation
    ? evaluation.mate !== null
      ? t("engine.mate", { moves: evaluation.mate })
      : `${(evaluation.cp ?? 0) > 0 ? "+" : ""}${((evaluation.cp ?? 0) / 100).toFixed(2)}`
    : "";
  return (
    <div className="cc-replay-grid">
      <section className="cc-board-panel">
        {/* The result, above the board where it is seen first; the final position stays visible. */}
        {finished && (
          <div className={`cc-result-banner cc-result-${outcome}`} role="status">
            <strong>{endingHeadlineLabel(t, summary)}</strong>
            {endingDetailLabel(t, i18n.language, structuredEnding) && (
              <span>{endingDetailLabel(t, i18n.language, structuredEnding)}</span>
            )}
            {sideStats.some(([, side]) => side.illegalAttempts > 0) && (
              <span className="cc-result-illegal">
                {t("replay.illegalBySide", {
                  white: t("colors.w"),
                  w: sideStats[0][1].illegalAttempts,
                  black: t("colors.b"),
                  b: sideStats[1][1].illegalAttempts,
                })}
              </span>
            )}
            {sideStats.some(([, side]) => side.truncatedAttempts > 0) && (
              <span className="cc-result-illegal">
                {t("replay.truncatedBySide", {
                  white: t("colors.w"),
                  w: sideStats[0][1].truncatedAttempts,
                  black: t("colors.b"),
                  b: sideStats[1][1].truncatedAttempts,
                })}
              </span>
            )}
            <span className="cc-result-score">{match.result}</span>
          </div>
        )}
        {row(top, "top")}
        <div className={showEval ? "cc-board-row" : undefined}>
          {showEval && <EvalBar point={evalPoint} flipped={flipped} />}
          <div className="cc-board-cell">
            <ChessBoard
              fen={boardFrame.fen}
              flipped={flipped}
              lastMove={boardFrame.lastMove}
              lookup={boardOverlay}
              motion={playback.motion}
              motionMs={playback.ms}
              onMotionEnd={playback.onMotionEnd}
              illegal={rejected?.board ?? null}
              // The board announces each rejected attempt as it plays (the Moves caption,
              // which follows the newest event, leaves them to it).
              announce
            />
          </div>
        </div>
        {row(bottom, "bottom")}
        {/* The board's lookup in words, right under the board (whichever sidebar tab is
            open). Announced only while the Moves panel, whose caption announces it, is hidden. */}
        {match.config.rules.legalMoves === "tool" && (
          <LookupNote
            lookup={lookup}
            side={toolEvent?.side ?? frame.turn}
            marks={!!overlay}
            live={movesHidden}
          />
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
              seek(Math.max(-1, index - 1));
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
          <button type="button" aria-label={t("replay.latest")} onClick={() => selectEvent(null)}>
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
            seek(Number(e.target.value), true);
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
          <p className="cc-muted cc-eval-note">{t(evaluationNote(match, spectator))}</p>
        )}
      </section>
      <aside className="cc-match-sidebar">
        <div className="cc-section-heading">
          <span className={live && cursor === null ? "cc-live-dot" : "cc-dot"} />
          {t(live && cursor === null ? "replay.live" : "replay.recorded")}
          <span className="cc-pill">{match.result}</span>
        </div>
        <h2>{match.config.title}</h2>
        {anonymized && <p className="text-muted-foreground text-sm">{t("replay.anonymized")}</p>}
        <p className="cc-muted cc-ending-text">{ending}</p>
        <div className="cc-rule-tags">
          <span>{t(`context.${match.config.rules.context}`)}</span>
          <span>{t(`identity.${match.config.rules.opponentIdentity}`)}</span>
          <span>{t(`tools.${match.config.rules.legalMoves}`)}</span>
          <span>{t(`accounting.${match.config.rules.tokenAccounting}`)}</span>
          <span>{t(`engineModes.${match.config.rules.engineEvaluation}`)}</span>
          <span>{timeControlLabel(t, match.config.rules)}</span>
          <span>{replyCapLabel(t, match.config.rules)}</span>
          <span>{remarkToneLabel(t, tone)}</span>
          <span>
            {t(
              match.config.rules.engineEvaluation === "off"
                ? "replay.evalSpectators"
                : "replay.evalPlayers",
            )}
          </span>
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
        {match.config.rules.tokenAccounting === "cl100k_base" &&
          sideStats.map(([side, shared]) => (
            <p key={side} className="cc-muted mb-2 text-xs">
              {t(`colors.${side}`)} ·{" "}
              {t("replay.sharedSpend", {
                input: count.format(shared.sharedInputTokens),
                output: count.format(shared.sharedOutputTokens),
                limit: count.format(match.config.rules.tokenBudget),
              })}
            </p>
          ))}
        {/* Each model's spend against its budget, live while the game runs. */}
        {sideStats
          .filter(([side]) => isModelPlayer(side === "w" ? match.config.white : match.config.black))
          .map(([side, spent]) => (
            <p key={side} className="cc-muted mb-2 text-xs cc-side-spend">
              {sideSpendLabel(t, i18n.language, match, side, spent)}
            </p>
          ))}
        <p className="cc-muted mb-4 text-xs">
          {t("replay.spend", {
            cost:
              stats.costMicros === null
                ? t("replay.unknownCost")
                : currency.format(stats.costMicros / 1000000),
            reserved: count.format(stats.peakReservedTokens),
          })}
        </p>
        <p className="cc-muted mb-4 text-xs cc-cache-usage">
          {stats.cacheReadShare === null
            ? t("replay.cacheUnknown", { tokens: count.format(stats.cachedInputTokens) })
            : t("replay.cacheUsage", {
                tokens: count.format(stats.cachedInputTokens),
                share: new Intl.NumberFormat(i18n.language, {
                  style: "percent",
                  maximumFractionDigits: 1,
                }).format(stats.cacheReadShare),
              })}
        </p>
        <details className="cc-muted mb-4 text-xs">
          <summary className="cursor-pointer py-3">{t("replay.rules")}</summary>
          <CodeSnippet code={rulesJson} copyLabel={t("replay.copyRules")} />
        </details>
        <div className="cc-mini-stats">
          <div>
            <strong>{count.format(stats.moves)}</strong>
            <span>{t("stats.plies")}</span>
          </div>
          <div>
            <strong>
              {sideStats[0][1].illegalAttempts} / {sideStats[1][1].illegalAttempts}
            </strong>
            <span>{t("stats.rejectedBySide")}</span>
          </div>
          <div>
            <strong>{count.format(stats.inputTokens + stats.outputTokens)}</strong>
            <span>{t("stats.tokens")}</span>
          </div>
        </div>
        {toolEvent?.type === "tool" && (
          <details className="cc-muted mb-4 text-xs">
            <summary className="cursor-pointer py-3">{t("replay.toolDetails")}</summary>
            <CodeSnippet
              code={`${toolEvent.input}\n${toolEvent.output}`}
              copyLabel={t("replay.copyTool")}
              wrap
            />
          </details>
        )}
        {commentary && (
          <div className="cc-tabs" role="tablist" aria-label={t("replay.sidebarTabs")}>
            {(["moves", "chat"] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                id={`${match.id}-tab-${name}`}
                aria-controls={`${match.id}-panel-${name}`}
                aria-selected={tab === name}
                // Roving focus: Tab reaches the selected tab; arrows, Home and End move.
                tabIndex={tab === name ? 0 : -1}
                className={tab === name ? "cc-tab cc-tab-active" : "cc-tab"}
                onClick={() => setTab(name)}
                onKeyDown={(keyEvent) => {
                  // Two tabs: either arrow moves to the other one (wrapping).
                  const other = name === "chat" ? "moves" : "chat";
                  const next = (
                    { ArrowLeft: other, ArrowRight: other, Home: "moves", End: "chat" } as const
                  )[keyEvent.key as "ArrowLeft"];
                  if (!next) return;
                  keyEvent.preventDefault();
                  setTab(next);
                  document.getElementById(`${match.id}-tab-${next}`)?.focus();
                }}
              >
                {name === "chat"
                  ? t("replay.chatTab", { count: remarks.length })
                  : t("replay.movesTab")}
              </button>
            ))}
          </div>
        )}
        {/* Both panels stay mounted (the tabs control them); only the selected one shows. */}
        {commentary && (
          <section
            className="cc-commentary"
            role="tabpanel"
            id={`${match.id}-panel-chat`}
            aria-labelledby={`${match.id}-tab-chat`}
            hidden={tab !== "chat"}
          >
            <p className="cc-muted text-xs">{t("replay.commentaryNote")}</p>
            {remarks.length === 0 ? (
              <p className="cc-muted text-xs">{t("replay.commentaryEmpty")}</p>
            ) : (
              <ol>
                {remarks.map((remark) => (
                  <li key={remark.index}>
                    <RemarkButton
                      remark={remark}
                      className={`cc-remark ${remark === currentRemark ? "cc-current-remark" : ""}`}
                      onSelect={selectRemark}
                    />
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
        {
          <div
            role={commentary ? "tabpanel" : undefined}
            id={`${match.id}-panel-moves`}
            aria-labelledby={commentary ? `${match.id}-tab-moves` : undefined}
            hidden={movesHidden}
          >
            <div
              className="cc-event-caption"
              aria-live={event?.type === "attempt" && !event.accepted ? "off" : "polite"}
            >
              {event?.type === "attempt"
                ? event.accepted
                  ? t("replay.accepted", { move: event.san })
                  : event.reason === "truncated"
                    ? t("replay.rejectedTruncated")
                    : t("replay.rejected", { move: event.move })
                : lookup
                  ? lookupLabel(t, lookup)
                  : event
                    ? t(`events.${event.type}`)
                    : t("replay.initial")}
            </div>
            {event?.type === "attempt" && event.reply !== undefined && (
              <details className="cc-muted mb-4 text-xs">
                <summary className="cursor-pointer py-3">{t("replay.replyDetails")}</summary>
                <p>
                  {event.reason === "illegal"
                    ? t("replay.stopReasons.illegal")
                    : t(`replay.stopReasons.${event.stopReason ?? "completed"}`)}{" "}
                  {t("replay.replyNote")}
                </p>
                {/* Untrusted model text: rendered as escaped plain text only. */}
                <CodeSnippet
                  code={event.reply || t("replay.replyEmpty")}
                  copyLabel={t("replay.copyReply")}
                />
              </details>
            )}
            <ol className="cc-timeline">
              {match.events.map((entry, i) => (
                <TimelineRow
                  key={entry.seq}
                  entry={entry}
                  lookup={replay.lookups.get(i)}
                  index={i}
                  current={i === index}
                  last={i === lastIndex}
                  onSelect={selectEvent}
                />
              ))}
            </ol>
          </div>
        }
        <div className="cc-export-row">
          <button type="button" onClick={() => downloadGame(match, "json")}>
            <Download size={15} />
            {t("replay.json")}
          </button>
          <button type="button" onClick={() => downloadGame(match, "pgn", describeEnding)}>
            {t("replay.pgn")}
          </button>
          <VideoExportDialog match={match} spectator={spectator?.evaluations} />
        </div>
        <CopyField value={frame.fen} copyLabel={t("replay.fen")} />
      </aside>
    </div>
  );
}
