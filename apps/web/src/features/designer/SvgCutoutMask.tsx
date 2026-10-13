import type { TopDesign } from "@steam-top/domain";

import { PREVIEW_HOLES, screwCenters } from "./previewGeometry";

const MASK_EXTENT_MM = 42;

export function SvgCutoutMask({
  design,
  id,
  extentMm = MASK_EXTENT_MM,
}: Readonly<{
  design: TopDesign;
  id: string;
  extentMm?: number;
}>) {
  return (
    <mask
      id={id}
      data-testid="acrylic-cutout-mask"
      maskUnits="userSpaceOnUse"
      x={-extentMm}
      y={-extentMm}
      width={extentMm * 2}
      height={extentMm * 2}
    >
      <rect
        x={-extentMm}
        y={-extentMm}
        width={extentMm * 2}
        height={extentMm * 2}
        fill="white"
      />
      <circle
        data-testid="axle-hole"
        cx="0"
        cy="0"
        r={PREVIEW_HOLES.axleRadiusMm}
        fill="black"
      />
      {screwCenters(design).map(({ x, y }, index) => (
        <circle
          key={index}
          data-testid="screw-hole"
          cx={x}
          cy={y}
          r={PREVIEW_HOLES.screwRadiusMm}
          fill="black"
        />
      ))}
    </mask>
  );
}
