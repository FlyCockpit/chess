import {
  applyUci,
  Chess,
  type Color,
  type EngineEvaluation,
  type MatchArchive,
  type Square,
  sideClockMs,
} from "@cockpit-chess/chess";
import { endingSummary, matchEnding } from "@cockpit-chess/chess/ending";
import { gamePositions, type SpectatorEvaluations } from "@cockpit-chess/chess/spectator";
import type { TFunction } from "i18next";
import {
  type Ghost,
  ILLEGAL_MS,
  type IllegalMark,
  illegalCaption,
  illegalMark,
  illegalMotion,
  MOVE_MS,
  markSquares,
  moreAttemptsCaption,
  moveMotion,
} from "../board-motion";
import { endingDetailLabel, endingHeadlineLabel, timeControlLabel } from "../ending-label";
import { evaluationSeries, shortScore, toolEvaluation, whiteShare } from "../evaluation";
import { describeLookup, type LookupTarget } from "../legal-lookup";

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
/** A legal-move lookup on the board before the move. */
export const LOOKUP_SECONDS = 0.6;
/** After an illegal attempt's motion: outline and caption held still, to read them. */
export const ILLEGAL_HOLD_SECONDS = 0.7;
/** An attempt without a slide (no piece there, or no squares at all). */
export const STILL_ATTEMPT_SECONDS = 1.5;
/**
 * How a turn's run of rejected attempts is shortened: more than `after` in one turn
 * plays the first `full` and flashes the rest (at most `flashes` of them) under a
 * counter. The first level is the normal one; Auto moves to the next only when even
 * the shortest extras of a level would not fit (very long, very struggling games);
 * the later ones also leave the lookups out.
 */
type Compression = { after: number; full: number; flashes: number; lookups: boolean };
const COMPRESSIONS: Compression[] = [
  { after: 5, full: 3, flashes: 24, lookups: true },
  { after: 2, full: 1, flashes: 6, lookups: true },
  { after: 1, full: 1, flashes: 2, lookups: false },
  // Last resort: one flash and the counter for each struggling turn.
  { after: 0, full: 0, flashes: 1, lookups: false },
];
/** One quick flash of a compressed attempt. */
export const FLASH_FRAMES = 5;
/** On Auto, extras (lookups, attempts) take at most this share of the time budget. */
const EXTRAS_SHARE = 0.5;

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
  /** Rejected attempts: slide, outline, shake and back, with a caption. */
  illegal: boolean;
  /** The models' legal-move lookups, as dots on the board before the move. */
  lookups: boolean;
};

export type VideoFeatures = {
  evalBar: boolean;
  remarks: boolean;
  clocks: boolean;
  illegal: boolean;
  lookups: boolean;
};

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
  let illegal = false;
  let lookups = false;
  const timed = sideClockMs(match.config.rules, "w") !== null;
  for (const event of match.events) {
    if (event.type === "attempt" && event.accepted && cleanRemark(event.comment)) remarks = true;
    else if (event.type === "attempt" && !event.accepted) illegal = true;
    else if (event.type === "timing" && timed) clocks = true;
    else if (event.type === "tool" && event.name === "legal_moves") lookups = true;
  }
  return { evalBar, remarks, clocks, illegal, lookups };
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
  /** `attempt`: a rejected attempt (or a burst of them); `lookup`: a legal-move lookup. */
  kind: "title" | "position" | "lookup" | "attempt" | "final";
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
  /** A legal-move lookup's dots (the looked-up square and its targets). */
  lookup: { from: Square; targets: LookupTarget[] } | null;
  /**
   * A rejected attempt: its outlined squares, its caption, who made it and, for a
   * reply that could not be read, the side whose row flashes red.
   */
  illegal: { squares: Square[]; caption: string; speaker: string; flash: Color | null } | null;
};
/**
 * Pieces in motion over the first `frames` frames of a scene (board-motion.ts ghosts;
 * the real pieces on `hide` stand aside meanwhile). The worker draws these frames one
 * by one, from the frame number alone, so the file is the same on every machine.
 */
