import type { RuleIssueCode } from "@steam-top/domain";
import { useEffect, useRef, useState } from "react";

import { AssemblyControls } from "./AssemblyControls";
import { LayerControls } from "./LayerControls";
import { useDesigner } from "./useDesigner";

const POSITION_LABELS = {
  top: "頂層",
  middle: "中層",
  bottom: "底層",
} as const;

const SHAPE_LABELS = {
  circle: "圓形",
  polygon: "多邊形",
  star: "星形",
  wave: "波浪形",
} as const;

const ISSUE_LABELS: Record<RuleIssueCode, string> = {
  DIAMETER_OVER_60: "最大直徑為 60 mm",
  HEIGHT_OVER_40: "總高度不可超過 40 mm",
  WEIGHT_OVER_60: "總重量不可超過 60 g",
  SCREW_OUTSIDE_LAYER: "螺絲孔必須完整位於每一層內",
  SCREW_HITS_AXLE: "螺絲孔與軸心重疊",
  NECK_TOO_THIN: "孔與邊緣之間的材料太薄",
  METAL_DISC_OUTSIDE_BOTTOM: "金屬碟必須完整位於最底層下方",
};

type Position = keyof typeof POSITION_LABELS;

function format(value: number, digits = 1): string {
  return value.toFixed(digits);
}

