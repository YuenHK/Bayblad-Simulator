import type { TopDesign } from "@steam-top/domain";

import { layerPath } from "./previewGeometry";
import { SvgCutoutMask } from "./SvgCutoutMask";

export type ExplodedViewProps = Readonly<{ design: TopDesign }>;

const OFFSETS = { top: 48, middle: 112, bottom: 176 } as const;
const POSITION_LABELS = { top: "頂層", middle: "中層", bottom: "底層" } as const;

export function ExplodedView({ design }: ExplodedViewProps) {
  const titleId = `${design.id}-exploded-title`;
  const descId = `${design.id}-exploded-desc`;
  const maskId = `${design.id}-exploded-cutouts`;

  return (
    <svg
      className="exploded-view-svg"
      viewBox="0 0 190 270"
      role="img"
      aria-label="陀螺分解圖"
      aria-describedby={descId}
      preserveAspectRatio="xMidYMid meet"
    >
      <title id={titleId}>陀螺分解圖</title>
      <desc id={descId}>三層亞加力膠對齊分開，金屬碟在底層下方</desc>
      <defs>
        <SvgCutoutMask design={design} id={maskId} />
      </defs>
      <path d="M 78 26 V 244" stroke="#98a2b3" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" aria-hidden="true" />
      {design.layers.map((layer) => {
        const offsetY = OFFSETS[layer.position];
        return (
          <g
            key={layer.id}
            data-testid="exploded-layer"
            data-layer-id={layer.id}
            data-position={layer.position}
            data-offset-y={offsetY}
            transform={`translate(78 ${offsetY}) scale(0.72 0.34)`}
          >
            <path d={layerPath(layer)} fill={layer.color} fillOpacity="0.68" stroke={layer.color} strokeWidth="0.8" vectorEffect="non-scaling-stroke" mask={`url(#${maskId})`} />
          </g>
        );
      })}
      {design.layers.map((layer) => (
        <text key={`${layer.id}-label`} x="118" y={OFFSETS[layer.position] + 4} className="exploded-label">
          {POSITION_LABELS[layer.position]}
        </text>
      ))}
      {design.metalDiscDiameterMm > 0 ? (
        <g data-testid="exploded-metal" data-offset-y="234" transform="translate(78 234)">
          <ellipse rx={design.metalDiscDiameterMm * 0.36} ry={design.metalDiscDiameterMm * 0.17} fill="#9aa4b2" stroke="#596579" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
          <text x="40" y="4" className="exploded-label">金屬碟</text>
        </g>
      ) : null}
    </svg>
  );
}
