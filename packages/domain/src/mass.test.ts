import { describe, expect, it } from "vitest";

import { makeDefaultDesign } from "./design";
import {
  ASSEMBLY,
  MATERIALS,
  calculateMassProperties,
  calculatePerforatedLayerMassProperties,
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
});

describe("calculatePerforatedLayerMassProperties", () => {
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
});

describe("calculateMassProperties", () => {
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
    const oneHoleAcrossThreeLayers =
      Math.PI * ASSEMBLY.screwHoleRadiusMm ** 2 *
      MATERIALS.layerThicknessMm *
      MATERIALS.acrylicDensityGPerMm3 *
      3;

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
});
