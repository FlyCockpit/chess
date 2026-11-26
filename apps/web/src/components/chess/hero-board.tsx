import { useTranslation } from "react-i18next";
import { ChessBoard } from "./chess-board";

/**
 * The landing page's tilted board. Its caption sits below the board, never over its
 * squares; pieces and corner labels scale with the board (see `.cc-hero-*` in
 * index.css). `pnpm -F web test:hero` checks the layout in a real browser.
 */
export function HeroBoard({ fen }: { fen: string }) {
  const { t } = useTranslation("chess");
  return (
    <figure className="cc-hero-figure">
      <div className="cc-hero-board">
        <ChessBoard fen={fen} />
      </div>
      <figcaption className="cc-hero-sticker">{t("hero.live")}</figcaption>
    </figure>
  );
}
