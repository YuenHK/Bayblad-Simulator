import { describe, expect, it } from "vitest";

import { makeDefaultDesign } from "./design";
import {
  ASSEMBLY,
  CIRCLE_LAYER_SEGMENTS,
  CUTOUT_CIRCLE_SEGMENTS,
  MATERIALS,
  calculateMassProperties,
  calculatePerforatedLayerMassProperties,
  makeMassLayerVertices,
} from "./mass";

describe("mass constants", () => {
  it("uses the approved material properties", () => {
    expect(MATERIALS).toEqual({
      acrylicDensityGPerMm3: 0.00118,
      layerThicknessMm: 6,
      metalDensityGPerMm3: 0.00785,
      metalDiscThicknessMm: 1,
    });
  });

  it("bounds the partial-circle approximation area error below 0.02%", () => {
    const relativeArea =
      (CUTOUT_CIRCLE_SEGMENTS *
        Math.sin((Math.PI * 2) / CUTOUT_CIRCLE_SEGMENTS)) /
      (Math.PI * 2);

    expect(CUTOUT_CIRCLE_SEGMENTS).toBeGreaterThanOrEqual(192);
    expect(1 - relativeArea).toBeLessThan(0.0002);
  });
});

describe("calculatePerforatedLayerMassProperties", () => {
  it("keeps an unperforated canonical circle within 0.002% analytic area", () => {
    const layer = {
      ...makeDefaultDesign().layers[0],
      shape: "circle" as const,
      diameterMm: 40,
    };
    const result = calculatePerforatedLayerMassProperties(
      makeMassLayerVertices(layer),
      [],
      1,
      1,
    );

    expect(Math.abs(result.totalMassG - Math.PI * 20 ** 2) / (Math.PI * 20 ** 2)).toBeLessThan(
      0.00002,
    );
  });

  it("uses the centroid and parallel-axis theorem for an asymmetric plate", () => {
    const result = calculatePerforatedLayerMassProperties(
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 0, y: 3 },
      ],
      [{ center: { x: 1, y: 1 }, radiusMm: 0.25 }],
      1,
      1,
    );
    const holeArea = Math.PI * 0.25 ** 2;
    const expectedMass = 6 - holeArea;
    const expectedCenter = {
      x: (8 - holeArea) / expectedMass,
      y: (6 - holeArea) / expectedMass,
    };
    const holePolarAtOrigin =
      (Math.PI * 0.25 ** 4) / 2 + holeArea * (1 ** 2 + 1 ** 2);
    const expectedPolarAtCenter =
      25 -
      holePolarAtOrigin -
      expectedMass * (expectedCenter.x ** 2 + expectedCenter.y ** 2);

    expect(result.totalMassG).toBeCloseTo(expectedMass, 10);
    expect(result.centerOfMassMm.x).toBeCloseTo(expectedCenter.x, 10);
    expect(result.centerOfMassMm.y).toBeCloseTo(expectedCenter.y, 10);
    expect(result.polarMomentGmm2).toBeCloseTo(expectedPolarAtCenter, 10);
  });

  it("fails clearly for degenerate or over-perforated geometry", () => {
    expect(() =>
      calculatePerforatedLayerMassProperties(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ],
        [],
        1,
        1,
      ),
    ).toThrow(/geometry/i);

    expect(() =>
      calculatePerforatedLayerMassProperties(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
        [{ center: { x: 0, y: 0 }, radiusMm: 10 }],
        1,
        1,
      ),
    ).toThrow(/geometry/i);
  });

  it("deducts only the portion of a circular cutout inside the layer", () => {
    const square = [
      { x: -10, y: -10 },
      { x: 10, y: -10 },
      { x: 10, y: 10 },
      { x: -10, y: 10 },
    ];
    const result = calculatePerforatedLayerMassProperties(
      square,
      [{ center: { x: 10, y: 0 }, radiusMm: 2 }],
      1,
      1,
    );
    const removedArea = 400 - result.totalMassG;
    const remainingPolarAtOrigin =
      result.polarMomentGmm2 +
      result.totalMassG *
        (result.centerOfMassMm.x ** 2 + result.centerOfMassMm.y ** 2);
    const removedPolarAtOrigin = 80_000 / 3 - remainingPolarAtOrigin;
    const fullCirclePolarAtOrigin = Math.PI * 2 ** 4 / 2 + Math.PI * 2 ** 2 * 10 ** 2;

    expect(removedArea).toBeGreaterThan(0);
    expect(removedArea).toBeLessThan(Math.PI * 2 ** 2);
    expect(removedArea).toBeCloseTo(Math.PI * 2 ** 2 / 2, 2);
    expect(removedPolarAtOrigin).toBeGreaterThan(0);
    expect(removedPolarAtOrigin).toBeLessThan(fullCirclePolarAtOrigin);
  });

  it("does not deduct overlapping circular cutouts twice", () => {
    const square = [
      { x: -10, y: -10 },
      { x: 10, y: -10 },
      { x: 10, y: 10 },
      { x: -10, y: 10 },
    ];
    const cutout = { center: { x: 0, y: 0 }, radiusMm: 2 };

    const duplicated = calculatePerforatedLayerMassProperties(
      square,
      [cutout, cutout],
      1,
      1,
    );
    const single = calculatePerforatedLayerMassProperties(
      square,
      [cutout],
      1,
      1,
    );

    expect(duplicated.totalMassG).toBeCloseTo(single.totalMassG, 3);
    expect(duplicated.centerOfMassMm.x).toBeCloseTo(
      single.centerOfMassMm.x,
      10,
    );
    expect(duplicated.centerOfMassMm.y).toBeCloseTo(
      single.centerOfMassMm.y,
      10,
    );
    expect(duplicated.polarMomentGmm2).toBeCloseTo(
      single.polarMomentGmm2,
      2,
    );
  });
});

