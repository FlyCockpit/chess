import { boardAt } from "@cockpit-chess/chess";
import { endingSummary, matchEnding } from "@cockpit-chess/chess/ending";
import type { LocalClient } from "@cockpit-chess/chess/local-contract";
import { CopyField } from "@cockpit-chess/ui/components/copy-field";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { TextField } from "@cockpit-chess/ui/components/text-field";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { isQueryAccessError } from "@/lib/query-access-error";
import { ChessBoard } from "./chess-board";
import {
  CONTEXT_MODES,
  ENGINE_MODES,
  IDENTITY_MODES,
  LIMITS,
  MOVE_FORMATS,
  PROTOCOL_CHOICES,
  type ProtocolChoice,
  REMARK_TONES,
  resolveProtocol,
  TOKEN_ACCOUNTING,
} from "./create-match-form";
import { endingHeadlineLabel } from "./ending-label";
import {
  LAB_DEFAULTS,
  LAB_MODES,
  type LabSection,
  labMatchConfig,
  labSummary,
  sectionsWithErrors,
  tokenBudgetValid,
} from "./lab-form";
import { MatchReplay } from "./replay";
import { ChoiceField, SettingsSection } from "./settings-section";
import { TimeControlField } from "./time-control-field";

const client = createORPCClient<LocalClient>(
  new RPCLink({
    url: new URL("/rpc", location.origin).href,
    plugins: [new SimpleCsrfProtectionLinkPlugin()],
  }),
);
const rpc = createTanstackQueryUtils(client);
export function LocalModelLab() {
  useMobileKeyboard();
  const { t, i18n } = useTranslation("chess");
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
    defaultValues: LAB_DEFAULTS,
    onSubmit: ({ value }) => {
      const config = labMatchConfig(value, t);
      setInvalid(!config);
      if (config) create.mutate(config);
    },
    // A field error blocks onSubmit: say so beside Start and open the section that holds it.
    onSubmitInvalid: ({ formApi }) => {
      setInvalid(true);
      const failing = sectionsWithErrors(formApi.state.fieldMeta);
      setSections((current) => new Set([...current, ...failing]));
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const [sections, setSections] = useState<ReadonlySet<LabSection>>(new Set());
  const toggle = (id: LabSection, next: boolean) =>
    setSections((current) => {
      const updated = new Set(current);
      if (next) updated.add(id);
      else updated.delete(id);
      return updated;
    });
  const protocolLabel = (choice: ProtocolChoice) =>
    choice === "auto"
      ? t("create.protocols.auto", {
          protocol: t(`create.protocols.${resolveProtocol("auto", values.model, undefined)}`),
        })
      : t(`create.protocols.${choice}`);
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
        className="sr-only fixed top-2 left-2 z-50 rounded-md bg-background px-4 py-3 text-foreground shadow-md focus:not-sr-only focus:fixed focus-visible:outline-2 focus-visible:outline-ring"
      >
        {t("nav:skipToContent")}
      </a>
      <header className="cc-header">
        <div className="cc-header-row">
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
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain"
      >
        {/* The public shell's column (components/public-shell.tsx): the page grows, the
            footer comes last and ends at the scroller's bottom on a short page. */}
        <div className="flex min-h-full min-w-0 flex-col">
          <div className="flex min-w-0 flex-1 flex-col">
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
                <Skeleton className="h-96" />
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
                        <span>
                          {match.config.black.protocol === "random"
                            ? t("lab.random")
                            : match.config.black.protocol === "human"
                              ? t("lab.human")
                              : t(`create.protocols.${match.config.black.protocol}`)}
                        </span>
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
                          : t("lab.finished", {
                              result: match.result,
                              ending: endingHeadlineLabel(t, endingSummary(matchEnding(match))),
                            })}
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
                      className="cc-form-grid cc-lab-form"
                      noValidate
                      onSubmit={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void form.handleSubmit();
                      }}
                    >
                      <form.Field name="mode">
                        {(field) => (
                          <ChoiceField
                            field={field}
                            label={t("local.mode")}
                            options={LAB_MODES}
                            optionLabel={(value) => t(`local.${value}`)}
                            explain={(value) => t(`local.explain.${value}`)}
                          />
                        )}
                      </form.Field>
                      <form.Field
                        name="model"
                        validators={{
                          onChange: ({ value }) =>
                            value.trim() ? undefined : t("create.errors.model"),
                        }}
                      >
                        {(field) => (
                          <TextField
                            field={field}
                            label={t("local.model")}
                            description={t("local.modelHint")}
                            autoComplete="off"
                            inputMode="text"
                            required
                            maxLength={160}
                          />
                        )}
                      </form.Field>
                      <form.Field name="time">
                        {(field) => (
                          <TimeControlField
                            value={field.state.value}
                            onChange={(next) => field.handleChange(next)}
                          />
                        )}
                      </form.Field>
                      <form.Field name="remarks">
                        {(field) => (
                          <ChoiceField
                            field={field}
                            label={t("settings.remarks")}
                            options={REMARK_TONES}
                            optionLabel={(value) => t(`remarkTones.${value}`)}
                            explain={(value) => t(`create.explain.remarks.${value}`)}
                          />
                        )}
                      </form.Field>
                      <div className="cc-create-summary">
                        <span>{t("create.summaryLabel")}</span>
                        <p>{labSummary(values, t)}</p>
                      </div>
                      <div className="cc-advanced">
                        <h3>{t("create.advanced")}</h3>
                        <p className="cc-field-hint">{t("create.advancedHint")}</p>
                        <SettingsSection
                          id="rules"
                          open={sections.has("rules")}
                          onToggle={toggle}
                          title={t("create.sections.rules")}
                          hint={t("local.sections.rulesHint")}
                          status={[
                            t(`context.${values.context}`),
                            t(`identity.${values.identity}`),
                            t(`moveFormats.${values.moveFormat}`),
                            t(`engineModes.${values.engineEvaluation}`),
                          ].join(" · ")}
                        >
                          <form.Field name="context">
                            {(field) => (
                              <ChoiceField
                                field={field}
                                label={t("studio.contextLabel")}
                                options={CONTEXT_MODES}
                                optionLabel={(value) => t(`context.${value}`)}
                                explain={(value) => t(`create.explain.context.${value}`)}
                              />
                            )}
                          </form.Field>
                          <form.Field name="identity">
                            {(field) => (
                              <ChoiceField
                                field={field}
                                label={t("studio.identityLabel")}
                                options={IDENTITY_MODES}
                                optionLabel={(value) => t(`identity.${value}`)}
                                explain={(value) => t(`create.explain.identity.${value}`)}
                              />
                            )}
                          </form.Field>
                          <form.Field name="moveFormat">
                            {(field) => (
                              <ChoiceField
                                field={field}
                                label={t("settings.moveFormat")}
                                options={MOVE_FORMATS}
                                optionLabel={(value) => t(`moveFormats.${value}`)}
                                explain={(value) => t(`create.explain.moveFormat.${value}`)}
                              />
                            )}
                          </form.Field>
                          <form.Field name="engineEvaluation">
                            {(field) => (
                              <ChoiceField
                                field={field}
                                label={t("settings.engineEvaluation")}
                                options={ENGINE_MODES}
                                optionLabel={(value) => t(`engineModes.${value}`)}
                                explain={(value) => t(`create.explain.engine.${value}`)}
                              />
                            )}
                          </form.Field>
                          <p className="cc-field-hint">{t("settings.anonymousCommentary")}</p>
                        </SettingsSection>
                        <SettingsSection
                          id="limits"
                          open={sections.has("limits")}
                          onToggle={toggle}
                          title={t("create.sections.limits")}
                          hint={t("local.sections.limitsHint")}
                          status={[
                            t(`accounting.${values.tokenAccounting}`),
                            t("local.tokens", {
                              tokens: Number(values.tokenBudget).toLocaleString(i18n.language),
                            }),
                          ].join(" · ")}
                        >
                          <form.Field name="tokenAccounting">
                            {(field) => (
                              <ChoiceField
                                field={field}
                                label={t("settings.tokenAccounting")}
                                options={TOKEN_ACCOUNTING}
                                optionLabel={(value) => t(`accounting.${value}`)}
                                explain={(value) => t(`create.explain.accounting.${value}`)}
                              />
                            )}
                          </form.Field>
                          <form.Field
                            name="tokenBudget"
                            validators={{
                              onChange: ({ value }) =>
                                tokenBudgetValid(value)
                                  ? undefined
                                  : t("create.errors.integerRange", {
                                      min: LIMITS.tokens.min,
                                      max: LIMITS.tokens.max,
                                    }),
                            }}
                          >
                            {(field) => (
                              <TextField
                                field={field}
                                label={t("settings.tokenBudget")}
                                description={t("create.explain.tokenBudget", {
                                  min: LIMITS.tokens.min,
                                  max: LIMITS.tokens.max,
                                })}
                                type="number"
                                autoComplete="off"
                                min={LIMITS.tokens.min}
                                max={LIMITS.tokens.max}
                                step={1}
                              />
                            )}
                          </form.Field>
                        </SettingsSection>
                        <SettingsSection
                          id="connection"
                          open={sections.has("connection")}
                          onToggle={toggle}
                          title={t("local.sections.connection")}
                          hint={t("local.sections.connectionHint")}
                          status={protocolLabel(values.protocol)}
                        >
                          <form.Field name="protocol">
                            {(field) => (
                              <ChoiceField
                                field={field}
                                label={t("studio.protocol")}
                                options={PROTOCOL_CHOICES}
                                optionLabel={protocolLabel}
                                explain={() => t("local.protocolHint")}
                              />
                            )}
                          </form.Field>
                        </SettingsSection>
                      </div>
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
                        {t(invalid ? "create.errors.invalid" : "studio.error")}
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
                  <MatchReplay
                    key={match.id}
                    match={match}
                    live={match.status === "running"}
                    spectator={data?.spectator}
                  />
                </>
              )}
            </div>
          </div>
          <footer className="cc-footer">
            <div className="cc-footer-row">
              <p>{t("local.footer")}</p>
              <CopyField value={location.origin} copyLabel={t("local.private")} />
            </div>
          </footer>
        </div>
      </main>
    </div>
  );
}
