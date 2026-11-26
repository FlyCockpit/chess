import { Button } from "@cockpit-chess/ui/components/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@cockpit-chess/ui/components/sheet";
import { fieldErrorMessages, TextField } from "@cockpit-chess/ui/components/text-field";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { orpc } from "@/utils/orpc";
import {
  autoTitle,
  CONTEXT_MODES,
  type CreateMatchValues,
  createMatchSchema,
  DEFAULT_VALUES,
  ENGINE_MODES,
  FIELD_SECTION,
  IDENTITY_MODES,
  LEGAL_MOVE_MODES,
  LIMITS,
  MOVE_FORMATS,
  PROTOCOL_CHOICES,
  REMARK_TONES,
  resolveProtocol,
  type SectionId,
  summaryParts,
  TOKEN_ACCOUNTING,
  toMatchConfig,
} from "./create-match-form";
import { durationLabel } from "./ending-label";
import { type CatalogState, ModelPicker } from "./model-picker";
import { ChoiceField, SettingsSection } from "./settings-section";
import {
  autoMoveLimitMs,
  clockFromTimeControl,
  MOVE_LIMIT_SECONDS,
  timeControlErrors,
} from "./time-control";
import { TimeControlField } from "./time-control-field";

/** The oRPC error code of a failed request, when it has one. */
function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** How often an open dialog asks again while its catalog copy is stale or its refresh failed. */
const CATALOG_STALE_POLL_MS = 12_000;

