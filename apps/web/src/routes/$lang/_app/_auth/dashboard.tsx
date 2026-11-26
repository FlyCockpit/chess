import { hasRole } from "@cockpit-chess/auth/roles";
import { env } from "@cockpit-chess/env/web";
import { buttonVariants } from "@cockpit-chess/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-chess/ui/components/card";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Clapperboard, Swords } from "lucide-react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { PageHeader, PageShell } from "@/components/page-shell";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/dashboard")({
  staticData: { pendingShape: "dashboard", pendingWidth: "narrow" },
  component: DashboardPage,
});

function DashboardPage() {
  const { session } = Route.useRouteContext();
  const { lang } = Route.useParams();
  const {
    isPending: appSettingsPending,
    isError: appSettingsError,
    refetch: refetchAppSettings,
  } = useQuery(orpc.settings.getAll.queryOptions());
  const { t } = useTranslation("dashboard");
  const appName = env.VITE_APP_NAME;

  return (
    <PageShell width="narrow">
      {appSettingsPending ? (
        <DashboardSkeleton />
      ) : appSettingsError ? (
        <InlineRetry
          className="py-12"
          message={t("dashboard:loadFailed")}
          onRetry={() => refetchAppSettings()}
        />
      ) : (
        <>
          <PageHeader
            title={t("dashboard:welcomeTitle", { name: appName })}
            description={t("dashboard:welcomeBack", { name: session.user.name })}
          />
          {/* The next step after signing in: the arena for everyone, Studio for admins (it
              lives on the public arena page, which this shell's nav does not link to). */}
          <section aria-label={t("dashboard:next.label")} className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Swords aria-hidden="true" className="size-4" />
                  {t("dashboard:next.arenaTitle")}
                </CardTitle>
                <CardDescription>{t("dashboard:next.arenaDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <Link
                  to="/$lang"
                  params={{ lang }}
                  className={buttonVariants({
                    variant: "secondary",
                    className: "min-h-11 md:min-h-0",
                  })}
                >
                  {t("dashboard:next.arenaAction")}
                </Link>
              </CardContent>
            </Card>
            {hasRole(session.user.role ?? "", "admin") && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Clapperboard aria-hidden="true" className="size-4" />
                    {t("dashboard:next.studioTitle")}
                  </CardTitle>
                  <CardDescription>{t("dashboard:next.studioDescription")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Link
                    to="/$lang"
                    params={{ lang }}
                    search={{ tab: "studio" }}
                    className={buttonVariants({ className: "min-h-11 md:min-h-0" })}
                  >
                    {t("dashboard:next.studioAction")}
                  </Link>
                </CardContent>
              </Card>
            )}
          </section>
        </>
      )}
    </PageShell>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-5 w-64" />
    </div>
  );
}
