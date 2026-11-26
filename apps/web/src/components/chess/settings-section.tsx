import { ChevronDown } from "lucide-react";
import { type ReactNode, useId } from "react";

/** The slice of a TanStack Form field these controls read and write. */
export type FieldShape<TValue> = {
  name: string;
  state: { value: TValue; meta: { errors: readonly unknown[] } };
  handleBlur: () => void;
  handleChange: (value: TValue) => void;
};

/** A labelled native select whose hint explains the selected option. */
export function ChoiceField<TValue extends string>({
  field,
  label,
  options,
  optionLabel,
  explain,
}: {
  field: FieldShape<TValue>;
  label: string;
  options: readonly TValue[];
  optionLabel: (value: TValue) => string;
  explain: (value: TValue) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="cc-choice">
      <label htmlFor={id} className="cc-field-label">
        {label}
      </label>
      <select
        id={id}
        name={field.name}
        value={field.state.value}
        aria-describedby={`${id}-hint`}
        onBlur={field.handleBlur}
        onChange={(event) => {
          const next = options.find((option) => option === event.target.value);
          if (next !== undefined) field.handleChange(next);
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="cc-field-hint">
        {explain(field.state.value)}
      </p>
    </div>
  );
}

export function SettingsSection<TId extends string>({
  id,
  open,
  onToggle,
  title,
  hint,
  status,
  children,
}: {
  id: TId;
  open: boolean;
  onToggle: (id: TId, open: boolean) => void;
  title: string;
  hint: string;
  status: string;
  children: ReactNode;
}) {
  return (
    <details
      className="cc-settings-section"
      open={open}
      data-section={id}
      onToggle={(event) => onToggle(id, event.currentTarget.open)}
    >
      <summary>
        <span className="cc-section-text">
          <strong>{title}</strong>
          <span>{open ? hint : status}</span>
        </span>
        <ChevronDown aria-hidden="true" size={16} className="cc-section-chevron" />
      </summary>
      <div className="cc-section-body">{children}</div>
    </details>
  );
}
