import { Button, buttonVariants } from "@cockpit-chess/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-chess/ui/components/card";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { PageShell } from "@/components/page-shell";
import { useRunnerClaim, useSelectedRunnerClaim } from "@/hooks/use-runner-claim";
import { rememberedRunnerClaim } from "@/lib/runner-claim-link";

export const Route = createFileRoute("/$lang/_app/_auth/runner/claim")({
  staticData: { pendingShape: "form", pendingWidth: "narrow" },
  head: () => ({
    meta: [
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: RunnerClaimPage,
});

function RunnerClaimPage() {
  const { session } = Route.useRouteContext();
  const hash = useLocation({ select: (location) => location.hash });
  const selected = useSelectedRunnerClaim(hash || rememberedRunnerClaim(session.user.id));
  return <RunnerClaimView key={selected} hash={selected} />;
}

function RunnerClaimView({ hash }: { hash: string }) {
  const { t } = useTranslation(["auth", "common"]);
  const { lang } = Route.useParams();
  const { session } = Route.useRouteContext();
  const claim = useRunnerClaim(hash, session.user.id);
  const unavailable =
    !claim.valid ||
    (claim.error &&
      "code" in claim.error &&
      ["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"].includes(String(claim.error.code)));

  return (
    <PageShell width="narrow" className="max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>{t("auth:runnerClaim.title")}</h1>
          </CardTitle>
          <CardDescription>{t("auth:runnerClaim.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {claim.isSuccess ? (
            <div role="status" className="space-y-3">
              <p>{t("auth:runnerClaim.claimed", { email: session.user.email })}</p>
              <p className="text-sm text-muted-foreground">{t("auth:runnerClaim.next")}</p>
              <Link
                to="/$lang/settings/cli"
                params={{ lang }}
                className={buttonVariants({ className: "min-h-[44px]" })}
              >
                {t("auth:runnerClaim.manage")}
              </Link>
            </div>
          ) : unavailable ? (
            <div role="alert" className="space-y-3">
              <p>{t("auth:runnerClaim.unavailable")}</p>
              <p className="text-sm text-muted-foreground">{t("auth:runnerClaim.restart")}</p>
            </div>
          ) : claim.error ? (
            <div role="alert" className="space-y-3">
              <p>{t("auth:runnerClaim.failed")}</p>
              <Button className="min-h-[44px]" onClick={claim.retry}>
                {t("common:actions.tryAgain")}
              </Button>
            </div>
          ) : (
            <div role="status" className="space-y-3">
              <p>{t("auth:runnerClaim.claiming", { email: session.user.email })}</p>
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          )}
          <p className="text-sm text-muted-foreground">{t("auth:runnerClaim.safety")}</p>
        </CardContent>
      </Card>
    </PageShell>
  );
}
