import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LegalDocument, LegalSection } from "@/components/legal-document";

export const Route = createFileRoute("/$lang/_public/terms")({
  head: ({ match }) => ({
    meta: [{ title: match.context.i18n.t("common:legal.terms.title") }],
  }),
  component: TermsPage,
});

function TermsPage() {
  const { lang } = Route.useParams();
  const { t } = useTranslation("common");
  return (
    <LegalDocument title={t("legal.terms.title")}>
      {(
        [
          "operator",
          "service",
          "billing",
          "official",
          "publication",
          "moderation",
          "deletion",
        ] as const
      ).map((section) => (
        <LegalSection key={section} id={section} title={t(`legal.terms.${section}.title`)}>
          <p>{t(`legal.terms.${section}.body`)}</p>
        </LegalSection>
      ))}
      <LegalSection id="contact" title={t("legal.contactTitle")}>
        <p>{t("legal.terms.contact")}</p>
        <a href="mailto:contact@flycockpit.app">{t("legal.contactAddress")}</a>
        <p>
          <Link to="/$lang/privacy" params={{ lang }}>
            {t("legal.privacy.title")}
          </Link>
          {" · "}
          <Link to="/$lang/licenses" params={{ lang }}>
            {t("legal.licenses.title")}
          </Link>
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
