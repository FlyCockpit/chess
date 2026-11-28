import { Button } from "@cockpit-chess/ui/components/button";
import { useTranslation } from "react-i18next";
import { useAccountExport } from "@/hooks/use-account-export";

export function AccountExportSection({ lang }: { lang: string }) {
  const { t } = useTranslation("settings");
  const { pending, issue, downloaded, download, reauthenticate } = useAccountExport(lang);
  return (
    <section className="mt-6 space-y-3 border-t pt-6" aria-labelledby="account-export-title">
      <h2 id="account-export-title" className="font-medium">
        {t("export.title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("export.description")}</p>
      <p className="text-sm text-muted-foreground">{t("export.freshSignIn")}</p>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={pending !== null || issue === "reauth"}
          onClick={() => void download("json")}
        >
          {pending === "json" ? t("export.preparing") : t("export.json")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={pending !== null || issue === "reauth"}
          onClick={() => void download("pgn")}
        >
          {pending === "pgn" ? t("export.preparing") : t("export.pgn")}
        </Button>
      </div>
      {pending && pending !== "reauth" ? (
        <p role="status" className="text-sm">
          {t("export.keepOpen")}
        </p>
      ) : null}
      {downloaded ? (
        <p role="status" className="text-sm">
          {t("export.downloaded")}
        </p>
      ) : null}
      {issue ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`export.errors.${issue}`)}
        </p>
      ) : null}
      {issue === "reauth" ? (
        <Button
          type="button"
          className="min-h-11"
          disabled={pending !== null}
          onClick={() => void reauthenticate()}
        >
          {pending === "reauth" ? t("export.preparing") : t("export.signInAgain")}
        </Button>
      ) : null}
    </section>
  );
}
