import type { AppRouterClient } from "@cockpit-chess/api/routers/index";
import { Button, buttonVariants } from "@cockpit-chess/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-chess/ui/components/card";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { QueryBoundary } from "@/components/query-boundary";
import { SegmentedControl } from "@/components/segmented-control";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import {
  type CallbackNotice,
  ConnectError,
  DEFAULT_EXPIRY,
  DEFAULT_LIMIT,
  EXPIRY_CHOICES,
  type ExpiryChoice,
  keyActivityUrl,
  LIMIT_CHOICES,
  type LimitChoice,
  manageKeyUrl,
  startOpenRouterConnect,
} from "@/lib/openrouter-connect";
import { orpc } from "@/utils/orpc";

/** `openrouter.status`, exactly as the server projects it (never key material). */
type OpenRouterStatus = Awaited<ReturnType<AppRouterClient["openrouter"]["status"]>>;
type Connected = Extract<OpenRouterStatus, { connected: true }>;

const microsUsd = (locale: string, micros: number) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: micros > 0 && micros < 10_000 ? 4 : 2,
  }).format(micros / 1_000_000);

/**
 * Settings → OpenRouter. Every state says what happens next: unavailable here,
 * not connected (pick a limit and expiry, then OpenRouter's consent screen),
 * connected (OpenRouter's own numbers, manage, disconnect) or invalid (reconnect).
 */
export function OpenRouterSettings({
  lang,
  notice,
  onDismissNotice,
}: {
  lang: string;
  notice: CallbackNotice | null;
  onDismissNotice: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const query = useQuery({
    ...orpc.openrouter.status.queryOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold">{t("settings:openrouter.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("settings:openrouter.description")}</p>
      </div>
      {notice && <Notice notice={notice} onDismiss={onDismissNotice} />}
      <QueryBoundary
        query={query}
        errorMessage={t("settings:openrouter.loadFailed")}
        skeleton={
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-full max-w-md" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-48" />
            </CardContent>
          </Card>
        }
      >
        {(status) =>
          !status.available && !status.connected ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("settings:openrouter.unavailableTitle")}</CardTitle>
                <CardDescription>{t("settings:openrouter.unavailableDescription")}</CardDescription>
              </CardHeader>
            </Card>
          ) : status.connected ? (
            <ConnectedView status={status} lang={lang} />
          ) : (
            <ConnectCard lang={lang} />
          )
        }
      </QueryBoundary>
    </div>
  );
}

function Notice({ notice, onDismiss }: { notice: CallbackNotice; onDismiss: () => void }) {
  const { t } = useTranslation(["settings"]);
  const ok = notice.kind === "connected";
  return (
    <div
      role={ok ? "status" : "alert"}
      className={
        ok
          ? "flex flex-col gap-3 rounded-md border border-primary/40 bg-primary/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
          : "flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
      }
    >
      <p>
        {t(
          notice.kind === "connected"
            ? "settings:openrouter.result.connected"
            : `settings:openrouter.result.${notice.code}`,
        )}
      </p>
      <Button variant="ghost" className="min-h-11 shrink-0" onClick={onDismiss}>
        {t("settings:openrouter.dismiss")}
      </Button>
    </div>
  );
}