export function DesignerPage() {
  const { design, validation, prediction, dispatch } = useDesigner();
  const [selectedLayerId, setSelectedLayerId] = useState(
    () => design.layers[0].id,
  );
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  const [dragOverLayerId, setDragOverLayerId] = useState<string | null>(null);
  const dragCapture = useRef<{
    element: HTMLButtonElement;
    pointerId: number;
  } | null>(null);
  const selectedLayer = design.layers.find(
    (layer) => layer.id === selectedLayerId,
  ) ?? design.layers[0];
  const selectedIndex = design.layers.findIndex(
    (layer) => layer.id === selectedLayer.id,
  );

  const moveSelected = (direction: "up" | "down") => {
    const targetIndex = direction === "up" ? selectedIndex - 1 : selectedIndex + 1;
    if (targetIndex < 0 || targetIndex >= design.layers.length) return;
    dispatch({ type: "move-layer", position: selectedLayer.position, direction });
  };

  const beginDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    layerId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    dragCapture.current = {
      element: event.currentTarget,
      pointerId: event.pointerId,
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Some test environments and older browsers expose but do not support capture.
      }
    }
    setDraggingLayerId(layerId);
    setDragOverLayerId(layerId);
  };

  const moveDraggedLayer = (targetId: string) => {
    if (
      draggingLayerId === null ||
      draggingLayerId === targetId ||
      dragOverLayerId === targetId
    ) {
      return;
    }
    dispatch({
      type: "reorder-layer",
      sourceId: draggingLayerId,
      targetId,
    });
    setDragOverLayerId(targetId);
  };

  const moveCapturedPointer = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (
      draggingLayerId === null ||
      typeof document.elementFromPoint !== "function"
    ) {
      return;
    }
    const hitElement = document.elementFromPoint(event.clientX, event.clientY);
    const targetLayer = hitElement?.closest<HTMLElement>("[data-layer-id]");
    const targetId = targetLayer?.dataset.layerId;
    if (targetId !== undefined) moveDraggedLayer(targetId);
  };

  const finishDrag = () => {
    const capture = dragCapture.current;
    if (
      capture !== null &&
      typeof capture.element.releasePointerCapture === "function"
    ) {
      try {
        capture.element.releasePointerCapture(capture.pointerId);
      } catch {
        // Pointer cancellation may release capture before the cleanup handler runs.
      }
    }
    dragCapture.current = null;
    setDraggingLayerId(null);
    setDragOverLayerId(null);
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    finishDrag();
  };

  useEffect(() => {
    if (draggingLayerId === null) return;
    const finishFromWindow = () => finishDrag();
    window.addEventListener("pointerup", finishFromWindow);
    window.addEventListener("pointercancel", finishFromWindow);
    return () => {
      window.removeEventListener("pointerup", finishFromWindow);
      window.removeEventListener("pointercancel", finishFromWindow);
    };
  }, [draggingLayerId]);

  return (
    <main className="designer-shell">
      <header className="page-heading">
        <p className="eyebrow">STEAM 陀螺</p>
        <h1>陀螺設計器</h1>
        <p>調整三層層板與共用裝配設定，數值會即時重新計算。</p>
      </header>

      <div className="designer-layout">
        <section className="panel controls-panel" aria-labelledby="layer-heading">
          <h2 id="layer-heading">層板設計</h2>
          <ol className="layer-list" aria-label="三層排列">
            {design.layers.map((layer) => (
              <li
                key={layer.id}
                data-layer-id={layer.id}
                className={[
                  draggingLayerId === layer.id ? "is-dragging" : "",
                  draggingLayerId !== null && dragOverLayerId === layer.id
                    ? "is-drag-target"
                    : "",
                ].filter(Boolean).join(" ")}
              >
                <div className="layer-summary">
                  <strong>{POSITION_LABELS[layer.position]}</strong>
                  <span>{SHAPE_LABELS[layer.shape]}</span>
                  <span>{layer.diameterMm} mm</span>
                </div>
                <button
                  type="button"
                  className="drag-handle"
                  data-source-layer-id={layer.id}
                  aria-label={`拖動${POSITION_LABELS[layer.position]}以重新排序`}
                  aria-pressed={draggingLayerId === layer.id}
                  onPointerDown={(event) => beginDrag(event, layer.id)}
                  onPointerMove={moveCapturedPointer}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onClick={(event) => event.preventDefault()}
                >
                  <span aria-hidden="true">↕</span>
                </button>
              </li>
            ))}
          </ol>

          <label>
            目前編輯層
            <select
              value={selectedLayer.position}
              onChange={(event) => {
                const position = event.currentTarget.value as Position;
                const layer = design.layers.find(
                  (candidate) => candidate.position === position,
                );
                if (layer !== undefined) setSelectedLayerId(layer.id);
              }}
            >
              {design.layers.map((layer) => (
                <option key={layer.id} value={layer.position}>
                  {POSITION_LABELS[layer.position]}
                </option>
              ))}
            </select>
          </label>

          <div className="move-actions" aria-label="調整層次順序">
            <button
              type="button"
              onClick={() => moveSelected("up")}
              disabled={selectedIndex === 0}
              aria-label="將目前層上移"
            >
              上移
            </button>
            <button
              type="button"
              onClick={() => moveSelected("down")}
              disabled={selectedIndex === design.layers.length - 1}
              aria-label="將目前層下移"
            >
              下移
            </button>
          </div>

          <LayerControls layer={selectedLayer} dispatch={dispatch} />
          <AssemblyControls design={design} dispatch={dispatch} />
        </section>

        <aside className="panel results-panel" aria-labelledby="results-heading">
          <h2 id="results-heading">即時計算</h2>
          <dl className="metrics">
            <div><dt>重量</dt><dd>{format(validation.massProperties.totalMassG)} g</dd></div>
            <div>
              <dt>重心偏移</dt>
              <dd>{format(Math.hypot(validation.massProperties.centerOfMassMm.x, validation.massProperties.centerOfMassMm.y), 2)} mm</dd>
            </div>
            <div><dt>轉動慣量</dt><dd>{format(validation.massProperties.polarMomentGmm2, 0)} g·mm²</dd></div>
            <div><dt>速度</dt><dd>{format(prediction.speed, 0)} / 100</dd></div>
            <div><dt>旋轉時間</dt><dd>{format(prediction.spinDuration, 0)} / 100</dd></div>
            <div><dt>穩定性</dt><dd>{format(prediction.stability, 0)} / 100</dd></div>
            <div><dt>抗撞能力</dt><dd>{format(prediction.impactResistance, 0)} / 100</dd></div>
          </dl>

          <div className="validation" aria-live="polite">
            {validation.valid ? (
              <p className="valid-message">設計符合課堂規格</p>
            ) : (
              <ul className="issue-list">
                {validation.issues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.layerId ?? "design"}-${index}`}>
                    {ISSUE_LABELS[issue.code]}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            className="readiness-button"
            type="button"
            disabled={!validation.valid}
            aria-label="規格通過，可參戰"
          >
            規格通過，可參戰
          </button>
        </aside>
      </div>
    </main>
  );
}
