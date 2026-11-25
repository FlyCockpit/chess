import { useTranslation } from "react-i18next";
import { type EvalPoint, shortScore } from "./evaluation";

function scoreText(point: EvalPoint | undefined, t: ReturnType<typeof useTranslation>["t"]) {
  if (!point) return t("replay.evalMissing");
  const { mate } = point.evaluation;
  if (mate !== null && mate !== 0)
    return t(mate > 0 ? "replay.evalWhiteMate" : "replay.evalBlackMate", {
      moves: Math.abs(mate),
    });
  return shortScore(point.evaluation);
}

/**
 * Vertical White/Black bar beside the board. White fills from the bottom unless
 * the board is flipped. With no evaluation yet (the start) it sits at even.
 */
export function EvalBar({ point, flipped }: { point: EvalPoint | undefined; flipped: boolean }) {
  const { t } = useTranslation("chess");
  const share = point?.share ?? 0.5;
  const label = point ? t("replay.evalBar", { score: scoreText(point, t) }) : scoreText(point, t);
  const whiteAhead = share >= 0.5;
  return (
    <div
      className={["cc-eval-bar", flipped && "cc-eval-flipped", !point && "cc-eval-none"]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={label}
      title={label}
      data-share={share.toFixed(3)}
    >
      <div className="cc-eval-white" style={{ blockSize: `${(share * 100).toFixed(2)}%` }} />
      <span
        aria-hidden="true"
        className={`cc-eval-score ${whiteAhead ? "cc-eval-score-white" : "cc-eval-score-black"}`}
      >
        {point ? shortScore(point.evaluation) : "–"}
      </span>
    </div>
  );
}

/**
 * Evaluation over the whole game: an SVG area chart with a native range input
 * laid over it, so a click, a tap or the arrow keys jump to that evaluation.
 */
export function EvalGraph({
  series,
  current,
  onSelect,
}: {
  series: readonly EvalPoint[];
  current: EvalPoint | undefined;
  onSelect: (index: number) => void;
}) {
  const { t } = useTranslation("chess");
  if (series.length === 0) return null;
  const width = Math.max(1, series.length - 1);
  const y = (share: number) => (100 - share * 100).toFixed(2);
  // A single evaluation still draws as a flat band across the graph.
  const drawn = series.length > 1 ? series : [series[0], series[0]];
  const line = drawn.map((point, i) => `${i},${y(point?.share ?? 0.5)}`).join(" ");
  const area = `0,100 ${line} ${width},100`;
  const position = current ? series.indexOf(current) : -1;
  const selected = series[Math.max(0, position)];
  return (
    <div className="cc-eval-graph">
      <svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" aria-hidden="true">
        <rect x="0" y="0" width={width} height="100" className="cc-eval-graph-black" />
        <polygon points={area} className="cc-eval-graph-white" />
        <line x1="0" x2={width} y1="50" y2="50" className="cc-eval-graph-mid" />
        {position >= 0 && (
          <line x1={position} x2={position} y1="0" y2="100" className="cc-eval-graph-cursor" />
        )}
      </svg>
      <input
        type="range"
        min={0}
        max={series.length - 1}
        step={1}
        value={Math.max(0, position)}
        aria-label={t("replay.evalGraph")}
        aria-valuetext={
          selected
            ? t("replay.evalGraphPoint", { move: selected.move, score: scoreText(selected, t) })
            : undefined
        }
        onChange={(event) => {
          const point = series[Number(event.target.value)];
          if (point) onSelect(point.index);
        }}
        // A click on the point the range already holds (or on a one-point graph)
        // changes no value, so clicks and Enter select explicitly as well.
        onClick={(event) => {
          const point = series[Number(event.currentTarget.value)];
          if (point) onSelect(point.index);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const point = series[Number(event.currentTarget.value)];
          if (point) onSelect(point.index);
        }}
      />
    </div>
  );
}
