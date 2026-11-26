import { useTranslation } from "react-i18next";
import { ConsentPreferencesButton } from "@/components/consent/consent-preferences-button";

/**
 * The public pages' one footer, rendered by `PublicShell` after the page, never
 * by a route or a tab. `PublicShell` makes the scroller's content a `min-h-full`
 * flex column, so on a short page this sits at the bottom of the viewport and
 * on a long one it follows the content (docs/design-system.md § Shell rules).
 * Its rule is full-bleed (`.cc-footer`); its text keeps the arena's content
 * line (`.cc-footer-row`, the `.cc-app` column).
 *
 * Anonymous visitors must be able to withdraw consent as easily as they gave
 * it, and every public page, the 404 included, renders this footer.
 */
export function PublicFooter() {
  const { t } = useTranslation("chess");
  return (
    <footer data-public-footer className="cc-footer">
      <div className="cc-footer-row">
        <div>
          <p>{t("footer")}</p>
          <p>{t("aiDisclosure")}</p>
        </div>
        <ConsentPreferencesButton />
      </div>
    </footer>
  );
}
