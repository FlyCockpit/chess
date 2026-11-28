import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LegalDocument, LegalSection } from "@/components/legal-document";

export const Route = createFileRoute("/$lang/_public/privacy")({
  head: ({ match }) => ({
    meta: [{ title: match.context.i18n.t("common:legal.privacy.title") }],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  const { lang } = Route.useParams();
  const { t } = useTranslation("common");
  return (
    <LegalDocument title={t("legal.privacy.title")}>
      {(
        [
          "operator",
          "data",
          "providers",
          "runner",
          "storage",
          "retention",
          "deletion",
          "reports",
          "choices",
        ] as const
      ).map((section) => (
        <LegalSection key={section} id={section} title={t(`legal.privacy.${section}.title`)}>
          <p>{t(`legal.privacy.${section}.body`)}</p>
        </LegalSection>
      ))}
      <LegalSection id="contact" title={t("legal.contactTitle")}>
        <p>{t("legal.privacy.contact")}</p>
        <a href="mailto:contact@flycockpit.app">{t("legal.contactAddress")}</a>
        <p>
          <a href="https://openrouter.ai/privacy">{t("legal.privacy.openrouterNotice")}</a>
          {" · "}
          <a href="https://www.cloudflare.com/privacypolicy/">
            {t("legal.privacy.cloudflareNotice")}
          </a>
        </p>
        <p>
          <Link to="/$lang/terms" params={{ lang }}>
            {t("legal.terms.title")}
          </Link>
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
