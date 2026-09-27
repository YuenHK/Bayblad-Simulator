import { describe, expect, it } from "vitest";
import { designSchema, makeDefaultDesign, polygonArea } from "@steam-top/domain";
import { buildCollisionOutlineVertices } from "./collision-proxy";

describe("custom contact outline", () => {
  it("keeps a concave boundary instead of a radial or convex envelope", () => {
    const vertices = [{ x: -15, y: -15 }, { x: 15, y: -15 }, { x: 15, y: 15 }, { x: 8, y: 8 }, { x: -15, y: 15 }];
    const basic = makeDefaultDesign();
    const design = designSchema.parse({ ...basic, layers: basic.layers.map(layer => ({ ...layer, shape: "custom", diameterMm: Math.hypot(15, 15) * 2, outline: { version: 1, vertices, mirror: "none" } })) });
    const outline = buildCollisionOutlineVertices(design);
    expect(polygonArea(outline)).toBeCloseTo(polygonArea(vertices), 8);
    expect(outline).toContainEqual({ x: 8, y: 8 });
  });
});
