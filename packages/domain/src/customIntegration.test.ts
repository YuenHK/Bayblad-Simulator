import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as domain from "./index";

const rectangle = [{ x: -10, y: -12 }, { x: 20, y: -12 }, { x: 20, y: 12 }, { x: -10, y: 12 }];
// Remove a 10 x 4 top-right corner: an asymmetric, genuinely concave ring.
const concave = [rectangle[0]!, rectangle[1]!, { x: 20, y: 8 }, { x: 10, y: 8 }, { x: 10, y: 12 }, rectangle[3]!];
const custom = (vertices = rectangle) => ({
  ...domain.makeDefaultDesign().layers[0], shape: "custom" as const,
  diameterMm: 2 * Math.max(...vertices.map(p => Math.hypot(p.x, p.y))),
  outline: { version: 1 as const, vertices, mirror: "none" as const },
});

describe("custom outline domain integration", () => {
  it("returns validation failures without throwing for huge or malformed outline arrays", () => {
    const layer = custom();
    for (const vertices of [Array.from({ length: 150_000 }, () => ({ x: 10, y: 10 })), null, [null, {}, "point"], [{ x: NaN, y: 0 }, ...rectangle]]) {
      let result: ReturnType<typeof domain.layerSchema.safeParse> | undefined;
      expect(() => { result = domain.layerSchema.safeParse({ ...layer, outline: { ...layer.outline, vertices } }); }).not.toThrow();
      expect(result?.success).toBe(false);
    }
  });
  it("accepts and preserves versioned custom outlines, including mirror metadata", () => {
    for (const mirror of ["none", "leftRight", "topBottom", 4, 6, 8, 12]) {
      const layer = { ...custom(), outline: { ...custom().outline, mirror } };
      expect(domain.layerSchema.parse(layer)).toEqual(layer);
    }
    expect(domain.designSchema.parse(domain.makeDefaultDesign())).not.toHaveProperty("layers.0.outline");
  });
  it("requires an outline exactly for custom, also through safeExtend", () => {
    const extended = domain.layerSchema.safeExtend({ extra: z.string() });
    expect(domain.layerSchema.safeParse({ ...custom(), outline: undefined }).success).toBe(false);
    expect(domain.layerSchema.safeParse({ ...custom(), shape: "circle" }).success).toBe(false);
    expect(extended.safeParse({ ...custom(), shape: "wave", extra: "ok" }).success).toBe(false);
    expect(extended.safeParse({ ...custom(), extra: "ok" }).success).toBe(true);
  });
  it.each([
    { version: 2 }, { mirror: 3 }, { vertices: rectangle.slice(0, 2) },
    { vertices: Array.from({ length: 257 }, (_, i) => ({ x: 20 * Math.cos(i * 2 * Math.PI / 257), y: 20 * Math.sin(i * 2 * Math.PI / 257) })) },
    { vertices: [{ x: Infinity, y: 0 }, ...rectangle] },
    { vertices: [{ x: 40.001, y: 0 }, ...rectangle] },
    { vertices: [rectangle[0], rectangle[2], rectangle[1], rectangle[3]] },
    { vertices: [{ x: -10, y: -3 }, { x: 20, y: -3 }, { x: 20, y: 12 }, { x: -10, y: 12 }] },
  ])("rejects invalid outline metadata or geometry: %j", change => {
    expect(domain.layerSchema.safeParse({ ...custom(), outline: { ...custom().outline, ...change } }).success).toBe(false);
  });
  it("checks diameter agreement while allowing numeric(7,3) persistence rounding", () => {
    const layer = custom();
    expect(domain.layerSchema.safeParse({ ...layer, diameterMm: Number(layer.diameterMm.toFixed(3)) }).success).toBe(true);
    expect(domain.layerSchema.safeParse({ ...layer, diameterMm: layer.diameterMm + 0.01 }).success).toBe(false);
  });
  it("rotates original vertices without recentering, convexifying, sorting or mutation", () => {
    const layer = { ...custom(concave), rotationDeg: 90 };
    const before = structuredClone(layer);
    const actual = domain.makeLayerVertices(layer);
    actual.forEach((p, i) => {
      expect(p.x).toBeCloseTo(-concave[i]!.y, 12);
      expect(p.y).toBeCloseTo(concave[i]!.x, 12);
    });
    expect(actual).toHaveLength(concave.length);
    expect(layer).toEqual(before);
    expect(() => domain.makeLayerVertices({ ...layer, diameterMm: 40 })).toThrow();
    expect(() => domain.makeLayerVertices({ ...layer, shape: "circle" })).toThrow();
  });
  it.each([false, true])("uses analytic perforated mass, centroid and inertia (concave=%s)", useConcave => {
    const design = domain.makeDefaultDesign();
    design.layers = design.layers.map(layer => ({ ...custom(useConcave ? concave : rectangle), id: layer.id, position: layer.position })) as typeof design.layers;
    design.screwLayout = { count: 3, radiusMm: 6, rotationDeg: 0 };
    const removedArea = useConcave ? 40 : 0;
    const area = 720 - removedArea - Math.PI * (3.25 ** 2 + 3 * 2 ** 2);
    const cx = (720 * 5 - removedArea * 15) / area;
    const cy = -removedArea * 10 / area;
    const polarOrigin = 720 * ((30 ** 2 + 24 ** 2) / 12 + 5 ** 2)
      - removedArea * ((10 ** 2 + 4 ** 2) / 12 + 15 ** 2 + 10 ** 2)
      - Math.PI * 3.25 ** 4 / 2 - 3 * Math.PI * (2 ** 4 / 2 + 2 ** 2 * 6 ** 2);
    const density = 3 * domain.MATERIALS.layerThicknessMm * domain.MATERIALS.acrylicDensityGPerMm3;
    const result = domain.calculateMassProperties(design);
    expect(result.totalMassG).toBeCloseTo(area * density, 10);
    expect(result.centerOfMassMm.x).toBeCloseTo(cx, 10);
    expect(result.centerOfMassMm.y).toBeCloseTo(cy, 10);
    expect(result.polarMomentGmm2).toBeCloseTo((polarOrigin - area * (cx ** 2 + cy ** 2)) * density, 8);
    expect(domain.validateDesign(design).massProperties).toEqual(result);
    expect(domain.predictDesignPerformance(design).modelVersion).toBe("1.1.0");
  });
  it("checks screw clearance against a concave notch rather than its convex hull", () => {
    // A top-edge notch reaches y=7, while the convex hull remains a 40 mm square.
    const vertices = [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 },
      { x: 3, y: 20 }, { x: 3, y: 7 }, { x: -3, y: 7 }, { x: -3, y: 20 }, { x: -20, y: 20 }];
    const design = domain.makeDefaultDesign();
    design.layers[0] = custom(vertices);
    design.screwLayout = { count: 4, radiusMm: 10, rotationDeg: 0 };
    expect(domain.validateFabrication(design).issues).toContainEqual(expect.objectContaining({
      code: "SCREW_OUTSIDE_LAYER", layerId: design.layers[0].id,
    }));
  });
  it("ignores custom roundness claims and versions all new predictions", () => {
    expect(domain.effectiveLayerRoundness(custom())).toBe(0);
    expect(domain.effectiveLayerRoundness({ ...custom(), cornerRoundness: 1 })).toBe(0);
    expect(domain.PERFORMANCE_MODEL_VERSION).toBe("1.1.0");
    expect(domain.predictDesignPerformance(domain.makeDefaultDesign()).modelVersion).toBe("1.1.0");
  });
});
