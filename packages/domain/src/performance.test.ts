import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PERFORMANCE_MODEL_VERSION,
  calculateMassProperties,
  calculateMinimumMaterialNeckMm,
  derivePerformanceInput,
  effectiveLayerRoundness,
  makeDefaultDesign,
  predictDesignPerformance,
  predictPerformance,
  scoreStability,
  validateDesign,
  type Layer,
  type PerformanceInput,
  type PerformancePrediction,
  type TopDesign,
} from ".";

type DesignFixture = Readonly<{
  name: string;
  shape: Layer["shape"] | "mixed";
  points: number;
  diameterMm: number;
  screwCount: number;
  screwRadiusMm: number;
  roundness: number;
  metalDiscDiameterMm: number;
  expectedEffectiveRoundness: number;
  expectedMassRange: readonly [number, number];
  expectedSpeedRange: readonly [number, number];
  expectedSpinDurationRange: readonly [number, number];
  expectedStabilityRange: readonly [number, number];
  expectedImpactRange: readonly [number, number];
}>;

const calibrationFixtures: readonly DesignFixture[] = [
  {
    name: "compact circle",
    shape: "circle",
    points: 6,
    diameterMm: 30,
    screwCount: 3,
    screwRadiusMm: 10,
    roundness: 0,
    metalDiscDiameterMm: 0,
    expectedEffectiveRoundness: 1,
    expectedMassRange: [13, 14],
    expectedSpeedRange: [95, 97],
    expectedSpinDurationRange: [27, 28],
    expectedStabilityRange: [74, 75],
    expectedImpactRange: [63, 65],
  },
  {
    name: "circle with thin neck",
    shape: "circle",
    points: 6,
    diameterMm: 40,
    screwCount: 4,
    screwRadiusMm: 16,
    roundness: 0.5,
    metalDiscDiameterMm: 0,
    expectedEffectiveRoundness: 1,
    expectedMassRange: [24, 26],
    expectedSpeedRange: [83, 85],
    expectedSpinDurationRange: [32, 33],
    expectedStabilityRange: [77, 78],
    expectedImpactRange: [50, 52],
  },
  {
    name: "circle with thick neck",
    shape: "circle",
    points: 6,
    diameterMm: 40,
    screwCount: 4,
    screwRadiusMm: 14,
    roundness: 1,
    metalDiscDiameterMm: 0,
    expectedEffectiveRoundness: 1,
    expectedMassRange: [24, 26],
    expectedSpeedRange: [83, 85],
    expectedSpinDurationRange: [32, 33],
    expectedStabilityRange: [77, 78],
    expectedImpactRange: [76, 78],
  },
  {
    name: "circle with central disc",
    shape: "circle",
    points: 6,
    diameterMm: 40,
    screwCount: 4,
    screwRadiusMm: 15,
    roundness: 0.2,
    metalDiscDiameterMm: 30,
    expectedEffectiveRoundness: 1,
    expectedMassRange: [30, 31],
    expectedSpeedRange: [77, 79],
    expectedSpinDurationRange: [33, 34],
    expectedStabilityRange: [76, 78],
    expectedImpactRange: [63, 65],
  },
  {
    name: "angular hexagon",
    shape: "polygon",
    points: 6,
    diameterMm: 45,
    screwCount: 4,
    screwRadiusMm: 15.8,
    roundness: 0.2,
    metalDiscDiameterMm: 0,
    expectedEffectiveRoundness: 0.2,
    expectedMassRange: [28, 29],
    expectedSpeedRange: [71, 73],
    expectedSpinDurationRange: [26, 27],
    expectedStabilityRange: [78, 79],
    expectedImpactRange: [41, 42],
  },
  {
    name: "rounded hexagon",
    shape: "polygon",
    points: 6,
    diameterMm: 45,
    screwCount: 4,
    screwRadiusMm: 16,
    roundness: 0.8,
    metalDiscDiameterMm: 0,
    expectedEffectiveRoundness: 0.8,
    expectedMassRange: [30, 31],
    expectedSpeedRange: [75, 77],
    expectedSpinDurationRange: [33, 34],
    expectedStabilityRange: [78, 79],
    expectedImpactRange: [67, 69],
  },
  {
    name: "rounded square",
    shape: "polygon",
    points: 4,
    diameterMm: 44,
    screwCount: 4,
    screwRadiusMm: 11,
    roundness: 0.6,
    metalDiscDiameterMm: 0,
    expectedEffectiveRoundness: 0.6,
    expectedMassRange: [25, 27],
    expectedSpeedRange: [78, 80],
    expectedSpinDurationRange: [29, 30],
    expectedStabilityRange: [77, 79],
    expectedImpactRange: [93, 95],
  },
  {
    name: "rounded six-point star",
    shape: "star",
    points: 6,
    diameterMm: 50,
    screwCount: 4,
    screwRadiusMm: 10,
    roundness: 0.6,
    metalDiscDiameterMm: 0,
    expectedEffectiveRoundness: 0.6,
    expectedMassRange: [26, 28],
    expectedSpeedRange: [77, 79],
    expectedSpinDurationRange: [30, 31],
    expectedStabilityRange: [78, 79],
    expectedImpactRange: [80, 82],
  },
  {
    name: "rounded eight-point star",
    shape: "star",
    points: 8,
    diameterMm: 55,
    screwCount: 4,
    screwRadiusMm: 15,
    roundness: 0.8,
    metalDiscDiameterMm: 0,
    expectedEffectiveRoundness: 0.8,
    expectedMassRange: [35, 37],
    expectedSpeedRange: [69, 71],
    expectedSpinDurationRange: [38, 39],
    expectedStabilityRange: [80, 81],
    expectedImpactRange: [99, 100],
  },
  {
    name: "angular six-lobe wave",
    shape: "wave",
    points: 6,
    diameterMm: 44,
    screwCount: 4,
    screwRadiusMm: 16,
    roundness: 0.2,
    metalDiscDiameterMm: 0,
    expectedEffectiveRoundness: 0.2,
    expectedMassRange: [27, 28],
    expectedSpeedRange: [72, 74],
    expectedSpinDurationRange: [25, 27],
    expectedStabilityRange: [78, 79],
    expectedImpactRange: [39, 40],
  },
  {
    name: "rounded eight-lobe wave",
    shape: "wave",
    points: 8,
    diameterMm: 52,
    screwCount: 4,
    screwRadiusMm: 20,
    roundness: 0.8,
    metalDiscDiameterMm: 0,
    expectedEffectiveRoundness: 0.8,
    expectedMassRange: [40, 41],
    expectedSpeedRange: [65, 66],
    expectedSpinDurationRange: [41, 42],
    expectedStabilityRange: [80, 81],
    expectedImpactRange: [73, 74],
  },
  {
    name: "mixed top with central disc",
    shape: "mixed",
    points: 6,
    diameterMm: 52,
    screwCount: 4,
    screwRadiusMm: 15,
    roundness: 0.7,
    metalDiscDiameterMm: 30,
    expectedEffectiveRoundness: 0.8,
    expectedMassRange: [47, 48],
    expectedSpeedRange: [58, 59],
    expectedSpinDurationRange: [43, 44],
    expectedStabilityRange: [80, 81],
    expectedImpactRange: [99, 100],
  },
];

