import {
  ASSEMBLY,
  makeLayerVertices,
  type Layer,
  type TopDesign,
} from "@steam-top/domain";

const FULL_TURN = Math.PI * 2;

export const PREVIEW_VIEW_BOX = "-34 -34 68 68";

export function layerPath(layer: Layer): string {
  const vertices = makeLayerVertices(layer);
  const [first, ...rest] = vertices;
  if (first === undefined) return "";
  return `M ${formatPoint(first.x)} ${formatPoint(first.y)} ${rest
    .map(({ x, y }) => `L ${formatPoint(x)} ${formatPoint(y)}`)
    .join(" ")} Z`;
}

function formatPoint(value: number): string {
  const rounded = Math.abs(value) < 0.0005 ? 0 : value;
  return rounded.toFixed(3);
}

export function screwCenters(design: TopDesign): ReadonlyArray<Readonly<{ x: number; y: number }>> {
  const rotation = (design.screwLayout.rotationDeg * Math.PI) / 180;
  return Array.from({ length: design.screwLayout.count }, (_, index) => {
    const angle = rotation + (index / design.screwLayout.count) * FULL_TURN;
    return {
      x: Math.cos(angle) * design.screwLayout.radiusMm,
      y: Math.sin(angle) * design.screwLayout.radiusMm,
    };
  });
}

export const PREVIEW_HOLES = {
  axleRadiusMm: ASSEMBLY.axleHoleRadiusMm,
  screwRadiusMm: ASSEMBLY.screwHoleRadiusMm,
} as const;
