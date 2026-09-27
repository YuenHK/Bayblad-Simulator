import { canonicalizeOutline, type TopDesign } from "@steam-top/domain";

export function designPopularityKey(design: TopDesign): string {
  // Mirrors describe the drawing tool, not the resulting physical geometry.
  // Match the database signature's fields and persisted diameter precision.
  return JSON.stringify([
    design.screwLayout.count, design.screwLayout.radiusMm, design.screwLayout.rotationDeg, design.metalDiscDiameterMm,
    design.layers.map(layer => [
      layer.position, layer.shape, layer.shape === "custom" ? null : layer.points,
      layer.shape === "custom" ? Number(layer.diameterMm.toFixed(3)) : layer.diameterMm,
      layer.shape === "custom" ? 0 : layer.cornerRoundness, layer.rotationDeg,
      layer.outline ? canonicalizeOutline(layer.outline.vertices) : null,
    ]),
  ]);
}
