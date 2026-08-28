export const PERFORMANCE_MODEL_VERSION = "1.0.0" as const;

/**
 * Pre-calculated physical properties consumed by the relative performance
 * model. Shape and design parameters intentionally stay outside this API.
 */
export type PerformanceInput = Readonly<{
  totalMassG: number;
  polarMomentGmm2: number;
  averageCornerRoundness: number;
  minNeckThicknessMm: number;
  centerOfMassOffsetMm: number;
}>;

export type PerformancePrediction = Readonly<{
  speed: number;
  spinDuration: number;
  stability: number;
  impactResistance: number;
  modelVersion: typeof PERFORMANCE_MODEL_VERSION;
}>;

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative`);
  }
}

function validateInput(input: PerformanceInput): void {
  assertFiniteNonNegative(input.totalMassG, "totalMassG");
  assertFiniteNonNegative(input.polarMomentGmm2, "polarMomentGmm2");
  assertFiniteNonNegative(input.minNeckThicknessMm, "minNeckThicknessMm");
  assertFiniteNonNegative(
    input.centerOfMassOffsetMm,
    "centerOfMassOffsetMm",
  );
  if (
    !Number.isFinite(input.averageCornerRoundness) ||
    input.averageCornerRoundness < 0 ||
    input.averageCornerRoundness > 1
  ) {
    throw new RangeError(
      "averageCornerRoundness must be finite and between 0 and 1",
    );
  }
}

export function scoreStability({
  offsetMm,
}: Readonly<{ offsetMm: number }>): number {
  assertFiniteNonNegative(offsetMm, "offsetMm");
  return clampScore(100 - 18 * offsetMm);
}

export function predictPerformance(
  input: PerformanceInput,
): PerformancePrediction {
  validateInput(input);

  return {
    speed: clampScore(
      100 - 1.05 * input.totalMassG + 10 * input.averageCornerRoundness,
    ),
    spinDuration: clampScore(
      15 +
        input.polarMomentGmm2 / 700 +
        10 * input.averageCornerRoundness,
    ),
    stability: scoreStability({ offsetMm: input.centerOfMassOffsetMm }),
    impactResistance: clampScore(
      10 +
        13 * input.minNeckThicknessMm +
        15 * input.averageCornerRoundness,
    ),
    modelVersion: PERFORMANCE_MODEL_VERSION,
  };
}
