import type { RecordsResponse } from "./types";
import { localizeAdminValue } from "./localize";
type Layer = RecordsResponse["rows"][number]["design"]["layers"][number];
export function LayerRecord({ layer }: { layer: Layer }) {
  if (layer.shape === "custom") {
    const mirror = layer.outline?.mirror;
    const label = typeof mirror === "number" ? `${mirror}份鏡像` : mirror ? localizeAdminValue(mirror) : "鏡像資料未提供";
    return <>
      {`${localizeAdminValue(layer.position)}：自定造型／${label}／${layer.diameterMm}mm／${layer.actualAreaMm2}mm²／${layer.holeCount}孔／旋轉${layer.rotationDeg}°`}
      {layer.outline && <svg role="img" aria-label="自定造型輪廓" viewBox="-44 -44 88 88" width="64" height="64">
        <g transform="scale(1 -1)"><polygon points={layer.outline.vertices.map(({ x, y }) => `${x},${y}`).join(" ")} transform={`rotate(${layer.rotationDeg})`} fill="none" stroke="currentColor" strokeWidth="1" /></g>
        <circle cx="0" cy="0" r="3.25" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>}
    </>;
  }
  return <>{`${localizeAdminValue(layer.position)}：${localizeAdminValue(layer.shape)} ${layer.points}角／${layer.diameterMm}mm／${layer.actualAreaMm2}mm²／${layer.holeCount}孔／旋轉${layer.rotationDeg}°／圓角${layer.cornerRoundness}`}</>;
}
