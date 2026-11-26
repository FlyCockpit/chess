import {
  type Color,
  type EngineEvaluation,
  evaluationSchema,
  type MatchArchive,
} from "@cockpit-chess/chess";
import {
  gamePositions,
  missingSpectatorPlies,
  type SpectatorEvaluations,
} from "@cockpit-chess/chess/spectator";

/**
 * Engine evaluations for the evaluation bar, graph and share card. Scores are
 * White's perspective, as the runner stores them. Both kinds the archive
 * records count: post-move observer evaluations and the players' own
 * `engine_eval` tool results.
 */

/** cp is clamped here before mapping; beyond ±10 pawns the bar barely moves anyway. */
const CP_CLAMP = 1000;
/** The usual logistic winning-chances curve (lichess): ±10 pawns ≈ 97.5%, never 100%. */
const CP_SCALE = 0.00368208;

/** The side to move in a FEN. */
function fenTurn(fen: string): Color {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}

/**
 * White's share of the bar, 0..1. A mate score fills it; `mate: 0` means the
 * side to move in the evaluated position is checkmated.
 */
export function whiteShare(evaluation: Pick<EngineEvaluation, "cp" | "mate" | "fen">) {
  if (evaluation.mate !== null) {
    if (evaluation.mate === 0) return fenTurn(evaluation.fen) === "w" ? 0 : 1;
    return evaluation.mate > 0 ? 1 : 0;
  }
  const cp = Math.max(-CP_CLAMP, Math.min(CP_CLAMP, evaluation.cp ?? 0));
  return 1 / (1 + Math.exp(-CP_SCALE * cp));
}

/** "+1.3", "−0.4", "+12", "M3" (White mates), "−M2" (Black mates), "#" for a finished mate. */
export function shortScore(evaluation: Pick<EngineEvaluation, "cp" | "mate">) {
  if (evaluation.mate !== null) {
    if (evaluation.mate === 0) return "#";
    return evaluation.mate > 0 ? `M${evaluation.mate}` : `−M${Math.abs(evaluation.mate)}`;
  }
  const cp = evaluation.cp ?? 0;
  // Whole pawns from ±10 on, so the number fits the narrow bar ("+12", not "+12.4").
  const pawns = Math.abs(cp / 100).toFixed(Math.abs(cp) >= 1000 ? 0 : 1);
  return cp > 0 ? `+${pawns}` : cp < 0 ? `−${pawns}` : "0.0";
}

