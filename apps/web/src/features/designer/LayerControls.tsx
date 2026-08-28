import type { Layer } from "@steam-top/domain";
import { useEffect, useState } from "react";

import type { DesignerAction } from "./useDesigner";

type LayerControlsProps = Readonly<{
  layer: Layer;
  dispatch: React.Dispatch<DesignerAction>;
}>;

function parseBoundedNumber(
  rawValue: string,
  minimum: number,
  maximum: number,
): number | null {
  if (rawValue.trim() === "") {
    return null;
  }
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

type DraftNumberInputProps = Readonly<{
  value: number;
  minimum: number;
  maximum: number;
  step: number;
  disabled?: boolean;
  integer?: boolean;
  onValidValue: (value: number) => void;
}>;

function DraftNumberInput({
  value,
  minimum,
  maximum,
  step,
  disabled = false,
  integer = false,
  onValidValue,
}: DraftNumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <input
      type="number"
      min={minimum}
      max={maximum}
      step={step}
      value={draft}
      disabled={disabled}
      onChange={(event) => {
        const rawValue = event.currentTarget.value;
        setDraft(rawValue);
        const parsed = parseBoundedNumber(rawValue, minimum, maximum);
        if (parsed !== null && (!integer || Number.isInteger(parsed))) {
          onValidValue(parsed);
        }
      }}
    />
  );
}

function DraftColorInput({
  value,
  onValidValue,
}: Readonly<{ value: string; onValidValue: (value: string) => void }>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <input
      type="text"
      inputMode="text"
      pattern="#[0-9a-fA-F]{6}"
      value={draft}
      onChange={(event) => {
        const nextValue = event.currentTarget.value;
        setDraft(nextValue);
        if (/^#[0-9a-f]{6}$/i.test(nextValue)) {
          onValidValue(nextValue);
        }
      }}
    />
  );
}

export function LayerControls({ layer, dispatch }: LayerControlsProps) {
  const updateNumber = (
    field: "points" | "diameterMm" | "cornerRoundness" | "rotationDeg",
  ) => (value: number) =>
    dispatch({ type: "update-layer", position: layer.position, field, value });
  const circle = layer.shape === "circle";

  return (
    <fieldset className="control-group">
      <legend>層板設定</legend>
      <label>
        形狀
        <select
          value={layer.shape}
          onChange={(event) =>
            dispatch({
              type: "update-layer",
              position: layer.position,
              field: "shape",
              value: event.currentTarget.value as Layer["shape"],
            })
          }
        >
          <option value="circle">圓形</option>
          <option value="polygon">多邊形</option>
          <option value="star">星形</option>
          <option value="wave">波浪形</option>
        </select>
      </label>

      <div className="control-grid">
        <label>
          角數
          <DraftNumberInput
            minimum={3}
            maximum={16}
            step={1}
            integer
            value={layer.points}
            disabled={circle}
            onValidValue={updateNumber("points")}
          />
        </label>
        <label>
          直徑（mm）
          <DraftNumberInput
            minimum={20}
            maximum={80}
            step={1}
            value={layer.diameterMm}
            onValidValue={updateNumber("diameterMm")}
          />
        </label>
        <label>
          圓角程度
          <DraftNumberInput
            minimum={0}
            maximum={1}
            step={0.05}
            value={layer.cornerRoundness}
            disabled={circle}
            onValidValue={updateNumber("cornerRoundness")}
          />
        </label>
        <label>
          旋轉角度（度）
          <DraftNumberInput
            minimum={0}
            maximum={359}
            step={1}
            value={layer.rotationDeg}
            onValidValue={updateNumber("rotationDeg")}
          />
        </label>
        <label>
          顏色
          <DraftColorInput
            value={layer.color}
            onValidValue={(value) =>
              dispatch({
                type: "update-layer",
                position: layer.position,
                field: "color",
                value,
              })
            }
          />
        </label>
      </div>
      {circle ? <p className="field-note">圓形不使用角數及圓角程度。</p> : null}
    </fieldset>
  );
}
