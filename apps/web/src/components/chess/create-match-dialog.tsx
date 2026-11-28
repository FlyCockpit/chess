import { FALLBACK_MAX_OUTPUT_TOKENS, type MatchConfig } from "@cockpit-chess/chess";
import { AsyncCombobox } from "@cockpit-chess/ui/components/async-combobox";
import { Button } from "@cockpit-chess/ui/components/button";
import { RangeField } from "@cockpit-chess/ui/components/range-field";
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
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { fieldErrorMessages, TextField } from "@cockpit-chess/ui/components/text-field";
import { useForm, useStore } from "@tanstack/react-form";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadMore } from "@/components/load-more";
import { SegmentedControl } from "@/components/segmented-control";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { useRangeFieldLabels } from "@/hooks/use-form-field-labels";
import { networkFailureKind } from "@/lib/network-failure";
import { openRouterMoney } from "@/lib/openrouter-connect";
import { isQueryAccessError } from "@/lib/query-access-error";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import {
  autoTitle,
  type Billing,
  billedLimits,
  budgetStops,
  CONTEXT_MODES,
  type CreateMatchValues,
  createMatchSchema,
  createRefusal,
  DEFAULT_VALUES,
  defaultValuesFor,
  ENGINE_MODES,
  FALLBACK_LIMITS,
  FIELD_SECTION,
  findModel,
  type HostedLimits,
  IDENTITY_MODES,
  ILLEGAL_POLICIES,
  LEGAL_MOVE_MODES,
  LIMITS,
  MOVE_FORMATS,
  maxBudgetUsd,
  officialEligible,
  PROTOCOL_CHOICES,
  REMARK_TONES,
  replyCapTokens,
  resolveProtocol,
  runnerFormLimits,
  runnerRecentlySeen,
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
  runner = false,
  limits: operatorLimits = FALLBACK_LIMITS,
  billingOptions = ["operator"],
  ownKeyRemainingMicros = null,
  onCreated,
}: {
  disabled: boolean;
  /** Offer a practice match to an own local machine, independently of hosted billing. */
  runner?: boolean;
  /** The server's per-side operator limits (`chess.info`); the budget fields stop there. */
  limits?: HostedLimits;
  /**
   * Who may pay, first = default: an admin has the server key (and their own key once
   * connected); a user only their own OpenRouter key.
   */
  billingOptions?: readonly [Billing, ...Billing[]];
  /** What the user's own key has left (OpenRouter's number); null = no limit. */
  ownKeyRemainingMicros?: number | null;
  onCreated: (slug: string) => void;
}) {
  const { t, i18n } = useTranslation("chess");
  const [billing, setBilling] = useState<Billing>(billingOptions[0]);
  // Keep the exact accepted intent for a retry, including catalog-derived names.
  const submission = useRef<
    (MatchConfig & { billing: Billing; official: boolean; creationKey: string }) | null
  >(null);
  const runnerSubmission = useRef<{
    machineId: string;
    creationKey: string;
    config: MatchConfig;
  } | null>(null);
  const runnerInFlight = useRef(false);
  const [offerLocked, setOfferLocked] = useState(false);
  const rangeLabels = useRangeFieldLabels();
  const [open, setOpen] = useState(false);
  const [machineId, setMachineId] = useState<string | null>(null);
  const {
    data: machinesData,
    isPending: machinesPending,
    isError: machinesError,
    error: machinesFailure,
    refetch: retryMachines,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    ...orpc.cliAccess.runners.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: 20, cursor }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
    enabled: open && runner,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: open && runner ? 15_000 : false,
    meta: { skipGlobalErrorToast: true },
  });
  const machines = isQueryAccessError(machinesFailure)
    ? []
    : (machinesData?.pages.flatMap((page) => page.items) ?? []);
  const availableMachines = machines.filter((machine) => runnerRecentlySeen(machine));
  const selectedMachine = machineId
    ? machines.find((machine) => machine.id === machineId)
    : availableMachines[0];
  const {
    data: limitsData,
    isPending: limitsPending,
    isError: limitsError,
    error: limitsFailure,
    refetch: retryLimits,
  } = useQuery({
    ...orpc.cliAccess.runners.getLimits.queryOptions({
      input: { id: selectedMachine?.id ?? "" },
    }),
    enabled: open && runner && !!selectedMachine,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: open && runner && selectedMachine ? 5000 : false,
    meta: { skipGlobalErrorToast: true },
  });
  const machineLimits =
    !selectedMachine || isQueryAccessError(limitsFailure) ? undefined : limitsData;
  const confirmedLimits =
    machineLimits?.available && machineLimits.operatingLimits && machineLimits.hardLimits
      ? runnerFormLimits(machineLimits.operatingLimits, machineLimits.hardLimits)
      : null;
  const runnerReady = !!(
    selectedMachine &&
    runnerRecentlySeen(selectedMachine) &&
    !machinesPending &&
    !limitsPending &&
    !machinesError &&
    !limitsError &&
    confirmedLimits &&
    confirmedLimits.maxCostMicros >= LIMITS.budgetUsd.min * 1_000_000
  );
  const limits = useMemo(
    () =>
      runner
        ? (confirmedLimits ?? { maxCostMicros: 0, maxTokens: LIMITS.tokens.max })
        : billing === "openrouter"
          ? billedLimits(operatorLimits, ownKeyRemainingMicros)
          : operatorLimits,
    [runner, confirmedLimits, billing, operatorLimits, ownKeyRemainingMicros],
  );
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
  const schema = useMemo(() => createMatchSchema(t, limits), [t, limits]);
  const budgetMax = maxBudgetUsd(limits);
  const usdUnits = useMemo(
    () => [{ factor: 1, label: t("create.units.usd"), aliases: ["usd", "dollars"] }],
    [t],
  );
  const tokenUnits = useMemo(
    () => [
      { factor: 1, label: "" },
      { factor: 1000, label: t("create.units.thousand"), aliases: ["k"] },
      { factor: 1_000_000, label: t("create.units.million"), aliases: ["m"] },
    ],
    [t],
  );
  const currency = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
      }),
    [i18n.language],
  );
  const hostedMutation = useEntityMutation(
    {
      ...orpc.chess.create.mutationOptions({
        onSuccess: (result) => {
          submission.current = null;
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
  const runnerMutation = useEntityMutation(
    {
      ...orpc.chess.createRunner.mutationOptions({
        onSuccess: (result) => {
          runnerInFlight.current = false;
          runnerSubmission.current = null;
          setOfferLocked(false);
          setOpen(false);
          onCreated(result.slug);
        },
        onError: (error) => {
          runnerInFlight.current = false;
          // A transport/server failure may hide a committed offer. Keep its receipt
          // and machine fixed until a retry resolves it. Explicit refusals are safe to edit.
          if (
            [
              "BAD_REQUEST",
              "NOT_FOUND",
              "FORBIDDEN",
              "UNAUTHORIZED",
              "TOO_MANY_REQUESTS",
              "CONFLICT",
            ].includes(String(errorCode(error))) &&
            !networkFailureKind(error)
          ) {
            runnerSubmission.current = null;
            setOfferLocked(false);
          }
        },
      }),
      meta: { skipGlobalErrorToast: true },
    },
    { invalidateKey: orpc.chess.key(), successMessage: t("create.runner.offered") },
  );
  const mutation = runner ? runnerMutation : hostedMutation;
  const locked = mutation.isPending || (runner && offerLocked);
  const form = useForm({
    defaultValues: defaultValuesFor(limits),
    listeners: {
      onChange: () => {
        if (runner ? runnerSubmission.current : hostedMutation.isPending) return;
        submission.current = null;
      },
    },
    // Retrying an uncertain offer must not revalidate against a newer machine cap.
    validators: {
      onChange: runner && offerLocked ? undefined : schema,
      onSubmit: runner && offerLocked ? undefined : schema,
    },
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
      if (disabled || mutation.isPending || (runner && runnerInFlight.current)) return;
      if (runner && runnerSubmission.current) {
        runnerInFlight.current = true;
        runnerMutation.mutate(runnerSubmission.current);
        return;
      }
      if (runner && (!runnerReady || !selectedMachine)) return;
      if (!runner && submission.current) {
        hostedMutation.mutate(submission.current);
        return;
      }
      const submittedValues = runner ? { ...value, official: false } : value;
      const config = toMatchConfig(submittedValues, catalog, t);
      const valid =
        schema.safeParse(submittedValues).success &&
        config.success &&
        (runner || !value.official || officialEligible(config.data));
      setInvalid(!valid);
      if (config.success && valid) {
        if (runner && selectedMachine) {
          runnerSubmission.current = {
            machineId: selectedMachine.id,
            creationKey: crypto.randomUUID(),
            config: config.data,
          };
          runnerInFlight.current = true;
          setMachineId(selectedMachine.id);
          setOfferLocked(true);
          runnerMutation.mutate(runnerSubmission.current);
          return;
        }
        submission.current = {
          ...config.data,
          billing,
          official: value.official,
          creationKey: crypto.randomUUID(),
        };
        hostedMutation.mutate(submission.current);
      }
    },
  });
  // effect:audited — clamp confirmed runner caps after other fields change; never alter a retry.
  useEffect(() => {
    if (!runner || !confirmedLimits || runnerSubmission.current) return;
    const maximum = maxBudgetUsd(confirmedLimits);
    if (form.getFieldValue("budget") > maximum) form.setFieldValue("budget", maximum);
  }, [runner, confirmedLimits, form]);
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
  const replyCap = replyCapTokens(values.replyCap);
  /** What one reply may use without a cap: the model's own maximum, or the fallback. */
  const modelMax = (side: "white" | "black") => {
    const max = findModel(catalog, values[side])?.maxOutputTokens;
    return max
      ? t("create.modelMax", { tokens: max.toLocaleString(i18n.language) })
      : t("create.modelMaxUnknown", {
          tokens: FALLBACK_MAX_OUTPUT_TOKENS.toLocaleString(i18n.language),
        });
  };
  const needsTools =
    values.tools === "tool" ||
    values.engineEvaluation === "tool" ||
    values.engineEvaluation === "both";
  const protocolLabel = (side: "white" | "black") => (choice: (typeof PROTOCOL_CHOICES)[number]) =>
    choice === "auto"
      ? t("create.protocols.auto", {
          protocol: t(`create.protocols.${resolveProtocol("auto", values[side], catalog)}`),
        })
      : t(`create.protocols.${choice}`);
  const refusal = createRefusal(mutation.error);
  const chooseBilling = (next: Billing) => {
    submission.current = null;
    setBilling(next);
    // A smaller allowance (the user's own key) pulls a budget above it down to fit.
    const nextMax = maxBudgetUsd(
      next === "openrouter" ? billedLimits(operatorLimits, ownKeyRemainingMicros) : operatorLimits,
    );
    if (form.getFieldValue("budget") > nextMax) form.setFieldValue("budget", nextMax);
  };
  const reset = () => {
    submission.current = null;
    runnerSubmission.current = null;
    runnerInFlight.current = false;
    setOfferLocked(false);
    setMachineId(null);
    setBilling(billingOptions[0]);
    form.reset(defaultValuesFor(limits));
    setInvalid(false);
    setSections(new Set());
    mutation.reset();
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (locked || (runner && runnerSubmission.current)) return;
        // Opening starts from defaults within the limits the server reports now.
        if (next) {
          submission.current = null;
          setBilling(billingOptions[0]);
          form.reset(
            defaultValuesFor(
              runner
                ? limits
                : billingOptions[0] === "openrouter"
                  ? billedLimits(operatorLimits, ownKeyRemainingMicros)
                  : operatorLimits,
            ),
          );
        }
        setOpen(next);
        if (!next) reset();
      }}
    >
      <SheetTrigger
        render={
          <Button className="cc-button" disabled={disabled}>
            <Plus size={16} />
            {t(runner ? "create.runner.trigger" : "studio.create")}
          </Button>
        }
      />
      <SheetContent side="right" size="wide" className="cc-dialog-content cc-create-dialog">
        <SheetHeader className="cc-create-header">
          <SheetTitle>{t(runner ? "create.runner.title" : "create.title")}</SheetTitle>
          <SheetDescription>
            {t(runner ? "create.runner.description" : "create.description")}
          </SheetDescription>
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
            <fieldset disabled={locked} inert={locked} className="contents">
              {runner && (
                <div className="cc-create-billing col-span-full space-y-3">
                  <label htmlFor="runner-machine" className="cc-field-label">
                    {t("create.runner.machine")}
                  </label>
                  {machinesError && <p role="alert">{t("create.runner.machinesFailed")}</p>}
                  {machinesPending && !machines.length ? (
                    <Skeleton className="h-11 w-full" />
                  ) : (
                    <>
                      <AsyncCombobox
                        id="runner-machine"
                        value={selectedMachine ?? null}
                        onSearch={async (query) =>
                          availableMachines.filter((machine) =>
                            machine.displayName
                              .toLocaleLowerCase()
                              .includes(query.toLocaleLowerCase()),
                          )
                        }
                        onSelect={(machine) => {
                          if (runnerSubmission.current || runnerInFlight.current) return;
                          setMachineId(machine.id);
                        }}
                        getKey={(machine) => machine.id}
                        getLabel={(machine) => machine.displayName}
                        renderItem={(machine) => machine.displayName}
                        placeholder={t("create.runner.selectMachine")}
                        searchPlaceholder={t("create.runner.searchMachine")}
                        emptyText={t("create.runner.empty")}
                        disabled={locked || availableMachines.length === 0}
                        className="min-h-11"
                      />
                      {availableMachines.length === 0 && <p>{t("create.runner.empty")}</p>}
                      {selectedMachine && !runnerRecentlySeen(selectedMachine) && (
                        <p role="alert">{t("create.runner.offline")}</p>
                      )}
                      <LoadMore
                        hasNextPage={!!hasNextPage}
                        isFetchingNextPage={isFetchingNextPage}
                        onLoadMore={() => void fetchNextPage()}
                      />
                    </>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => void retryMachines()}
                  >
                    {t("create.retry")}
                  </Button>
                  {locked ? (
                    <span>{t("create.runner.settings")}</span>
                  ) : (
                    <Link
                      to="/$lang/settings/cli"
                      params={{ lang: i18n.language }}
                      className="inline-flex min-h-11 items-center underline"
                    >
                      {t("create.runner.settings")}
                    </Link>
                  )}
                  {limitsError && <p role="alert">{t("create.runner.limitsFailed")}</p>}
                  {selectedMachine &&
                    (limitsPending && !machineLimits ? (
                      <Skeleton className="h-20 w-full" />
                    ) : machineLimits?.available &&
                      machineLimits.operatingLimits &&
                      machineLimits.hardLimits ? (
                      <div className="space-y-2" aria-live="polite">
                        <p>
                          {t("create.runner.operating", {
                            match: openRouterMoney(
                              i18n.language,
                              machineLimits.operatingLimits.matchMicros,
                            ),
                            day: openRouterMoney(
                              i18n.language,
                              machineLimits.operatingLimits.dayMicros,
                            ),
                            concurrency: machineLimits.operatingLimits.concurrency,
                            revision: machineLimits.operatingLimits.revision,
                          })}
                        </p>
                        <p>
                          {t("create.runner.hard", {
                            match: openRouterMoney(
                              i18n.language,
                              machineLimits.hardLimits.matchMicros,
                            ),
                            day: openRouterMoney(i18n.language, machineLimits.hardLimits.dayMicros),
                            concurrency: machineLimits.hardLimits.concurrency,
                          })}
                        </p>
                        {confirmedLimits &&
                          confirmedLimits.maxCostMicros >= LIMITS.budgetUsd.min * 1_000_000 && (
                            <p>
                              {t("create.runner.combinedCap", {
                                max: currency.format(budgetMax),
                              })}
                            </p>
                          )}
                        {!runnerReady && <p role="alert">{t("create.runner.unavailable")}</p>}
                        {machineLimits.pending && (
                          <p>
                            {t("create.runner.pendingLimits", {
                              revision: machineLimits.pending.revision,
                            })}
                          </p>
                        )}
                        {machineLimits.lastResult && (
                          <p>
                            {t("create.runner.limitResult", {
                              revision: machineLimits.lastResult.revision,
                            })}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p>{t("create.runner.noLimits")}</p>
                    ))}
                  {selectedMachine && (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      onClick={() => void retryLimits()}
                    >
                      {t("create.runner.refreshLimits")}
                    </Button>
                  )}
                  <p role="note">{t("create.runner.catalogHint")}</p>
                </div>
              )}
              {catalogStale && (
                <p className="cc-model-warn cc-catalog-notice col-span-full" role="status">
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
              {!runner && (
                <div className="cc-create-billing col-span-full">
                  {billingOptions.length > 1 && (
                    <div className="cc-choice">
                      <span className="cc-field-label">{t("create.billingLabel")}</span>
                      <SegmentedControl
                        ariaLabel={t("create.billingLabel")}
                        value={billing}
                        onChange={chooseBilling}
                        items={billingOptions.map((option) => ({
                          value: option,
                          label: t(`create.billing.${option}`),
                        }))}
                      />
                    </div>
                  )}
                  <p className="cc-field-hint">
                    {billing === "openrouter"
                      ? ownKeyRemainingMicros === null
                        ? t("studio.billedToUnlimited")
                        : t("studio.billedTo", {
                            remaining: openRouterMoney(i18n.language, ownKeyRemainingMicros),
                          })
                      : t("create.billingHint.operator")}
                    {billing === "openrouter" && <> {t("create.billingHint.openrouter")}</>}
                  </p>
                  {billing === "openrouter" &&
                    ownKeyRemainingMicros !== null &&
                    limits.maxCostMicros < operatorLimits.maxCostMicros && (
                      <p className="cc-field-hint">
                        {t(
                          values.playAs === "none" ? "create.remainingCap" : "human.remainingCap",
                          {
                            remaining: openRouterMoney(i18n.language, ownKeyRemainingMicros),
                            max: currency.format(budgetMax),
                          },
                        )}
                      </p>
                    )}
                </div>
              )}
              <div className="cc-create-quick">
                <form.Field name="playAs">
                  {(field) => (
                    <div className="cc-choice">
                      <span className="cc-field-label">{t("human.mode")}</span>
                      <SegmentedControl
                        ariaLabel={t("human.mode")}
                        value={field.state.value}
                        onChange={(next) => {
                          field.handleChange(next);
                          if (next !== "none") {
                            form.setFieldValue("official", false);
                            form.setFieldValue("context", "fresh");
                          }
                        }}
                        items={
                          [
                            { value: "none", label: t("human.watchModels") },
                            { value: "white", label: t("human.playWhite") },
                            { value: "black", label: t("human.playBlack") },
                          ] as const
                        }
                      />
                      {field.state.value !== "none" && (
                        <p className="cc-field-hint">{t("human.createHint")}</p>
                      )}
                    </div>
                  )}
                </form.Field>
                {runner || values.playAs !== "none" ? (
                  <p className="cc-pill">
                    {t(runner ? "create.runner.practice" : "human.practice")}
                  </p>
                ) : (
                  <form.Field name="official">
                    {(field) => (
                      <div className="cc-choice">
                        <span className="cc-field-label">{t("create.participationLabel")}</span>
                        <SegmentedControl
                          ariaLabel={t("create.participationLabel")}
                          value={field.state.value ? "official" : "practice"}
                          onChange={(next) => field.handleChange(next === "official")}
                          items={[
                            { value: "practice", label: t("create.practice") },
                            { value: "official", label: t("create.official") },
                          ]}
                        />
                        <p className="cc-field-hint">{t("create.participationHint")}</p>
                        <p className="cc-field-hint" role="note">
                          {t(
                            field.state.value
                              ? "create.officialCommitment"
                              : "create.practiceCommitment",
                          )}
                        </p>
                      </div>
                    )}
                  </form.Field>
                )}
                <div className="cc-create-players">
                  {(["white", "black"] as const).map((name) => (
                    <form.Field key={name} name={name}>
                      {(field) =>
                        values.playAs === name ? (
                          <div className="cc-choice">
                            <span className="cc-field-label">
                              {t(`colors.${name === "white" ? "w" : "b"}`)}
                            </span>
                            <strong>{t("human.you")}</strong>
                          </div>
                        ) : (
                          <ModelPicker
                            side={name === "white" ? "w" : "b"}
                            value={field.state.value}
                            onChange={(id) => {
                              if (locked || (runner && runnerSubmission.current)) return;
                              field.handleChange(id);
                            }}
                            catalog={catalog}
                            catalogState={catalogState}
                            onRetry={() => void retryCatalog()}
                            errors={field.state.meta.errors}
                            needsTools={needsTools}
                            typedHint={runner ? t("create.runner.unknownModel") : undefined}
                          />
                        )
                      }
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
                      values.playAs === "white"
                        ? t("human.you")
                        : protocolLabel("white")(values.whiteProtocol),
                      values.playAs === "black"
                        ? t("human.you")
                        : protocolLabel("black")(values.blackProtocol),
                      t(`identity.${values.identity}`),
                    ].join(" · ")}
                  >
                    {(["white", "black"] as const)
                      .filter((side) => side !== values.playAs)
                      .map((side) => (
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
                      values.illegalPolicy === "retry"
                        ? t("create.summary.retry")
                        : t("create.summary.forfeitAfter", { count: values.maxAttempts }),
                      typeof replyCap === "number"
                        ? t("create.summary.replyCap", { count: replyCap })
                        : t("create.summary.noReplyCap"),
                    ].join(" · ")}
                  >
                    <form.Field name="context">
                      {(field) => (
                        <ChoiceField
                          field={field}
                          label={t("studio.contextLabel")}
                          options={values.playAs === "none" ? CONTEXT_MODES : ["fresh"]}
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
                    <form.Field name="illegalPolicy">
                      {(field) => (
                        <ChoiceField
                          field={field}
                          label={t("settings.illegalPolicy")}
                          options={ILLEGAL_POLICIES}
                          optionLabel={(value) => t(`illegalPolicies.${value}`)}
                          explain={(value) => t(`create.explain.illegalPolicy.${value}`)}
                        />
                      )}
                    </form.Field>
                    {values.illegalPolicy === "forfeit" && (
                      <form.Field name="maxAttempts">
                        {(field) => (
                          <RangeField
                            field={field}
                            labels={rangeLabels}
                            label={t("settings.maxAttempts")}
                            description={t("create.explain.maxAttempts", LIMITS.attempts)}
                            min={LIMITS.attempts.min}
                            max={LIMITS.attempts.max}
                            step={1}
                            defaultValue={DEFAULT_VALUES.maxAttempts}
                          />
                        )}
                      </form.Field>
                    )}
                    <form.Field name="replyCap">
                      {(field) => (
                        <TextField
                          field={field}
                          type="number"
                          inputMode="numeric"
                          autoComplete="off"
                          min={LIMITS.replyCap.min}
                          max={LIMITS.replyCap.max}
                          step={1}
                          placeholder={t("create.replyCapOff")}
                          label={t("settings.replyCap")}
                          description={t("create.explain.replyCap", {
                            white: modelMax("white"),
                            black: modelMax("black"),
                            min: LIMITS.replyCap.min.toLocaleString(i18n.language),
                            max: LIMITS.replyCap.max.toLocaleString(i18n.language),
                          })}
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
                      t("create.summary.budget", { budget: currency.format(values.budget) }),
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
                        <RangeField
                          field={field}
                          labels={rangeLabels}
                          label={t("settings.tokenBudget")}
                          description={t("create.explain.tokenBudget", {
                            min: LIMITS.tokens.min.toLocaleString(i18n.language),
                            max: limits.maxTokens.toLocaleString(i18n.language),
                          })}
                          min={LIMITS.tokens.min}
                          max={limits.maxTokens}
                          step={1}
                          scale="log"
                          units={tokenUnits}
                          defaultValue={defaultValuesFor(limits).tokenBudget}
                        />
                      )}
                    </form.Field>
                    <form.Field name="budget">
                      {(field) => (
                        <RangeField
                          field={field}
                          labels={rangeLabels}
                          label={t("studio.budget")}
                          description={t("create.explain.budget", {
                            min: currency.format(LIMITS.budgetUsd.min),
                            max: currency.format(budgetMax),
                          })}
                          min={LIMITS.budgetUsd.min}
                          max={budgetMax}
                          step={0.01}
                          scale="log"
                          stops={budgetStops(LIMITS.budgetUsd.min, budgetMax)}
                          units={usdUnits}
                          defaultValue={defaultValuesFor(limits).budget}
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
            </fieldset>
          </SheetBody>
          <SheetFooter className="cc-create-footer">
            <p className="cc-field-hint w-full" role="note">
              {t(
                runner
                  ? "create.runner.submitHint"
                  : values.official
                    ? "create.officialSubmitHint"
                    : "create.practiceSubmitHint",
              )}
            </p>
            {runner && offerLocked && !mutation.isPending && (
              <p role="status">{t("create.runner.retryIntent")}</p>
            )}
            {(invalid || mutation.isError) && (
              <p role="alert" className="cc-error cc-create-error">
                {/* Offline the start fails at once (the offline mutation policy, router.tsx)
                    and says so here, beside the action bar. */}
                {!invalid && networkFailureKind(mutation.error)
                  ? friendly(mutation.error)
                  : t(
                      invalid
                        ? "create.errors.invalid"
                        : refusal
                          ? `create.errors.${refusal}`
                          : errorCode(mutation.error) === "SERVICE_UNAVAILABLE"
                            ? "create.errors.unavailable"
                            : errorCode(mutation.error) === "TOO_MANY_REQUESTS"
                              ? "create.errors.rateLimited"
                              : runner
                                ? "create.runner.failed"
                                : "studio.error",
                    )}
              </p>
            )}
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={locked}
              onClick={() => {
                if (locked || (runner && runnerSubmission.current)) return;
                setOpen(false);
                reset();
              }}
            >
              {t("create.cancel")}
            </Button>
            <Button
              className="cc-button min-h-11"
              type="submit"
              disabled={
                disabled ||
                mutation.isPending ||
                (runner && !runnerSubmission.current && !runnerReady)
              }
            >
              {t(
                runner
                  ? mutation.isPending
                    ? "create.runner.sending"
                    : offerLocked
                      ? "create.runner.retry"
                      : "create.runner.send"
                  : mutation.isPending
                    ? "create.starting"
                    : "create.start",
              )}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
