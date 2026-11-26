import { DEFAULT_POSITION } from "@cockpit-chess/chess";
import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { ChessBoard } from "./chess-board";
import { PIECE_PATHS } from "./piece-paths";

const i18n = createInstance();
await i18n.init({
  lng: "en-US",
  resources: { "en-US": { chess: enChess } },
  defaultNS: "chess",
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function render(fen: string) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ChessBoard fen={fen} />
    </I18nextProvider>,
  );
}

function squares(html: string) {
  return [...html.matchAll(/<button[^>]*aria-label="([^"]*)"[^>]*>(.*?)<\/button>/g)].map(
    ([, label, inner]) => ({ label: label ?? "", inner: inner ?? "" }),
  );
}

describe("ChessBoard pieces", () => {
  it("draws each piece as a decorative SVG outline in its colour, never as a font glyph", () => {
    const html = render(DEFAULT_POSITION);
    // No chess symbol anywhere: an emoji presentation (U+265F on Apple systems) can't apply.
    expect(html).not.toMatch(/[♔-♟]/u);
    const board = squares(html);
    expect(board).toHaveLength(64);
    const e2 = board.find((square) => square.label.endsWith("e2"));
    expect(e2?.inner).toMatch(
      /<svg aria-hidden="true" focusable="false" viewBox="0 0 100 100" class="cc-piece cc-white-piece\s*">/,
    );
    expect(e2?.inner).toContain(`<path d="${PIECE_PATHS.p}"></path>`);
    const e7 = board.find((square) => square.label.endsWith("e7"));
    expect(e7?.inner).toContain("cc-black-piece");
    expect(e7?.inner).toContain(`<path d="${PIECE_PATHS.p}"></path>`);
    // Every white piece on ranks 1–2 and every black one on 7–8, each with its own outline.
    const pieces = board.filter((square) => square.inner.includes("<svg"));
    expect(pieces).toHaveLength(32);
    for (const square of pieces) {
      const rank = Number(square.label.at(-1));
      expect(square.inner).toContain(rank <= 2 ? "cc-white-piece" : "cc-black-piece");
      expect(square.inner).toContain('aria-hidden="true"');
    }
    const kings = pieces.filter((square) => square.inner.includes(PIECE_PATHS.k));
    expect(kings.map((square) => square.label.slice(-2)).sort()).toEqual(["e1", "e8"]);
  });

  it("keeps each square's accessible name, empty or not", () => {
    const html = render(DEFAULT_POSITION);
    const labels = squares(html).map((square) => square.label);
    expect(labels).toContain("White pawn on e2");
    expect(labels).toContain("Black king on e8");
    expect(labels).toContain("Empty square e4");
    expect(labels.filter((label) => label.startsWith("Empty square"))).toHaveLength(32);
  });
});
