import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PERFORMANCE_MODEL_VERSION,
  predictPerformance,
  scoreStability,
  type PerformanceInput,
  type PerformancePrediction,
} from ".";

type CalibrationFixture = Readonly<{
  name: string;
  input: PerformanceInput;
  expected: Omit<PerformancePrediction, "modelVersion">;
}>;

const calibrationFixtures: readonly CalibrationFixture[] = [
  {
    name: "light compact beginner top",
    input: {
      totalMassG: 10,
      polarMomentGmm2: 5_000,
      averageCornerRoundness: 0.2,
      minNeckThicknessMm: 2,
      centerOfMassOffsetMm: 0.1,
    },
    expected: {
      speed: 91.5,
      spinDuration: 24.142857142857142,
      stability: 98.2,
      impactResistance: 39,
    },
  },
  {
    name: "light rim-weighted top",
    input: {
      totalMassG: 10,
      polarMomentGmm2: 15_000,
      averageCornerRoundness: 0.2,
      minNeckThicknessMm: 2,
      centerOfMassOffsetMm: 0.1,
    },
    expected: {
      speed: 91.5,
      spinDuration: 38.42857142857143,
      stability: 98.2,
      impactResistance: 39,
    },
  },
  {
    name: "medium balanced top",
    input: {
      totalMassG: 35,
      polarMomentGmm2: 25_000,
      averageCornerRoundness: 0.5,
      minNeckThicknessMm: 3,
      centerOfMassOffsetMm: 0.5,
    },
    expected: {
      speed: 68.25,
      spinDuration: 55.714285714285715,
      stability: 91,
      impactResistance: 56.5,
    },
  },
  {
    name: "medium fully rounded top",
    input: {
      totalMassG: 35,
      polarMomentGmm2: 25_000,
      averageCornerRoundness: 1,
      minNeckThicknessMm: 3,
      centerOfMassOffsetMm: 0.5,
    },
    expected: {
      speed: 73.25,
      spinDuration: 60.714285714285715,
      stability: 91,
      impactResistance: 64,
    },
  },
  {
    name: "medium sharp-cornered top",
    input: {
      totalMassG: 35,
      polarMomentGmm2: 25_000,
      averageCornerRoundness: 0,
      minNeckThicknessMm: 3,
      centerOfMassOffsetMm: 0.5,
    },
    expected: {
      speed: 63.25,
      spinDuration: 50.714285714285715,
      stability: 91,
      impactResistance: 49,
    },
  },
  {
    name: "medium thin-neck top",
    input: {
      totalMassG: 35,
      polarMomentGmm2: 25_000,
      averageCornerRoundness: 0.5,
      minNeckThicknessMm: 1,
      centerOfMassOffsetMm: 0.5,
    },
    expected: {
      speed: 68.25,
      spinDuration: 55.714285714285715,
      stability: 91,
      impactResistance: 30.5,
    },
  },
  {
    name: "medium thick-neck top",
    input: {
      totalMassG: 35,
      polarMomentGmm2: 25_000,
      averageCornerRoundness: 0.5,
      minNeckThicknessMm: 6,
      centerOfMassOffsetMm: 0.5,
    },
    expected: {
      speed: 68.25,
      spinDuration: 55.714285714285715,
      stability: 91,
      impactResistance: 95.5,
    },
  },
  {
    name: "perfectly centred top",
    input: {
      totalMassG: 35,
      polarMomentGmm2: 25_000,
      averageCornerRoundness: 0.5,
      minNeckThicknessMm: 3,
      centerOfMassOffsetMm: 0,
    },
    expected: {
      speed: 68.25,
      spinDuration: 55.714285714285715,
      stability: 100,
      impactResistance: 56.5,
    },
  },
  {
    name: "two-millimetre offset top",
    input: {
      totalMassG: 35,
      polarMomentGmm2: 25_000,
      averageCornerRoundness: 0.5,
      minNeckThicknessMm: 3,
      centerOfMassOffsetMm: 2,
    },
    expected: {
      speed: 68.25,
      spinDuration: 55.714285714285715,
      stability: 64,
      impactResistance: 56.5,
    },
  },
  {
    name: "heavy high-inertia top",
    input: {
      totalMassG: 80,
      polarMomentGmm2: 60_000,
      averageCornerRoundness: 0.5,
      minNeckThicknessMm: 4,
      centerOfMassOffsetMm: 1,
    },
    expected: {
      speed: 21,
      spinDuration: 100,
      stability: 82,
      impactResistance: 69.5,
    },
  },
  {
    name: "high-inertia rounded top",
    input: {
      totalMassG: 50,
      polarMomentGmm2: 100_000,
      averageCornerRoundness: 0.8,
      minNeckThicknessMm: 4,
      centerOfMassOffsetMm: 0.25,
    },
    expected: {
      speed: 55.5,
      spinDuration: 100,
      stability: 95.5,
      impactResistance: 74,
    },
  },
  {
    name: "extreme input clamped to score limits",
    input: {
      totalMassG: 1_000,
      polarMomentGmm2: 1_000_000_000,
      averageCornerRoundness: 1,
      minNeckThicknessMm: 100,
      centerOfMassOffsetMm: 100,
    },
    expected: {
      speed: 0,
      spinDuration: 100,
      stability: 0,
      impactResistance: 100,
    },
  },
];

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

  it.each(calibrationFixtures)("locks v1 calibration: $name", ({ input, expected }) => {
    const result = predictPerformance(input);

    expect(result.speed).toBeCloseTo(expected.speed, 10);
    expect(result.spinDuration).toBeCloseTo(expected.spinDuration, 10);
    expect(result.stability).toBeCloseTo(expected.stability, 10);
    expect(result.impactResistance).toBeCloseTo(
      expected.impactResistance,
      10,
    );
    expect(result.modelVersion).toBe("1.0.0");
  });

  it.each(calibrationFixtures)("returns finite 0..100 scores: $name", ({ input }) => {
    const { modelVersion: _modelVersion, ...scores } = predictPerformance(input);

    for (const score of Object.values(scores)) {
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it("is deterministic and does not mutate its input", () => {
    const input = Object.freeze({ ...calibrationFixtures[2]!.input });
    const before = structuredClone(input);

    const first = predictPerformance(input);
    const second = predictPerformance(input);

    expect(first).toEqual(second);
    expect(input).toEqual(before);
  });
});

describe("performance model monotonicity", () => {
  const baseline: PerformanceInput = {
    totalMassG: 40,
    polarMomentGmm2: 30_000,
    averageCornerRoundness: 0.5,
    minNeckThicknessMm: 3,
    centerOfMassOffsetMm: 0.5,
  };

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
    const centred = predictPerformance({
      ...baseline,
      centerOfMassOffsetMm: 0,
    });
    const offset = predictPerformance({
      ...baseline,
      centerOfMassOffsetMm: 2,
    });

    expect(centred.stability).toBeGreaterThan(offset.stability);
  });

  it("never lowers impact resistance when the minimum neck thickens", () => {
    const thicknesses = [0, 1, 2, 4, 8, 20];
    const scores = thicknesses.map(
      (minNeckThicknessMm) =>
        predictPerformance({ ...baseline, minNeckThicknessMm })
          .impactResistance,
    );

    expect(scores).toEqual([...scores].sort((left, right) => left - right));
  });

  it("never raises speed when only total mass increases in a reasonable range", () => {
    const masses = [5, 10, 20, 35, 50, 80, 100];
    const scores = masses.map(
      (totalMassG) => predictPerformance({ ...baseline, totalMassG }).speed,
    );

    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });
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

describe("performance input validation", () => {
  const validInput = calibrationFixtures[2]!.input;

  it.each([
    "totalMassG",
    "polarMomentGmm2",
    "minNeckThicknessMm",
    "centerOfMassOffsetMm",
  ] as const)("rejects non-finite or negative %s", (field) => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      expect(() =>
        predictPerformance({ ...validInput, [field]: invalid }),
      ).toThrow(RangeError);
    }
  });

  it.each([Number.NaN, Number.NEGATIVE_INFINITY, -0.01, 1.01])(
    "rejects invalid average corner roundness: %s",
    (averageCornerRoundness) => {
      expect(() =>
        predictPerformance({ ...validInput, averageCornerRoundness }),
      ).toThrow(RangeError);
    },
  );
});
