import { boardAt, matchConfigSchema } from "@cockpit-chess/chess";
import type { LocalClient } from "@cockpit-chess/chess/local-contract";
import { CopyField } from "@cockpit-chess/ui/components/copy-field";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { TextField } from "@cockpit-chess/ui/components/text-field";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { isQueryAccessError } from "@/lib/query-access-error";
import { ChessBoard } from "./chess-board";
import { MatchReplay } from "./replay";

const client = createORPCClient<LocalClient>(
  new RPCLink({
    url: new URL("/rpc", location.origin).href,
    plugins: [new SimpleCsrfProtectionLinkPlugin()],
  }),
);
const rpc = createTanstackQueryUtils(client);
export function LocalModelLab() {
  useMobileKeyboard();
  const { t } = useTranslation("chess");
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: rpc.key() });
  };
  const {
    data: stateData,
    error,
    isPending,
    isError,
    refetch,
  } = useQuery({
    ...rpc.state.queryOptions({ input: {} }),
    refetchInterval: (query) =>
      query.state.data?.busy ? 700 : query.state.data?.match?.status === "running" ? 3000 : 10000,
  });
  const create = useMutation(rpc.create.mutationOptions({ onSuccess: refresh }));
  const move = useMutation(rpc.move.mutationOptions({ onSuccess: refresh }));
  const stop = useMutation(rpc.stop.mutationOptions({ onSuccess: refresh }));
  const [invalid, setInvalid] = useState(false);
  const form = useForm({
    defaultValues: {
      model: "openai/gpt-4.1-nano",
      protocol: "openai-chat",
      context: "fresh",
      identity: "hidden",
      mode: "play",
      tokenAccounting: "provider",
      tokenBudget: 1000000,
      engineEvaluation: "off",
      trashTalk: false,
      moveFormat: "strict",
    },
    onSubmit: ({ value }) => {
      const model = { name: value.model, model: value.model, protocol: value.protocol };
      const parsed = matchConfigSchema.safeParse({
        title: t(value.mode === "play" ? "local.playTitle" : "local.simulateTitle"),
        white:
          value.mode === "play"
            ? { name: t("lab.human"), model: "human", protocol: "human" }
            : model,
        black: model,
        rules: {
          context: value.context,
          opponentIdentity: value.identity,
          maxPlies: 120,
          tokenBudget: value.tokenBudget,
          tokenAccounting: value.tokenAccounting,
          engineEvaluation: value.engineEvaluation,
          trashTalk: value.trashTalk,
          moveFormat: value.moveFormat,
          costBudgetMicros: 100000,
        },
      });
      setInvalid(!parsed.success);
      if (parsed.success) create.mutate(parsed.data);
    },
  });
  const data = isQueryAccessError(error) ? undefined : stateData;
  const match = data?.match;
  const chess = useMemo(() => (match ? boardAt(match) : undefined), [match]);
  const currentPlayer =
    match && chess ? (chess.turn() === "w" ? match.config.white : match.config.black) : undefined;
  const pending = Boolean(data?.busy || create.isPending || move.isPending);
  return (
    <div className="cc-public-shell">
      <a
        href="#main-content"
        className="sr-only fixed top-2 left-2 z-[100] rounded-md bg-background px-4 py-3 text-foreground shadow-md focus:not-sr-only focus-visible:outline-2 focus-visible:outline-ring"
      >
        {t("nav:skipToContent")}
      </a>
      <header className="cc-header">
        <span className="cc-brand">
          <img
            src="/pwa-192x192.png"
            alt=""
            width={36}
            height={36}
            decoding="async"
            className="size-9 shrink-0"
          />
          {t("brand")}
        </span>
        <span className="cc-pill">{t("local.private")}</span>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain [scrollbar-gutter:stable]"
      >
        <div className="cc-app">
          <div className="cc-page-intro">
            <h1>{t("lab.title")}</h1>
            <p>{t("local.description")}</p>
          </div>
          {isError && data && (
            <button type="button" className="cc-error" onClick={() => void refetch()}>
              {t("arena.retry")}
            </button>
          )}
          {isPending ? (
            <Skeleton className="h-96 bg-white/5" />
          ) : !data || !match || !chess ? (
            <button type="button" className="cc-error" onClick={() => void refetch()}>
              {t("arena.retry")}
            </button>
          ) : (
            <div className="cc-baseline-layout">
              <section className="cc-board-panel">
                <div className="cc-player">
                  <span className="cc-avatar">♚</span>
                  <div>
                    <strong>{match.config.black.name}</strong>
                    <span>{match.config.black.protocol}</span>
                  </div>
                </div>
                <ChessBoard
                  key={match.id}
                  fen={chess.fen()}
                  disabled={
                    pending || match.status !== "running" || currentPlayer?.protocol !== "human"
                  }
                  onMove={(uci) => move.mutate({ move: uci, expectedSeq: match.events.length })}
                />
                <div className="cc-player">
                  <span className="cc-avatar cc-avatar-light">♔</span>
                  <strong>{match.config.white.name}</strong>
                </div>
                <p className="cc-muted" aria-live="polite">
                  {pending
                    ? t("local.running")
                    : match.status === "running"
                      ? t("lab.yourTurn")
                      : t("lab.finished", { result: match.result })}
                </p>
                <div className="cc-export-row">
                  <button
                    type="button"
                    disabled={stop.isPending || match.status !== "running"}
                    onClick={() => stop.mutate({})}
                  >
                    <Square size={14} />
                    {t("studio.stop")}
                  </button>
                  <a className="cc-button cc-button-secondary" href="/archive" download>
                    <Download size={14} />
                    {t("replay.json")}
                  </a>
                </div>
              </section>
              <aside className="cc-lab-instructions">
                <h2>{t("local.configure")}</h2>
                <p>{t("local.spendNote")}</p>
                {!data.providerReady && <p className="cc-error">{t("local.noKey")}</p>}
                <form
                  className="cc-form-grid"
                  onSubmit={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void form.handleSubmit();
                  }}
                >
                  <form.Field name="model">
                    {(field) => (
                      <TextField
                        field={field}
                        label={t("local.model")}
                        autoComplete="off"
                        inputMode="text"
                        required
                        maxLength={160}
                      />
                    )}
                  </form.Field>
                  <form.Field name="protocol">
                    {(field) => (
                      <label>
                        {t("studio.protocol")}
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
                  <form.Field name="mode">
                    {(field) => (
                      <label>
                        {t("local.mode")}
                        <select
                          value={field.state.value}
                          onChange={(event) => field.handleChange(event.target.value)}
                        >
                          <option value="play">{t("local.play")}</option>
                          <option value="simulate">{t("local.simulate")}</option>
                        </select>
                      </label>
                    )}
                  </form.Field>
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
                  <button
                    className="cc-button"
                    type="submit"
                    disabled={pending || !data.providerReady}
                  >
                    {t("local.start")}
                  </button>
                </form>
                {(invalid || create.isError || move.isError || stop.isError) && (
                  <p role="alert" className="cc-error">
                    {t("studio.error")}
                  </p>
                )}
              </aside>
            </div>
          )}
          {match && (
            <>
              <div className="cc-section-bar">
                <h2>{t("replay.recorded")}</h2>
                <span className="cc-pill">{t("local.private")}</span>
              </div>
              <MatchReplay match={match} live={match.status === "running"} />
            </>
          )}
          <footer className="cc-footer">
            <p>{t("local.footer")}</p>
            <CopyField value={location.origin} copyLabel={t("local.private")} />
          </footer>
        </div>
      </main>
    </div>
  );
}
