import { Chess, type Color, type PieceSymbol, type Square } from "@cockpit-chess/chess";
import { type CSSProperties, memo, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WideContent } from "@/components/wide-content";
import type { BoardIllegal, BoardMotion } from "./board-motion";
import type { LookupOverlay } from "./legal-lookup";
import { PIECE_PATHS, PIECE_VIEWBOX } from "./piece-paths";

/**
 * One piece, drawn from the bundled outlines (piece-paths.ts), never from a font
 * glyph. Decorative: the square's accessible name says which piece stands there.
 */
function Piece({
  piece,
  hidden = false,
}: {
  piece: { color: Color; type: PieceSymbol };
  hidden?: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${PIECE_VIEWBOX} ${PIECE_VIEWBOX}`}
      className={`cc-piece ${piece.color === "w" ? "cc-white-piece" : "cc-black-piece"} ${hidden ? "cc-piece-hidden" : ""}`}
    >
      <path d={PIECE_PATHS[piece.type]} />
    </svg>
  );
}

/** A square's place on the displayed board: column and row from the top-left corner. */
function place(square: Square, flipped: boolean) {
  const column = square.charCodeAt(0) - 97;
  const row = 8 - Number(square[1]);
  return flipped ? { column: 7 - column, row: 7 - row } : { column, row };
}

/**
 * The pieces in motion, over the squares (decorative; the event text carries the
 * meaning). The clock is an invisible element whose CSS animation lasts exactly the
 * motion, so its end reports the motion's end even with reduced motion, when the
 * pieces themselves stand still.
 */
function MotionLayer({
  motion,
  ms,
  flipped,
  onEnd,
}: {
  motion: BoardMotion;
  ms: number;
  flipped: boolean;
  onEnd?: (motion: BoardMotion) => void;
}) {
  const sign = flipped ? -1 : 1;
  return (
    <div className="cc-motion-layer" aria-hidden="true">
      {motion.ghosts.map((ghost, i) => {
        const at = place(ghost.from, flipped);
        const style = {
          "--x": at.column,
          "--y": at.row,
          "--dx": sign * (ghost.to.charCodeAt(0) - ghost.from.charCodeAt(0)),
          "--dy": sign * (Number(ghost.from[1]) - Number(ghost.to[1])),
          "--motion-ms": `${ms}ms`,
        } as CSSProperties;
        return (
          <span
            // A new motion is a new element, so its animation starts from the beginning.
            key={`${motion.index}-${motion.kind}-${i}`}
            className={`cc-ghost cc-ghost-${ghost.effect}`}
            style={style}
          >
            <Piece piece={ghost.piece} />
          </span>
        );
      })}
      <span
        key={`${motion.index}-${motion.kind}-${ms}`}
        className="cc-motion-clock"
        style={{ "--motion-ms": `${ms}ms` } as CSSProperties}
        onAnimationEnd={() => onEnd?.(motion)}
      />
    </div>
  );
}
export const ChessBoard = memo(function ChessBoard({
  fen,
  onMove,
  disabled = false,
  flipped = false,
  lastMove,
  lookup,
  motion,
  motionMs = 0,
  onMotionEnd,
  onInteract,
  illegal,
  playFen,
  inputKey,
  announce = false,
}: {
  fen: string;
  onMove?: (move: string) => void;
  disabled?: boolean;
  flipped?: boolean;
  lastMove?: string;
  /** A model's legal-move lookup: decorative marks only; the event text carries the meaning. */
  lookup?: LookupOverlay;
  /** The motion leading into this position (`use-board-playback`); null when still. */
  motion?: BoardMotion | null;
  /** How long the motion runs now (shorter while more events wait). */
  motionMs?: number;
  onMotionEnd?: (motion: BoardMotion) => void;
  /** A click on the playable board: ends any motion first, so input is never blocked. */
  onInteract?: () => void;
  /** A rejected attempt to outline, with its caption. */
  illegal?: BoardIllegal | null;
  /**
   * The position the next move is played in, when the board still shows an earlier
   * one (catching up with a game). A click snaps the board to it, and selection and
   * moves always follow it, never the position on screen mid-motion.
   */
  playFen?: string;
  /** A new authoritative turn invalidates input even when its FEN is unchanged. */
  inputKey?: string | number;
  /** Announce each rejected attempt politely as the board shows it. */
  announce?: boolean;
}) {
  const { t } = useTranslation("chess");
  const [selection, setSelection] = useState<{
    square: Square;
    version: object;
  } | null>(null);
  const [promotion, setPromotion] = useState<{
    from: Square;
    to: Square;
    version: object;
  } | null>(null);
  const shown = useMemo(() => new Chess(fen), [fen]);
  const live = playFen ?? fen;
  // A committed input epoch, independent of board animation. New props hide
  // old selection/promotion immediately; the ref callback retires gestures
  // before browser events can run, without mutating refs during render.
  const playable = Boolean(onMove);
  const version = useMemo(
    () => ({ live, inputKey, disabled, playable }),
    [live, inputKey, disabled, playable],
  );
  const input = useRef({ version, disabled, locked: false });
  const drag = useRef<{
    pointerId: number;
    from: Square;
    x: number;
    y: number;
    moved: boolean;
    version: object;
  } | null>(null);
  const suppressClick = useRef(false);
  const chess = useMemo(() => (live === fen ? shown : new Chess(live)), [live, fen, shown]);
  const squares = useMemo(() => {
    const list = shown.board().flatMap((row, rowIndex) =>
      row.map((piece, columnIndex) => ({
        piece,
        square: `${"abcdefgh"[columnIndex]}${8 - rowIndex}` as Square,
        rowIndex,
        columnIndex,
      })),
    );
    if (flipped) list.reverse();
    return list;
  }, [shown, flipped]);
  const selected = selection?.version === version && !disabled && onMove ? selection.square : null;
  const activePromotion = promotion?.version === version && onMove && !disabled ? promotion : null;
  const targets = useMemo(
    () => (selected ? chess.moves({ square: selected, verbose: true }).map((move) => move.to) : []),
    [chess, selected],
  );
  const hidden = motion ? motion.hide : [];
  const outlined = illegal?.squares ?? [];
  // The caption covers an edge rank that holds no outlined square: the bottom one, else
  // the top one, else (both edge ranks outlined) the middle of the board.
  const outlinedRows = outlined.map((square) => place(square, flipped).row);
  const captionAt = !outlinedRows.includes(7) ? "" : !outlinedRows.includes(0) ? "top" : "middle";
  function send(move: string) {
    if (!onMove || disabled || input.current.locked || input.current.version !== version) return;
    input.current.locked = true;
    setPromotion(null);
    setSelection(null);
    onMove(move);
  }
  function move(from: Square, to: Square) {
    if (!chess.moves({ square: from, verbose: true }).some((candidate) => candidate.to === to))
      return false;
    if (chess.get(from)?.type === "p" && (to[1] === "8" || to[1] === "1"))
      setPromotion({ from, to, version });
    else send(`${from}${to}`);
    return true;
  }
  function choose(square: Square) {
    if (
      !onMove ||
      disabled ||
      activePromotion ||
      input.current.locked ||
      input.current.version !== version
    )
      return;
    onInteract?.();
    if (selected && move(selected, square)) return;
    setSelection(chess.get(square)?.color === chess.turn() ? { square, version } : null);
  }
  return (
    <div className="cc-board-wrap">
      <WideContent>
        <div
          ref={(node) => {
            if (!node) return;
            if (input.current.version !== version) {
              if (drag.current) suppressClick.current = true;
              drag.current = null;
              input.current = { version, disabled, locked: false };
            }
            // A single-finger piece drag owns its gesture. Keep the global
            // touch-action and pinch zoom; scrolling still works from empty or
            // opposing squares. React's delegated touch listeners are passive,
            // so this narrowly scoped native listener must opt out of that.
            const moveTouch = (event: TouchEvent) => {
              if (event.touches.length === 1 && drag.current && !input.current.disabled)
                event.preventDefault();
            };
            node.addEventListener("touchmove", moveTouch, { passive: false });
            return () => node.removeEventListener("touchmove", moveTouch);
          }}
          className={`cc-board ${onMove ? "cc-playable-board" : ""}`}
          role="group"
          aria-label={t("board.label")}
        >
          {squares.map(({ piece, square, rowIndex, columnIndex }, index) => (
            <button
              type="button"
              key={square}
              onClick={(event) => {
                if (suppressClick.current && event.detail !== 0) {
                  suppressClick.current = false;
                  return;
                }
                suppressClick.current = false;
                choose(square);
              }}
              onPointerDown={(event) => {
                if (
                  !onMove ||
                  disabled ||
                  activePromotion ||
                  input.current.locked ||
                  input.current.version !== version ||
                  drag.current ||
                  !event.isPrimary ||
                  event.button !== 0
                )
                  return;
                suppressClick.current = false;
                if (chess.get(square)?.color !== chess.turn()) return;
                onInteract?.();
                drag.current = {
                  pointerId: event.pointerId,
                  from: square,
                  x: event.clientX,
                  y: event.clientY,
                  moved: false,
                  version,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const current = drag.current;
                if (
                  !current ||
                  current.pointerId !== event.pointerId ||
                  current.version !== version
                )
                  return;
                if (
                  !current.moved &&
                  Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 8
                ) {
                  current.moved = true;
                  setSelection({ square: current.from, version });
                }
              }}
              onPointerUp={(event) => {
                const current = drag.current;
                if (!current || current.pointerId !== event.pointerId) return;
                drag.current = null;
                if (current.version !== version) return;
                const moved =
                  current.moved ||
                  Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 8;
                if (!moved) return;
                suppressClick.current = true;
                setSelection(null);
                const rect = event.currentTarget.parentElement?.getBoundingClientRect();
                if (
                  !rect ||
                  event.clientX < rect.left ||
                  event.clientX >= rect.right ||
                  event.clientY < rect.top ||
                  event.clientY >= rect.bottom
                )
                  return;
                const column = Math.floor(((event.clientX - rect.left) / rect.width) * 8);
                const row = Math.floor(((event.clientY - rect.top) / rect.height) * 8);
                const to =
                  `${"abcdefgh"[flipped ? 7 - column : column]}${flipped ? row + 1 : 8 - row}` as Square;
                move(current.from, to);
              }}
              onPointerCancel={(event) => {
                if (drag.current?.pointerId !== event.pointerId) return;
                suppressClick.current = true;
                drag.current = null;
                setSelection(null);
              }}
              onLostPointerCapture={(event) => {
                if (drag.current?.pointerId !== event.pointerId) return;
                suppressClick.current = true;
                drag.current = null;
                setSelection(null);
              }}
              disabled={disabled || !onMove}
              aria-label={
                piece
                  ? t("board.pieceSquare", {
                      color: t(`colors.${piece.color}`),
                      piece: t(`pieces.${piece.type}`),
                      square,
                    })
                  : t("board.emptySquare", { square })
              }
              aria-pressed={selected === square}
              className={`cc-square ${(rowIndex + columnIndex) % 2 === 0 ? "cc-light" : "cc-dark"} ${selected === square ? "cc-selected" : ""} ${lastMove?.slice(0, 2) === square || lastMove?.slice(2, 4) === square ? "cc-last" : ""}`}
              onKeyDown={(event) => {
                const delta = {
                  ArrowLeft: -1,
                  ArrowRight: 1,
                  ArrowUp: -8,
                  ArrowDown: 8,
                }[event.key];
                if (delta === undefined) return;
                event.preventDefault();
                const next = event.currentTarget.parentElement?.children.item(
                  Math.max(0, Math.min(63, index + delta)),
                );
                if (next instanceof HTMLElement) next.focus();
              }}
            >
              {piece && <Piece piece={piece} hidden={hidden.includes(square)} />}
              {outlined.includes(square) && (
                <span key={illegal?.index} aria-hidden="true" className="cc-illegal-ring" />
              )}
              {lookup?.from === square && <span aria-hidden="true" className="cc-lookup-from" />}
              {lookup?.targets.map(
                (target) =>
                  target.square === square && (
                    <span
                      key={target.square}
                      aria-hidden="true"
                      className={target.capture ? "cc-lookup-capture" : "cc-lookup-target"}
                    />
                  ),
              )}
              {targets.includes(square) && (
                <span aria-hidden="true" className={piece ? "cc-capture-target" : "cc-target"} />
              )}
              {(flipped ? columnIndex === 7 : columnIndex === 0) && (
                <span aria-hidden="true" className="cc-rank">
                  {8 - rowIndex}
                </span>
              )}
              {(flipped ? rowIndex === 0 : rowIndex === 7) && (
                <span aria-hidden="true" className="cc-file">
                  {"abcdefgh"[columnIndex]}
                </span>
              )}
            </button>
          ))}
          {motion && (
            <MotionLayer motion={motion} ms={motionMs} flipped={flipped} onEnd={onMotionEnd} />
          )}
          {illegal && (
            <p
              aria-hidden="true"
              key={illegal.index}
              className={`cc-illegal-caption ${captionAt ? `cc-illegal-caption-${captionAt}` : ""}`}
            >
              {illegal.caption}
            </p>
          )}
        </div>
      </WideContent>
      {/* The caption for assistive tech: one polite region that stays mounted, so each
          attempt the board shows is announced once, in the order it plays. Each attempt
          is its own child node (keyed by its event), so two that read alike are still
          two additions, and both are announced. */}
      <p className="sr-only" aria-live={announce ? "polite" : "off"}>
        {illegal && <span key={illegal.index}>{illegal.caption}</span>}
      </p>
      {activePromotion && (
        <div className="cc-promotion" role="group" aria-label={t("board.promote")}>
          {(["q", "r", "b", "n"] as const).map((piece) => (
            <button
              key={piece}
              type="button"
              onClick={() => {
                send(`${activePromotion.from}${activePromotion.to}${piece}`);
              }}
            >
              {t(`pieces.${piece}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
