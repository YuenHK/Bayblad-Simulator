import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PERFORMANCE_MODEL_VERSION,
  calculateMassProperties,
  calculateMinimumMaterialNeckMm,
  derivePerformanceInput,
  makeDefaultDesign,
  predictDesignPerformance,
  predictPerformance,
  scoreStability,
  validateDesign,
  type PerformanceInput,
  type PerformancePrediction,
  type TopDesign,
} from ".";

type DesignFixture = Readonly<{
  name: string;
  diameterMm: number;
  screwCount: number;
  screwRadiusMm: number;
  roundness: number;
  metalDiscDiameterMm: number;
  expectedMassRange: readonly [number, number];
  expectedSpeedRange: readonly [number, number];
  expectedSpinDurationRange: readonly [number, number];
}>;

const calibrationFixtures: readonly DesignFixture[] = [
  {
    name: "compact sharp three-screw",
    diameterMm: 30,
    screwCount: 3,
    screwRadiusMm: 10,
    roundness: 0,
    metalDiscDiameterMm: 0,
    expectedMassRange: [13, 14],
    expectedSpeedRange: [85, 87],
    expectedSpinDurationRange: [17, 18],
  },
  {
    name: "compact rounded three-screw",
    diameterMm: 30,
    screwCount: 3,
    screwRadiusMm: 10,
    roundness: 1,
    metalDiscDiameterMm: 0,
    expectedMassRange: [13, 14],
    expectedSpeedRange: [95, 97],
    expectedSpinDurationRange: [27, 28],
  },
  {
    name: "small four-screw",
    diameterMm: 36,
    screwCount: 4,
    screwRadiusMm: 13,
    roundness: 0.25,
    metalDiscDiameterMm: 0,
    expectedMassRange: [19, 21],
    expectedSpeedRange: [81, 83],
    expectedSpinDurationRange: [22, 23],
  },
  {
    name: "balanced four-screw",
    diameterMm: 40,
    screwCount: 4,
    screwRadiusMm: 15,
    roundness: 0.5,
    metalDiscDiameterMm: 0,
    expectedMassRange: [24, 26],
    expectedSpeedRange: [78, 80],
    expectedSpinDurationRange: [27, 28],
  },
  {
    name: "balanced top with metal disc",
    diameterMm: 40,
    screwCount: 4,
    screwRadiusMm: 15,
    roundness: 0.5,
    metalDiscDiameterMm: 30,
    expectedMassRange: [30, 31],
    expectedSpeedRange: [72, 74],
    expectedSpinDurationRange: [28, 29],
  },
  {
    name: "medium five-screw",
    diameterMm: 44,
    screwCount: 5,
    screwRadiusMm: 17,
    roundness: 0.4,
    metalDiscDiameterMm: 0,
    expectedMassRange: [30, 31],
    expectedSpeedRange: [71, 73],
    expectedSpinDurationRange: [29, 31],
  },
  {
    name: "wide six-screw",
    diameterMm: 50,
    screwCount: 6,
    screwRadiusMm: 20,
    roundness: 0.6,
    metalDiscDiameterMm: 0,
    expectedMassRange: [39, 40],
    expectedSpeedRange: [64, 66],
    expectedSpinDurationRange: [38, 40],
  },
  {
    name: "wide top with metal disc",
    diameterMm: 50,
    screwCount: 6,
    screwRadiusMm: 20,
    roundness: 0.6,
    metalDiscDiameterMm: 40,
    expectedMassRange: [49, 50],
    expectedSpeedRange: [53, 55],
    expectedSpinDurationRange: [41, 42],
  },
  {
    name: "broad three-screw",
    diameterMm: 54,
    screwCount: 3,
    screwRadiusMm: 22,
    roundness: 0.3,
    metalDiscDiameterMm: 0,
    expectedMassRange: [47, 48],
    expectedSpeedRange: [53, 54],
    expectedSpinDurationRange: [42, 44],
  },
  {
    name: "large seven-screw",
    diameterMm: 56,
    screwCount: 7,
    screwRadiusMm: 23,
    roundness: 0.7,
    metalDiscDiameterMm: 0,
    expectedMassRange: [49, 50],
    expectedSpeedRange: [54, 56],
    expectedSpinDurationRange: [49, 51],
  },
  {
    name: "large eight-screw",
    diameterMm: 58,
    screwCount: 8,
    screwRadiusMm: 24,
    roundness: 0.8,
    metalDiscDiameterMm: 0,
    expectedMassRange: [53, 54],
    expectedSpeedRange: [51, 53],
    expectedSpinDurationRange: [54, 56],
  },
  {
    name: "maximum course circle",
    diameterMm: 60,
    screwCount: 8,
    screwRadiusMm: 25,
    roundness: 1,
    metalDiscDiameterMm: 0,
    expectedMassRange: [57, 58],
    expectedSpeedRange: [49, 51],
    expectedSpinDurationRange: [61, 63],
  },
];

function makeCalibrationDesign(fixture: DesignFixture): TopDesign {
  const design = makeDefaultDesign();
  return {
    ...design,
    name: fixture.name,
    layers: design.layers.map((layer) => ({
      ...layer,
      shape: "circle" as const,
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
        fixture.roundness,
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
      expectScoresInRange(prediction);
    },
  );

  it("preserves expected v1 ordering across physical design variants", () => {
    const predictions = calibrationFixtures.map((fixture) =>
      predictDesignPerformance(makeCalibrationDesign(fixture)),
    );
    const compactSharp = predictions[0]!;
    const compactRounded = predictions[1]!;
    const balanced = predictions[3]!;
    const balancedDisc = predictions[4]!;
    const maximum = predictions[11]!;

    expect(compactRounded.speed).toBeGreaterThan(compactSharp.speed);
    expect(compactRounded.spinDuration).toBeGreaterThan(
      compactSharp.spinDuration,
    );
    expect(compactRounded.impactResistance).toBeGreaterThan(
      compactSharp.impactResistance,
    );
    expect(balancedDisc.speed).toBeLessThan(balanced.speed);
    expect(balancedDisc.spinDuration).toBeGreaterThan(
      balanced.spinDuration,
    );
    expect(maximum.speed).toBeLessThan(compactRounded.speed);
    expect(maximum.spinDuration).toBeGreaterThan(
      compactRounded.spinDuration,
    );
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
