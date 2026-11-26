import { z } from "zod";
import { applyUci, Chess, evaluationSchema, type MatchArchive } from "./index";

/**
 * Spectator evaluation: an engine score of every position of a game, for the people
 * watching (evaluation bar, graph, PNG, MP4). It is not a rule and never reaches the
 * players: it is stored outside the archive (`chess_match.spectatorEvaluations`, the
 * local lab's state), computed in the background on its own engine lane after each
 * move is committed, and a failure only leaves positions unevaluated. Player-facing
 * evaluation stays the separate `engineEvaluation` rule.
 *
 * Keyed by ply: "0" is the start position, "n" the position after n accepted moves.
 */
export const spectatorEvaluationsSchema = z.record(
  z.string().regex(/^(?:0|[1-9]\d{0,4})$/),
  // A stored score has exactly one of cp / mate (the engine always sets one); an entry
  // with neither would read as an invented 0.0 and stop the position being backfilled.
  evaluationSchema.refine((evaluation) => (evaluation.cp === null) !== (evaluation.mate === null), {
    message: "A spectator score has exactly one of cp or mate",
  }),
);
export type SpectatorEvaluations = z.infer<typeof spectatorEvaluationsSchema>;
/**
 * Stored values are read leniently, entry by entry: a malformed entry (or a stored
 * value that is not an object) reads as "not evaluated" without hiding the valid ones,
 * so a backfill can fill it in.
 */
export const storedSpectatorEvaluations = {
  parse(value: unknown): SpectatorEvaluations | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out: SpectatorEvaluations = {};
    for (const [ply, entry] of Object.entries(value)) {
      const parsed = spectatorEvaluationsSchema.safeParse({ [ply]: entry });
      if (parsed.success) Object.assign(out, parsed.data);
    }
    return out;
  },
};

/** The FEN of every position of the game, by ply (accepted attempts only, as `boardAt`). */
export function gamePositions(match: MatchArchive): string[] {
  const chess = new Chess(match.config.initialFen);
  const positions = [chess.fen()];
  for (const event of match.events) {
    if (event.type !== "attempt" || !event.accepted) continue;
    applyUci(chess, event.move);
    positions.push(chess.fen());
  }
  return positions;
}

/** Plies whose position has no spectator evaluation of that exact position yet. */
export function missingSpectatorPlies(
  match: MatchArchive,
  evaluations: SpectatorEvaluations | null,
): number[] {
  return gamePositions(match).flatMap((fen, ply) =>
    evaluations?.[String(ply)]?.fen === fen ? [] : [ply],
  );
}
