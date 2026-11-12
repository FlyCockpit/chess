import { Chess, type Square } from "@cockpit-chess/chess";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { WideContent } from "@/components/wide-content";

const glyphs = {
  wk: "♚",
  wq: "♛",
  wr: "♜",
  wb: "♝",
  wn: "♞",
  wp: "♟",
  bk: "♚",
  bq: "♛",
  br: "♜",
  bb: "♝",
  bn: "♞",
  bp: "♟",
};
export const ChessBoard = memo(function ChessBoard({
  fen,
  onMove,
  disabled = false,
  flipped = false,
  lastMove,
}: {
  fen: string;
  onMove?: (move: string) => void;
  disabled?: boolean;
  flipped?: boolean;
  lastMove?: string;
}) {
  const { t } = useTranslation("chess");
  const [selectedSquare, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const chess = useMemo(() => new Chess(fen), [fen]);
  const squares = useMemo(() => {
    const list = chess.board().flatMap((row, rowIndex) =>
      row.map((piece, columnIndex) => ({
        piece,
        square: `${"abcdefgh"[columnIndex]}${8 - rowIndex}` as Square,
        rowIndex,
        columnIndex,
      })),
    );
    if (flipped) list.reverse();
    return list;
  }, [chess, flipped]);
  // A selection survives a position change only while it still holds a piece
  // of the side to move; otherwise it is stale and ignored.
  const selected =
    selectedSquare && chess.get(selectedSquare)?.color === chess.turn() ? selectedSquare : null;
  // Same rule for an open promotion picker: it belongs to one pawn of the side to
  // move, and closes once the position or interactivity no longer allows that move.
  const promotionPiece = promotion ? chess.get(promotion.from) : undefined;
  const activePromotion =
    promotion &&
    onMove &&
    !disabled &&
    promotionPiece?.type === "p" &&
    promotionPiece.color === chess.turn()
      ? promotion
      : null;
  const targets = useMemo(
    () => (selected ? chess.moves({ square: selected, verbose: true }).map((move) => move.to) : []),
    [chess, selected],
  );
  function choose(square: Square) {
    if (!onMove || disabled || activePromotion) return;
    if (selected && targets.includes(square)) {
      const piece = chess.get(selected);
      if (piece?.type === "p" && (square[1] === "8" || square[1] === "1"))
        setPromotion({ from: selected, to: square });
      else {
        onMove(`${selected}${square}`);
        setSelected(null);
      }
    } else setSelected(chess.get(square)?.color === chess.turn() ? square : null);
  }
  return (
    <div className="cc-board-wrap">
      <WideContent>
        <div
          className={`cc-board ${onMove ? "cc-playable-board" : ""}`}
          role="group"
          aria-label={t("board.label")}
        >
          {squares.map(({ piece, square, rowIndex, columnIndex }, index) => (
            <button
              type="button"
              key={square}
              onClick={() => choose(square)}
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
                const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 }[
                  event.key
                ];
                if (delta === undefined) return;
                event.preventDefault();
                const next = event.currentTarget.parentElement?.children.item(
                  Math.max(0, Math.min(63, index + delta)),
                );
                if (next instanceof HTMLElement) next.focus();
              }}
            >
              {piece && (
                <span
                  aria-hidden="true"
                  className={`cc-piece ${piece.color === "w" ? "cc-white-piece" : "cc-black-piece"}`}
                >
                  {glyphs[`${piece.color}${piece.type}`]}
                </span>
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
        </div>
      </WideContent>
      {activePromotion && (
        <div className="cc-promotion" role="group" aria-label={t("board.promote")}>
          {(["q", "r", "b", "n"] as const).map((piece) => (
            <button
              key={piece}
              type="button"
              onClick={() => {
                onMove?.(`${activePromotion.from}${activePromotion.to}${piece}`);
                setPromotion(null);
                setSelected(null);
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