function makeCalibrationDesign(fixture: DesignFixture): TopDesign {
  const design = makeDefaultDesign();
  const shapes: readonly Layer["shape"][] =
    fixture.shape === "mixed"
      ? ["circle", "polygon", "wave"]
      : [fixture.shape, fixture.shape, fixture.shape];
  return {
    ...design,
    name: fixture.name,
    layers: design.layers.map((layer, index) => ({
      ...layer,
      shape: shapes[index]!,
      points: fixture.points,
      diameterMm: fixture.diameterMm,
      cornerRoundness: fixture.roundness,
    })) as TopDesign["layers"],
    screwLayout: {
      count: fixture.screwCount,
      radiusMm: fixture.screwRadiusMm,
      rotationDeg: 0,
    },
    metalDiscDiameterMm: fixture.metalDiscDiameterMm,
  };
}

function expectScoresInRange(prediction: PerformancePrediction): void {
  for (const score of [
    prediction.speed,
    prediction.spinDuration,
    prediction.stability,
    prediction.impactResistance,
  ]) {
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  }
}

describe("performance model contract", () => {
  it("exposes readonly input and prediction fields with model version 1.0.0", () => {
    expect(PERFORMANCE_MODEL_VERSION).toBe("1.0.0");
    expectTypeOf<PerformanceInput>().toEqualTypeOf<
      Readonly<{
        totalMassG: number;
        polarMomentGmm2: number;
        averageCornerRoundness: number;
        minNeckThicknessMm: number;
        centerOfMassOffsetMm: number;
      }>
    >();
    expectTypeOf<PerformancePrediction>().toEqualTypeOf<
      Readonly<{
        speed: number;
        spinDuration: number;
        stability: number;
        impactResistance: number;
        modelVersion: "1.0.0";
      }>
    >();
  });

  it("canonicalises the ineffective circle roundness without changing predictions", () => {
    const rawSquareCorner = makeCalibrationDesign(calibrationFixtures[3]!);
    const rawRoundCorner = structuredClone(rawSquareCorner);
    rawSquareCorner.layers = rawSquareCorner.layers.map((layer) => ({
      ...layer,
      cornerRoundness: 0,
    })) as TopDesign["layers"];
    rawRoundCorner.layers = rawRoundCorner.layers.map((layer) => ({
      ...layer,
      cornerRoundness: 1,
    })) as TopDesign["layers"];

    expect(effectiveLayerRoundness(rawSquareCorner.layers[0])).toBe(1);
    expect(derivePerformanceInput(rawSquareCorner)).toEqual(
      derivePerformanceInput(rawRoundCorner),
    );
    expect(predictDesignPerformance(rawSquareCorner)).toEqual(
      predictDesignPerformance(rawRoundCorner),
    );
  });

  it.each(calibrationFixtures)(
    "calibrates a real valid design: $name",
    (fixture) => {
      const design = makeCalibrationDesign(fixture);
      const validation = validateDesign(design);
      const input = derivePerformanceInput(design);
      const prediction = predictDesignPerformance(design);

      expect(validation.valid).toBe(true);
      expect(input.totalMassG).toBeGreaterThanOrEqual(
        fixture.expectedMassRange[0],
      );
      expect(input.totalMassG).toBeLessThanOrEqual(
        fixture.expectedMassRange[1],
      );
      expect(input.polarMomentGmm2).toBeGreaterThan(0);
      expect(input.minNeckThicknessMm).toBeGreaterThanOrEqual(2);
      expect(input.averageCornerRoundness).toBeCloseTo(
        fixture.expectedEffectiveRoundness,
        12,
      );
      expect(prediction.modelVersion).toBe("1.0.0");
      expect(prediction.speed).toBeGreaterThanOrEqual(
        fixture.expectedSpeedRange[0],
      );
      expect(prediction.speed).toBeLessThanOrEqual(
        fixture.expectedSpeedRange[1],
      );
      expect(prediction.spinDuration).toBeGreaterThanOrEqual(
        fixture.expectedSpinDurationRange[0],
      );
      expect(prediction.spinDuration).toBeLessThanOrEqual(
        fixture.expectedSpinDurationRange[1],
      );
      expect(prediction.stability).toBeGreaterThanOrEqual(
        fixture.expectedStabilityRange[0],
      );
      expect(prediction.stability).toBeLessThanOrEqual(
        fixture.expectedStabilityRange[1],
      );
      expect(prediction.impactResistance).toBeGreaterThanOrEqual(
        fixture.expectedImpactRange[0],
      );
      expect(prediction.impactResistance).toBeLessThanOrEqual(
        fixture.expectedImpactRange[1],
      );
      expectScoresInRange(prediction);
    },
  );

  it("preserves expected v1 ordering across physical design variants", () => {
    const predictions = calibrationFixtures.map((fixture) =>
      predictDesignPerformance(makeCalibrationDesign(fixture)),
    );
    const compactCircle = predictions[0]!;
    const thinNeckCircle = predictions[1]!;
    const thickNeckCircle = predictions[2]!;
    const centralDiscCircle = predictions[3]!;
    const angularHexagon = predictions[4]!;
    const roundedHexagon = predictions[5]!;
    const roundedStar = predictions[8]!;

    expect(roundedHexagon.speed).toBeGreaterThan(angularHexagon.speed);
    expect(roundedHexagon.spinDuration).toBeGreaterThan(
      angularHexagon.spinDuration,
    );
    expect(roundedHexagon.impactResistance).toBeGreaterThan(
      angularHexagon.impactResistance,
    );
    expect(thickNeckCircle.impactResistance).toBeGreaterThan(
      thinNeckCircle.impactResistance,
    );
    expect(centralDiscCircle.speed).toBeLessThan(thinNeckCircle.speed);
    expect(centralDiscCircle.spinDuration).toBeGreaterThan(
      thinNeckCircle.spinDuration,
    );
    expect(roundedStar.stability).toBeGreaterThan(compactCircle.stability);
  });

  it("derives every calculated value from authoritative domain helpers", () => {
    const design = makeCalibrationDesign(calibrationFixtures[6]!);
    const mass = calculateMassProperties(design);
    const input = derivePerformanceInput(design);

    expect(input.totalMassG).toBeCloseTo(mass.totalMassG, 12);
    expect(input.polarMomentGmm2).toBeCloseTo(mass.polarMomentGmm2, 12);
    expect(input.centerOfMassOffsetMm).toBeCloseTo(
      Math.hypot(mass.centerOfMassMm.x, mass.centerOfMassMm.y),
      12,
    );
    expect(input.averageCornerRoundness).toBeCloseTo(0.6, 12);
    expect(input.minNeckThicknessMm).toBeCloseTo(
      calculateMinimumMaterialNeckMm(design),
      12,
    );
  });

  it("predicts a schema-valid course-invalid draft with negative neck clamped to zero", () => {
    const design = makeCalibrationDesign(calibrationFixtures[3]!);
    design.screwLayout.radiusMm = 18.5;
    const before = structuredClone(design);

    expect(validateDesign(design).valid).toBe(false);
    expect(calculateMinimumMaterialNeckMm(design)).toBeLessThan(0);
    expect(derivePerformanceInput(design).minNeckThicknessMm).toBe(0);
    expectScoresInRange(predictDesignPerformance(design));
    expect(design).toEqual(before);
  });

  it("is deterministic and does not mutate the design", () => {
    const design = makeCalibrationDesign(calibrationFixtures[7]!);
    const before = structuredClone(design);

    const first = predictDesignPerformance(design);
    const second = predictDesignPerformance(design);

    expect(first).toEqual(second);
    expect(design).toEqual(before);
  });
});

