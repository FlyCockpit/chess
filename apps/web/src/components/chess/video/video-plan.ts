import {
  applyUci,
  Chess,
  type Color,
  type EngineEvaluation,
  type MatchArchive,
  sideClockMs,
} from "@cockpit-chess/chess";
import { endingSummary, matchEnding } from "@cockpit-chess/chess/ending";
import { gamePositions, type SpectatorEvaluations } from "@cockpit-chess/chess/spectator";
import type { TFunction } from "i18next";
import { endingDetailLabel, endingHeadlineLabel, timeControlLabel } from "../ending-label";
import { evaluationSeries, shortScore, toolEvaluation, whiteShare } from "../evaluation";

/**
 * The MP4 export's frame plan: which position, move, remark, clock and banner
 * each stretch of frames shows. Pure and serializable, so the encoder worker
 * only draws what the plan says, and the plan is testable without a browser.
 */

export const VIDEO_FPS = 30;
/** X's maximum video length (2 min 20 s). Auto pace always fits inside it. */
export const X_MAX_SECONDS = 140;
export const TITLE_SECONDS = 2;
export const FINAL_HOLD_SECONDS = 4;
/** Auto pace: at most this long per position, at least one frame. */
export const AUTO_MAX_SECONDS_PER_MOVE = 1.5;
/** On Auto, a move with a remark stays on screen this long when the budget allows. */
const REMARK_SECONDS = 2.5;

export const VIDEO_ASPECTS = ["square", "landscape"] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];
export const VIDEO_PACES = ["auto", "0.5", "1", "1.5", "2", "3"] as const;
export type VideoPace = (typeof VIDEO_PACES)[number];

export const VIDEO_SIZES: Record<VideoAspect, { width: number; height: number; bitrate: number }> =
  {
    // Board graphics compress very well; these caps keep a 2:20 video under ~60 MB,
    // far below X's 512 MB limit.
    square: { width: 1080, height: 1080, bitrate: 3_000_000 },
    landscape: { width: 1920, height: 1080, bitrate: 3_500_000 },
  };

export type VideoOptions = {
  aspect: VideoAspect;
  pace: VideoPace;
  evalBar: boolean;
  remarks: boolean;
  clocks: boolean;
};

export type VideoFeatures = { evalBar: boolean; remarks: boolean; clocks: boolean };

/** What the match can show at all; a toggle for a missing feature is hidden. */
export function videoFeatures(
  match: MatchArchive,
  spectator?: SpectatorEvaluations | null,
): VideoFeatures {
  // A bar only when some score (spectator, after-move or a tool call's) is of a position
  // the game actually reached: the frames show exact-position scores only.
  let evalBar = false;
  try {
    const reached = new Set(gamePositions(match));
    evalBar = evaluationSeries(match, spectator).some((point) => reached.has(point.evaluation.fen));
  } catch {
    // An archive that does not replay has no positions to score.
  }
  let remarks = false;
  // Clocks only in timed games (an untimed game has no clock to run down).
  let clocks = false;
  const timed = sideClockMs(match.config.rules, "w") !== null;
  for (const event of match.events) {
    if (event.type === "attempt" && event.accepted && cleanRemark(event.comment)) remarks = true;
    else if (event.type === "timing" && timed) clocks = true;
  }
  return { evalBar, remarks, clocks };
}

