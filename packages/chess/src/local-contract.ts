import type { MatchArchive, MatchConfig } from "./index";
import type { SpectatorEvaluations } from "./spectator";
export interface LocalState {
  match: MatchArchive;
  busy: boolean;
  providerReady: boolean;
  /**
   * Spectator-only engine scores of the game's positions (never sent to the players).
   * `available` is false when this companion has no engine (a compiled binary) or its
   * engine failed; the lab then hides the evaluation bar and says why.
   */
  spectator: { evaluations: SpectatorEvaluations; available: boolean };
}
/** Shared browser/CLI contract; credentials and filesystem paths never cross it. */
export type LocalClient = {
  state: (input?: Record<string, never>) => Promise<LocalState>;
  create: (input: MatchConfig) => Promise<LocalState>;
  move: (input: { move: string; expectedSeq: number }) => Promise<LocalState>;
  stop: (input?: Record<string, never>) => Promise<LocalState>;
};
