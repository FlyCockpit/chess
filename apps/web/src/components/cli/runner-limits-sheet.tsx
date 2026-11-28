import type { AppRouterClient } from "@cockpit-chess/api/routers/index";
import { Button } from "@cockpit-chess/ui/components/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@cockpit-chess/ui/components/sheet";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { TextField } from "@cockpit-chess/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { InlineRetry } from "@/components/inline-retry";
import { QueryBoundary } from "@/components/query-boundary";
import { SegmentedControl } from "@/components/segmented-control";
import { isQueryAccessError } from "@/lib/query-access-error";
import {
  exceedsRunnerCeiling,
  raisesRunnerLimits,
  runnerLimitsError,
  runnerLimitValues,
} from "@/lib/runner-limits";
import { orpc } from "@/utils/orpc";
import type { RunnerRow } from "./revoke-runner-dialog";

type LimitsState = Awaited<ReturnType<AppRouterClient["cliAccess"]["runners"]["getLimits"]>>;

export function RunnerLimitsSheet({
  runner,
  onClose,
}: {
  runner: RunnerRow | null;
  onClose: () => void;
}) {
  return runner ? <RunnerLimitsContent key={runner.id} runner={runner} onClose={onClose} /> : null;
}

function RunnerLimitsContent({ runner, onClose }: { runner: RunnerRow; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const { id } = runner;
  const query = useQuery({
    ...orpc.cliAccess.runners.getLimits.queryOptions({ input: { id } }),
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 3000,
  });
  // Drop the entire overlay and its form state, including step-up input, on
  // an access failure. A later successful retry mounts a fresh form.
  if (isQueryAccessError(query.error)) {
    return (
      <InlineRetry
        message={t("cli.runners.limits.loadFailed")}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("cli.runners.limits.title")}</SheetTitle>
          <SheetDescription>
            {t("cli.runners.limits.description", { name: runner.displayName })}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <QueryBoundary
            query={query}
            errorMessage={t("cli.runners.limits.loadFailed")}
            skeleton={
              <div className="space-y-5">
                {[0, 1, 2].map((item) => (
                  <Skeleton key={item} className="h-16 w-full" />
                ))}
              </div>
            }
          >
            {(state) =>
              state.available && state.operatingLimits && state.hardLimits ? (
                <RunnerLimitsForm key={state.operatingLimits.revision} id={id} state={state} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("cli.runners.limits.connectFirst")}
                </p>
              )
            }
          </QueryBoundary>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function RunnerLimitsForm({ id, state }: { id: string; state: LimitsState }) {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const [selectedMethod, setMethod] = useState<"password" | "totp">(
    state.methods.password ? "password" : "totp",
  );
  const method = state.methods[selectedMethod]
    ? selectedMethod
    : state.methods.password
      ? "password"
      : "totp";
  const [notice, setNotice] = useState<string | null>(null);
  const [submittedCommand, setSubmittedCommand] = useState<string | null>(null);
  const proof = useMutation(orpc.cliAccess.runners.proveLimits.mutationOptions());
  const update = useMutation(orpc.cliAccess.runners.setLimits.mutationOptions());
  const busy = proof.isPending || update.isPending;
  const current = state.operatingLimits;
  const hard = state.hardLimits;
  const schema = z
    .object({
      match: z.string(),
      day: z.string(),
      concurrency: z.string(),
      password: z.string(),
      code: z.string(),
    })
    .refine((value) => runnerLimitValues(value) !== undefined, {
      message: t("settings:cli.runners.limits.invalid"),
    });
  const form = useForm({
    defaultValues: {
      match: current ? String(current.matchMicros / 1_000_000) : "",
      day: current ? String(current.dayMicros / 1_000_000) : "",
      concurrency: current ? String(current.concurrency) : "",
      password: "",
      code: "",
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const limits = runnerLimitValues(value);
      if (!limits || !current || !hard || state.pending) return;
      if (exceedsRunnerCeiling(limits, hard)) {
        setNotice("ceiling");
        return;
      }
      const input = { id, expectedRevision: current.revision, limits };
      try {
        setNotice(null);
        let token: string | undefined;
        if (raisesRunnerLimits(limits, current)) {
          if (!state.methods[method]) {
            setNotice("setup");
            return;
          }
          const verified = await proof.mutateAsync({
            ...input,
            verification:
              method === "password"
                ? { method, password: value.password }
                : { method, code: value.code },
          });
          token = verified.proof;
        }
        const queued = await update.mutateAsync({ ...input, ...(token ? { proof: token } : {}) });
        setSubmittedCommand(queued.pending?.commandId ?? null);
        setNotice("waiting");
        await queryClient.invalidateQueries({
          queryKey: orpc.cliAccess.runners.getLimits.key({ input: { id } }),
        });
      } catch (error) {
        setNotice(`errors.${runnerLimitsError(error)}`);
      } finally {
        form.setFieldValue("password", "");
        form.setFieldValue("code", "");
        proof.reset();
        update.reset();
      }
    },
  });
  const money = (micros: number) =>
    new Intl.NumberFormat(i18n.language, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 6,
    }).format(micros / 1_000_000);
  if (!current || !hard) return null;
  const methods = [
    ...(state.methods.password
      ? [{ value: "password" as const, label: t("settings:cli.runners.limits.password") }]
      : []),
    ...(state.methods.totp
      ? [{ value: "totp" as const, label: t("settings:cli.runners.limits.totp") }]
      : []),
  ];
  return (
    <div className="space-y-5">
      <div className="rounded-md border p-3 text-sm space-y-2" aria-live="polite">
        <p>
          {t("settings:cli.runners.limits.current", {
            match: money(current.matchMicros),
            day: money(current.dayMicros),
            concurrency: current.concurrency,
            revision: current.revision,
          })}
        </p>
        <p className="text-muted-foreground">
          {t("settings:cli.runners.limits.hard", {
            match: money(hard.matchMicros),
            day: money(hard.dayMicros),
            concurrency: hard.concurrency,
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("settings:cli.runners.limits.localOnly")}
        </p>
        {state.pending && (
          <p>{t("settings:cli.runners.limits.pending", { revision: state.pending.revision })}</p>
        )}
        {state.lastResult && (
          <p role="status">
            {t(`settings:cli.runners.limits.result.${state.lastResult.reason}`, {
              revision: state.lastResult.revision,
            })}
          </p>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{t("settings:cli.runners.limits.reduction")}</p>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <form.Field name="match">
          {(field) => (
            <TextField
              field={field}
              label={t("settings:cli.runners.limits.match")}
              inputMode="decimal"
              autoComplete="off"
              disabled={busy || !!state.pending}
              maxLength={17}
            />
          )}
        </form.Field>
        <form.Field name="day">
          {(field) => (
            <TextField
              field={field}
              label={t("settings:cli.runners.limits.day")}
              inputMode="decimal"
              autoComplete="off"
              disabled={busy || !!state.pending}
              maxLength={17}
            />
          )}
        </form.Field>
        <form.Field name="concurrency">
          {(field) => (
            <TextField
              field={field}
              label={t("settings:cli.runners.limits.concurrency")}
              inputMode="numeric"
              autoComplete="off"
              disabled={busy || !!state.pending}
              maxLength={2}
            />
          )}
        </form.Field>
        <form.Subscribe selector={(value) => value.values}>
          {(values) => {
            const next = runnerLimitValues(values);
            const raises = !!next && raisesRunnerLimits(next, current);
            return (
              <>
                {!next && (
                  <p role="alert" className="text-sm text-destructive">
                    {t("settings:cli.runners.limits.invalid")}
                  </p>
                )}
                {next && exceedsRunnerCeiling(next, hard) && (
                  <p role="alert" className="text-sm text-destructive">
                    {t("settings:cli.runners.limits.ceiling")}
                  </p>
                )}
                {raises && (
                  <div className="space-y-3">
                    <p className="text-sm">{t("settings:cli.runners.limits.stepUp")}</p>
                    {methods.length > 0 ? (
                      <>
                        {methods.length > 1 && (
                          <SegmentedControl
                            value={method}
                            onChange={setMethod}
                            items={methods}
                            ariaLabel={t("settings:cli.runners.limits.method")}
                          />
                        )}
                        {method === "password" ? (
                          <form.Field name="password">
                            {(field) => (
                              <TextField
                                field={field}
                                label={t("settings:cli.runners.limits.password")}
                                type="password"
                                autoComplete="current-password"
                                maxLength={1024}
                                disabled={busy}
                              />
                            )}
                          </form.Field>
                        ) : (
                          <form.Field name="code">
                            {(field) => (
                              <TextField
                                field={field}
                                label={t("settings:cli.runners.limits.totp")}
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                maxLength={6}
                                disabled={busy}
                              />
                            )}
                          </form.Field>
                        )}
                      </>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">
                          {t("settings:cli.runners.limits.setup")}
                        </p>
                        <Link
                          to="/$lang/settings/security"
                          params={{ lang: i18n.language }}
                          className="inline-flex min-h-11 items-center underline"
                        >
                          {t("settings:cli.runners.limits.setupLink")}
                        </Link>
                      </div>
                    )}
                  </div>
                )}
                <Button
                  type="submit"
                  className="min-h-11 w-full"
                  disabled={
                    busy ||
                    !!state.pending ||
                    !next ||
                    (!!next && exceedsRunnerCeiling(next, hard)) ||
                    (raises && methods.length === 0)
                  }
                >
                  {busy ? t("common:actions.saving") : t("settings:cli.runners.limits.submit")}
                </Button>
              </>
            );
          }}
        </form.Subscribe>
        {notice &&
          !(
            notice === "waiting" &&
            submittedCommand &&
            state.lastResult?.commandId === submittedCommand
          ) && (
            <p role="status" className="text-sm">
              {t(`settings:cli.runners.limits.${notice}`)}
            </p>
          )}
      </form>
    </div>
  );
}