export function defaultVideoOptions(
  match: MatchArchive,
  spectator?: SpectatorEvaluations | null,
): VideoOptions {
  return { aspect: "square", pace: "auto", ...videoFeatures(match, spectator) };
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

type PlayerLine = { label: string; clock: string | null };
export type FrameState = {
  kind: "title" | "position" | "final";
  fen: string;
  lastMove: string | null;
  brand: string;
  title: string;
  players: Record<Color, PlayerLine>;
  /** The side to move; null on the title card and the final position. */
  toMove: Color | null;
  moveLabel: string | null;
  /** White's share of the bar (0–1) and its label; null when the bar is off. */
  evaluation: { share: number; label: string } | null;
  showEvalBar: boolean;
  remark: { side: Color; speaker: string; text: string } | null;
  banner: { headline: string; detail: string } | null;
  titleCard: { white: string; black: string; versus: string; rules: string } | null;
};
type Scene = { frames: number; state: FrameState };
export type VideoPlan = {
  width: number;
  height: number;
  bitrate: number;
  fps: number;
  scenes: Scene[];
  totalFrames: number;
};

/**
 * Frames per position and the extra frames for a position with a remark.
 * Auto fits every position, the title card and the final hold inside X's limit
 * and gives remarks reading time from what is left; a fixed pace is taken
 * literally for every position (the dialog warns when it runs long).
 */
export function pacing(positions: number, remarkMoves: number, pace: VideoPace) {
  const fixedFrames = (TITLE_SECONDS + FINAL_HOLD_SECONDS) * VIDEO_FPS;
  const remarkFrames = REMARK_SECONDS * VIDEO_FPS;
  if (pace !== "auto") {
    return { perMove: Math.max(1, Math.round(Number(pace) * VIDEO_FPS)), remarkExtra: 0 };
  }
  const budget = X_MAX_SECONDS * VIDEO_FPS - fixedFrames;
  const perMove = Math.max(
    1,
    Math.min(AUTO_MAX_SECONDS_PER_MOVE * VIDEO_FPS, Math.floor(budget / Math.max(1, positions))),
  );
  const leftover = budget - perMove * positions;
  const remarkExtra =
    remarkMoves > 0
      ? Math.max(0, Math.min(remarkFrames - perMove, Math.floor(leftover / remarkMoves)))
      : 0;
  return { perMove, remarkExtra };
}

/**
 * A model's remark is untrusted text. It is only ever drawn with `fillText`
 * (never parsed as markup), and this strips what could still distort that:
 * control characters, bidi overrides/isolates, and runs of whitespace.
 */
export function cleanRemark(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function outcome(result: MatchArchive["result"], t: Translate) {
  if (result === "1-0") return t("video.outcome.whiteWins");
  if (result === "0-1") return t("video.outcome.blackWins");
  if (result === "1/2-1/2") return t("video.outcome.draw");
  return t("video.outcome.unfinished");
}

/**
 * The final banner: the same plain-words ending as the game view (`chess:ending.*`,
 * one mapping for every surface), with its detail, else the result.
 */
function resultBanner(match: MatchArchive, t: Translate, locale: string) {
  const labels = t as unknown as TFunction<"chess">;
  const ending = matchEnding(match);
  return {
    headline: endingHeadlineLabel(labels, endingSummary(ending)),
    detail: endingDetailLabel(labels, locale, ending) ?? outcome(match.result, t),
  };
}

/** `<match-title>-<result>.mp4`, safe for every file system. */
export function videoFileName(match: MatchArchive): string {
  const slug =
    match.config.title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "cockpit-chess";
  const result =
    match.result === "1/2-1/2" ? "draw" : match.result === "*" ? "unfinished" : match.result;
  return `${slug}-${result}.mp4`;
}

/**
 * One pass over the archive. Like the replay view, the board is replayed from
 * accepted attempts only (stored FENs are not trusted); a move that does not
 * replay ends the plan at the last good position.
 */
export function buildVideoPlan(
  match: MatchArchive,
  options: VideoOptions,
  t: Translate,
  context: { locale?: string; spectator?: SpectatorEvaluations | null } = {},
): VideoPlan {
  const size = VIDEO_SIZES[options.aspect];
  const chess = new Chess(match.config.initialFen);
  const remaining: Record<Color, number> = {
    w: sideClockMs(match.config.rules, "w") ?? 0,
    b: sideClockMs(match.config.rules, "b") ?? 0,
  };
  // Spectator scores (by exact position) first; the archive's own evaluations add to them.
  const evaluations = new Map<string, EngineEvaluation>(
    context.spectator
      ? evaluationSeries(match, context.spectator).map((point) => [
          point.evaluation.fen,
          point.evaluation,
        ])
      : [],
  );
  type Position = {
    fen: string;
    turn: Color;
    lastMove: string | null;
    moveLabel: string | null;
    remark: { side: Color; text: string } | null;
    clocks: Record<Color, number>;
    evaluation: EngineEvaluation | undefined;
  };
  const positions: Position[] = [
    {
      fen: chess.fen(),
      turn: chess.turn(),
      lastMove: null,
      moveLabel: null,
      remark: null,
      clocks: { ...remaining },
      evaluation: evaluations.get(chess.fen()),
    },
  ];
  // Positions the spectators scored keep that score: the archive's own evaluations
  // (player-facing or tool calls) only fill positions without one, as in the replay.
  const spectatorScored = new Set(evaluations.keys());
  let replayFailed = false;
  for (const event of match.events) {
    if (event.type === "timing") {
      // Thinking time is spent before the move it produced, but the runner may
      // record it just after that move. Time of the side to move counts from
      // its next move on; time of the side that just moved belongs to the
      // position it reached.
      remaining[event.side] -= event.elapsedMs;
      const current = positions.at(-1);
      if (current?.lastMove && current.turn !== event.side) current.clocks = { ...remaining };
    } else if (
      event.type === "evaluation" ||
      (event.type === "tool" && event.name === "engine_eval")
    ) {
      const value = event.type === "evaluation" ? event.evaluation : toolEvaluation(event.output);
      if (value && !spectatorScored.has(value.fen)) {
        evaluations.set(value.fen, value);
        const current = positions.at(-1);
        if (current && current.fen === value.fen) current.evaluation = value;
      }
    } else if (event.type === "attempt" && event.accepted && !replayFailed) {
      const number = chess.moveNumber();
      const mover = chess.turn();
      let san: string;
      try {
        san = applyUci(chess, event.move).san;
      } catch {
        replayFailed = true;
        continue;
      }
      const fen = chess.fen();
      const text = options.remarks ? cleanRemark(event.comment) : "";
      // A mate on the board is a fact, not an estimate: show it even unevaluated.
      const mated: EngineEvaluation | undefined = chess.isCheckmate()
        ? {
            engine: "stockfish-19-lite-single",
            fen,
            depth: 0,
            nodes: 0,
            cp: null,
            mate: 0,
            bestMove: null,
          }
        : undefined;
      positions.push({
        fen,
        turn: chess.turn(),
        lastMove: event.move,
        moveLabel: `${number}${mover === "w" ? "." : "..."} ${san}`,
        remark: text ? { side: mover, text } : null,
        clocks: { ...remaining },
        evaluation: evaluations.get(fen) ?? mated,
      });
    }
  }

  const brand = t("brand").toUpperCase();
  const name = (side: Color) =>
    `${t(`colors.${side}`)} · ${side === "w" ? match.config.white.name : match.config.black.name}`;
  const players = (clocks: Record<Color, number> | null): Record<Color, PlayerLine> => ({
    w: { label: name("w"), clock: clocks && options.clocks ? formatClock(clocks.w) : null },
    b: { label: name("b"), clock: clocks && options.clocks ? formatClock(clocks.b) : null },
  });
  const base = {
    brand,
    title: match.config.title,
    showEvalBar: options.evalBar,
    banner: null,
    titleCard: null,
  };
  const remarkMoves = positions.filter((p) => p.remark).length;
  const { perMove, remarkExtra } = pacing(positions.length, remarkMoves, options.pace);
  const scenes: Scene[] = [];
  const first = positions[0] as Position;
  scenes.push({
    frames: TITLE_SECONDS * VIDEO_FPS,
    state: {
      ...base,
      kind: "title",
      fen: first.fen,
      lastMove: null,
      players: players(null),
      toMove: null,
      moveLabel: null,
      evaluation: null,
      remark: null,
      titleCard: {
        white: name("w"),
        black: name("b"),
        versus: t("video.versus"),
        rules: `${timeControlLabel(t as unknown as TFunction<"chess">, match.config.rules)} · ${t(`context.${match.config.rules.context}`)} · ${t(`identity.${match.config.rules.opponentIdentity}`)}`,
      },
    },
  });
  for (const position of positions) {
    scenes.push({
      frames: perMove + (position.remark ? remarkExtra : 0),
      state: {
        ...base,
        kind: "position",
        fen: position.fen,
        lastMove: position.lastMove,
        players: players(position.clocks),
        toMove: position.turn,
        moveLabel: position.moveLabel,
        // Only the evaluation of exactly this position; none is shown as unknown,
        // never as an older position's score.
        evaluation:
          options.evalBar && position.evaluation
            ? {
                share: whiteShare(position.evaluation),
                label: shortScore(position.evaluation),
              }
            : null,
        remark: position.remark
          ? { ...position.remark, speaker: name(position.remark.side) }
          : null,
      },
    });
  }
  const last = scenes.at(-1)?.state as FrameState;
  scenes.push({
    frames: FINAL_HOLD_SECONDS * VIDEO_FPS,
    state: {
      ...last,
      kind: "final",
      players: players(remaining),
      toMove: null,
      remark: null,
      banner: resultBanner(match, t, context.locale ?? "en-US"),
    },
  });
  return {
    ...size,
    fps: VIDEO_FPS,
    scenes,
    totalFrames: scenes.reduce((n, scene) => n + scene.frames, 0),
  };
}