/** A tool call's output, when it is a valid engine evaluation. */
export function toolEvaluation(output: string): EngineEvaluation | undefined {
  try {
    const result = evaluationSchema.safeParse(JSON.parse(output));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The move number (as a move list counts it) of the move made after `plies`
 * accepted moves, honouring the start position's side to move and fullmove counter.
 */
export function moveNumber(initialFen: string, plies: number) {
  const fields = initialFen.split(" ");
  const fullmove = Math.max(1, Number.parseInt(fields[5] ?? "1", 10) || 1);
  return fullmove + Math.floor((plies + (fields[1] === "b" ? 1 : 0)) / 2);
}

export type EvalPoint = {
  /** Event index of the evaluation; the replay cursor it jumps to shows its position. */
  index: number;
  /** Number of the move the evaluated position follows (or, at the start, precedes). */
  move: number;
  share: number;
  evaluation: EngineEvaluation;
};

/**
 * The evaluations the bar, graph, PNG and MP4 show, in game order (the bar looks
 * positions up in this). The spectators' evaluation of every position when the game has
 * one (`spectator`, stored outside the archive); otherwise, for older games, whatever
 * the archive recorded (player-facing after-move scores and the players' own engine
 * tool calls). Empty when neither exists: the bar is then hidden with a reason.
 */
export function evaluationSeries(
  match: MatchArchive,
  spectator?: SpectatorEvaluations | null,
): EvalPoint[] {
  const scored = spectator ? spectatorSeries(match, spectator) : [];
  if (!scored.length) return archiveSeries(match);
  // Spectator scores win per exact position; the archive's fill the positions the
  // spectators have not scored (yet), so a sparse backfill never hides a score.
  const covered = new Set(scored.map((point) => point.evaluation.fen));
  return [
    ...scored,
    ...archiveSeries(match).filter((point) => !covered.has(point.evaluation.fen)),
  ].sort((a, b) => a.index - b.index);
}

/** One point per evaluated position, at the event that reached it (-1: the start). */
function spectatorSeries(match: MatchArchive, spectator: SpectatorEvaluations): EvalPoint[] {
  let positions: string[];
  try {
    positions = gamePositions(match);
  } catch {
    return [];
  }
  const reachedAt = [-1];
  for (const [index, event] of match.events.entries())
    if (event.type === "attempt" && event.accepted) reachedAt.push(index);
  const points: EvalPoint[] = [];
  for (const [ply, fen] of positions.entries()) {
    const evaluation = spectator[String(ply)];
    // Only a score of exactly this position counts (never a stale one).
    if (!evaluation || evaluation.fen !== fen) continue;
    points.push({
      index: reachedAt[ply] ?? -1,
      move: moveNumber(match.config.initialFen, Math.max(0, ply - 1)),
      share: whiteShare(evaluation),
      evaluation,
    });
  }
  return points;
}

function archiveSeries(match: MatchArchive): EvalPoint[] {
  const points: EvalPoint[] = [];
  let plies = 0;
  for (const [index, event] of match.events.entries()) {
    if (event.type === "attempt" && event.accepted) plies += 1;
    const evaluation =
      event.type === "evaluation"
        ? event.evaluation
        : event.type === "tool" && event.name === "engine_eval"
          ? toolEvaluation(event.output)
          : undefined;
    if (!evaluation) continue;
    points.push({
      index,
      move: moveNumber(match.config.initialFen, Math.max(0, plies - 1)),
      share: whiteShare(evaluation),
      evaluation,
    });
  }
  return points;
}

/**
 * The graph's points: one per position as the game went, so an observer score
 * and a player's tool call on the same position draw once (the later one).
 */
export function graphSeries(series: readonly EvalPoint[]): EvalPoint[] {
  const points: EvalPoint[] = [];
  for (const point of series) {
    if (points.at(-1)?.evaluation.fen === point.evaluation.fen) points[points.length - 1] = point;
    else points.push(point);
  }
  return points;
}

/** The latest point at or before a replay cursor (-1 = the start), or undefined. */
export function pointAt(series: readonly EvalPoint[], index: number) {
  let found: EvalPoint | undefined;
  for (const point of series) {
    if (point.index > index) break;
    found = point;
  }
  return found;
}

/** The evaluation of exactly the position on the board at the cursor, if one was recorded by then. */
export function pointForPosition(series: readonly EvalPoint[], index: number, fen: string) {
  let found: EvalPoint | undefined;
  for (const point of series) {
    if (point.index > index) break;
    if (point.evaluation.fen === fen) found = point;
  }
  return found;
}

/**
 * The graph point standing for the evaluation the bar shows: the drawn
 * representative of its run of same-position evaluations. Falls back to the
 * latest graph point reached when the board's position has no evaluation.
 */
export function graphCursor(
  graph: readonly EvalPoint[],
  exact: EvalPoint | undefined,
  index: number,
) {
  if (exact) {
    const drawn = graph.find(
      (point) => point.index >= exact.index && point.evaluation.fen === exact.evaluation.fen,
    );
    if (drawn) return drawn;
  }
  return pointAt(graph, index);
}

/** Each query's refetch count when its game was first seen finished. */
const finishedAtFetch = new WeakMap<object, number>();
/**
 * `refetchInterval` for a game view's query: counts the finished-game polling allowance
 * from when the game was first seen finished, not from the live game's many polls.
 */
export function replayRefetch(query: {
  state: {
    /** A null archive is an old-rules game: nothing to poll. */
    data?: { archive: MatchArchive | null; spectatorEvaluations: SpectatorEvaluations | null };
    dataUpdateCount: number;
  };
}) {
  const { data, dataUpdateCount } = query.state;
  if (!data?.archive) return false;
  if (data.archive.status !== "running" && !finishedAtFetch.has(query))
    finishedAtFetch.set(query, dataUpdateCount);
  return replayRefetchInterval(
    { archive: data.archive, spectatorEvaluations: data.spectatorEvaluations },
    dataUpdateCount - (finishedAtFetch.get(query) ?? dataUpdateCount),
  );
}
/** Polls a finished game's spectator scores for at most this many refetches (~6 min). */
const SPECTATOR_POLLS = 36;
/**
 * How often a game view refetches: every 2 s while the game runs; every 10 s for a
 * bounded while when a finished game still lacks spectator scores (the run's last
 * positions, or a backfill the read just asked for); otherwise not at all.
 */
export function replayRefetchInterval(
  data: { archive: MatchArchive; spectatorEvaluations: SpectatorEvaluations | null } | undefined,
  fetches: number,
) {
  if (!data) return false;
  if (data.archive.status === "running") return 2000;
  if (fetches >= SPECTATOR_POLLS) return false;
  try {
    return missingSpectatorPlies(data.archive, data.spectatorEvaluations).length ? 10_000 : false;
  } catch {
    return false;
  }
}
