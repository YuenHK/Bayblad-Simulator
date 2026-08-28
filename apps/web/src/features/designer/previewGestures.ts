export type PreviewRotation = Readonly<{ x: number; y: number }>;
export type PointerDelta = Readonly<{ x: number; y: number }>;

export const MIN_PREVIEW_ZOOM = 0.55;
export const MAX_PREVIEW_ZOOM = 2.2;
export const ROTATION_RADIANS_PER_PIXEL = 0.01;

export function clampPreviewZoom(zoom: number): number {
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, zoom));
}

export function rotatePreview(
  rotation: PreviewRotation,
  delta: PointerDelta,
): PreviewRotation {
  return {
    x: rotation.x + delta.y * ROTATION_RADIANS_PER_PIXEL,
    y: rotation.y + delta.x * ROTATION_RADIANS_PER_PIXEL,
  };
}

export function zoomFromPinch(
  zoom: number,
  previousDistance: number,
  nextDistance: number,
): number {
  if (previousDistance <= 0 || nextDistance <= 0) return clampPreviewZoom(zoom);
  return clampPreviewZoom(zoom * (nextDistance / previousDistance));
}

export function pointerDistance(
  left: Readonly<{ x: number; y: number }>,
  right: Readonly<{ x: number; y: number }>,
): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

export function selectGesturePointers<T>(
  pointers: ReadonlyMap<number, T>,
): readonly [] | readonly [T] | readonly [T, T] {
  const active = [...pointers.values()];
  const first = active[0];
  const second = active[1];
  if (first === undefined) return [];
  if (second === undefined) return [first];
  return [first, second];
}
