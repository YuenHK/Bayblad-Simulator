import { describe, expect, it } from "vitest";
import { designSchema, makeDefaultDesign, polygonArea, radialFactor } from "@steam-top/domain";
import { buildCollisionOutlineVertices } from "./collision-proxy";

describe("custom contact outline", () => {
  it("retains adaptive star accuracy when an inner custom board is hidden", () => {
    const design = makeDefaultDesign();
    design.layers[0] = { ...design.layers[0], shape: "star", points: 16, diameterMm: 60, cornerRoundness: 0 };
    design.layers[1] = { ...design.layers[1], shape: "custom", diameterMm: Math.hypot(8, 8) * 2, outline: { version: 1, mirror: "none", vertices: [{ x: -8, y: -8 }, { x: 8, y: -8 }, { x: 8, y: 8 }, { x: -8, y: 8 }] } };
    design.layers[2] = { ...design.layers[2], shape: "circle", diameterMm: 20 };
    const outline = buildCollisionOutlineVertices(design);
    const angle = Math.PI / 128, dx = Math.cos(angle), dy = Math.sin(angle);
    const radii = outline.flatMap((a, i) => {
      const b = outline[(i + 1) % outline.length]!, ex = b.x - a.x, ey = b.y - a.y;
      const det = dx * ey - dy * ex;
      if (Math.abs(det) < 1e-12) return [];
      const t = (a.x * ey - a.y * ex) / det, u = (a.x * dy - a.y * dx) / det;
      return t >= 0 && u >= 0 && u <= 1 ? [t] : [];
    });
    expect(radii).toHaveLength(1);
    expect(Math.abs(radii[0]! - 30 * radialFactor("star", 16, angle, 0))).toBeLessThanOrEqual(0.35);
  });
  it("keeps a concave boundary instead of a radial or convex envelope", () => {
    const vertices = [{ x: -15, y: -15 }, { x: 15, y: -15 }, { x: 15, y: 15 }, { x: 8, y: 8 }, { x: -15, y: 15 }];
    const basic = makeDefaultDesign();
    const design = designSchema.parse({ ...basic, layers: basic.layers.map(layer => ({ ...layer, shape: "custom", diameterMm: Math.hypot(15, 15) * 2, outline: { version: 1, vertices, mirror: "none" } })) });
    const outline = buildCollisionOutlineVertices(design);
    expect(polygonArea(outline)).toBeCloseTo(polygonArea(vertices), 8);
    expect(outline).toContainEqual({ x: 8, y: 8 });
  });
});
