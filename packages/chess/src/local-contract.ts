import type { MatchArchive, MatchConfig } from "./index";
export interface LocalState {
  match: MatchArchive;
  busy: boolean;
  providerReady: boolean;
}
/** Shared browser/CLI contract; credentials and filesystem paths never cross it. */
export type LocalClient = {
  state: (input?: Record<string, never>) => Promise<LocalState>;
  create: (input: MatchConfig) => Promise<LocalState>;
  move: (input: { move: string; expectedSeq: number }) => Promise<LocalState>;
  stop: (input?: Record<string, never>) => Promise<LocalState>;
};
