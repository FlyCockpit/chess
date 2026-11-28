import type { AppRouterClient } from "@cockpit-chess/api/routers/index";
import { Button } from "@cockpit-chess/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@cockpit-chess/ui/components/dialog";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { SelectField, TextareaField } from "@cockpit-chess/ui/components/text-field";
import { useForm, useStore } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { LoadMore } from "@/components/load-more";
import { PageHeader, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { SegmentedControl } from "@/components/segmented-control";
import { orpc } from "@/utils/orpc";

type ModerationMatch = Awaited<
  ReturnType<AppRouterClient["chessModeration"]["list"]>
>["items"][number];
const reasons = [
  "privacy",
  "harassment",
  "illegal_content",
  "spam",
  "other",
  "no_violation",
] as const;
type Reason = (typeof reasons)[number];

function ModerationAction({ match, hidden }: { match: ModerationMatch; hidden: boolean }) {
  const { t } = useTranslation(["chess", "common"]);
  const [open, setOpen] = useState(false);
  const actionLabel = hidden ? "hide" : match.hiddenAt ? "unhide" : "keepVisible";
  const queryClient = useQueryClient();
  const mutation = useMutation(
    orpc.chessModeration.setHidden.mutationOptions({
      meta: { skipGlobalErrorToast: true },
      onSuccess: () => {
        setOpen(false);
        void queryClient.invalidateQueries({ queryKey: orpc.chessModeration.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.chess.key() });
      },
    }),
  );
  const form = useForm({
    defaultValues: { reason: (hidden ? "other" : "no_violation") as Reason, note: "" },
    validators: {
      onSubmit: z.object({
        reason: z.enum(reasons),
        note: z
          .string()
          .trim()
          .min(1, t("chess:moderation.statementRequired"))
          .max(1000, t("chess:moderation.noteLimit")),
      }),
    },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync({
          id: match.id,
          hidden,
          reason: value.reason,
          note: value.note.trim(),
        });
      } catch {
        // Keep the reason visible so the administrator can retry deliberately.
      }
    },
  });
  const note = useStore(form.store, (state) => state.values.note);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      form.reset();
      mutation.reset();
    }
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant={hidden ? "destructive" : "outline"} className="min-h-11" />
        }
      >
        {t(`chess:moderation.${actionLabel}`)}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(`chess:moderation.${actionLabel}Title`)}</DialogTitle>
          <DialogDescription>{t("chess:moderation.actionHelp")}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="reason">
            {(field) => (
              <SelectField
                field={field}
                label={t("chess:moderation.reason")}
                disabled={mutation.isPending}
                options={reasons
                  .filter((value) => !hidden || value !== "no_violation")
                  .map((value) => ({ value, label: t(`chess:moderation.reasons.${value}`) }))}
              />
            )}
          </form.Field>
          <form.Field name="note">
            {(field) => (
              <TextareaField
                field={field}
                label={t("chess:moderation.statement")}
                description={t("chess:moderation.statementHelp")}
                autoComplete="off"
                inputMode="text"
                rows={4}
                maxLength={1000}
                disabled={mutation.isPending}
              />
            )}
          </form.Field>
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t("chess:moderation.actionFailed")}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>
              {t("common:actions.cancel")}
            </DialogClose>
            <Button
              type="submit"
              className="min-h-11"
              disabled={mutation.isPending || !note.trim()}
            >
              {t(
                mutation.isPending ? "chess:moderation.saving" : `chess:moderation.${actionLabel}`,
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One cursor-bounded moderation queue; nested reports and audit history are bounded too. */
export function ChessModerationView() {
  const { t, i18n } = useTranslation(["chess", "common"]);
  const [status, setStatus] = useState<"reported" | "hidden" | "all">("reported");
  const {
    data,
    error,
    isPending,
    isError,
    fetchStatus,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    orpc.chessModeration.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: 20, cursor, status }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor,
      refetchInterval: 30_000,
      meta: { skipGlobalErrorToast: true },
    }),
  );
  const date = (value: Date | string) =>
    new Date(value).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  return (
    <PageShell width="wide">
      <PageHeader
        title={t("chess:moderation.adminTitle")}
        description={t("chess:moderation.adminDescription")}
      />
      <SegmentedControl
        ariaLabel={t("chess:moderation.filter")}
        value={status}
        onChange={setStatus}
        items={(["reported", "hidden", "all"] as const).map((value) => ({
          value,
          label: t(`chess:moderation.filters.${value}`),
        }))}
      />
      <QueryBoundary
        query={{ data, error, isPending, isError, fetchStatus, refetch }}
        skeleton={
          <div className="space-y-4">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-56 w-full" />
            ))}
          </div>
        }
        errorMessage={t("chess:moderation.loadFailed")}
        isEmpty={(result) => result.pages.every((page) => page.items.length === 0)}
        empty={<p className="py-8 text-muted-foreground">{t("chess:moderation.empty")}</p>}
      >
        {(result) => (
          <>
            <ul className="space-y-4">
              {result.pages
                .flatMap((page) => page.items)
                .map((match) => (
                  <li key={match.id} className="min-w-0 space-y-4 rounded-lg border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h2 className="break-words font-semibold">{match.title}</h2>
                        <p className="text-sm text-muted-foreground">
                          {t(
                            match.hiddenAt ? "chess:moderation.hidden" : "chess:moderation.visible",
                          )}{" "}
                          · {t("chess:moderation.reportCount", { count: match._count.Reports })}
                        </p>
                        {!match.published && (
                          <p className="text-xs text-muted-foreground">
                            {t("chess:moderation.private")}
                          </p>
                        )}
                        {match.published && !match.hiddenAt && (
                          <Link
                            className="inline-flex min-h-11 items-center text-sm underline"
                            to="/$lang"
                            params={{ lang: i18n.language }}
                            search={{ tab: "arena", game: match.slug }}
                          >
                            {t("chess:moderation.viewReplay")}
                          </Link>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {!match.hiddenAt && (
                          <ModerationAction
                            key={`hide:${match.id}:${match.moderationVersion}`}
                            match={match}
                            hidden
                          />
                        )}
                        <ModerationAction
                          key={`review:${match.id}:${match.moderationVersion}`}
                          match={match}
                          hidden={false}
                        />
                      </div>
                    </div>
                    {match.moderationReason && (
                      <div className="rounded-md bg-muted p-3">
                        <p className="text-sm font-medium">
                          {t(`chess:moderation.reasons.${match.moderationReason}`)}
                        </p>
                        <p className="whitespace-pre-wrap break-words text-sm">
                          {match.moderationNote}
                        </p>
                      </div>
                    )}
                    <section>
                      <h3 className="text-sm font-medium">{t("chess:moderation.recentReports")}</h3>
                      <p className="text-xs text-muted-foreground">
                        {t("chess:moderation.historyBound")}
                      </p>
                      <ul className="mt-2 divide-y">
                        {match.Reports.map((report) => (
                          <li key={report.id} className="py-2 text-sm">
                            <p>
                              {t(`chess:moderation.reasons.${report.reason}`)} ·{" "}
                              {date(report.createdAt)} ·{" "}
                              {t(
                                report.reviewedAt
                                  ? "chess:moderation.reviewed"
                                  : "chess:moderation.pending",
                              )}
                            </p>
                            {report.note && (
                              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                                {report.note}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                    {match.ModerationActions.length > 0 && (
                      <section>
                        <h3 className="text-sm font-medium">{t("chess:moderation.audit")}</h3>
                        <ul className="mt-2 divide-y">
                          {match.ModerationActions.map((action) => (
                            <li key={action.id} className="py-2 text-sm">
                              <p>
                                {t(
                                  action.hidden
                                    ? "chess:moderation.hidden"
                                    : "chess:moderation.restored",
                                )}{" "}
                                · {t(`chess:moderation.reasons.${action.reason}`)} ·{" "}
                                {date(action.createdAt)}
                              </p>
                              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                                {action.note}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </li>
                ))}
            </ul>
            <LoadMore
              hasNextPage={Boolean(hasNextPage)}
              isFetchingNextPage={isFetchingNextPage}
              onLoadMore={() => void fetchNextPage()}
            />
          </>
        )}
      </QueryBoundary>
    </PageShell>
  );
}