describe("calculateMassProperties", () => {
  it("keeps canonical circle-layer mass within 0.01% of the analytic circle", () => {
    const design = makeDefaultDesign();
    design.layers = design.layers.map((layer) => ({
      ...layer,
      shape: "circle",
      diameterMm: 40,
    })) as typeof design.layers;
    design.screwLayout = { count: 4, radiusMm: 18, rotationDeg: 0 };
    const expectedLayerAreaMm2 =
      Math.PI * 20 ** 2 -
      Math.PI * ASSEMBLY.axleHoleRadiusMm ** 2 -
      4 * Math.PI * ASSEMBLY.screwHoleRadiusMm ** 2;
    const result = calculateMassProperties(design);
    const expectedMassG =
      expectedLayerAreaMm2 *
      MATERIALS.layerThicknessMm *
      MATERIALS.acrylicDensityGPerMm3 *
      3;

    expect(
      Math.abs(result.totalMassG - expectedMassG) / expectedMassG,
    ).toBeLessThan(
      0.0001,
    );
  });

  it("adds an unperforated solid metal disc", () => {
    const withoutDisc = makeDefaultDesign();
    const withDisc = { ...withoutDisc, metalDiscDiameterMm: 30 };
    const base = calculateMassProperties(withoutDisc);
    const result = calculateMassProperties(withDisc);
    const radiusMm = 15;
    const expectedDiscMass =
      Math.PI * radiusMm ** 2 *
      MATERIALS.metalDiscThicknessMm *
      MATERIALS.metalDensityGPerMm3;
    const expectedDiscPolar = expectedDiscMass * radiusMm ** 2 / 2;

    expect(result.totalMassG - base.totalMassG).toBeCloseTo(expectedDiscMass, 10);
    expect(result.polarMomentGmm2 - base.polarMomentGmm2).toBeCloseTo(
      expectedDiscPolar,
      8,
    );
  });

  it("deducts every screw hole from all three acrylic layers, not the metal disc", () => {
    const threeScrews = {
      ...makeDefaultDesign(),
      metalDiscDiameterMm: 30,
      screwLayout: { count: 3, radiusMm: 15, rotationDeg: 0 },
    };
    const fourScrews = {
      ...threeScrews,
      screwLayout: { ...threeScrews.screwLayout, count: 4 },
    };
    const three = calculateMassProperties(threeScrews);
    const four = calculateMassProperties(fourScrews);
    const circleLayerHoleAreaMm2 =
      (CIRCLE_LAYER_SEGMENTS *
        Math.sin((Math.PI * 2) / CIRCLE_LAYER_SEGMENTS) *
        ASSEMBLY.screwHoleRadiusMm ** 2) /
      2;
    const oneHoleAcrossThreeLayers =
      (Math.PI * ASSEMBLY.screwHoleRadiusMm ** 2 +
        2 * circleLayerHoleAreaMm2) *
      MATERIALS.layerThicknessMm *
      MATERIALS.acrylicDensityGPerMm3;

    expect(three.totalMassG - four.totalMassG).toBeCloseTo(
      oneHoleAcrossThreeLayers,
      10,
    );
  });

  it("returns only finite non-negative values without mutating the input", () => {
    const design = {
      ...makeDefaultDesign(),
      metalDiscDiameterMm: 20,
      layers: makeDefaultDesign().layers.map((layer, index) => ({
        ...layer,
        shape: index === 1 ? ("star" as const) : layer.shape,
        rotationDeg: index * 17,
      })) as ReturnType<typeof makeDefaultDesign>["layers"],
    };
    const before = structuredClone(design);
    const result = calculateMassProperties(design);
    const numbers = [
      result.totalMassG,
      result.centerOfMassMm.x,
      result.centerOfMassMm.y,
      result.polarMomentGmm2,
    ];

    expect(numbers.every(Number.isFinite)).toBe(true);
    expect(result.totalMassG).toBeGreaterThanOrEqual(0);
    expect(result.polarMomentGmm2).toBeGreaterThanOrEqual(0);
    expect(design).toEqual(before);
  });

  it("changes continuously when screw holes cross a layer boundary", () => {
    const makeBoundaryDesign = (radiusMm: number) => {
      const design = makeDefaultDesign();
      return {
        ...design,
        layers: design.layers.map((layer) => ({
          ...layer,
          shape: "circle" as const,
          diameterMm: 40,
        })) as typeof design.layers,
        screwLayout: { count: 4, radiusMm, rotationDeg: 0 },
        metalDiscDiameterMm: 0,
      };
    };
    const fullFitBoundaryMm = 20 - ASSEMBLY.screwHoleRadiusMm;
    const justInside = calculateMassProperties(
      makeBoundaryDesign(fullFitBoundaryMm - 0.0005),
    );
    const justOutside = calculateMassProperties(
      makeBoundaryDesign(fullFitBoundaryMm + 0.0005),
    );

    expect(Math.abs(justOutside.totalMassG - justInside.totalMassG)).toBeLessThan(
      0.001,
    );
    expect(
      Math.abs(
        justOutside.polarMomentGmm2 - justInside.polarMomentGmm2,
      ),
    ).toBeLessThan(1);
  });

  it("has no mass jump across the analytic 18 mm circle boundary", () => {
    const makeBoundaryDesign = (radiusMm: number) => {
      const design = makeDefaultDesign();
      design.layers = design.layers.map((layer) => ({
        ...layer,
        shape: "circle",
        diameterMm: 40,
      })) as typeof design.layers;
      design.screwLayout = { count: 4, radiusMm, rotationDeg: 0 };
      return design;
    };
    const inside = calculateMassProperties(makeBoundaryDesign(17.999999));
    const outside = calculateMassProperties(makeBoundaryDesign(18.000001));

    expect(Math.abs(outside.totalMassG - inside.totalMassG)).toBeLessThan(
      0.00002,
    );
    expect(
      Math.abs(outside.polarMomentGmm2 - inside.polarMomentGmm2),
    ).toBeLessThan(0.01);
  });
});
