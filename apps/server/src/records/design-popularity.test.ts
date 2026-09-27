import { makeDefaultDesign } from "@steam-top/domain";
import { describe, expect, it } from "vitest";
import { designPopularityKey } from "./design-popularity";

function customDesign() {
  const design = makeDefaultDesign();
  design.layers[0] = { ...design.layers[0], shape: "custom", diameterMm: 2 * Math.hypot(10, 10), outline: { version: 1, mirror: "none", vertices: [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }] } };
  return design;
}
describe("popular geometry identity", () => {
  it("merges identical custom rings regardless of start, winding and drawing metadata", () => {
    const first = customDesign(), second = structuredClone(first);
    const layer = second.layers[0], ring = layer.outline!.vertices;
    layer.outline!.vertices = [...ring.slice(2), ...ring.slice(0, 2)].reverse();
    layer.outline!.mirror = "leftRight";
    layer.points = 12;
    layer.cornerRoundness = 0.9;
    layer.diameterMm = 28.284;
    expect(designPopularityKey(second)).toBe(designPopularityKey(first));
  });
  it("keeps rotation, outline, layer order and assembly changes distinct", () => {
    const first = customDesign();
    for (const change of [
      (d: typeof first) => { d.layers[0].rotationDeg = 10; },
      (d: typeof first) => { d.layers[0].outline!.vertices[0]!.x = -9; },
      (d: typeof first) => { d.screwLayout.radiusMm += 1; },
      (d: typeof first) => { d.metalDiscDiameterMm = 40; },
    ]) {
      const next = structuredClone(first); change(next);
      expect(designPopularityKey(next)).not.toBe(designPopularityKey(first));
    }
  });
});
