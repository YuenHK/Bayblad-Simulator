import { useEffect, useId, useState } from "react";

export type FieldValidityChange = (
  fieldKey: string,
  isValid: boolean,
) => void;

type NumericFieldProps = Readonly<{
  value: number;
  accessibleLabel: string;
  scopeKey: string;
  fieldName: string;
  minimum: number;
  maximum: number;
  step: number;
  errorMessage: string;
  disabled?: boolean;
  integer?: boolean;
  onValidValue: (value: number) => void;
  onValidityChange: FieldValidityChange;
}>;

function matchesStep(value: number, minimum: number, step: number): boolean {
  const stepCount = (value - minimum) / step;
  return Math.abs(stepCount - Math.round(stepCount)) < 1e-9;
}

export function NumericField({
  value,
  accessibleLabel,
  scopeKey,
  fieldName,
  minimum,
  maximum,
  step,
  errorMessage,
  disabled = false,
  integer = false,
  onValidValue,
  onValidityChange,
}: NumericFieldProps) {
  const fieldKey = `${scopeKey}:${fieldName}`;
  const errorId = `${useId()}-error`;
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
    onValidityChange(fieldKey, true);
    return () => onValidityChange(fieldKey, true);
  }, [disabled, fieldKey, onValidityChange, value]);

  return (
    <>
      <input
        type="number"
        min={minimum}
        max={maximum}
        step={step}
        value={draft}
        disabled={disabled}
        aria-label={accessibleLabel}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(event) => {
          const rawValue = event.currentTarget.value;
          setDraft(rawValue);
          const parsed = Number(rawValue);
          const isValid =
            rawValue.trim() !== "" &&
            Number.isFinite(parsed) &&
            parsed >= minimum &&
            parsed <= maximum &&
            (!integer || Number.isInteger(parsed)) &&
            matchesStep(parsed, minimum, step);
          setInvalid(!isValid);
          onValidityChange(fieldKey, isValid);
          if (isValid) onValidValue(parsed);
        }}
      />
      {invalid ? (
        <span id={errorId} className="field-error">
          {errorMessage}
        </span>
      ) : null}
    </>
  );
}