export function CreateMatchDialog({
  disabled,
  onCreated,
}: {
  disabled: boolean;
  onCreated: (slug: string) => void;
}) {
  const { t, i18n } = useTranslation("chess");
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [sections, setSections] = useState<ReadonlySet<SectionId>>(new Set());
  const {
    data: catalogData,
    isError: catalogError,
    refetch: retryCatalog,
  } = useQuery({
    ...orpc.chess.models.queryOptions(),
    enabled: open,
    // A stale server copy is refetched on the next open or retry; a fresh one is kept a while.
    staleTime: (query) => (query.state.data?.stale ? 0 : 30 * 60 * 1000),
    // While the copy is stale (the server's upstream refresh failed) or our own
    // refresh failed, keep asking so recovered prices replace it by themselves.
    refetchInterval: (query) =>
      query.state.data && (query.state.data.stale || query.state.status === "error")
        ? CATALOG_STALE_POLL_MS
        : false,
    retry: 1,
    meta: { skipGlobalErrorToast: true },
  });
  const catalog = catalogData?.models;
  const catalogState: CatalogState = catalog ? "ready" : catalogError ? "error" : "pending";
  // Older prices are still usable, but the picker says they could not be refreshed.
  const catalogStale = Boolean(catalogData && (catalogData.stale || catalogError));
  const schema = useMemo(() => createMatchSchema(t), [t]);
  const currency = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
      }),
    [i18n.language],
  );
  const mutation = useEntityMutation(
    {
      ...orpc.chess.create.mutationOptions({
        onSuccess: (result) => {
          setOpen(false);
          onCreated(result.slug);
        },
      }),
      // The sheet says what went wrong beside its action bar; a toast would cover that bar
      // on phones and contradict the inline text.
      meta: { skipGlobalErrorToast: true },
    },
    { invalidateKey: orpc.chess.key(), successMessage: t("create.started") },
  );
  const form = useForm({
    defaultValues: DEFAULT_VALUES,
    validators: { onChange: schema, onSubmit: schema },
    onSubmitInvalid: ({ formApi }) => {
      setInvalid(true);
      const failing = Object.entries(formApi.state.fieldMeta).flatMap(([name, meta]) =>
        meta && fieldErrorMessages(meta.errors).length ? [name as keyof CreateMatchValues] : [],
      );
      const toOpen = failing.flatMap((name) => {
        const section = FIELD_SECTION[name];
        return section ? [section] : [];
      });
      if (toOpen.length) setSections((current) => new Set([...current, ...toOpen]));
    },
    onSubmit: ({ value }) => {
      const config = toMatchConfig(value, catalog, t);
      setInvalid(!config.success);
      if (config.success) mutation.mutate(config.data);
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const toggle = (id: SectionId, next: boolean) =>
    setSections((current) => {
      if (current.has(id) === next) return current;
      const copy = new Set(current);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  const summary = summaryParts(values, t, currency).join(" · ");
  const validClock = Object.keys(timeControlErrors(t, values.time)).length
    ? null
    : clockFromTimeControl(values.time);
  const autoMoveLimit = autoMoveLimitMs(validClock);
  const moveLimitText = values.moveLimit.trim()
    ? t("duration.seconds", { seconds: values.moveLimit.trim() })
    : t("create.summary.autoMoveLimit", { time: durationLabel(t, autoMoveLimit) });
  const derivedTitle = autoTitle(values, catalog, t);
  const needsTools =
    values.tools === "tool" ||
    values.engineEvaluation === "tool" ||
    values.engineEvaluation === "both";
  const protocolLabel = (side: "white" | "black") => (choice: (typeof PROTOCOL_CHOICES)[number]) =>
    choice === "auto"
      ? t("create.protocols.auto", {
          protocol: t(`create.protocols.${resolveProtocol("auto", values[side], catalog)}`),
        })
      : `${t(`create.protocols.${choice}`)} · ${choice}`;
  const reset = () => {
    form.reset();
    setInvalid(false);
    setSections(new Set());
    mutation.reset();
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (mutation.isPending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <SheetTrigger
        render={
          <Button className="cc-button" disabled={disabled}>
            <Plus size={16} />
            {t("studio.create")}
          </Button>
        }
      />
      <SheetContent side="right" size="wide" className="cc-dialog-content cc-create-dialog">
        <SheetHeader className="cc-create-header">
          <SheetTitle>{t("create.title")}</SheetTitle>
          <SheetDescription>{t("create.description")}</SheetDescription>
        </SheetHeader>
        <form
          className="cc-create-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <SheetBody className="cc-create-body">
            {catalogStale && (
              <p className="cc-model-warn cc-catalog-notice" role="status">
                {t("create.catalogStale", {
                  time: new Date(catalogData?.fetchedAt ?? Date.now()).toLocaleString(
                    i18n.language,
                    { dateStyle: "medium", timeStyle: "short" },
                  ),
                })}{" "}
                <button
                  type="button"
                  className="cc-link-button"
                  onClick={() => void retryCatalog()}
                >
                  {t("create.retry")}
                </button>
              </p>
            )}
            <div className="cc-create-quick">
              <div className="cc-create-players">
                {(["white", "black"] as const).map((name) => (
                  <form.Field key={name} name={name}>
                    {(field) => (
                      <ModelPicker
                        side={name === "white" ? "w" : "b"}
                        value={field.state.value}
                        onChange={(id) => field.handleChange(id)}
                        catalog={catalog}
                        catalogState={catalogState}
                        onRetry={() => void retryCatalog()}
                        errors={field.state.meta.errors}
                        needsTools={needsTools}
                      />
                    )}
                  </form.Field>
                ))}
              </div>
              <form.Field name="time">
                {(field) => (
                  <TimeControlField
                    value={field.state.value}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </form.Field>
              <form.Field name="title">
                {(field) => (
                  <TextField
                    field={field}
                    label={t("create.titleLabel")}
                    description={t("create.titleHint", { title: derivedTitle })}
                    placeholder={derivedTitle}
                    autoComplete="off"
                    inputMode="text"
                    maxLength={LIMITS.title}
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
                    explain={(value) => (
                      <>
                        {t(`create.explain.remarks.${value}`)}
                        {value !== "off" && <> {t("settings.anonymousCommentary")}</>}
                      </>
                    )}
                  />
                )}
              </form.Field>
            </div>
            <div className="cc-create-side">
              <div className="cc-create-summary">
                <span>{t("create.summaryLabel")}</span>
                <p>{summary}</p>
              </div>
              <div className="cc-advanced">
                <h3>{t("create.advanced")}</h3>
                <p className="cc-field-hint">{t("create.advancedHint")}</p>
                <SettingsSection
                  id="players"
                  open={sections.has("players")}
                  onToggle={toggle}
                  title={t("create.sections.players")}
                  hint={t("create.sections.playersHint")}
                  status={[
                    protocolLabel("white")(values.whiteProtocol),
                    protocolLabel("black")(values.blackProtocol),
                    t(`identity.${values.identity}`),
                  ].join(" · ")}
                >
                  {(["white", "black"] as const).map((side) => (
                    <form.Field
                      key={side}
                      name={side === "white" ? "whiteProtocol" : "blackProtocol"}
                    >
                      {(field) => (
                        <ChoiceField
                          field={field}
                          label={t("create.protocolLabel", {
                            side: t(`colors.${side === "white" ? "w" : "b"}`),
                          })}
                          options={PROTOCOL_CHOICES}
                          optionLabel={protocolLabel(side)}
                          explain={() => t("create.protocolHint")}
                        />
                      )}
                    </form.Field>
                  ))}
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
                </SettingsSection>
                <SettingsSection
                  id="rules"
                  open={sections.has("rules")}
                  onToggle={toggle}
                  title={t("create.sections.rules")}
                  hint={t("create.sections.rulesHint")}
                  status={[
                    t(`context.${values.context}`),
                    t(`tools.${values.tools}`),
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
                  <form.Field name="tools">
                    {(field) => (
                      <ChoiceField
                        field={field}
                        label={t("studio.toolsLabel")}
                        options={LEGAL_MOVE_MODES}
                        optionLabel={(value) => t(`tools.${value}`)}
                        explain={(value) => t(`create.explain.tools.${value}`)}
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
                        explain={(value) => (
                          <>
                            {t(`create.explain.engine.${value}`)}
                            {value !== "off" && <> {t("settings.engineLimits")}</>}
                          </>
                        )}
                      />
                    )}
                  </form.Field>
                </SettingsSection>
                <SettingsSection
                  id="limits"
                  open={sections.has("limits")}
                  onToggle={toggle}
                  title={t("create.sections.limits")}
                  hint={t("create.sections.limitsHint")}
                  status={[
                    t(`accounting.${values.tokenAccounting}`),
                    t("create.summary.budget", {
                      budget: Number.isFinite(Number(values.budget))
                        ? currency.format(Number(values.budget))
                        : values.budget,
                    }),
                    t("create.summary.moveLimit", { time: moveLimitText }),
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
                  <form.Field name="tokenBudget">
                    {(field) => (
                      <TextField
                        field={field}
                        type="number"
                        inputMode="numeric"
                        autoComplete="off"
                        min={LIMITS.tokens.min}
                        max={LIMITS.tokens.max}
                        step={1}
                        label={t("settings.tokenBudget")}
                        description={t("create.explain.tokenBudget", {
                          min: LIMITS.tokens.min.toLocaleString(i18n.language),
                          max: LIMITS.tokens.max.toLocaleString(i18n.language),
                        })}
                      />
                    )}
                  </form.Field>
                  <form.Field name="budget">
                    {(field) => (
                      <TextField
                        field={field}
                        type="number"
                        inputMode="decimal"
                        autoComplete="off"
                        min={LIMITS.budgetUsd.min}
                        max={LIMITS.budgetUsd.max}
                        step={0.01}
                        label={t("studio.budget")}
                        description={t("create.explain.budget", {
                          min: currency.format(LIMITS.budgetUsd.min),
                          max: currency.format(LIMITS.budgetUsd.max),
                        })}
                      />
                    )}
                  </form.Field>
                  <form.Field name="moveLimit">
                    {(field) => (
                      <TextField
                        field={field}
                        type="number"
                        inputMode="numeric"
                        autoComplete="off"
                        min={MOVE_LIMIT_SECONDS.min}
                        max={MOVE_LIMIT_SECONDS.max}
                        step={1}
                        placeholder={String(autoMoveLimit / 1000)}
                        label={t("time.moveLimit")}
                        description={t("create.explain.moveLimit", {
                          auto: durationLabel(t, autoMoveLimit),
                          min: MOVE_LIMIT_SECONDS.min,
                          max: MOVE_LIMIT_SECONDS.max,
                        })}
                      />
                    )}
                  </form.Field>
                </SettingsSection>
              </div>
            </div>
          </SheetBody>
          <SheetFooter className="cc-create-footer">
            {(invalid || mutation.isError) && (
              <p role="alert" className="cc-error cc-create-error">
                {t(
                  invalid
                    ? "create.errors.invalid"
                    : errorCode(mutation.error) === "SERVICE_UNAVAILABLE"
                      ? "create.errors.unavailable"
                      : errorCode(mutation.error) === "TOO_MANY_REQUESTS"
                        ? "create.errors.rateLimited"
                        : "studio.error",
                )}
              </p>
            )}
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={mutation.isPending}
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              {t("create.cancel")}
            </Button>
            <Button className="cc-button min-h-11" type="submit" disabled={mutation.isPending}>
              {t(mutation.isPending ? "create.starting" : "create.start")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
