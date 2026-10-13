import { makeLayerVertices, type TopDesign } from "@steam-top/domain";

import { layerPath } from "./previewGeometry";
import { SvgCutoutMask } from "./SvgCutoutMask";

export type ExplodedViewProps = Readonly<{ design: TopDesign; scale?: number }>;

const OFFSETS = { top: 48, middle: 112, bottom: 176 } as const;
const POSITION_LABELS = { top: "頂層", middle: "中層", bottom: "底層" } as const;

export function ExplodedView({ design, scale = 1 }: ExplodedViewProps) {
  const radius = Math.max(10, ...design.layers.flatMap(layer => makeLayerVertices(layer).map(p => Math.hypot(p.x, p.y))));
  const sx = Number((0.72 * scale).toFixed(2));
  const sy = Number((0.34 * scale).toFixed(2));
  const centerX = scale === 1 ? 78 : Math.max(78, radius * sx + 12);
  const firstY = scale === 1 ? 48 : Math.max(48, radius * sy + 12);
  const gap = scale === 1 ? 64 : Math.max(64, 2 * radius * sy + 12);
  const offsets = scale === 1 ? OFFSETS : { top: firstY, middle: firstY + gap, bottom: firstY + 2 * gap };
  const labelX = scale === 1 ? 118 : centerX + radius * sx + 12;
  const metalY = scale === 1 ? 234 : offsets.bottom + gap;
  const width = scale === 1 ? 190 : Math.max(190, labelX + 55);
  const height = scale === 1 ? 270 : Math.max(270, (design.metalDiscDiameterMm > 0 ? metalY : offsets.bottom) + radius * sy + 18);
  const titleId = `${design.id}-exploded-title`;
  const descId = `${design.id}-exploded-desc`;
  const maskId = `${design.id}-exploded-cutouts`;

  return (
    <svg
      className="exploded-view-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="陀螺分解圖"
      aria-describedby={descId}
      preserveAspectRatio="xMidYMid meet"
    >
      <title id={titleId}>陀螺分解圖</title>
      <desc id={descId}>三層亞加力膠對齊分開，金屬碟在底層下方</desc>
      <defs>
        <SvgCutoutMask design={design} id={maskId} extentMm={Math.max(42, Number((radius + 2).toFixed(6)))} />
      </defs>
      <path d={`M ${centerX} 26 V ${height - 26}`} stroke="#98a2b3" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" aria-hidden="true" />
      {design.layers.map((layer) => {
        const offsetY = offsets[layer.position];
        return (
          <g
            key={layer.id}
            data-testid="exploded-layer"
            data-layer-id={layer.id}
            data-position={layer.position}
            data-offset-y={offsetY}
            transform={`translate(${centerX} ${offsetY}) scale(${sx} ${sy})`}
          >
            <path d={layerPath(layer)} fill={layer.color} fillOpacity="0.68" stroke={layer.color} strokeWidth="0.8" vectorEffect="non-scaling-stroke" mask={`url(#${maskId})`} />
          </g>
        );
      })}
      {design.layers.map((layer) => (
        <text key={`${layer.id}-label`} x={labelX} y={offsets[layer.position] + 4} className="exploded-label">
          {POSITION_LABELS[layer.position]}
        </text>
      ))}
      {design.metalDiscDiameterMm > 0 ? (
        <g data-testid="exploded-metal" data-offset-y={metalY} transform={`translate(${centerX} ${metalY})`}>
          <ellipse rx={design.metalDiscDiameterMm * 0.36 * scale} ry={design.metalDiscDiameterMm * 0.17 * scale} fill="#9aa4b2" stroke="#596579" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
          <text x={labelX - centerX} y="4" className="exploded-label">金屬碟</text>
        </g>
      ) : null}
    </svg>
  );
}
