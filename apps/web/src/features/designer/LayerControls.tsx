import type { Layer } from "@steam-top/domain";

import { ColorField } from "./ColorField";
import { NumericField, type FieldValidityChange } from "./NumericField";
import type { DesignerAction } from "./useDesigner";

type LayerControlsProps = Readonly<{
  layer: Layer;
  dispatch: React.Dispatch<DesignerAction>;
  onFieldValidityChange: FieldValidityChange;
}>;

export function LayerControls({
  layer,
  dispatch,
  onFieldValidityChange,
}: LayerControlsProps) {
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
          <NumericField
            accessibleLabel="角數"
            scopeKey={layer.id}
            fieldName="points"
            minimum={3}
            maximum={16}
            step={1}
            integer
            errorMessage="請輸入 3 至 16 的有效整數"
            value={layer.points}
            disabled={circle}
            onValidValue={updateNumber("points")}
            onValidityChange={onFieldValidityChange}
          />
        </label>
        <label>
          直徑（mm）
          <NumericField
            accessibleLabel="直徑（mm）"
            scopeKey={layer.id}
            fieldName="diameterMm"
            minimum={20}
            maximum={80}
            step={1}
            errorMessage="請輸入 20 至 80 的有效數值"
            value={layer.diameterMm}
            onValidValue={updateNumber("diameterMm")}
            onValidityChange={onFieldValidityChange}
          />
        </label>
        <label>
          圓角程度
          <NumericField
            accessibleLabel="圓角程度"
            scopeKey={layer.id}
            fieldName="cornerRoundness"
            minimum={0}
            maximum={1}
            step={0.05}
            errorMessage="請輸入 0 至 1、每格 0.05 的有效數值"
            value={layer.cornerRoundness}
            disabled={circle}
            onValidValue={updateNumber("cornerRoundness")}
            onValidityChange={onFieldValidityChange}
          />
        </label>
        <label>
          旋轉角度（度）
          <NumericField
            accessibleLabel="旋轉角度（度）"
            scopeKey={layer.id}
            fieldName="rotationDeg"
            minimum={0}
            maximum={359}
            step={1}
            integer
            errorMessage="請輸入 0 至 359 的有效整數"
            value={layer.rotationDeg}
            onValidValue={updateNumber("rotationDeg")}
            onValidityChange={onFieldValidityChange}
          />
        </label>
        <label>
          顏色
          <ColorField
            scopeKey={layer.id}
            value={layer.color}
            onValidValue={(value) =>
              dispatch({
                type: "update-layer",
                position: layer.position,
                field: "color",
                value,
              })
            }
            onValidityChange={onFieldValidityChange}
          />
        </label>
      </div>
      {circle ? <p className="field-note">圓形不使用角數及圓角程度。</p> : null}
    </fieldset>
  );
}
