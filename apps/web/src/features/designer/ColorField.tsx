import { useEffect, useId, useState } from "react";

import type { FieldValidityChange } from "./NumericField";

const COLOR_ERROR = "請輸入 #RRGGBB 格式的顏色，例如 #2563EB";

type ColorFieldProps = Readonly<{
  value: string;
  scopeKey: string;
  onValidValue: (value: string) => void;
  onValidityChange: FieldValidityChange;
}>;

export function ColorField({
  value,
  scopeKey,
  onValidValue,
  onValidityChange,
}: ColorFieldProps) {
  const fieldKey = `${scopeKey}:color`;
  const errorId = `${useId()}-error`;
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(value);
    setInvalid(false);
    onValidityChange(fieldKey, true);
    return () => onValidityChange(fieldKey, true);
  }, [fieldKey, onValidityChange, value]);

  return (
    <>
      <input
        type="text"
        inputMode="text"
        pattern="#[0-9a-fA-F]{6}"
        aria-label="顏色"
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        value={draft}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          const isValid = /^#[0-9a-f]{6}$/i.test(nextValue);
          setDraft(nextValue);
          setInvalid(!isValid);
          onValidityChange(fieldKey, isValid);
          if (isValid) onValidValue(nextValue);
        }}
      />
      {invalid ? (
        <span id={errorId} className="field-error">
          {COLOR_ERROR}
        </span>
      ) : null}
    </>
  );
}