describe("raw calculated performance input", () => {
  const baseline: PerformanceInput = {
    totalMassG: 35,
    polarMomentGmm2: 25_000,
    averageCornerRoundness: 0.5,
    minNeckThicknessMm: 3,
    centerOfMassOffsetMm: 0.5,
  };

  it("remains deterministic and does not mutate a trusted calculated input", () => {
    const input = Object.freeze({ ...baseline });
    const before = structuredClone(input);

    expect(predictPerformance(input)).toEqual(predictPerformance(input));
    expect(input).toEqual(before);
  });

  it("raises spin duration when the same mass moves outward", () => {
    const compact = predictPerformance({
      ...baseline,
      polarMomentGmm2: 20_000,
    });
    const rimWeighted = predictPerformance({
      ...baseline,
      polarMomentGmm2: 40_000,
    });

    expect(rimWeighted.spinDuration).toBeGreaterThan(compact.spinDuration);
  });

  it("lowers stability as centre-of-mass offset grows", () => {
    expect(
      predictPerformance({ ...baseline, centerOfMassOffsetMm: 0 }).stability,
    ).toBeGreaterThan(
      predictPerformance({ ...baseline, centerOfMassOffsetMm: 2 }).stability,
    );
  });

  it("raises stability when the same mass has a larger radius of gyration", () => {
    const compact = predictPerformance({
      ...baseline,
      centerOfMassOffsetMm: 0,
      polarMomentGmm2: 15_000,
    });
    const rimWeighted = predictPerformance({
      ...baseline,
      centerOfMassOffsetMm: 0,
      polarMomentGmm2: 45_000,
    });

    expect(rimWeighted.stability).toBeGreaterThan(compact.stability);
  });

  it("never lowers impact resistance when the minimum neck thickens", () => {
    const scores = [0, 1, 2, 4, 8, 20].map(
      (minNeckThicknessMm) =>
        predictPerformance({ ...baseline, minNeckThicknessMm })
          .impactResistance,
    );

    expect(scores).toEqual([...scores].sort((left, right) => left - right));
  });

  it("never raises speed when only total mass increases", () => {
    const scores = [20, 35, 50, 80].map(
      (totalMassG) => predictPerformance({ ...baseline, totalMassG }).speed,
    );

    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
    "rejects invalid total mass: %s",
    (totalMassG) => {
      expect(() => predictPerformance({ ...baseline, totalMassG })).toThrow(
        RangeError,
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
    "rejects invalid polar moment: %s",
    (polarMomentGmm2) => {
      expect(() =>
        predictPerformance({ ...baseline, polarMomentGmm2 }),
      ).toThrow(RangeError);
    },
  );

  it.each([
    "minNeckThicknessMm",
    "centerOfMassOffsetMm",
  ] as const)("rejects non-finite or negative %s", (field) => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      expect(() => predictPerformance({ ...baseline, [field]: value })).toThrow(
        RangeError,
      );
    }
  });

  it("rejects a polar moment above the schema-radius physical bound", () => {
    expect(() =>
      predictPerformance({
        ...baseline,
        totalMassG: 1,
        polarMomentGmm2: Number.MAX_VALUE,
      }),
    ).toThrow(RangeError);
    expect(() =>
      predictPerformance({
        ...baseline,
        totalMassG: 1,
        polarMomentGmm2: 1_601,
      }),
    ).toThrow(RangeError);
  });

  it.each([
    ["centerOfMassOffsetMm", 40.01],
    ["minNeckThicknessMm", 80.01],
  ] as const)("rejects canonical bound overflow for %s", (field, value) => {
    expect(() => predictPerformance({ ...baseline, [field]: value })).toThrow(
      RangeError,
    );
  });

  it.each([Number.NaN, Number.NEGATIVE_INFINITY, -0.01, 1.01])(
    "rejects invalid average corner roundness: %s",
    (averageCornerRoundness) => {
      expect(() =>
        predictPerformance({ ...baseline, averageCornerRoundness }),
      ).toThrow(RangeError);
    },
  );
});

describe("scoreStability", () => {
  it("scores zero offset higher than two millimetres", () => {
    expect(scoreStability({ offsetMm: 0 })).toBeGreaterThan(
      scoreStability({ offsetMm: 2 }),
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
    "rejects an invalid offset: %s",
    (offsetMm) => {
      expect(() => scoreStability({ offsetMm })).toThrow(RangeError);
    },
  );
});
