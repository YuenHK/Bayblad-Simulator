import { makeLayerVertices, type TopDesign } from "@steam-top/domain";
import { TopViewSvg } from "./TopViewSvg";

const LABELS = { top: "頂層", middle: "中層", bottom: "底層" } as const;
export function LayerTopViews({ design, selectedLayerId }: { design: TopDesign; selectedLayerId?: string }) {
  const extentMm = Math.max(10, ...design.layers.flatMap(layer => makeLayerVertices(layer).map(p => Math.hypot(p.x, p.y)))) * 1.16;
  return <div className={`layer-top-views${selectedLayerId ? " selected-layer-view" : ""}`} role="group" aria-label={selectedLayerId ? "目前編輯層俯視圖" : "三層獨立俯視圖"}>
    {design.layers.filter(layer => !selectedLayerId || layer.id === selectedLayerId).map(layer => <figure key={layer.id}><TopViewSvg design={design} position={layer.position} extentMm={extentMm} /><figcaption>{LABELS[layer.position]} · {layer.diameterMm.toFixed(2).replace(/\.00$/, "")} mm</figcaption></figure>)}
  </div>;
}
