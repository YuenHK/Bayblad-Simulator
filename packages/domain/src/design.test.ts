import { describe, expect, it } from "vitest";

import { designSchema, layerSchema, makeDefaultDesign } from "./design";

describe("designSchema", () => {
  it("accepts a valid three-layer default design", () => {
    const design = makeDefaultDesign();
    const parsed = designSchema.parse(design);

    expect(parsed.layers).toHaveLength(3);
    expect(parsed.layers.map((layer) => layer.position)).toEqual([
      "top",
      "middle",
      "bottom",
    ]);
    expect(parsed.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(parsed.layers.every((layer) => layerSchema.safeParse(layer).success)).toBe(true);
    expect(parsed.screwLayout).toEqual({
      count: 4,
      radiusMm: 18,
      rotationDeg: 0,
    });
    expect(parsed.metalDiscDiameterMm).toBe(0);
  });

  it("rejects a fourth layer", () => {
    const design = makeDefaultDesign();

    expect(() =>
      designSchema.parse({
        ...design,
        layers: [...design.layers, design.layers[0]],
      }),
    ).toThrow();
  });

  it("rejects layers in the wrong order", () => {
    const design = makeDefaultDesign();

    expect(
      designSchema.safeParse({
        ...design,
        layers: [design.layers[1], design.layers[0], design.layers[2]],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate layer positions", () => {
    const design = makeDefaultDesign();

    expect(
      designSchema.safeParse({
        ...design,
        layers: [
          design.layers[0],
          { ...design.layers[1], position: "top" },
          design.layers[2],
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate layer ids", () => {
    const design = makeDefaultDesign();

    expect(
      designSchema.safeParse({
        ...design,
        layers: [
          design.layers[0],
          { ...design.layers[1], id: design.layers[0].id },
          design.layers[2],
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    ["empty id", { id: "" }],
    ["unsupported position", { position: "centre" }],
    ["unsupported shape", { shape: "square" }],
    ["non-integer points", { points: 3.5 }],
    ["too few points", { points: 2 }],
    ["too many points", { points: 17 }],
    ["diameter below range", { diameterMm: 19.9 }],
    ["diameter above range", { diameterMm: 80.1 }],
    ["corner roundness below range", { cornerRoundness: -0.01 }],
    ["corner roundness above range", { cornerRoundness: 1.01 }],
    ["rotation below range", { rotationDeg: -1 }],
    ["rotation above range", { rotationDeg: 360 }],
    ["invalid colour", { color: "#12345g" }],
  ])("rejects a layer with %s", (_label, change) => {
    const layer = makeDefaultDesign().layers[0];

    expect(layerSchema.safeParse({ ...layer, ...change }).success).toBe(false);
  });

  it.each([
    ["empty id", { id: "" }],
    ["empty name", { name: "" }],
    ["whitespace-only name", { name: "   " }],
    ["name longer than 40 characters", { name: "x".repeat(41) }],
    ["too few screws", { screwLayout: { count: 2, radiusMm: 15, rotationDeg: 0 } }],
    ["non-integer screw count", { screwLayout: { count: 3.5, radiusMm: 15, rotationDeg: 0 } }],
    ["screw radius below range", { screwLayout: { count: 4, radiusMm: 4.9, rotationDeg: 0 } }],
    ["screw rotation above range", { screwLayout: { count: 4, radiusMm: 15, rotationDeg: 360 } }],
    ["metal disc below range", { metalDiscDiameterMm: 9.9 }],
    ["metal disc above range", { metalDiscDiameterMm: 55.1 }],
  ])("rejects a design with %s", (_label, change) => {
    expect(
      designSchema.safeParse({ ...makeDefaultDesign(), ...change }).success,
    ).toBe(false);
  });

  it.each([0, 10, 55])("accepts metal disc diameter %s", (metalDiscDiameterMm) => {
    expect(
      designSchema.safeParse({
        ...makeDefaultDesign(),
        metalDiscDiameterMm,
      }).success,
    ).toBe(true);
  });
});