export type SceneMotion = { frames: number; ghosts: Ghost[]; hide: Square[] };
type Scene = { frames: number; state: FrameState; motion?: SceneMotion };
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
export function pacing(
  positions: number,
  remarkMoves: number,
  pace: VideoPace,
  /** Frames already spent on lookups and attempts (see `planExtras`). */
  extraFrames = 0,
) {
  const fixedFrames = (TITLE_SECONDS + FINAL_HOLD_SECONDS) * VIDEO_FPS + extraFrames;
  const remarkFrames = REMARK_SECONDS * VIDEO_FPS;
  if (pace !== "auto") {
    return { perMove: Math.max(1, Math.round(Number(pace) * VIDEO_FPS)), remarkExtra: 0 };
  }
  const budget = Math.max(0, X_MAX_SECONDS * VIDEO_FPS - fixedFrames);
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
    /** The position before this one's move (null for the first). */
    before: string | null;
    turn: Color;
    lastMove: string | null;
    moveLabel: string | null;
    remark: { side: Color; text: string } | null;
    clocks: Record<Color, number>;
    evaluation: EngineEvaluation | undefined;
  };
  /**
   * What the video shows, in order: each position, and before a move the turn's
   * lookups and rejected attempts, in the position they were made in.
   */
  type Beat =
    | { kind: "position"; position: Position }
    | { kind: "lookup"; at: Position; lookup: { from: Square; targets: LookupTarget[] } }
    | { kind: "attempt"; at: Position; mark: IllegalMark; turn: string }
    | { kind: "burst"; at: Position; marks: IllegalMark[]; flashes: number };
  const first: Position = {
    fen: chess.fen(),
    before: null,
    turn: chess.turn(),
    lastMove: null,
    moveLabel: null,
    remark: null,
    clocks: { ...remaining },
    evaluation: evaluations.get(chess.fen()),
  };
  const positions: Position[] = [first];
  const beats: Beat[] = [{ kind: "position", position: first }];
  // Positions the spectators scored keep that score: the archive's own evaluations
  // (player-facing or tool calls) only fill positions without one, as in the replay.
  const spectatorScored = new Set(evaluations.keys());
  let replayFailed = false;
  for (const [index, event] of match.events.entries()) {
    const current = positions.at(-1) as Position;
    if (event.type === "timing") {
      // Thinking time is spent before the move it produced, but the runner may
      // record it just after that move. Time of the side to move counts from
      // its next move on; time of the side that just moved belongs to the
      // position it reached.
      remaining[event.side] -= event.elapsedMs;
      if (current.lastMove && current.turn !== event.side) current.clocks = { ...remaining };
    } else if (
      event.type === "evaluation" ||
      (event.type === "tool" && event.name === "engine_eval")
    ) {
      const value = event.type === "evaluation" ? event.evaluation : toolEvaluation(event.output);
      if (value && !spectatorScored.has(value.fen)) {
        evaluations.set(value.fen, value);
        if (current.fen === value.fen) current.evaluation = value;
      }
    } else if (event.type === "tool" && event.name === "legal_moves") {
      if (!options.lookups || replayFailed) continue;
      const lookup = describeLookup(chess, event);
      // A piece with nowhere to go still shows its looked-up square, as on the board.
      if (lookup?.square && lookup.piece)
        beats.push({
          kind: "lookup",
          at: current,
          lookup: { from: lookup.square, targets: lookup.targets },
        });
    } else if (event.type === "attempt" && !event.accepted) {
      if (!options.illegal || replayFailed) continue;
      const mark = illegalMark(chess.fen(), event, index);
      if (mark)
        beats.push({ kind: "attempt", at: current, mark, turn: `${event.ply}${event.side}` });
    } else if (event.type === "attempt" && event.accepted && !replayFailed) {
      const number = chess.moveNumber();
      const mover = chess.turn();
      const before = chess.fen();
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
      const position: Position = {
        fen,
        before,
        turn: chess.turn(),
        lastMove: event.move,
        moveLabel: `${number}${mover === "w" ? "." : "..."} ${san}`,
        remark: text ? { side: mover, text } : null,
        clocks: { ...remaining },
        evaluation: evaluations.get(fen) ?? mated,
      };
      positions.push(position);
      beats.push({ kind: "position", position });
    }
  }
  const { story, scale } = planExtras(beats, options.pace, positions.length);

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
    lookup: null,
    illegal: null,
  };
  const extraFrames = story.reduce((n, beat) => n + beatFrames(beat, scale).total, 0);
  const remarkMoves = positions.filter((p) => p.remark).length;
  const { perMove, remarkExtra } = pacing(positions.length, remarkMoves, options.pace, extraFrames);
  const stateOf = (position: Position): FrameState => ({
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
    remark: position.remark ? { ...position.remark, speaker: name(position.remark.side) } : null,
  });
  const attemptState = (at: Position, mark: IllegalMark, caption: string): FrameState => ({
    ...stateOf(at),
    kind: "attempt",
    remark: null,
    illegal: {
      squares: markSquares(mark),
      caption,
      speaker: name(mark.side),
      flash: mark.kind === "unreadable" ? mark.side : null,
    },
  });
  const scenes: Scene[] = [];
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
  for (const beat of story) {
    if (beat.kind === "position") {
      const { position } = beat;
      const frames = perMove + (position.remark ? remarkExtra : 0);
      // The move slides in during the scene's first frames when the pace leaves room.
      const slideFrames = Math.min(
        Math.round((MOVE_MS / 1000) * VIDEO_FPS),
        Math.floor(frames / 2),
      );
      const slide =
        position.before && position.lastMove && slideFrames >= 2
          ? moveMotion(position.before, position.lastMove, 0)
          : null;
      scenes.push({
        frames,
        state: stateOf(position),
        ...(slide
          ? { motion: { frames: slideFrames, ghosts: slide.ghosts, hide: slide.hide } }
          : {}),
      });
    } else if (beat.kind === "lookup") {
      scenes.push({
        frames: beatFrames(beat, scale).total,
        state: { ...stateOf(beat.at), kind: "lookup", remark: null, lookup: beat.lookup },
      });
    } else if (beat.kind === "attempt") {
      const { total, motion } = beatFrames(beat, scale);
      const moving = illegalMotion(beat.mark);
      scenes.push({
        frames: total,
        state: attemptState(beat.at, beat.mark, illegalCaption(t, beat.mark)),
        ...(motion > 0 && moving.ghosts.length > 0
          ? { motion: { frames: motion, ghosts: moving.ghosts, hide: moving.hide } }
          : {}),
      });
    } else {
      // The rest of a long run of attempts: one quick flash each under a counter.
      const caption = moreAttemptsCaption(t, beat.marks.length);
      const { flash, hold } = beatFrames(beat, scale);
      for (const mark of flashedMarks(beat.marks, beat.flashes)) {
        scenes.push({ frames: flash - 1, state: attemptState(beat.at, mark, caption) });
        const off = attemptState(beat.at, mark, caption);
        scenes.push({
          frames: 1,
          state: { ...off, illegal: off.illegal && { ...off.illegal, squares: [], flash: null } },
        });
      }
      const still = attemptState(beat.at, beat.marks.at(-1) as IllegalMark, caption);
      scenes.push({
        frames: hold,
        state: {
          ...still,
          illegal: still.illegal && { ...still.illegal, squares: [], flash: null },
        },
      });
    }
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
      lookup: null,
      illegal: null,
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

type StoryBeat<P> =
  | { kind: "position"; position: P }
  | { kind: "lookup"; at: P; lookup: unknown }
  | { kind: "attempt"; at: P; mark: IllegalMark; turn: string }
  | { kind: "burst"; at: P; marks: IllegalMark[]; flashes: number };

/**
 * A turn with more than `after` rejected attempts keeps its first `full`; the rest
 * become one burst (a counter with a quick flash each), and that turn's later lookups
 * are dropped with them.
 */
function compressAttempts<P, B extends StoryBeat<P>>(beats: B[], level: Compression): B[] {
  const totals = new Map<string, number>();
  for (const beat of beats)
    if (beat.kind === "attempt") totals.set(beat.turn, (totals.get(beat.turn) ?? 0) + 1);
  const seen = new Map<string, number>();
  const bursts = new Map<string, { kind: "burst"; at: P; marks: IllegalMark[]; flashes: number }>();
  const out: B[] = [];
  let compressing: string | null = null;
  for (const beat of beats) {
    if (beat.kind === "position") compressing = null;
    if (beat.kind === "lookup" && (compressing !== null || !level.lookups)) continue;
    if (beat.kind !== "attempt") {
      out.push(beat);
      continue;
    }
    const count = (seen.get(beat.turn) ?? 0) + 1;
    seen.set(beat.turn, count);
    if ((totals.get(beat.turn) ?? 0) <= level.after || count <= level.full) {
      out.push(beat);
      continue;
    }
    compressing = beat.turn;
    let burst = bursts.get(beat.turn);
    if (!burst) {
      burst = { kind: "burst", at: beat.at, marks: [], flashes: level.flashes };
      bursts.set(beat.turn, burst);
      out.push(burst as B);
    }
    burst.marks.push(beat.mark);
  }
  return out;
}

/** At most `max` of a burst's attempts, evenly spread over it. */
function flashedMarks(marks: IllegalMark[], max: number): IllegalMark[] {
  if (marks.length <= max) return marks;
  return Array.from(
    { length: max },
    (_, i) => marks[Math.floor((i * marks.length) / max)] as IllegalMark,
  );
}

const fps = (seconds: number) => Math.round(seconds * VIDEO_FPS);

/**
 * Frames of one extra beat at `scale` (1 = full length): its total, the part with
 * pieces in motion (an attempt's out-shake-back), and a burst's frames per flash and
 * closing hold.
 */
function beatFrames(
  beat: StoryBeat<unknown>,
  scale: number,
): { total: number; motion: number; flash: number; hold: number } {
  const scaled = (frames: number, min: number) => Math.max(min, Math.round(frames * scale));
  if (beat.kind === "position") return { total: 0, motion: 0, flash: 0, hold: 0 };
  if (beat.kind === "lookup")
    return { total: scaled(fps(LOOKUP_SECONDS), 4), motion: 0, flash: 0, hold: 0 };
  if (beat.kind === "attempt") {
    const slides = beat.mark.kind === "illegal" && beat.mark.piece !== null;
    if (!slides)
      return { total: scaled(fps(STILL_ATTEMPT_SECONDS), 10), motion: 0, flash: 0, hold: 0 };
    const motion = scaled(fps(ILLEGAL_MS / 1000), 8);
    return { total: motion + scaled(fps(ILLEGAL_HOLD_SECONDS), 4), motion, flash: 0, hold: 0 };
  }
  const flash = scaled(FLASH_FRAMES, 2);
  const hold = scaled(fps(0.5), 2);
  return {
    total: flashedMarks(beat.marks, beat.flashes).length * flash + hold,
    motion: 0,
    flash,
    hold,
  };
}

/**
 * The extras to show and their length. A fixed pace keeps them at full length. Auto
 * gives them at most EXTRAS_SHARE of X's budget, counted in the frames they really
 * take (minimum lengths included): at full length when they fit, else shortened
 * evenly as far as needed, else (even the shortest would not fit) compressed harder.
 */
function planExtras<P, B extends StoryBeat<P>>(
  beats: B[],
  pace: VideoPace,
  positions: number,
): { story: B[]; scale: number } {
  const normal = COMPRESSIONS[0] as Compression;
  if (pace !== "auto") return { story: compressAttempts(beats, normal), scale: 1 };
  const budget = (X_MAX_SECONDS - TITLE_SECONDS - FINAL_HOLD_SECONDS) * VIDEO_FPS;
  // Every position keeps at least one frame.
  const cap = Math.max(0, Math.min(budget * EXTRAS_SHARE, budget - positions));
  const total = (story: B[], scale: number) =>
    story.reduce((n, beat) => n + beatFrames(beat, scale).total, 0);
  let story: B[] = [];
  for (const level of COMPRESSIONS) {
    story = compressAttempts(beats, level);
    if (total(story, 1) <= cap) return { story, scale: 1 };
    if (total(story, 0) > cap) continue;
    // The longest even scale that fits (the total only grows with the scale).
    let low = 0;
    let high = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (low + high) / 2;
      if (total(story, mid) <= cap) low = mid;
      else high = mid;
    }
    return { story, scale: low };
  }
  // Even one flash per struggling turn is too long: keep evenly spread turns only.
  return { story: thinned(story, cap), scale: 0 };
}

/** The story with extras kept for evenly spread turns only, within `cap` frames. */
function thinned<P, B extends StoryBeat<P>>(story: B[], cap: number): B[] {
  const extras = story.filter((beat) => beat.kind !== "position");
  const each = Math.max(1, ...extras.map((beat) => beatFrames(beat, 0).total));
  const keep = Math.floor(cap / each);
  if (keep >= extras.length) return story;
  const kept = new Set(
    Array.from({ length: keep }, (_, i) => extras[Math.floor((i * extras.length) / keep)]),
  );
  return story.filter((beat) => beat.kind === "position" || kept.has(beat));
}
