import { Chess, type MatchArchive } from "@cockpit-chess/chess";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { boardIllegal, rejectedAt } from "./board-motion";
import { ChessBoard } from "./chess-board";
import { latestOverlay } from "./legal-lookup";
import { gameSource, useBoardPlayback } from "./use-board-playback";

/**
 * The board a game is played on: it follows the game's latest event, animating each
 * new one in order (the model's lookups, its illegal attempts, then its move). A click
 * ends any motion at once, so input is never blocked. Give it `key={match.id}` so a
 * new game starts still.
 */
export function GameBoard({
  match,
  onMove,
  disabled,
  flipped = false,
  lookups = false,
}: {
  match: MatchArchive;
  onMove: (move: string) => void;
  disabled: boolean;
  flipped?: boolean;
  /** Show the model's legal-move lookups on the board. */
  lookups?: boolean;
}) {
  const { t } = useTranslation("chess");
  const source = useMemo(() => gameSource(match, { lookups }), [match, lookups]);
  const playback = useBoardPlayback(match.events.length - 1, true, source);
  const shown = playback.shown;
  const fen = source.fenAt(shown);
  const lastMove = useMemo(() => {
    for (let i = shown; i >= 0; i--) {
      const event = match.events[i];
      if (event?.type === "attempt" && event.accepted) return event.move;
    }
    return undefined;
  }, [match.events, shown]);
  const lookup = useMemo(
    () =>
      // Gone once the game is over, but only when the board has caught up with its end.
      lookups && (match.status === "running" || shown < match.events.length - 1)
        ? latestOverlay(match.events.slice(0, shown + 1), new Chess(fen))
        : undefined,
    [lookups, match.status, match.events, shown, fen],
  );
  const illegal = useMemo(() => {
    const mark = rejectedAt(match.events, source.fenAt, shown);
    return mark ? boardIllegal(t, mark) : null;
  }, [match.events, source, shown, t]);
  return (
    <ChessBoard
      fen={fen}
      onMove={onMove}
      disabled={disabled}
      flipped={flipped}
      lastMove={lastMove}
      lookup={lookup}
      motion={playback.motion}
      motionMs={playback.ms}
      onMotionEnd={playback.onMotionEnd}
      onInteract={playback.finish}
      illegal={illegal}
      playFen={source.fenAt(match.events.length - 1)}
      inputKey={
        match.turn.type === "idle"
          ? match.events.length
          : `${match.turn.turnId}:${match.turn.expectedSeq}`
      }
    />
  );
}
