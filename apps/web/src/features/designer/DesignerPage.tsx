import type { RuleIssueCode, TopDesign } from "@steam-top/domain";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";

import { LayerRail } from "./LayerRail";
import { WorkbenchTabs } from "./WorkbenchTabs";
import { OutlineCanvasHost } from "./OutlineCanvasHost";
import "./makerWorkbench.css";
import { AssemblyControls } from "./AssemblyControls";
import { DesignExportControls } from "./DesignExportControls";
import { ExplodedView } from "./ExplodedView";
import { LayerControls } from "./LayerControls";
import { PreviewErrorBoundary } from "./PreviewErrorBoundary";
import { TopViewSvg } from "./TopViewSvg";
import { useDesigner } from "./useDesigner";

const POSITION_LABELS = {
  top: "頂層",
  middle: "中層",
  bottom: "底層",
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
type PreviewMode = "top" | "exploded" | "3d";
type WorkspaceTab = "preview" | "shape" | "assembly";
type ToolTab = "shape" | "assembly";

const WORKSPACE_TABS = [
  { id: "preview", label: "預覽", panelId: "workspace-panel-preview" },
  { id: "shape", label: "造型", panelId: "workspace-panel-shape" },
  { id: "assembly", label: "裝配", panelId: "workspace-panel-assembly" },
] as const;
const TOOL_TABS = [
  { id: "shape", label: "層板造型", panelId: "workspace-panel-shape" },
  { id: "assembly", label: "共用裝配", panelId: "workspace-panel-assembly" },
] as const;

const PREVIEW_TABS: ReadonlyArray<Readonly<{ mode: PreviewMode; label: string }>> = [
  { mode: "top", label: "俯視圖" },
  { mode: "exploded", label: "分解圖" },
  { mode: "3d", label: "3D 預覽" },
];

type Preview3DModule = Readonly<{
  default: ComponentType<Readonly<{ design: TopDesign }>>;
}>;

export type DesignerPageProps = Readonly<{
  load3DPreview?: () => Promise<Preview3DModule>;
  onUseDesign?: (design: TopDesign) => void | Promise<void>;
}>;

const loadDefault3DPreview = async (): Promise<Preview3DModule> => {
  const module = await import("./TopPreview3D");
  return { default: module.TopPreview3D };
};

function format(value: number, digits = 1): string {
  return value.toFixed(digits);
}

export function DesignerPage({
  load3DPreview = loadDefault3DPreview,
  onUseDesign,
}: DesignerPageProps = {}) {
  const { design, validation, prediction, dispatch } = useDesigner();
  const [selectedLayerId, setSelectedLayerId] = useState(
    () => design.layers[0].id,
  );
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  const [dragOverLayerId, setDragOverLayerId] = useState<string | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("top");
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("shape");
  const [tool, setTool] = useState<ToolTab>("shape");
  const [layerModes, setLayerModes] = useState<Record<string, "basic" | "custom">>({});
  const [canvasHosts, setCanvasHosts] = useState<Record<string, HTMLDivElement | null>>({});
  const [outlineSurface, setOutlineSurface] = useState(true);
  const controlsRef = useRef<HTMLElement>(null);
  const setCanvasHost = useCallback((id: string, node: HTMLDivElement | null) => {
    setCanvasHosts((previous) => previous[id] === node ? previous : { ...previous, [id]: node });
  }, []);
  const onModeChange = useCallback((id: string, mode: "basic" | "custom") => {
    setLayerModes((previous) => previous[id] === mode ? previous : { ...previous, [id]: mode });
  }, []);
  const changeWorkspace = (tab: WorkspaceTab) => {
    setWorkspaceTab(tab);
    if (tab !== "preview") setTool(tab);
  };
  const selectLayer = (id: string) => {
    setSelectedLayerId(id);
    setTool("shape");
    setWorkspaceTab("shape");
    setOutlineSurface(true);
  };
  const [previewLoadAttempt, setPreviewLoadAttempt] = useState(0);
  const LazyTopPreview3D = useMemo(
    () => lazy(load3DPreview),
    [load3DPreview, previewLoadAttempt],
  );
  const [invalidFieldKeys, setInvalidFieldKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
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
  const updateFieldValidity = useCallback(
    (fieldKey: string, isValid: boolean) => {
      setInvalidFieldKeys((current) => {
        const currentlyInvalid = current.has(fieldKey);
        if (currentlyInvalid === !isValid) return current;
        const next = new Set(current);
        if (isValid) next.delete(fieldKey);
        else next.add(fieldKey);
        return next;
      });
    },
    [],
  );
  const selectPreviewMode = useCallback((mode: PreviewMode) => {
    if (mode === "3d" && previewMode !== "3d") {
      setPreviewLoadAttempt((current) => current + 1);
    }
    setPreviewMode(mode);
  }, [previewMode]);

  const reorderLayers = (sourceId: string, targetId: string) => {
    const source = design.layers.find((layer) => layer.id === sourceId);
    const target = design.layers.find((layer) => layer.id === targetId);
    if (source === undefined || target === undefined || source.id === target.id) {
      return;
    }
    dispatch({ type: "reorder-layer", sourceId, targetId });
    setReorderAnnouncement(
      `${POSITION_LABELS[source.position]}層板已移至${POSITION_LABELS[target.position]}`,
    );
  };

  const moveSelected = (direction: "up" | "down") => {
    const targetIndex = direction === "up" ? selectedIndex - 1 : selectedIndex + 1;
    if (targetIndex < 0 || targetIndex >= design.layers.length) return;
    reorderLayers(selectedLayer.id, design.layers[targetIndex]!.id);
  };

  const beginDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    layerId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (dragCapture.current !== null) return;
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
    reorderLayers(draggingLayerId, targetId);
    setDragOverLayerId(targetId);
  };

  const moveCapturedPointer = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    const capture = dragCapture.current;
    if (
      capture === null ||
      capture.pointerId !== event.pointerId ||
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

  const finishDrag = (pointerId: number) => {
    const capture = dragCapture.current;
    if (capture === null || capture.pointerId !== pointerId) return;
    if (
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
    finishDrag(event.pointerId);
  };

  useEffect(() => {
    if (draggingLayerId === null) return;
    const finishFromWindow = (event: PointerEvent) => finishDrag(event.pointerId);
    window.addEventListener("pointerup", finishFromWindow);
    window.addEventListener("pointercancel", finishFromWindow);
    return () => {
      window.removeEventListener("pointerup", finishFromWindow);
      window.removeEventListener("pointercancel", finishFromWindow);
    };
  }, [draggingLayerId]);

  const customMode = (layerModes[selectedLayerId] ?? (selectedLayer.shape === "custom" ? "custom" : "basic")) === "custom";
  const showingOutline = customMode && tool === "shape" && outlineSurface;
  const openCanvas = () => { setOutlineSurface(true); setWorkspaceTab("preview"); };
  const invalidScopes = [
    ...design.layers.filter((layer) => [...invalidFieldKeys].some((key) => key.startsWith(layer.id + ":")))
      .map((layer) => ({ id: layer.id, label: POSITION_LABELS[layer.position] })),
    ...([...invalidFieldKeys].some((key) => key.startsWith("assembly:")) ? [{ id: "assembly", label: "共用裝配" }] : []),
  ];
  const showInvalidScope = (id: string) => {
    if (id === "assembly") changeWorkspace("assembly"); else selectLayer(id);
    requestAnimationFrame(() => {
      controlsRef.current?.querySelector<HTMLElement>('[data-tool-panel]:not([hidden]) [data-layer-controls]:not([hidden]) [aria-invalid="true"], [data-tool-panel="assembly"]:not([hidden]) [aria-invalid="true"]')?.focus();
    });
  };
  const readinessValid = validation.valid && invalidFieldKeys.size === 0;

  return (
    <main className="designer-shell game-designer maker-workbench" data-workspace={workspaceTab}>
      <header className="page-heading">
        <p className="eyebrow">STEAM 陀螺</p>
        <h1>陀螺設計器</h1>
        <p>調整三層層板與共用裝配設定，數值會即時重新計算。</p>
      </header>

      <WorkbenchTabs items={WORKSPACE_TABS} value={workspaceTab} onChange={changeWorkspace} label="設計室區域" idPrefix="workspace-tab" className="workbench-mobile-tabs" />

      <div className="designer-layout">
        <LayerRail layers={design.layers} selectedId={selectedLayerId} draggingId={draggingLayerId} dragOverId={dragOverLayerId}
          onSelect={selectLayer} onMove={moveSelected} onDragStart={beginDrag} onDragMove={moveCapturedPointer} onDragEnd={endDrag} announcement={reorderAnnouncement} />
        <section id="workspace-panel-preview" className={`panel preview-panel workspace-panel${workspaceTab === "preview" ? " is-active" : ""}`} aria-labelledby="preview-heading" data-workspace-panel="preview">
          <div className="preview-heading-row">
            <h2 id="preview-heading">即時預覽</h2>
            <div className="preview-tabs" hidden={showingOutline} role="tablist" aria-label="預覽模式">
              {PREVIEW_TABS.map(({ mode, label }, index) => (
                <button
                  key={mode}
                  id={`preview-tab-${mode}`}
                  type="button"
                  role="tab"
                  aria-selected={previewMode === mode}
                  aria-controls="preview-tabpanel"
                  tabIndex={previewMode === mode ? 0 : -1}
                  onClick={() => selectPreviewMode(mode)}
                  onKeyDown={(event) => {
                    let nextIndex = index;
                    if (event.key === "ArrowRight") nextIndex = (index + 1) % PREVIEW_TABS.length;
                    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + PREVIEW_TABS.length) % PREVIEW_TABS.length;
                    else if (event.key === "Home") nextIndex = 0;
                    else if (event.key === "End") nextIndex = PREVIEW_TABS.length - 1;
                    else return;
                    event.preventDefault();
                    const nextMode = PREVIEW_TABS[nextIndex]!.mode;
                    selectPreviewMode(nextMode);
                    requestAnimationFrame(() => document.getElementById(`preview-tab-${nextMode}`)?.focus());
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {customMode && tool === "shape" ? <div className="outline-surface-tabs" role="group" aria-label="輪廓工作區">
            <button type="button" aria-pressed={outlineSurface} onClick={() => setOutlineSurface(true)}>編輯輪廓</button>
            <button type="button" aria-pressed={!outlineSurface} onClick={() => setOutlineSurface(false)}>預覽成品</button>
          </div> : null}
          <div className="workbench-canvas-area" hidden={!showingOutline}>
            <p className="field-note">輪廓草稿 · 套用後才更新成品</p>
            {design.layers.map((layer) => <OutlineCanvasHost key={layer.id} layerId={layer.id} hidden={layer.id !== selectedLayerId} onHost={setCanvasHost} />)}
            <button type="button" className="return-outline-tools" onClick={() => changeWorkspace("shape")}>返回造型工具</button>
          </div>
          <div
            hidden={showingOutline}
            id="preview-tabpanel"
            className="preview-stage hologram-stage"
            role="tabpanel"
            aria-labelledby={`preview-tab-${previewMode}`}
          >
            {previewMode === "top" ? <TopViewSvg design={design} /> : null}
            {previewMode === "exploded" ? <ExplodedView design={design} /> : null}
            {previewMode === "3d" ? (
              <PreviewErrorBoundary design={design} resetKey={previewLoadAttempt}>
                <Suspense fallback={<p role="status">正在載入 3D 預覽……</p>}>
                  <LazyTopPreview3D design={design} />
                </Suspense>
              </PreviewErrorBoundary>
            ) : null}
          </div>
        </section>

        <section ref={controlsRef} className="panel controls-panel" aria-label="工作台工具面板">
          <WorkbenchTabs items={TOOL_TABS} value={tool} onChange={changeWorkspace} label="工作台工具" idPrefix="tool-tab" className="workbench-tool-tabs" />
          <div id="workspace-panel-shape" role="tabpanel" aria-labelledby="tool-tab-shape" data-tool-panel="shape" hidden={tool !== "shape"}>
            <h2>層板設計 · {POSITION_LABELS[selectedLayer.position]}</h2>
            {design.layers.map((layer) => <div key={layer.id} data-layer-controls={layer.id} hidden={selectedLayerId !== layer.id}>
              <LayerControls layer={layer} screwLayout={design.screwLayout} dispatch={dispatch}
                onFieldValidityChange={updateFieldValidity} canvasHost={canvasHosts[layer.id]}
                onModeChange={onModeChange} onOpenCanvas={openCanvas} />
            </div>)}
          </div>
          <div id="workspace-panel-assembly" role="tabpanel" aria-labelledby="tool-tab-assembly" data-tool-panel="assembly" hidden={tool !== "assembly"}>
            <h2>共用裝配</h2>
            <AssemblyControls design={design} dispatch={dispatch} onFieldValidityChange={updateFieldValidity} />
          </div>
        </section>

        <aside id="workspace-panel-results" className="panel results-panel" aria-labelledby="results-heading" data-workspace-panel="results">
          <h2 id="results-heading">即時計算</h2>
          <dl className="metrics ability-grid" role="group" aria-label="陀螺能力值">
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

          <div id="validation-status" className="validation" aria-live="polite">
            {invalidFieldKeys.size > 0 ? (
              <div><p className="issue-message">請先修正標示的數值欄位。</p>
                <div className="invalid-scope-links">{invalidScopes.map(({ id, label }) => <button key={id} type="button" onClick={() => showInvalidScope(id)}>前往{label}修正</button>)}</div>
              </div>
            ) : null}
            {validation.valid && invalidFieldKeys.size === 0 ? (
              <p className="valid-message">設計符合課堂規格</p>
            ) : validation.issues.length > 0 ? (
              <ul className="issue-list">
                {validation.issues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.layerId ?? "design"}-${index}`}>
                    {ISSUE_LABELS[issue.code]}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <DesignExportControls design={design} invalidFields={invalidFieldKeys.size > 0}>
          <button
            className="readiness-button"
            type="button"
            disabled={!readinessValid}
            aria-label={
              readinessValid
                ? onUseDesign ? "用此設計參戰" : "規格通過，可參戰"
                : "規格未通過，請先修正"
            }
            aria-describedby={readinessValid ? undefined : "validation-status"}
            onClick={() => {
              if (readinessValid) void onUseDesign?.(design);
            }}
          >
            {readinessValid && onUseDesign ? "用此設計參戰" : readinessValid ? "規格通過，可參戰" : "規格未通過，請先修正"}
          </button>
          </DesignExportControls>
        </aside>
      </div>
    </main>
  );
}
