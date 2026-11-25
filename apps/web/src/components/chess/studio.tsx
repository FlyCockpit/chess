import { hasRole } from "@cockpit-chess/auth/roles";
import { MAX_ARCHIVE_BYTES, type MatchArchive } from "@cockpit-chess/chess";
import { Button } from "@cockpit-chess/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@cockpit-chess/ui/components/dialog";
import { toast } from "@cockpit-chess/ui/components/sileo";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { TextareaField } from "@cockpit-chess/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download, Upload } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { InlineRetry } from "@/components/inline-retry";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { useAuthSession } from "@/hooks/use-auth-session";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";
import { CreateMatchDialog } from "./create-match-dialog";
import { MatchReplay } from "./replay";
import { drawShareCard, SHARE_HEIGHT, SHARE_WIDTH } from "./share-card";

export function Studio({ onWatch }: { onWatch: (slug: string) => void }) {
  const { t, i18n } = useTranslation("chess");
  const { state } = useAuthSession();
  const admin = state.status === "authenticated" && hasRole(state.session.user.role ?? "", "admin");
  const [selected, setSelected] = useState("");
  const {
    data,
    error,
    isPending,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    ...orpc.chess.studio.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: 12, cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor,
    }),
    enabled: admin,
    meta: { skipGlobalErrorToast: true },
    refetchInterval: (query) =>
      admin &&
      query.state.data?.pages.some((page) =>
        page.items.some((game) => game.status === "running" || game.status === "queued"),
      )
        ? 5000
        : false,
  });
  const { data: info } = useQuery(orpc.chess.info.queryOptions());
  const {
    data: detailData,
    error: detailFailure,
    isPending: detailPending,
    isError: detailError,
    refetch: retryDetail,
  } = useQuery({
    ...orpc.chess.inspect.queryOptions({ input: { slug: selected || "not-selected" } }),
    enabled: admin && Boolean(selected),
    meta: { skipGlobalErrorToast: true },
    refetchInterval: (query) => (query.state.data?.archive.status === "running" ? 2000 : false),
  });
  const detail = isQueryAccessError(detailFailure) ? undefined : detailData;
  const publish = useEntityMutation(orpc.chess.publish.mutationOptions(), {
    invalidateKey: orpc.chess.key(),
    successMessage: t("studio.success"),
  });
  const stop = useEntityMutation(orpc.chess.stop.mutationOptions(), {
    invalidateKey: orpc.chess.key(),
  });
  if (state.status === "pending") return <Skeleton className="mt-12 h-96" />;
  return (
    <>
      <div className="cc-page-intro">
        <h1>{t("studio.title")}</h1>
        <p>{t("studio.description")}</p>
      </div>
      {!admin ? (
        <div className="cc-empty">
          <p>{t("studio.signIn")}</p>
          <Link
            className="cc-button mt-5"
            to="/$lang/login"
            params={{ lang: i18n.language }}
            search={{ redirectTo: `/${i18n.language}/?tab=studio` }}
          >
            {t("studio.signIn")}
          </Link>
        </div>
      ) : (
        <>
          {!info?.hostedEnabled && <p className="cc-muted mb-6">{t("studio.disabled")}</p>}
          <div className="cc-hero-actions mb-8">
            <CreateMatchDialog disabled={!info?.hostedEnabled} onCreated={setSelected} />
            <ImportDialog onImported={setSelected} />
          </div>
          <QueryBoundary
            query={{ data, error, isPending, isError, refetch }}
            skeleton={<Skeleton className="h-32" />}
            isEmpty={(result) => !result.pages.some((page) => page.items.length)}
            empty={
              <div className="cc-empty">
                <h3>{t("studio.empty")}</h3>
              </div>
            }
          >
            {(data) => (
              <div className="cc-card-grid">
                {data.pages
                  .flatMap((page) => page.items)
                  .map((game) => (
                    <article className="cc-game-card" key={game.id}>
                      <span className="cc-pill">
                        {game.published ? t(`arena.status.${game.status}`) : t("arena.unpublished")}
                      </span>
                      <h3>{game.title}</h3>
                      <p>
                        {game.whiteName} × {game.blackName}
                      </p>
                      <div className="cc-export-row">
                        <button type="button" onClick={() => setSelected(game.slug)}>
                          {t("studio.preview")}
                        </button>
                        <button
                          type="button"
                          disabled={publish.isPending}
                          onClick={() =>
                            publish.mutate({ slug: game.slug, published: !game.published })
                          }
                        >
                          {t(game.published ? "studio.unpublish" : "studio.publish")}
                        </button>
                        {["running", "queued"].includes(game.status) && (
                          <button
                            type="button"
                            disabled={stop.isPending}
                            onClick={() => stop.mutate({ slug: game.slug })}
                          >
                            {t("studio.stop")}
                          </button>
                        )}
                        {game.published && (
                          <button type="button" onClick={() => onWatch(game.slug)}>
                            {t("studio.view")}
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
              </div>
            )}
          </QueryBoundary>
          <LoadMore
            onLoadMore={() => void fetchNextPage()}
            hasNextPage={!isQueryAccessError(error) && Boolean(hasNextPage)}
            isFetchingNextPage={isFetchingNextPage}
          />
          {(publish.isError || stop.isError) && (
            <p role="alert" className="cc-error">
              {t("studio.error")}
            </p>
          )}
          {selected && detailError && (
            <InlineRetry onRetry={() => void retryDetail()} message={t("studio.error")} />
          )}
          {selected && detailPending && <Skeleton className="h-96" />}
          {selected && detail && (
            <>
              <div className="cc-section-bar">
                <h2>{t("studio.preview")}</h2>
                <ShareCard match={detail.archive} slug={selected} published={detail.published} />
              </div>
              <MatchReplay
                key={detail.archive.id}
                match={detail.archive}
                live={detail.archive.status === "running"}
              />
            </>
          )}
        </>
      )}
    </>
  );
}
function ImportDialog({ onImported }: { onImported: (slug: string) => void }) {
  const { t } = useTranslation("chess");
  const [open, setOpen] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const mutation = useEntityMutation(
    orpc.chess.importGame.mutationOptions({
      onSuccess: (result) => {
        setOpen(false);
        if (result.duplicate) toast.message(t("studio.duplicate"));
        onImported(result.slug);
      },
    }),
    { invalidateKey: orpc.chess.key() },
  );
  const form = useForm({
    defaultValues: { json: "" },
    validators: { onChange: z.object({ json: z.string().min(1).max(MAX_ARCHIVE_BYTES) }) },
    onSubmit: ({ value }) => mutation.mutate(value),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!mutation.isPending) setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button className="cc-button cc-button-secondary">
            <Upload size={15} />
            {t("studio.import")}
          </Button>
        }
      />
      <DialogContent className="cc-dialog-content sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("studio.archiveTitle")}</DialogTitle>
          <DialogDescription>{t("studio.description")}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
          className="cc-form-grid"
        >
          <input
            type="file"
            accept=".json,application/json"
            aria-label={t("studio.import")}
            onChange={async (event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              input.value = "";
              if (!file) return;
              setTooLarge(file.size > MAX_ARCHIVE_BYTES);
              if (file.size <= MAX_ARCHIVE_BYTES) form.setFieldValue("json", await file.text());
            }}
          />
          <form.Field name="json">
            {(field) => (
              <TextareaField
                field={field}
                autoComplete="off"
                label={t("studio.jsonLabel")}
                rows={8}
              />
            )}
          </form.Field>
          {tooLarge && (
            <p role="alert" className="cc-error">
              {t("lab.importTooLarge")}
            </p>
          )}
          {mutation.isError && (
            <p role="alert" className="cc-error">
              {t("lab.importError")}
            </p>
          )}
          <Button className="min-h-11 md:min-h-0" type="submit" disabled={mutation.isPending}>
            {t(mutation.isPending ? "studio.pending" : "studio.import")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function ShareCard({
  match,
  slug,
  published,
}: {
  match: MatchArchive;
  slug: string;
  published: boolean;
}) {
  const { t } = useTranslation("chess");
  function download() {
    const canvas = document.createElement("canvas");
    canvas.width = SHARE_WIDTH;
    canvas.height = SHARE_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const replayUrl = new URL(window.location.href);
    replayUrl.search = new URLSearchParams({ game: slug }).toString();
    replayUrl.hash = "";
    drawShareCard(ctx, match, t, published ? replayUrl.toString() : null);
    const anchor = document.createElement("a");
    anchor.download = `cockpit-${match.id}.png`;
    anchor.href = canvas.toDataURL("image/png");
    anchor.click();
  }
  return (
    <button className="cc-button cc-button-secondary" type="button" onClick={download}>
      <Download size={15} />
      {t("studio.shareDownload")}
    </button>
  );
}
