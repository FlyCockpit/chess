import { type RemarkTone, type Rules, sideClockMs } from "@cockpit-chess/chess";
import {
  displayMove,
  type EndingSummary,
  endingSummary,
  type IllegalWhy,
  type MatchEnding,
} from "@cockpit-chess/chess/ending";
import type { TFunction } from "i18next";

/**
 * The web rendering of `@cockpit-chess/chess/ending`: the same headline/detail mapping
 * through the `chess` locale (`ending.*`, `endingDetail.*`). Every surface uses these:
 * the result banner and game view (headline + detail), match cards and the PNG
 * (headline). Untrusted move text is bounded by `displayMove` and rendered as text.
 */
type ChessT = TFunction<"chess">;

export function durationLabel(t: ChessT, ms: number) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return t("duration.seconds", { seconds: rest });
  return rest
    ? t("duration.minutesSeconds", { minutes, seconds: rest })
    : t("duration.minutes", { minutes });
}

function usdLabel(locale: string, micros: number) {
  const dollars = micros / 1_000_000;
  const cents = Number.isInteger(micros / 10_000) && dollars >= 0.01;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 4,
  }).format(dollars);
}

export function endingHeadlineLabel(t: ChessT, summary: EndingSummary): string {
  const side = summary.side ? t(`colors.${summary.side}`) : null;
  switch (summary.kind) {
    case "checkmate":
      return summary.side
        ? t("ending.checkmate", { winner: t(`colors.${summary.side === "w" ? "b" : "w"}`) })
        : t("ending.checkmateUnknown");
    case "draw":
      return summary.draw && summary.draw !== "other"
        ? t("ending.drawKind", { kind: t(`drawKinds.${summary.draw}`) })
        : t("ending.draw");
    case "illegal-forfeit":
      if (!side) return t("ending.illegalForfeitUnknown");
      if (summary.illegal === undefined) return t("ending.illegalForfeitUncounted", { side });
      return t("ending.illegalForfeit", { side, count: summary.illegal });
    case "timeout":
    case "move-timeout":
    case "token-budget":
    case "cost-budget":
    case "resignation":
      return side
        ? t(`ending.${summary.kind}`, { side })
        : t(`ending.${summary.kind}Unknown` as const);
    default:
      return t(`ending.${summary.kind}`);
  }
}

function illegalWhyLabel(t: ChessT, why: IllegalWhy) {
  switch (why.code) {
    case "unparseable":
      return t("illegalWhy.unparseable");
    case "pawn-moved":
      return t("illegalWhy.pawnMoved", { file: why.file });
    case "piece-moved":
      return t("illegalWhy.pieceMoved", {
        piece: t(`pieceNames.${why.piece}`),
        square: why.square,
      });
    case "empty":
      return t("illegalWhy.empty", { square: why.square });
    case "opponent-piece":
      return t("illegalWhy.opponentPiece", { square: why.square });
    case "cannot-move":
      return t("illegalWhy.cannotMove", {
        piece: t(`pieceNames.${why.piece}`),
        from: why.from,
        to: why.to,
      });
    case "promotion":
      return t("illegalWhy.promotion", { from: why.from });
  }
}

export function endingDetailLabel(t: ChessT, locale: string, ending: MatchEnding): string | null {
  switch (ending.kind) {
    case "illegal-forfeit": {
      const whys = ending.attempts.map((attempt) => illegalWhyLabel(t, attempt.why));
      if (!whys.length) return null;
      const moves = ending.attempts.map((attempt) => displayMove(attempt.move));
      if (whys.every((why) => why === whys[0]))
        return t("endingDetail.sameReason", { moves: moves.join(", "), why: whys[0] });
      return moves
        .map((move, index) => t("endingDetail.moveReason", { move, why: whys[index] }))
        .join("; ");
    }
    case "timeout":
      return ending.clockMs === null
        ? null
        : t("endingDetail.clock", { time: durationLabel(t, ending.clockMs) });
    case "move-timeout":
      return t("endingDetail.moveLimit", { time: durationLabel(t, ending.limitMs) });
    case "token-budget":
      return t("endingDetail.tokens", {
        tokens: new Intl.NumberFormat(locale).format(ending.tokens),
      });
    case "cost-budget":
      return t("endingDetail.spend", { budget: usdLabel(locale, ending.budgetMicros) });
    case "ply-limit":
      return t("endingDetail.plies", { plies: ending.plies });
    case "cancelled":
    case "interrupted":
    case "provider-error":
    case "engine-error":
    case "event-limit":
      return t("endingDetail.unscored");
    default:
      return null;
  }
}

/** Headline plus bracketed detail: the result banner, the game view and the PGN comment. */
export function endingLabel(t: ChessT, locale: string, ending: MatchEnding): string {
  const headline = endingHeadlineLabel(t, endingSummary(ending));
  const detail = endingDetailLabel(t, locale, ending);
  return detail ? t("endingDetail.withDetail", { headline, detail }) : headline;
}

/** "10 min each", "White 15 min · Black 5 min", or "Untimed". */
export function timeControlLabel(t: ChessT, rules: Rules) {
  const white = sideClockMs(rules, "w");
  const black = sideClockMs(rules, "b");
  if (white === null || black === null) return t("timeControl.untimed");
  if (white === black) return t("timeControl.each", { time: durationLabel(t, white) });
  return t("timeControl.uneven", {
    white: durationLabel(t, white),
    black: durationLabel(t, black),
  });
}

export function remarkToneLabel(t: ChessT, tone: RemarkTone) {
  return t(`remarkTones.${tone}`);
}
