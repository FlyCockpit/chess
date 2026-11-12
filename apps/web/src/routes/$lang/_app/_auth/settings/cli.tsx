import { Button } from "@cockpit-chess/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-chess/ui/components/card";
import { CopyField } from "@cockpit-chess/ui/components/copy-field";
import { Label } from "@cockpit-chess/ui/components/label";
import { toast } from "@cockpit-chess/ui/components/sileo";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { CreateApiKeyDialog } from "@/components/cli/create-api-key-dialog";
import { type ApiKeyRow, RevokeApiKeyDialog } from "@/components/cli/revoke-api-key-dialog";
import { EmptyState } from "@/components/empty-state";
import { InlineRetry } from "@/components/inline-retry";
import { QueryBoundary } from "@/components/query-boundary";
import { SkeletonList } from "@/components/skeleton-list";
import { orpc } from "@/utils/orpc";

/**
 * Settings → Command-line access. The web half of the companion CLI
 * (packages/api/src/routers/cli.ts): a copy-paste install/update command and the user's API
 * keys. The CLI itself talks to `/api/cli/rpc`, never to these procedures.
 */
export const Route = createFileRoute("/$lang/_app/_auth/settings/cli")({
  component: CliSettings,
});

function CliSettings() {
  return (
    <div className="space-y-6">
      <InstallCard />
      <ApiKeysCard />
    </div>
  );
}

function InstallCard() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  // Every page load mints a fresh install token: never serve a cached one
  // (staleTime/gcTime 0) and always refetch on mount. The token expires 15
  // minutes after it is minted, so a stale command would just fail.
  const { data, isPending, isError, isFetching, refetch } = useQuery({
    ...orpc.cliAccess.installCommand.queryOptions(),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings:cli.install.title")}</CardTitle>
        <CardDescription>
          <Trans
            i18nKey="cli.install.description"
            ns="settings"
            t={t}
            components={[<code key="0" />]}
          />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isPending ? (
          <div className="space-y-4">
            {[0, 1].map((row) => (
              <div key={row} className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-11 w-full" />
              </div>
            ))}
          </div>
        ) : isError && !data ? (
          <InlineRetry message={t("settings:cli.install.loadFailed")} onRetry={() => refetch()} />
        ) : data && !data.available ? (
          <div className="rounded-md border p-4 text-sm">
            <p className="font-medium">{t("settings:cli.install.unavailableTitle")}</p>
            <p className="mt-1 text-muted-foreground">
              {t("settings:cli.install.unavailableDescription")}
            </p>
          </div>
        ) : data?.available ? (
          <>
            <div className="min-w-0 space-y-1.5">
              <Label>{t("settings:cli.install.unixLabel")}</Label>
              <CopyField
                value={data.unix}
                copyLabel={t("settings:cli.install.copyAriaLabel")}
                onCopied={() => toast.success(t("settings:cli.install.copied"))}
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label>{t("settings:cli.install.windowsLabel")}</Label>
              <CopyField
                value={data.windows}
                copyLabel={t("settings:cli.install.copyAriaLabel")}
                onCopied={() => toast.success(t("settings:cli.install.copied"))}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings:cli.install.expiresAt", {
                time: new Date(data.expiresAt).toLocaleTimeString(i18n.language, {
                  hour: "numeric",
                  minute: "2-digit",
                }),
              })}
            </p>
            <p className="text-sm text-muted-foreground">
              <Trans
                i18nKey="cli.install.nextStep"
                ns="settings"
                t={t}
                components={[<code key="0" />]}
              />
            </p>
            <Button
              variant="outline"
              className="min-h-[44px]"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              <RefreshCw aria-hidden className="size-4" />
              {isFetching
                ? t("settings:cli.install.regenerating")
                : t("settings:cli.install.regenerate")}
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ApiKeysCard() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const listQuery = useQuery(orpc.cliAccess.apiKeys.list.queryOptions());
  const formatDate = (value: Date | string) => new Date(value).toLocaleDateString(i18n.language);

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <CardTitle>{t("settings:cli.apiKeys.title")}</CardTitle>
          <CardDescription>
            <Trans
              i18nKey="cli.apiKeys.description"
              ns="settings"
              t={t}
              components={[<code key="0" />]}
            />
          </CardDescription>
        </div>
        <CreateApiKeyDialog />
      </CardHeader>
      <CardContent className="p-0">
        <QueryBoundary
          query={listQuery}
          skeleton={<SkeletonList count={2} />}
          errorMessage={t("settings:cli.apiKeys.loadFailed")}
          errorClassName="py-12"
          isEmpty={(keys) => keys.length === 0}
          empty={
            <EmptyState
              title={t("settings:cli.apiKeys.emptyTitle")}
              description={t("settings:cli.apiKeys.emptyDescription")}
            />
          }
        >
          {(keys) => (
            <ul className="divide-y border-t">
              {keys.map((key) => (
                <li
                  key={key.id}
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{key.name ?? key.start}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {[
                        key.start ? `${key.start}…` : null,
                        t("settings:cli.apiKeys.createdOn", { date: formatDate(key.createdAt) }),
                        key.expiresAt
                          ? t("settings:cli.apiKeys.expiresOn", { date: formatDate(key.expiresAt) })
                          : null,
                        key.lastRequest
                          ? t("settings:cli.apiKeys.lastUsed", {
                              date: formatDate(key.lastRequest),
                            })
                          : t("settings:cli.apiKeys.neverUsed"),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="min-h-[44px] shrink-0"
                    onClick={() => setRevoking(key)}
                  >
                    {t("settings:cli.apiKeys.revoke")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </CardContent>

      <RevokeApiKeyDialog
        apiKey={revoking}
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      />
    </Card>
  );
}
