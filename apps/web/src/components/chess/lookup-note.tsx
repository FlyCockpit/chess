import type { Color } from "@cockpit-chess/chess";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { LegalLookup } from "./legal-lookup";

/** A lookup in plain words: "Checked moves for the knight on g1: Nf3, Nh3". */
export function lookupLabel(t: TFunction<"chess">, lookup: LegalLookup) {
  if (lookup.square === null) return t("replay.lookupAll", { count: lookup.count });
  if (!lookup.piece) return t("replay.lookupNoPiece", { square: lookup.square });
  const subject = t(`replay.lookupPiece.${lookup.piece.type}`, { square: lookup.square });
  return lookup.san.length
    ? t("replay.lookupMoves", { subject, moves: lookup.san.join(", ") })
    : t("replay.lookupNone", { subject });
}

/**
 * A board's lookup in words, on a reserved two-line strip under it (so nothing below
 * moves); the dot key appears when the board shows the marks.
 */
export function LookupNote({
  lookup,
  side,
  marks,
  live,
}: {
  lookup: LegalLookup | undefined;
  side: Color;
  marks: boolean;
  live: boolean;
}) {
  const { t } = useTranslation("chess");
  return (
    <p className="cc-lookup-note" aria-live={live ? "polite" : "off"}>
      {lookup && (
        <>
          {marks && <span aria-hidden="true" className="cc-lookup-key" />}
          <span className="cc-lookup-text">
            {t(`colors.${side}`)} · {lookupLabel(t, lookup)}
          </span>
        </>
      )}
    </p>
  );
}
