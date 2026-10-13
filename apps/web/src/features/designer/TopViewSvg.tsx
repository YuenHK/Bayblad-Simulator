import type { Layer, TopDesign } from "@steam-top/domain";
import { useId } from "react";

import { layerPath, PREVIEW_HOLES, PREVIEW_VIEW_BOX } from "./previewGeometry";
import { SvgCutoutMask } from "./SvgCutoutMask";

export type TopViewSvgProps = Readonly<{ design: TopDesign; position?: Layer["position"]; extentMm?: number }>;

const POSITION_LABELS = { top: "頂層", middle: "中層", bottom: "底層" } as const;
const LAYER_OPACITY = { top: 0.72, middle: 0.58, bottom: 0.48 } as const;

export function TopViewSvg({ design, position, extentMm }: TopViewSvgProps) {
  const instance = useId();
  const titleId = `${instance}-top-view-title`;
  const descId = `${instance}-top-view-desc`;
  const maskId = `${instance}-acrylic-cutouts`;
  const label = position ? `${POSITION_LABELS[position]}俯視圖` : "陀螺俯視圖";

  return (
    <svg
      className="top-view-svg"
      viewBox={extentMm ? `${-extentMm} ${-extentMm} ${extentMm * 2} ${extentMm * 2}` : PREVIEW_VIEW_BOX}
      role="img"
      aria-label={label}
      aria-describedby={descId}
      preserveAspectRatio="xMidYMid meet"
    >
      <title id={titleId}>{label}</title>
      <desc id={descId}>{position ? `${POSITION_LABELS[position]}層板及軸孔、螺絲孔，以三層相同比例顯示` : "頂層、中層、底層亞加力膠及共用螺絲孔的對齊位置"}</desc>
      <defs>
        <SvgCutoutMask design={design} id={maskId} {...(extentMm ? { extentMm } : {})} />
      </defs>

      {!position && design.metalDiscDiameterMm > 0 ? (
        <circle
          data-testid="metal-disc"
          cx="0"
          cy="0"
          r={design.metalDiscDiameterMm / 2}
          fill="#98a2b3"
          fillOpacity="0.2"
          stroke="#596579"
          strokeDasharray="2 1.5"
          vectorEffect="non-scaling-stroke"
          aria-hidden="true"
        />
      ) : null}

      {[...design.layers].reverse().filter(layer => !position || layer.position === position).map((layer) => (
        <path
          key={layer.id}
          data-testid="layer-path"
          data-layer-id={layer.id}
          data-position={layer.position}
          aria-label={`${POSITION_LABELS[layer.position]}：${layer.diameterMm} mm`}
          d={layerPath(layer)}
          fill={layer.color}
          fillOpacity={position ? 0.8 : LAYER_OPACITY[layer.position]}
          stroke={layer.color}
          strokeWidth="0.7"
          vectorEffect="non-scaling-stroke"
          mask={`url(#${maskId})`}
        />
      ))}

      <g data-testid="axle-marker" aria-label="中央軸心">
        <circle
          cx="0"
          cy="0"
          r={PREVIEW_HOLES.axleRadiusMm}
          fill="none"
          stroke="#172033"
          strokeWidth="0.7"
          vectorEffect="non-scaling-stroke"
        />
        <path d="M -1.5 0 H 1.5 M 0 -1.5 V 1.5" stroke="#172033" strokeWidth="0.45" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}
