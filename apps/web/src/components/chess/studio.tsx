import { hasRole } from "@cockpit-chess/auth/roles";
import {
  boardAt,
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  matchConfigSchema,
  matchStats,
} from "@cockpit-chess/chess";
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
import { TextareaField, TextField } from "@cockpit-chess/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download, Plus, Upload } from "lucide-react";
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
import { MatchReplay } from "./replay";

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
  if (state.status === "pending") return <Skeleton className="mt-12 h-96 bg-white/5" />;
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
            <CreateMatchDialog
              disabled={!info?.hostedEnabled}
              models={info?.models ?? []}
              onCreated={setSelected}
            />
            <ImportDialog onImported={setSelected} />
          </div>
          <QueryBoundary
            query={{ data, error, isPending, isError, refetch }}
            skeleton={<Skeleton className="h-32 bg-white/5" />}
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
          {selected && detailPending && <Skeleton className="h-96 bg-white/5" />}
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
function CreateMatchDialog({
  disabled,
  models,
  onCreated,
}: {
  disabled: boolean;
  models: string[];
  onCreated: (slug: string) => void;
}) {
  const { t } = useTranslation("chess");
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const mutation = useEntityMutation(
    orpc.chess.create.mutationOptions({
      onSuccess: (result) => {
        setOpen(false);
        onCreated(result.slug);
      },
    }),
    { invalidateKey: orpc.chess.key() },
  );
  const form = useForm({
    defaultValues: {
      title: "",
      white: "openai/gpt-4.1-nano",
      black: "openai/gpt-4.1-mini",
      whiteProtocol: "openai-chat",
      blackProtocol: "openai-chat",
      context: "fresh",
      identity: "hidden",
      tools: "tool",
      maxPlies: 80,
      budget: 0.1,
      tokenAccounting: "provider",
      tokenBudget: 1000000,
      engineEvaluation: "off",
      trashTalk: false,
      moveFormat: "strict",
    },
    onSubmit: ({ value }) => {
      const config = matchConfigSchema.safeParse({
        title: value.title,
        white: { name: value.white, model: value.white, protocol: value.whiteProtocol },
        black: { name: value.black, model: value.black, protocol: value.blackProtocol },
        rules: {
          context: value.context,
          opponentIdentity: value.identity,
          legalMoves: value.tools,
          maxPlies: value.maxPlies,
          costBudgetMicros: Math.round(value.budget * 1000000),
          tokenBudget: value.tokenBudget,
          tokenAccounting: value.tokenAccounting,
          engineEvaluation: value.engineEvaluation,
          trashTalk: value.trashTalk,
          moveFormat: value.moveFormat,
        },
      });
      setInvalid(!config.success);
      if (config.success) mutation.mutate(config.data);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (mutation.isPending) return;
        setOpen(next);
        setInvalid(false);
      }}
    >
      <DialogTrigger
        render={
          <Button className="cc-button" disabled={disabled}>
            <Plus size={16} />
            {t("studio.create")}
          </Button>
        }
      />
      <DialogContent className="cc-dialog-content sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("studio.createTitle")}</DialogTitle>
          <DialogDescription>{t("studio.description")}</DialogDescription>
        </DialogHeader>
        <form
          className="cc-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field name="title">
            {(field) => (
              <TextField
                field={field}
                label={t("studio.titleLabel")}
                autoComplete="off"
                inputMode="text"
                maxLength={140}
                required
              />
            )}
          </form.Field>
          {(["white", "black"] as const).map((name) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <label>
                  {t(name === "white" ? "studio.whiteModel" : "studio.blackModel")}
                  <input
                    autoComplete="off"
                    inputMode="text"
                    list="chess-models"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    required
                    maxLength={160}
                  />
                </label>
              )}
            </form.Field>
          ))}
          <datalist id="chess-models">
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          {(["whiteProtocol", "blackProtocol"] as const).map((name) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <label>
                  {t(name === "whiteProtocol" ? "studio.whiteProtocol" : "studio.blackProtocol")}
                  <select
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    {["openai-chat", "openai-responses", "anthropic"].map((protocol) => (
                      <option key={protocol} value={protocol}>
                        {protocol}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </form.Field>
          ))}
          <form.Field name="context">
            {(field) => (
              <label>
                {t("studio.contextLabel")}
                <select
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  {["fresh", "persistent"].map((value) => (
                    <option key={value} value={value}>
                      {t(`context.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </form.Field>
          <form.Field name="identity">
            {(field) => (
              <label>
                {t("studio.identityLabel")}
                <select
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  {["hidden", "disclosed"].map((value) => (
                    <option key={value} value={value}>
                      {t(`identity.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </form.Field>
          <form.Field name="tools">
            {(field) => (
              <label>
                {t("studio.toolsLabel")}
                <select
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  {["hidden", "tool", "provided"].map((value) => (
                    <option key={value} value={value}>
                      {t(`tools.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </form.Field>

          <form.Field name="moveFormat">
            {(field) => (
              <label>
                {t("settings.moveFormat")}
                <select
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  {["strict", "lenient"].map((value) => (
                    <option key={value} value={value}>
                      {t(`moveFormats.${value}`)}
                    </option>
                  ))}
                </select>
                <small>{t("settings.moveFormatNote")}</small>
              </label>
            )}
          </form.Field>
          <form.Field name="tokenAccounting">
            {(field) => (
              <label>
                {t("settings.tokenAccounting")}
                <select
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  {["provider", "cl100k_base"].map((value) => (
                    <option key={value} value={value}>
                      {t(`accounting.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </form.Field>
          <form.Field name="tokenBudget">
            {(field) => (
              <label>
                {t("settings.tokenBudget")}
                <input
                  type="number"
                  autoComplete="off"
                  min={256}
                  max={1000000}
                  required
                  value={field.state.value}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber;
                    if (Number.isFinite(value)) field.handleChange(value);
                  }}
                />
              </label>
            )}
          </form.Field>
          <form.Field name="engineEvaluation">
            {(field) => (
              <label>
                {t("settings.engineEvaluation")}
                <select
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  {["off", "tool", "after-move", "both"].map((value) => (
                    <option key={value} value={value}>
                      {t(`engineModes.${value}`)}
                    </option>
                  ))}
                </select>
                <small>{t("settings.engineLimits")}</small>
              </label>
            )}
          </form.Field>
          <form.Field name="trashTalk">
            {(field) => (
              <label className="cc-check">
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                {t("settings.trashTalk")}
              </label>
            )}
          </form.Field>
          <p className="cc-muted text-xs">{t("settings.anonymousCommentary")}</p>
          <form.Field name="maxPlies">
            {(field) => (
              <label>
                {t("studio.plies")}
                <input
                  type="number"
                  autoComplete="off"
                  min={2}
                  max={200}
                  required
                  value={field.state.value}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber;
                    if (Number.isFinite(value)) field.handleChange(value);
                  }}
                />
              </label>
            )}
          </form.Field>
          <form.Field name="budget">
            {(field) => (
              <label>
                {t("studio.budget")}
                <input
                  type="number"
                  autoComplete="off"
                  min={0.01}
                  max={1}
                  step={0.01}
                  required
                  value={field.state.value}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber;
                    if (Number.isFinite(value)) field.handleChange(value);
                  }}
                />
              </label>
            )}
          </form.Field>
          {(invalid || mutation.isError) && (
            <p role="alert" className="cc-error">
              {t("studio.error")}
            </p>
          )}
          <Button className="min-h-11 md:min-h-0" type="submit" disabled={mutation.isPending}>
            {t(mutation.isPending ? "studio.pending" : "studio.create")}
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
    canvas.width = 1200;
    canvas.height = 675;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#101b1a";
    ctx.fillRect(0, 0, 1200, 675);
    ctx.fillStyle = "#a2e5b4";
    ctx.fillRect(0, 0, 1200, 8);
    ctx.font = "bold 22px sans-serif";
    ctx.fillText(t("brand").toUpperCase(), 56, 65);
    ctx.fillStyle = "#f2f1e8";
    ctx.font = "bold 44px sans-serif";
    const titleWords = match.config.title.split(/\s+/);
    let titleLine = "";
    let titleY = 130;
    for (const word of titleWords) {
      if (ctx.measureText(`${titleLine} ${word}`).width > 620 && titleLine) {
        ctx.fillText(titleLine, 56, titleY, 620);
        titleY += 48;
        titleLine = "";
        if (titleY > 178) break;
      }
      titleLine = titleLine ? `${titleLine} ${word}` : word;
    }
    if (titleY <= 178) ctx.fillText(titleLine, 56, titleY, 620);
    ctx.font = "24px sans-serif";
    ctx.fillText(match.config.white.name, 56, 230, 620);
    ctx.fillText(match.config.black.name, 56, 266, 620);
    ctx.font = "bold 100px monospace";
    ctx.fillStyle = "#a2e5b4";
    ctx.fillText(match.result, 56, 378);
    const stats = matchStats(match);
    ctx.fillStyle = "#bbc9c1";
    ctx.font = "20px sans-serif";
    ctx.fillText(
      `${stats.moves} ${t("stats.plies")} · ${stats.illegalAttempts} ${t("stats.rejected")}`,
      56,
      420,
      620,
    );
    ctx.fillText(
      `${t(`context.${match.config.rules.context}`)} · ${t(`identity.${match.config.rules.opponentIdentity}`)}`,
      56,
      456,
      620,
    );
    ctx.fillText(t(`termination.${match.termination}`), 56, 490, 620);
    ctx.font = "16px sans-serif";
    ctx.fillText(
      `${t("studio.noSamples")} · ${match.source} · ${match.config.rules.version}`,
      56,
      548,
      620,
    );
    ctx.fillText(`${match.config.white.protocol} / ${match.config.black.protocol}`, 56, 574, 620);
    ctx.fillText(
      `${t(`accounting.${match.config.rules.tokenAccounting}`)} · ${t(`engineModes.${match.config.rules.engineEvaluation}`)}`,
      56,
      600,
      620,
    );
    const replayUrl = new URL(window.location.href);
    replayUrl.search = new URLSearchParams({ game: slug }).toString();
    replayUrl.hash = "";
    ctx.fillText(published ? replayUrl.toString() : t("studio.privateGraphic"), 56, 628, 1080);
    const chess = boardAt(match);
    const glyphs = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" };
    chess.board().forEach((row, rank) => {
      row.forEach((piece, file) => {
        const x = 735 + file * 50;
        const y = 150 + rank * 50;
        ctx.fillStyle = (rank + file) % 2 ? "#5a7d69" : "#dfe4cd";
        ctx.fillRect(x, y, 50, 50);
        if (piece) {
          ctx.font = "42px Georgia";
          ctx.fillStyle = piece.color === "w" ? "#fffdf3" : "#182520";
          ctx.strokeStyle = "#182520";
          ctx.lineWidth = 1;
          ctx.strokeText(glyphs[piece.type], x + 4, y + 40);
          ctx.fillText(glyphs[piece.type], x + 4, y + 40);
        }
      });
    });
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
