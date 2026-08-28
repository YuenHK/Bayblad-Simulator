import type { TopDesign } from "@steam-top/domain";

import { NumericField, type FieldValidityChange } from "./NumericField";
import type { DesignerAction } from "./useDesigner";

type AssemblyControlsProps = Readonly<{
  design: TopDesign;
  dispatch: React.Dispatch<DesignerAction>;
  onFieldValidityChange: FieldValidityChange;
}>;

export function AssemblyControls({
  design,
  dispatch,
  onFieldValidityChange,
}: AssemblyControlsProps) {
  const updateScrew = (field: keyof TopDesign["screwLayout"]) =>
    (value: number) => dispatch({ type: "update-screw-layout", field, value });

  return (
    <fieldset className="control-group">
      <legend>共用裝配設定</legend>
      <p className="field-note">三層使用同一組螺絲孔。</p>
      <div className="control-grid">
        <label>
          螺絲數量
          <NumericField
            accessibleLabel="螺絲數量"
            scopeKey="assembly"
            fieldName="count"
            minimum={3}
            maximum={8}
            step={1}
            integer
            errorMessage="請輸入 3 至 8 的有效整數"
            value={design.screwLayout.count}
            onValidValue={updateScrew("count")}
            onValidityChange={onFieldValidityChange}
          />
        </label>
        <label>
          螺絲半徑（mm）
          <NumericField
            accessibleLabel="螺絲半徑（mm）"
            scopeKey="assembly"
            fieldName="radiusMm"
            minimum={5}
            maximum={25}
            step={0.5}
            errorMessage="請輸入 5 至 25、每格 0.5 的有效數值"
            value={design.screwLayout.radiusMm}
            onValidValue={updateScrew("radiusMm")}
            onValidityChange={onFieldValidityChange}
          />
        </label>
        <label>
          螺絲旋轉角度（度）
          <NumericField
            accessibleLabel="螺絲旋轉角度（度）"
            scopeKey="assembly"
            fieldName="rotationDeg"
            minimum={0}
            maximum={359}
            step={1}
            integer
            errorMessage="請輸入 0 至 359 的有效整數"
            value={design.screwLayout.rotationDeg}
            onValidValue={updateScrew("rotationDeg")}
            onValidityChange={onFieldValidityChange}
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
