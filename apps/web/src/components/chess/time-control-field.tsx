import { CLOCK_MAX_MS, CLOCK_MIN_MS } from "@cockpit-chess/chess";
import { Switch } from "@cockpit-chess/ui/components/switch";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { durationLabel } from "./ending-label";
import {
  applyCustom,
  applyPreset,
  type SideTime,
  selectedPreset,
  TIME_PRESETS_MINUTES,
  type TimeControlValue,
  timeControlErrors,
} from "./time-control";

function SideTimeInputs({
  label,
  value,
  error,
  onChange,
}: {
  label: string;
  value: SideTime;
  error: string | undefined;
  onChange: (next: SideTime) => void;
}) {
  const id = useId();
  const { t } = useTranslation("chess");
  return (
    <fieldset className="cc-time-side" aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="cc-field-label">{label}</legend>
      <div className="cc-time-inputs">
        <label htmlFor={`${id}-m`}>
          <input
            id={`${id}-m`}
            type="number"
            inputMode="numeric"
            autoComplete="off"
            min={0}
            max={60}
            step={1}
            value={value.minutes}
            aria-invalid={error ? true : undefined}
            onChange={(event) => onChange({ ...value, minutes: event.target.value })}
          />
          <span>{t("time.minutes")}</span>
        </label>
        <label htmlFor={`${id}-s`}>
          <input
            id={`${id}-s`}
            type="number"
            inputMode="numeric"
            autoComplete="off"
            min={0}
            max={59}
            step={1}
            value={value.seconds}
            aria-invalid={error ? true : undefined}
            onChange={(event) => onChange({ ...value, seconds: event.target.value })}
          />
          <span>{t("time.seconds")}</span>
        </label>
      </div>
      {error && (
        <p id={`${id}-error`} className="cc-error text-xs" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * Time control for both create flows: Untimed or a clock per side, with 5/10/30-minute
 * shortcuts, typed minutes and seconds, and an "Uneven time" switch for a handicap.
 */
export function TimeControlField({
  value,
  onChange,
}: {
  value: TimeControlValue;
  onChange: (next: TimeControlValue) => void;
}) {
  const { t } = useTranslation("chess");
  const id = useId();
  const preset = selectedPreset(value);
  const errors = timeControlErrors(t, value);
  const choices: Array<{ key: string; label: string; pick: () => void; pressed: boolean }> = [
    {
      key: "untimed",
      label: t("timeControl.untimed"),
      pick: () => onChange(applyPreset(value, "untimed")),
      pressed: preset === "untimed",
    },
    ...TIME_PRESETS_MINUTES.map((minutes) => ({
      key: String(minutes),
      label: t("duration.minutes", { minutes }),
      pick: () => onChange(applyPreset(value, minutes)),
      pressed: preset === minutes,
    })),
    {
      key: "custom",
      label: t("time.custom"),
      pick: () => onChange(applyCustom(value)),
      pressed: preset === "custom",
    },
  ];
  return (
    <fieldset className="cc-time-control" aria-describedby={`${id}-hint`}>
      <legend className="cc-field-label">{t("time.label")}</legend>
      <div className="cc-time-presets">
        {choices.map((choice) => (
          <button
            key={choice.key}
            type="button"
            className="cc-time-preset"
            aria-pressed={choice.pressed}
            onClick={choice.pick}
          >
            {choice.label}
          </button>
        ))}
      </div>
      <p id={`${id}-hint`} className="cc-field-hint">
        {value.timed
          ? t("time.limits", {
              min: durationLabel(t, CLOCK_MIN_MS),
              max: durationLabel(t, CLOCK_MAX_MS),
            })
          : t("time.untimedHint")}
      </p>
      {value.timed && (
        <>
          <div className="cc-time-sides">
            <SideTimeInputs
              label={value.uneven ? t("colors.w") : t("time.eachSide")}
              value={value.white}
              error={errors.white}
              onChange={(white) => onChange({ ...value, white })}
            />
            {value.uneven && (
              <SideTimeInputs
                label={t("colors.b")}
                value={value.black}
                error={errors.black}
                onChange={(black) => onChange({ ...value, black })}
              />
            )}
          </div>
          <div className="cc-time-uneven">
            <Switch
              id={`${id}-uneven`}
              checked={value.uneven}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  uneven: checked,
                  black: checked ? value.white : value.black,
                })
              }
            />
            <label htmlFor={`${id}-uneven`}>{t("time.uneven")}</label>
          </div>
          {value.uneven && <p className="cc-field-hint">{t("time.unevenHint")}</p>}
        </>
      )}
    </fieldset>
  );
}
