import type { TopDesign } from "@steam-top/domain";

import { layerPath, PREVIEW_HOLES, PREVIEW_VIEW_BOX, screwCenters } from "./previewGeometry";

export type TopViewSvgProps = Readonly<{ design: TopDesign }>;

const POSITION_LABELS = { top: "頂層", middle: "中層", bottom: "底層" } as const;
const LAYER_OPACITY = { top: 0.72, middle: 0.58, bottom: 0.48 } as const;

export function TopViewSvg({ design }: TopViewSvgProps) {
  const titleId = `${design.id}-top-view-title`;
  const descId = `${design.id}-top-view-desc`;

  return (
    <svg
      className="top-view-svg"
      viewBox={PREVIEW_VIEW_BOX}
      role="img"
      aria-label="陀螺俯視圖"
      aria-describedby={descId}
      preserveAspectRatio="xMidYMid meet"
    >
      <title id={titleId}>陀螺俯視圖</title>
      <desc id={descId}>頂層、中層、底層亞加力膠及共用螺絲孔的對齊位置</desc>

      {design.metalDiscDiameterMm > 0 ? (
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

      {[...design.layers].reverse().map((layer) => (
        <path
          key={layer.id}
          data-testid="layer-path"
          data-layer-id={layer.id}
          data-position={layer.position}
          aria-label={`${POSITION_LABELS[layer.position]}：${layer.diameterMm} mm`}
          d={layerPath(layer)}
          fill={layer.color}
          fillOpacity={LAYER_OPACITY[layer.position]}
          stroke={layer.color}
          strokeWidth="0.7"
          vectorEffect="non-scaling-stroke"
        />
      ))}

      <g aria-label={`共用螺絲孔：${design.screwLayout.count} 個`}>
        {screwCenters(design).map(({ x, y }, index) => (
          <circle
            key={index}
            data-testid="screw-hole"
            cx={x}
            cy={y}
            r={PREVIEW_HOLES.screwRadiusMm}
            fill="#ffffff"
            stroke="#344054"
            strokeWidth="0.55"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
      <g data-testid="axle-hole" aria-label="中央軸心">
        <circle
          cx="0"
          cy="0"
          r={PREVIEW_HOLES.axleRadiusMm}
          fill="#ffffff"
          stroke="#172033"
          strokeWidth="0.7"
          vectorEffect="non-scaling-stroke"
        />
        <path d="M -1.5 0 H 1.5 M 0 -1.5 V 1.5" stroke="#172033" strokeWidth="0.45" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}
