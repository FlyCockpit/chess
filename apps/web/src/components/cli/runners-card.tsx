import { Button } from "@cockpit-chess/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-chess/ui/components/card";
import { CopyField } from "@cockpit-chess/ui/components/copy-field";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";

import { runnerRecentlySeen } from "@/components/chess/create-match-form";
import { EmptyState } from "@/components/empty-state";
import { InlineRetry } from "@/components/inline-retry";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { SkeletonList } from "@/components/skeleton-list";
import { useAuthSession } from "@/hooks/use-auth-session";
import { useDocumentAdmits } from "@/hooks/use-document-admits";
import { useNow } from "@/hooks/use-now";
import { orpc } from "@/utils/orpc";
import { RevokeRunnerDialog, type RunnerRow } from "./revoke-runner-dialog";
import { RunnerLimitsSheet } from "./runner-limits-sheet";

export function RunnersCard() {
  const { t } = useTranslation("settings");
  const { state, actions } = useAuthSession();
  const identity = state.status === "authenticated" ? state.session.user.id : undefined;
  const admitted = useDocumentAdmits(identity);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cli.runners.title")}</CardTitle>
        <CardDescription>{t("cli.runners.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        <div className="space-y-3 px-4 text-sm">
          <ol className="list-inside list-decimal space-y-3">
            <li>
              {t("cli.runners.guide.start")}
              <CopyField
                className="mt-2"
                value="npx @flycockpit/chess"
                copyLabel={t("cli.runners.guide.copyCommand")}
              />
            </li>
            <li>{t("cli.runners.guide.claim")}</li>
            <li>{t("cli.runners.guide.studio")}</li>
          </ol>
          <p className="text-muted-foreground">{t("cli.runners.guide.localAuthority")}</p>
          <p className="font-medium">{t("cli.runners.guide.practice")}</p>
          <p className="text-muted-foreground">{t("cli.runners.guide.limits")}</p>
          <p className="text-muted-foreground">{t("cli.runners.resetPolicy")}</p>
        </div>
        {admitted && identity ? (
          // Remount selections and overlays with the document's confirmed owner.
          <OwnedRunners key={identity} />
        ) : state.status === "pending" ? (
          <RunnersSkeleton />
        ) : (
          <InlineRetry message={t("cli.runners.loadFailed")} onRetry={() => void actions.retry()} />
        )}
      </CardContent>
    </Card>
  );
}

function OwnedRunners() {
  const { t } = useTranslation("settings");
  const query = useInfiniteQuery({
    ...orpc.cliAccess.runners.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: 20, cursor }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;

  return (
    <QueryBoundary
      query={query}
      skeleton={<RunnersSkeleton />}
      errorMessage={t("cli.runners.loadFailed")}
      errorClassName="py-6"
      isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
      empty={
        <EmptyState
          title={t("cli.runners.emptyTitle")}
          description={t("cli.runners.guide.empty")}
        />
      }
    >
      {(data) => (
        // Preserve selections when QueryBoundary adds its retry sibling.
        <Fragment key="runners">
          <RunnersList runners={data.pages.flatMap((page) => page.items)} />
          <LoadMore
            onLoadMore={() => void fetchNextPage()}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
          />
        </Fragment>
      )}
    </QueryBoundary>
  );
}

function RunnersList({ runners }: { runners: RunnerRow[] }) {
  const { t, i18n } = useTranslation("settings");
  const [revokingId, setRevoking] = useState<string | null>(null);
  const [editingId, setEditing] = useState<string | null>(null);
  const now = useNow(true, 1000);
  const statusOf = (runner: RunnerRow) => {
    if (runner.revokedAt || runner.status === "revoked") return "revoked";
    if (runner.status === "expired" || !(new Date(runner.expiresAt).getTime() > now))
      return "expired";
    if (runnerRecentlySeen(runner, now)) return "online";
    return runner.lastSeenAt ? "offline" : "connecting";
  };
  const active = (runner: RunnerRow) => !["revoked", "expired"].includes(statusOf(runner));
  const revoking = runners.find(
    (runner) => runner.id === revokingId && statusOf(runner) !== "revoked",
  );
  const editing = runners.find((runner) => runner.id === editingId && active(runner));
  const formatDate = (value: Date | string) => new Date(value).toLocaleString(i18n.language);

  return (
    <>
      <ul className="divide-y border-t">
        {runners.map((runner) => {
          const status = statusOf(runner);
          return (
            <li
              key={runner.id}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <p className="truncate font-medium">{runner.displayName}</p>
                <span className="inline-block rounded-full border bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                  {t(`cli.runners.guide.status.${status}`)}
                </span>
                <p className="text-sm">{t(`cli.runners.guide.next.${status}`)}</p>
                <p className="break-all text-xs text-muted-foreground">
                  {t("cli.runners.credentialPrefix", { prefix: runner.credentialPrefix })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("cli.runners.expiresOn", { date: formatDate(runner.expiresAt) })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {runner.lastSeenAt
                    ? t("cli.runners.lastSeen", { date: formatDate(runner.lastSeenAt) })
                    : t("cli.runners.neverSeen")}
                </p>
                {runner.revokedAt && (
                  <p className="text-xs text-muted-foreground">
                    {t("cli.runners.revokedOn", { date: formatDate(runner.revokedAt) })}
                  </p>
                )}
                {active(runner) && (
                  <Link
                    to="/$lang"
                    params={{ lang: i18n.language }}
                    search={{ tab: "studio" }}
                    className="inline-flex min-h-11 items-center underline"
                  >
                    {t("cli.runners.guide.openStudio")}
                  </Link>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {active(runner) && (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => setEditing(runner.id)}
                  >
                    {t("cli.runners.limits.edit")}
                  </Button>
                )}
                {status !== "revoked" && (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => setRevoking(runner.id)}
                  >
                    {t("cli.runners.revoke")}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {revoking && (
        <RevokeRunnerDialog
          key={`revoke-${revoking.id}`}
          runner={revoking}
          open
          onOpenChange={(open) => {
            if (!open) setRevoking(null);
          }}
        />
      )}
      {editing && (
        <RunnerLimitsSheet
          key={`limits-${editing.id}`}
          runner={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function RunnersSkeleton() {
  return (
    <SkeletonList count={2}>
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-11 w-20" />
    </SkeletonList>
  );
}