/** The limit and expiry for the new key, then off to OpenRouter's consent screen. */
function ConnectCard({
  lang,
  mode = "connect",
}: {
  lang: string;
  mode?: "connect" | "reconnect" | "replace";
}) {
  const { t } = useTranslation(["settings"]);
  const [limit, setLimit] = useState<LimitChoice>(DEFAULT_LIMIT);
  const [expiry, setExpiry] = useState<ExpiryChoice>(DEFAULT_EXPIRY);
  const limitId = useId();
  const expiryId = useId();
  const connect = useMutation({
    mutationFn: () => startOpenRouterConnect({ limitUsd: limit, expiration: expiry, lang }),
    onSuccess: (url) => {
      // OpenRouter's consent screen is another site: a full navigation, by design.
      window.location.assign(url);
    },
    meta: { skipGlobalErrorToast: true },
  });
  const failure = connect.error instanceof ConnectError ? connect.error.reason : "failed";
  // Pending stays on while the browser leaves for OpenRouter.
  const busy = connect.isPending || connect.isSuccess;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t(
            mode === "replace"
              ? "settings:openrouter.replace"
              : mode === "reconnect"
                ? "settings:openrouter.reconnect"
                : "settings:openrouter.connect",
          )}
        </CardTitle>
        <CardDescription>
          {mode === "replace"
            ? t("settings:openrouter.replaceHint")
            : t("settings:openrouter.how.title")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {mode !== "replace" && (
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>{t("settings:openrouter.how.pay")}</li>
            <li>{t("settings:openrouter.how.limit")}</li>
            <li>{t("settings:openrouter.how.safe")}</li>
            <li>{t("settings:openrouter.how.revoke")}</li>
          </ul>
        )}
        <div className="min-w-0 space-y-1.5" role="group" aria-labelledby={limitId}>
          <p id={limitId} className="text-sm font-medium">
            {t("settings:openrouter.limitLabel")}
          </p>
          <SegmentedControl
            ariaLabel={t("settings:openrouter.limitLabel")}
            value={limit === null ? "none" : String(limit)}
            onChange={(next) => setLimit(next === "none" ? null : (Number(next) as LimitChoice))}
            items={LIMIT_CHOICES.map((choice) => ({
              value: choice === null ? "none" : String(choice),
              label:
                choice === null
                  ? t("settings:openrouter.noLimit")
                  : t("settings:openrouter.limitUsd", { amount: choice }),
            }))}
          />
          <p className="text-xs text-muted-foreground">{t("settings:openrouter.limitHint")}</p>
        </div>
        <div className="min-w-0 space-y-1.5" role="group" aria-labelledby={expiryId}>
          <p id={expiryId} className="text-sm font-medium">
            {t("settings:openrouter.expiryLabel")}
          </p>
          <SegmentedControl
            ariaLabel={t("settings:openrouter.expiryLabel")}
            value={expiry}
            onChange={setExpiry}
            items={EXPIRY_CHOICES.map((choice) => ({
              value: choice,
              label: t(`settings:openrouter.expiry.${choice}`),
            }))}
          />
          <p className="text-xs text-muted-foreground">{t("settings:openrouter.expiryHint")}</p>
        </div>
        {connect.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t(`settings:openrouter.connectError.${failure}`)}
          </p>
        )}
        <div className="space-y-2">
          <Button className="min-h-11" disabled={busy} onClick={() => connect.mutate()}>
            {busy
              ? t("settings:openrouter.connecting")
              : t(
                  mode === "replace"
                    ? "settings:openrouter.replace"
                    : mode === "reconnect"
                      ? "settings:openrouter.reconnect"
                      : "settings:openrouter.connect",
                )}
          </Button>
          <p className="text-xs text-muted-foreground">{t("settings:openrouter.connectNext")}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectedView({ status, lang }: { status: Connected; lang: string }) {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnect = useEntityMutation(
    orpc.openrouter.disconnect.mutationOptions({
      onSuccess: () => setDisconnecting(false),
    }),
    {
      invalidateKey: orpc.openrouter.key(),
      successMessage: t("settings:openrouter.disconnectDialog.success"),
    },
  );
  const money = (micros: number | null, nullLabel: string) =>
    micros === null ? nullLabel : microsUsd(i18n.language, micros);
  const date = (value: string | null) =>
    value === null
      ? t("settings:openrouter.never")
      : new Date(value).toLocaleDateString(i18n.language, { dateStyle: "medium" });
  const invalid = status.status !== "active";
  const unknown = t("settings:openrouter.unknown");
  const rows: Array<[string, string]> = [
    [
      t("settings:openrouter.keyLabel"),
      [status.label, t("settings:openrouter.keyHint", { hint: status.keyHint })]
        .filter(Boolean)
        .join(" · "),
    ],
    [t("settings:openrouter.limit"), money(status.limitMicros, t("settings:openrouter.unlimited"))],
    [t("settings:openrouter.used"), money(status.usageMicros, unknown)],
    [
      t("settings:openrouter.remaining"),
      status.limitMicros === null
        ? t("settings:openrouter.unlimited")
        : money(status.limitRemainingMicros, unknown),
    ],
    [t("settings:openrouter.usedToday"), money(status.usageDailyMicros, unknown)],
    [t("settings:openrouter.expires"), date(status.expiresAt)],
    [t("settings:openrouter.connectedAt"), date(status.connectedAt)],
  ];
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            {t(invalid ? "settings:openrouter.invalidTitle" : "settings:openrouter.connectedTitle")}
          </CardTitle>
          {invalid && (
            <CardDescription>{t("settings:openrouter.invalidDescription")}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {!status.live && !invalid && (
            <p className="text-xs text-muted-foreground" role="status">
              {t("settings:openrouter.stale")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <a
              href={manageKeyUrl(status.keyHash)}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", className: "min-h-11" })}
            >
              {t("settings:openrouter.manage")}
              <ExternalLink aria-hidden className="size-4" />
            </a>
            <a
              href={keyActivityUrl(status.keyHash)}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", className: "min-h-11" })}
            >
              {t("settings:openrouter.activity")}
              <ExternalLink aria-hidden className="size-4" />
            </a>
            <Button
              variant="outline"
              className="min-h-11 text-destructive"
              onClick={() => setDisconnecting(true)}
            >
              {t("settings:openrouter.disconnect")}
            </Button>
          </div>
          {!invalid && (
            <div className="flex flex-col gap-2 rounded-md border p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
              <p>{t("settings:openrouter.nextStep")}</p>
              <Link
                to="/$lang"
                params={{ lang }}
                search={{ tab: "studio" }}
                className={buttonVariants({ className: "min-h-11 shrink-0" })}
              >
                {t("settings:openrouter.openStudio")}
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
      {/* Connecting again needs the feature on here; the details and Disconnect stay. */}
      {status.available ? (
        <ConnectCard lang={lang} mode={invalid ? "reconnect" : "replace"} />
      ) : (
        <p className="text-sm text-muted-foreground">{t("settings:openrouter.connectOff")}</p>
      )}
      <ConfirmDeleteDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={t("settings:openrouter.disconnectDialog.title")}
        description={
          <>
            {t("settings:openrouter.disconnectDialog.description")}{" "}
            {t("settings:openrouter.disconnectDialog.revokeNote")}
          </>
        }
        confirmToken={t("settings:openrouter.disconnectDialog.token")}
        typePrompt={t("settings:openrouter.disconnectDialog.typePrompt")}
        copyAriaLabel={t("settings:openrouter.disconnectDialog.copyAriaLabel")}
        inputMode="text"
        confirmLabel={t("settings:openrouter.disconnectDialog.confirm")}
        pendingLabel={t("settings:openrouter.disconnectDialog.pending")}
        isPending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </>
  );
}
