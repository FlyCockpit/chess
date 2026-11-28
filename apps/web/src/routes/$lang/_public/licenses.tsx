import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LegalDocument, LegalSection } from "@/components/legal-document";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_public/licenses")({
  head: ({ match }) => ({
    meta: [{ title: match.context.i18n.t("common:legal.licenses.title") }],
  }),
  component: LicensesPage,
});

function LicensesPage() {
  const { t } = useTranslation("common");
  const { data: info } = useQuery(orpc.chess.info.queryOptions());
  return (
    <LegalDocument title={t("legal.licenses.title")}>
      <LegalSection id="application" title={t("legal.licenses.application.title")}>
        <p>{t("legal.licenses.application.body")}</p>
        <a href="https://github.com/FlyCockpit/chess/blob/main/LICENSE">
          {t("legal.licenses.appLicense")}
        </a>
        {info?.sourceCodeUrl && (
          <p>
            <a href={info.sourceCodeUrl}>{t("sourceCode")}</a>
          </p>
        )}
      </LegalSection>
      <LegalSection id="stockfish" title={t("legal.licenses.stockfish.title")}>
        <p>{t("legal.licenses.stockfish.body")}</p>
        <p>
          <a href="/third-party/stockfish/Copying.txt">{t("legal.licenses.engineLicense")}</a>
        </p>
        <p>
          <a href="/third-party/stockfish/stockfish-19.0.1-source.tar.gz">
            {t("legal.licenses.engineSource")}
          </a>
        </p>
        <p>
          <a href="/third-party/stockfish/AUTHORS">{t("legal.licenses.engineAuthors")}</a>
        </p>
        <p>
          <a href="/third-party/stockfish/SHA256SUMS">{t("legal.licenses.engineChecksums")}</a>
        </p>
      </LegalSection>
      <LegalSection id="notices" title={t("legal.licenses.notices.title")}>
        <p>{t("legal.licenses.notices.body")}</p>
        <a href="https://github.com/FlyCockpit/chess/blob/main/THIRD-PARTY-LICENSES.md">
          {t("legal.licenses.noticesLink")}
        </a>
      </LegalSection>
    </LegalDocument>
  );
}
