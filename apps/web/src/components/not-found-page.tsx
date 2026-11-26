import { buttonVariants } from "@cockpit-chess/ui/components/button";
import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";

/**
 * Unknown URLs and deliberately hidden routes share the same presentation.
 * The page body only: the router's `defaultNotFoundComponent`, for a
 * not-found boundary that already renders inside a shell. `h-full` fills a
 * shell's scroller; `flex-1` fills the public shell's content column.
 */
export function NotFoundPage() {
  const { t } = useTranslation("errors");
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <h1 className="text-base font-medium">{t("pageNotFound.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("pageNotFound.description")}</p>
      <Link to="/$lang" params={{ lang }} className={buttonVariants({ size: "touch" })}>
        {t("pageNotFound.home")}
      </Link>
    </div>
  );
}
