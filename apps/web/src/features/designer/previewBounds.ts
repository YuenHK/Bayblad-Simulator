import { MATERIALS, makeLayerVertices, type TopDesign } from "@steam-top/domain";

export const PREVIEW_FIT_PADDING = 1.16;

export type PreviewBounds = Readonly<{
  maxRadialExtentMm: number;
  minZMm: number;
  maxZMm: number;
  centerZMm: number;
  boundingSphereRadiusMm: number;
}>;

export type OrthographicFit = Readonly<{
  baseZoom: number;
  visibleWidthMm: number;
  visibleHeightMm: number;
}>;

export function calculatePreviewBounds(design: TopDesign): PreviewBounds {
  const maximumLayerRadius = Math.max(
    ...design.layers.flatMap((layer) =>
      makeLayerVertices(layer).map(({ x, y }) => Math.hypot(x, y)),
    ),
  );
  const metalRadius = design.metalDiscDiameterMm / 2;
  const maxRadialExtentMm = Math.max(maximumLayerRadius, metalRadius);
  const minZMm = design.metalDiscDiameterMm > 0
    ? -MATERIALS.metalDiscThicknessMm
    : 0;
  const maxZMm = design.layers.length * MATERIALS.layerThicknessMm;
  const centerZMm = (minZMm + maxZMm) / 2;
  const halfHeightMm = (maxZMm - minZMm) / 2;

  return {
    maxRadialExtentMm,
    minZMm,
    maxZMm,
    centerZMm,
    boundingSphereRadiusMm: Math.hypot(maxRadialExtentMm, halfHeightMm),
  };
}

export function calculateOrthographicFit(
  widthPx: number,
  heightPx: number,
  boundingSphereRadiusMm: number,
  padding = PREVIEW_FIT_PADDING,
): OrthographicFit {
  if (
    !Number.isFinite(widthPx) || widthPx <= 0 ||
    !Number.isFinite(heightPx) || heightPx <= 0 ||
    !Number.isFinite(boundingSphereRadiusMm) || boundingSphereRadiusMm <= 0 ||
    !Number.isFinite(padding) || padding < 1
  ) {
    throw new RangeError("Preview fit dimensions, radius, and padding must be positive and finite");
  }
  const requiredWorldSpanMm = boundingSphereRadiusMm * 2 * padding;
  const baseZoom = Math.min(widthPx, heightPx) / requiredWorldSpanMm;
  return {
    baseZoom,
    visibleWidthMm: widthPx / baseZoom,
    visibleHeightMm: heightPx / baseZoom,
  };
}
