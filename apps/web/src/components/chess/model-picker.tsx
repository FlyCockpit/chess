import { AsyncCombobox } from "@cockpit-chess/ui/components/async-combobox";
import { fieldErrorMessages } from "@cockpit-chess/ui/components/text-field";
import { useCallback, useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type CatalogModel, findModel, LIMITS, searchModels } from "./create-match-form";

type PickerItem = { kind: "model"; model: CatalogModel } | { kind: "typed"; id: string };
export type CatalogState = "pending" | "error" | "ready";

function usePriceFormat() {
  const { t, i18n } = useTranslation("chess");
  return useMemo(() => {
    const money = new Intl.NumberFormat(i18n.language, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 3,
    });
    const compact = new Intl.NumberFormat(i18n.language, {
      notation: "compact",
      maximumFractionDigits: 1,
    });
    const price = (value: number) => (value === 0 ? t("create.free") : money.format(value));
    return {
      prices: (model: CatalogModel) =>
        t("create.price", {
          prompt: price(model.promptPerMillion),
          completion: price(model.completionPerMillion),
        }),
      context: (model: CatalogModel) =>
        model.contextLength === null
          ? null
          : t("create.context", { tokens: compact.format(model.contextLength) }),
    };
  }, [t, i18n.language]);
}

/** One line of facts per model: provider, context, prompt/completion price, tool support. */
function ModelFacts({ model }: { model: CatalogModel }) {
  const { t } = useTranslation("chess");
  const format = usePriceFormat();
  const context = format.context(model);
  return (
    <span className="cc-model-facts">
      <span>{model.provider}</span>
      {context && <span>{context}</span>}
      <span>{format.prices(model)}</span>
      {!model.tools && <span className="cc-model-warn">{t("create.noTools")}</span>}
    </span>
  );
}

/**
 * Searchable model picker over the server's OpenRouter catalog (`chess.models`).
 * A typed id is always offered as an escape, and is the only path while the
 * catalog is unavailable.
 */
export function ModelPicker({
  side,
  value,
  onChange,
  catalog,
  catalogState,
  onRetry,
  errors,
  needsTools,
  typedHint,
}: {
  side: "w" | "b";
  value: string;
  onChange: (id: string) => void;
  catalog: readonly CatalogModel[] | undefined;
  catalogState: CatalogState;
  onRetry: () => void;
  errors: readonly unknown[];
  needsTools: boolean;
  typedHint?: string;
}) {
  const { t } = useTranslation("chess");
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const selected = findModel(catalog, value);
  const messages = fieldErrorMessages(errors);
  const current: PickerItem | null = selected
    ? { kind: "model", model: selected }
    : value.trim()
      ? { kind: "typed", id: value.trim() }
      : null;
  const search = useCallback(
    async (query: string): Promise<PickerItem[]> => {
      const items: PickerItem[] = searchModels(catalog ?? [], query).map((model) => ({
        kind: "model",
        model,
      }));
      const typed = query.trim();
      if (
        typed &&
        typed.length <= LIMITS.model &&
        !/\s/.test(typed) &&
        !catalog?.some((model) => model.id === typed)
      )
        items.push({ kind: "typed", id: typed });
      return items;
    },
    [catalog],
  );
  const sideLabel = t(`colors.${side}`);
  return (
    <div className="cc-model-picker">
      <span className="cc-field-label" id={labelId}>
        <span aria-hidden="true" className={`cc-swatch cc-swatch-${side}`} />
        {t("create.modelLabel", { side: sideLabel })}
      </span>
      <AsyncCombobox<PickerItem>
        id={`${id}-trigger`}
        aria-labelledby={`${labelId} ${id}-trigger`}
        aria-describedby={messages.length ? `${hintId} ${errorId}` : hintId}
        aria-invalid={messages.length > 0}
        className="cc-model-trigger"
        value={current}
        onSearch={search}
        onSelect={(item) => onChange(item.kind === "model" ? item.model.id : item.id)}
        placeholder={t("create.modelPlaceholder")}
        searchPlaceholder={t("create.search")}
        emptyText={catalogState === "error" ? t("create.catalogError") : t("create.empty")}
        getKey={(item) => (item.kind === "model" ? item.model.id : `typed:${item.id}`)}
        getLabel={(item) =>
          item.kind === "model" ? item.model.name : t("create.typedLabel", { id: item.id })
        }
        renderItem={(item) =>
          item.kind === "model" ? (
            <span className="cc-model-row">
              <span className="cc-model-name">{item.model.name}</span>
              <span className="cc-model-id">{item.model.id}</span>
              <ModelFacts model={item.model} />
            </span>
          ) : (
            <span className="cc-model-row">
              <span className="cc-model-name">{t("create.useTyped", { id: item.id })}</span>
            </span>
          )
        }
      />
      <div id={hintId} className="cc-field-hint">
        {selected ? (
          <>
            <span className="cc-model-id">{selected.id}</span>
            <ModelFacts model={selected} />
            {needsTools && !selected.tools && (
              <span className="cc-model-warn">{t("create.noToolsWarning")}</span>
            )}
          </>
        ) : catalogState === "pending" ? (
          t("create.catalogPending")
        ) : catalogState === "error" ? (
          <span className="cc-model-warn">
            {t("create.catalogError")}{" "}
            <button type="button" className="cc-link-button" onClick={onRetry}>
              {t("create.retry")}
            </button>
          </span>
        ) : value.trim() ? (
          (typedHint ?? t("create.unknownModel"))
        ) : null}
      </div>
      {messages.length > 0 && (
        <p id={errorId} role="alert" className="cc-field-error">
          {messages[0]}
        </p>
      )}
    </div>
  );
}
