import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ConsentPreferencesButton } from "@/components/consent/consent-preferences-button";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { orpc } from "@/utils/orpc";

/**
 * The public pages' one footer, rendered by `PublicShell` after the page, never
 * by a route or a tab. `PublicShell` makes the scroller's content a `min-h-full`
 * flex column, so on a short page this sits at the bottom of the viewport and
 * on a long one it follows the content (docs/design-system.md § Shell rules).
 * Its rule is full-bleed (`.cc-footer`); its text keeps the arena's content
 * line (`.cc-footer-row`, the `.cc-app` column).
 *
 * In an app with analytics it also carries Cookie preferences: anonymous
 * visitors must be able to withdraw consent as easily as they gave it, and
 * every public page, the 404 included, renders this footer. Without analytics
 * (the default, lib/analytics.ts) that button renders nothing.
 *
 * The "Source code" link is the AGPL-3.0 section 13 offer: the server names the
 * repository and commit it runs (`chess.info.sourceCodeUrl`, from SOURCE_CODE_URL).
 */
export function PublicFooter() {
  const { t } = useTranslation(["chess", "common"]);
  const { lang: langParam } = useParams({ strict: false });
  const lang = isSupportedLocale(langParam) ? langParam : DEFAULT_LOCALE;
  const { data: info } = useQuery(orpc.chess.info.queryOptions());
  return (
    <footer data-public-footer className="cc-footer">
      <div className="cc-footer-row">
        <div>
          <p>{t("chess:footer")}</p>
          <p>{t("chess:aiDisclosure")}</p>
          {info?.sourceCodeUrl && (
            <p>
              <a href={info.sourceCodeUrl} target="_blank" rel="noopener noreferrer">
                {t("common:sourceCode")}
              </a>
            </p>
          )}
        </div>
        <nav aria-label={t("common:legal.navigation")} className="flex flex-wrap gap-x-4">
          <Link to="/$lang/terms" params={{ lang }} className="inline-flex min-h-11 items-center">
            {t("common:legal.terms.title")}
          </Link>
          <Link to="/$lang/privacy" params={{ lang }} className="inline-flex min-h-11 items-center">
            {t("common:legal.privacy.title")}
          </Link>
          <Link
            to="/$lang/licenses"
            params={{ lang }}
            className="inline-flex min-h-11 items-center"
          >
            {t("common:legal.licenses.title")}
          </Link>
        </nav>
        <ConsentPreferencesButton />
      </div>
    </footer>
  );
}
