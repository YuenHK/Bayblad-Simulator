import type { TopDesign } from "@steam-top/domain";

import { PREVIEW_HOLES, screwCenters } from "./previewGeometry";

const MASK_EXTENT_MM = 42;
const MASK_SIZE_MM = MASK_EXTENT_MM * 2;

export function SvgCutoutMask({
  design,
  id,
}: Readonly<{
  design: TopDesign;
  id: string;
}>) {
  return (
    <mask
      id={id}
      data-testid="acrylic-cutout-mask"
      maskUnits="userSpaceOnUse"
      x={-MASK_EXTENT_MM}
      y={-MASK_EXTENT_MM}
      width={MASK_SIZE_MM}
      height={MASK_SIZE_MM}
    >
      <rect
        x={-MASK_EXTENT_MM}
        y={-MASK_EXTENT_MM}
        width={MASK_SIZE_MM}
        height={MASK_SIZE_MM}
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
