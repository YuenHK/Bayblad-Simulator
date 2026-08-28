import type { TopDesign } from "@steam-top/domain";

import { PREVIEW_HOLES, screwCenters } from "./previewGeometry";

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
      x="-34"
      y="-34"
      width="68"
      height="68"
    >
      <rect x="-34" y="-34" width="68" height="68" fill="white" />
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
