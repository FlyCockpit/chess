import chessEn from "@locales/en-US/chess.json";
import i18next from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { HeroBoard } from "../../src/components/chess/hero-board";
import "../../src/index.css";

/**
 * Browser side of the hero board check (scripts/hero-board-check.ts): the landing
 * page's hero layout with the real HeroBoard and stylesheet, and a measurement of
 * every piece, corner label, square and the caption.
 */
const FENS = {
  // Every square of ranks 1, 2, 7 and 8 occupied: corner labels sit beside pieces.
  start: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  middlegame: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5",
};
const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  defaultNS: "chess",
  resources: { en: { chess: chessEn } },
  interpolation: { escapeValue: false },
});
const root = createRoot(document.getElementById("root") as HTMLElement);

type Rect = { x: number; y: number; width: number; height: number };
const box = (rect: DOMRect): Rect => ({
  x: rect.x,
  y: rect.y,
  width: rect.width,
  height: rect.height,
});
/** The glyph's ink box on the page, from the span's box and the font's measured ink. */
function inkBox(span: HTMLElement): Rect {
  const style = getComputedStyle(span);
  const ctx = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const metrics = ctx.measureText(span.textContent ?? "");
  const outer = span.getBoundingClientRect();
  // The span is an inline line box of line-height 1 centred in its square: its
  // baseline sits where the font's ascent places it inside that box.
  const contentHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  const baseline = outer.y + outer.height / 2 - contentHeight / 2 + metrics.fontBoundingBoxAscent;
  const left = outer.x + outer.width / 2 - metrics.width / 2;
  return {
    x: left - metrics.actualBoundingBoxLeft,
    y: baseline - metrics.actualBoundingBoxAscent,
    width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
    height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
  };
}

async function measure(fen: keyof typeof FENS, dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  root.render(
    <I18nextProvider i18n={i18n}>
      {/* The hosted landing page's ancestors (src/components/public-shell.tsx): the
          shell, its header and the bounded main scroller with its overflow rules and
          content column, so any clipping they introduce reaches the corner hit-tests.
          Keep in step with it. */}
      <div className="cc-public-shell">
        <header className="cc-header">
          <div className="cc-header-row">
            <span className="cc-brand">Cockpit Chess</span>
          </div>
        </header>
        <main className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain">
          <div className="flex min-h-full min-w-0 flex-col">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="cc-app">
                <section className="cc-hero">
                  <div>
                    <h1>The board doesn't bluff</h1>
                  </div>
                  <HeroBoard fen={FENS[fen]} />
                </section>
              </div>
            </div>
          </div>
        </main>
      </div>
    </I18nextProvider>,
  );
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
  await document.fonts.ready;
  const board = document.querySelector(".cc-hero-board") as HTMLElement;
  const caption = document.querySelector(".cc-hero-sticker") as HTMLElement;
  const figure = document.querySelector(".cc-hero-figure") as HTMLElement;
  // Hit-testing sees only the viewport: bring the whole figure into it first.
  figure.scrollIntoView({ block: "center" });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  // The board element rotated about its centre: its true corners on the page.
  const angle =
    (new DOMMatrix(getComputedStyle(board).transform).b > 0 ? 1 : -1) *
    Math.asin(Math.abs(new DOMMatrix(getComputedStyle(board).transform).b));
  const outer = board.getBoundingClientRect();
  const cx = outer.x + outer.width / 2;
  const cy = outer.y + outer.height / 2;
  const w = board.offsetWidth / 2;
  const h = board.offsetHeight / 2;
  const corners = [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ].map(([x = 0, y = 0]) => ({
    x: cx + x * Math.cos(angle) - y * Math.sin(angle),
    y: cy + x * Math.sin(angle) + y * Math.cos(angle),
  }));
  const caption_ = box(caption.getBoundingClientRect());
  // Paint visibility of each tilted corner: hit-testing honours every clipping
  // ancestor, so a clipped corner is not the board (or within it) at that point.
  const cornersVisible = corners.map(({ x, y }) => {
    // Inset past the rounded corner (border-radius cuts the hit area too).
    const inward = { x: x + (cx - x) * 0.06, y: y + (cy - y) * 0.06 };
    const hits = document.elementsFromPoint(inward.x, inward.y);
    return hits.some((element) => element === board || board.contains(element))
      ? null
      : `${Math.round(inward.x)},${Math.round(inward.y)}: ${hits
          .slice(0, 3)
          .map((element) => element.className || element.tagName)
          .join(" > ")}`;
  });
  // Pieces and labels are measured on the untilted board (the tilt turns the whole
  // board rigidly, so what holds flat holds tilted).
  board.style.transform = "none";
  const squares = [...document.querySelectorAll<HTMLElement>(".cc-hero-board .cc-square")].map(
    (square) => {
      const piece = square.querySelector<HTMLElement>(".cc-piece");
      return {
        square: box(square.getBoundingClientRect()),
        size: square.offsetWidth,
        piece: piece ? inkBox(piece) : null,
        labels: [...square.querySelectorAll<HTMLElement>(".cc-rank, .cc-file")].map((label) =>
          box(label.getBoundingClientRect()),
        ),
      };
    },
  );
  board.style.transform = "";
  // The caption must be painted where it sits (not clipped by an ancestor).
  const captionBox = caption.getBoundingClientRect();
  const captionPainted = document
    .elementsFromPoint(captionBox.x + captionBox.width / 2, captionBox.y + captionBox.height / 2)
    .some((element) => element === caption || caption.contains(element));
  return {
    corners,
    cornersVisible,
    captionPainted,
    caption: caption_,
    figure: box(figure.getBoundingClientRect()),
    viewport: { width: innerWidth, height: innerHeight },
    overflowX: document.documentElement.scrollWidth > innerWidth,
    captionColor: getComputedStyle(caption).color,
    captionBackground: getComputedStyle(caption).backgroundColor,
    squares,
  };
}

(window as unknown as { heroBoard: unknown }).heroBoard = { measure };
document.title = "ready";
