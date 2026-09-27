import type { Layer, TopDesign } from "@steam-top/domain";
import { layerSchema } from "@steam-top/domain";
import { useState } from "react";

import { ColorField } from "./ColorField";
import { NumericField, type FieldValidityChange } from "./NumericField";
import type { DesignerAction } from "./useDesigner";
import { CustomOutlineEditor } from "./CustomOutlineEditor";
import { createOutlineDraft, type OutlineDraft } from "./customOutlineDraft";

type LayerControlsProps = Readonly<{
  layer: Layer;
  dispatch: React.Dispatch<DesignerAction>;
  onFieldValidityChange: FieldValidityChange;
  screwLayout?: TopDesign["screwLayout"];
}>;

export function LayerControls({
  layer: appliedLayer,
  dispatch: applyDispatch,
  onFieldValidityChange,
  screwLayout,
}: LayerControlsProps) {
  const [modes, setModes] = useState<Record<string, "basic" | "custom">>({});
  const [drafts, setDrafts] = useState<Record<string, OutlineDraft>>({});
  const [basics, setBasics] = useState<Record<string, Layer>>({});
  const [scaleFailure, setScaleFailure] = useState({ id: "", attempt: 0 });
  const mode =
    modes[appliedLayer.id] ??
    (appliedLayer.shape === "custom" ? "custom" : "basic");
  const { outline: _outline, ...basicFields } = appliedLayer;
  const layer =
    mode === "basic" && appliedLayer.shape === "custom"
      ? (basics[appliedLayer.id] ?? {
          ...basicFields,
          shape: "circle" as const,
        })
      : appliedLayer;
  const draft =
    drafts[appliedLayer.id] ?? createOutlineDraft(appliedLayer.outline);
  const dispatch = (action: DesignerAction) => {
    if (
      mode === "basic" &&
      appliedLayer.shape === "custom" &&
      action.type === "update-layer"
    ) {
      setBasics((previous) => ({
        ...previous,
        [appliedLayer.id]: { ...layer, [action.field]: action.value },
      }));
    } else applyDispatch(action);
  };
  const updateNumber =
    (field: "points" | "diameterMm" | "cornerRoundness" | "rotationDeg") =>
    (value: number) => {
      if (field === "diameterMm" && layer.shape === "custom" && layer.outline) {
        const scale = value / layer.diameterMm;
        const candidate = {
          ...layer,
          diameterMm: value,
          outline: {
            ...layer.outline,
            vertices: layer.outline.vertices.map((p) => ({
              x: p.x * scale,
              y: p.y * scale,
            })),
          },
        };
        if (!layerSchema.safeParse(candidate).success) {
          setScaleFailure((previous) => ({
            id: layer.id,
            attempt: previous.attempt + 1,
          }));
          return;
        }
      }
      setScaleFailure((previous) => ({ ...previous, id: "" }));
      dispatch({
        type: "update-layer",
        position: layer.position,
        field,
        value,
      });
    };
  const circle = layer.shape === "circle";

  return (
    <fieldset className="control-group">
      <legend>層板設定</legend>
      <div className="custom-outline-mode" role="group" aria-label="造型類型">
        <button
          type="button"
          aria-pressed={mode === "basic"}
          onClick={() => {
            setDrafts((previous) => ({
              ...previous,
              [appliedLayer.id]: previous[appliedLayer.id] ?? draft,
            }));
            setModes((previous) => ({
              ...previous,
              [appliedLayer.id]: "basic",
            }));
          }}
        >
          基礎造型
        </button>
        <button
          type="button"
          aria-pressed={mode === "custom"}
          onClick={() => {
            if (appliedLayer.shape !== "custom")
              setBasics((previous) => ({
                ...previous,
                [appliedLayer.id]: appliedLayer,
              }));
            setModes((previous) => ({
              ...previous,
              [appliedLayer.id]: "custom",
            }));
          }}
        >
          自定造型
        </button>
      </div>
      {mode === "custom" ? (
        <CustomOutlineEditor
          key={appliedLayer.id}
          draft={draft}
          screwLayout={screwLayout}
          rotationDeg={appliedLayer.rotationDeg}
          onChange={(next) =>
            setDrafts((previous) => ({ ...previous, [appliedLayer.id]: next }))
          }
          onApply={(outline, diameterMm) =>
            applyDispatch({
              type: "replace-layer",
              layer: { ...appliedLayer, shape: "custom", outline, diameterMm },
            })
          }
        />
      ) : null}
      {mode === "basic" && appliedLayer.shape === "custom" ? (
        <p>基礎造型草稿；按「套用基礎造型」後才會取代已套用輪廓。</p>
      ) : null}
      <div className="control-grid">
        {mode === "basic" ? (
          <>
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
          </>
        ) : null}
        <label>
          直徑（mm）
          <NumericField
            accessibleLabel="直徑（mm）"
            key={`${layer.id}:${mode}:${scaleFailure.attempt}`}
            scopeKey={`${layer.id}:${mode}`}
            fieldName="diameterMm"
            minimum={20}
            maximum={80}
            step={0.01}
            errorMessage="請輸入 20 至 80、每格 0.01 的有效數值"
            value={layer.diameterMm}
            onValidValue={updateNumber("diameterMm")}
            onValidityChange={onFieldValidityChange}
          />
        </label>
        {mode === "basic" ? (
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
        ) : null}
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
      {scaleFailure.id === layer.id ? (
        <p role="alert">縮放未套用：輪廓必須保留軸孔淨距並符合尺寸限制。</p>
      ) : null}
      {mode === "basic" && appliedLayer.shape === "custom" ? (
        <button
          type="button"
          onClick={() =>
            applyDispatch({
              type: "replace-layer",
              layer: {
                ...layer,
                id: appliedLayer.id,
                position: appliedLayer.position,
              },
            })
          }
        >
          套用基礎造型
        </button>
      ) : null}
      {mode === "custom" ? (
        <p className="field-note">
          直徑、旋轉及顏色控制目前已套用的層板；畫布草稿須另按套用。
        </p>
      ) : null}
      {circle ? <p className="field-note">圓形不使用角數及圓角程度。</p> : null}
    </fieldset>
  );
}
