import type { Layer } from "@steam-top/domain";
import type { PointerEvent } from "react";
import { layerPath } from "./previewGeometry";

const POSITIONS = { top: "頂層", middle: "中層", bottom: "底層" } as const;
const SHAPES = { circle: "圓形", polygon: "多邊形", star: "星形", wave: "波浪形", custom: "自定造型" } as const;
export function LayerRail({ layers, selectedId, draggingId, dragOverId, onSelect, onMove, onDragStart, onDragMove, onDragEnd, announcement }: Readonly<{
  layers: readonly Layer[]; selectedId: string; draggingId: string | null; dragOverId: string | null;
  onSelect: (id: string) => void; onMove: (direction: "up" | "down") => void;
  onDragStart: (event: PointerEvent<HTMLButtonElement>, id: string) => void;
  onDragMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onDragEnd: (event: PointerEvent<HTMLButtonElement>) => void;
  announcement: string;
}>) {
  const selectedIndex = layers.findIndex((layer) => layer.id === selectedId);
  return <section className="workbench-layer-rail" aria-label="層板選擇與排序">
    <ol className="layer-list" aria-label="三層排列">{layers.map((layer) => <li key={layer.id} data-layer-id={layer.id}
      className={[draggingId === layer.id ? "is-dragging" : "", draggingId !== null && dragOverId === layer.id ? "is-drag-target" : ""].filter(Boolean).join(" ")}>
      <button type="button" className="layer-select" aria-label={`編輯${POSITIONS[layer.position]}`} aria-pressed={selectedId === layer.id} onClick={() => onSelect(layer.id)}>
        <svg viewBox="-44 -44 88 88" aria-hidden="true" focusable="false"><path d={layerPath(layer)} fill={layer.color} stroke="currentColor" strokeWidth="0.6" /></svg>
        <span className="layer-summary"><strong>{POSITIONS[layer.position]}</strong><span>{SHAPES[layer.shape]}</span><span>{layer.diameterMm.toFixed(2).replace(/\.00$/, "")} mm</span></span>
      </button>
      <button type="button" className="drag-handle" data-source-layer-id={layer.id} aria-label={`拖動${POSITIONS[layer.position]}以重新排序`}
        aria-pressed={draggingId === layer.id} onPointerDown={(event) => onDragStart(event, layer.id)} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd} onClick={(event) => event.preventDefault()}><span aria-hidden="true">↕</span></button>
    </li>)}</ol>
    <div className="move-actions" aria-label="調整層次順序"><button type="button" onClick={() => onMove("up")} disabled={selectedIndex === 0} aria-label="將目前層上移">上移</button><button type="button" onClick={() => onMove("down")} disabled={selectedIndex === layers.length - 1} aria-label="將目前層下移">下移</button></div>
    <p className="sr-only" aria-live="polite">{announcement}</p>
  </section>;
}
