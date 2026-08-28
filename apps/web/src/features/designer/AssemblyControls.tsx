import type { TopDesign } from "@steam-top/domain";
import { useEffect, useState } from "react";

import type { DesignerAction } from "./useDesigner";

type AssemblyControlsProps = Readonly<{
  design: TopDesign;
  dispatch: React.Dispatch<DesignerAction>;
}>;

function boundedValue(
  rawValue: string,
  minimum: number,
  maximum: number,
): number | null {
  if (rawValue.trim() === "") return null;
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function AssemblyNumberInput({
  value,
  minimum,
  maximum,
  step,
  integer = false,
  onValidValue,
}: Readonly<{
  value: number;
  minimum: number;
  maximum: number;
  step: number;
  integer?: boolean;
  onValidValue: (value: number) => void;
}>) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <input
      type="number"
      min={minimum}
      max={maximum}
      step={step}
      value={draft}
      onChange={(event) => {
        const rawValue = event.currentTarget.value;
        setDraft(rawValue);
        const parsed = boundedValue(rawValue, minimum, maximum);
        if (parsed !== null && (!integer || Number.isInteger(parsed))) {
          onValidValue(parsed);
        }
      }}
    />
  );
}

export function AssemblyControls({ design, dispatch }: AssemblyControlsProps) {
  const updateScrew = (field: keyof TopDesign["screwLayout"]) =>
    (value: number) => dispatch({ type: "update-screw-layout", field, value });

  return (
    <fieldset className="control-group">
      <legend>共用裝配設定</legend>
      <p className="field-note">三層使用同一組螺絲孔。</p>
      <div className="control-grid">
        <label>
          螺絲數量
          <AssemblyNumberInput
            minimum={3}
            maximum={8}
            step={1}
            integer
            value={design.screwLayout.count}
            onValidValue={updateScrew("count")}
          />
        </label>
        <label>
          螺絲半徑（mm）
          <AssemblyNumberInput
            minimum={5}
            maximum={25}
            step={0.5}
            value={design.screwLayout.radiusMm}
            onValidValue={updateScrew("radiusMm")}
          />
        </label>
        <label>
          螺絲旋轉角度（度）
          <AssemblyNumberInput
            minimum={0}
            maximum={359}
            step={1}
            value={design.screwLayout.rotationDeg}
            onValidValue={updateScrew("rotationDeg")}
          />
        </label>
        <label>
          金屬碟直徑
          <select
            value={String(design.metalDiscDiameterMm)}
            onChange={(event) =>
              dispatch({
                type: "update-metal-disc",
                value: Number(event.currentTarget.value),
              })
            }
          >
            <option value="0">沒有</option>
            {[10, 20, 30, 40, 50, 55].map((diameter) => (
              <option key={diameter} value={diameter}>
                {diameter} mm
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="assembly-note">只置於最底層下方，由軸心夾住，不設螺絲孔</p>
    </fieldset>
  );
}
