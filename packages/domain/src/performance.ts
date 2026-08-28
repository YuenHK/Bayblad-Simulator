import type { Layer, TopDesign } from "./design";
import { calculateMinimumMaterialNeckMm, validateDesign } from "./rules";

export const PERFORMANCE_MODEL_VERSION = "1.0.0" as const;
export const MAX_SCHEMA_RADIUS_MM = 40;

const MAX_CANONICAL_NECK_MM = 80;
const PHYSICAL_BOUND_EPSILON = 1e-9;

/**
 * Trusted, pre-calculated physical properties consumed by the relative
 * performance model. Shape and design parameters intentionally stay outside
 * this API. Authoritative callers must use predictDesignPerformance instead
 * of accepting these values from an untrusted client DTO.
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
  if (!Number.isFinite(input.totalMassG) || input.totalMassG <= 0) {
    throw new RangeError("totalMassG must be finite and positive");
  }
  assertFiniteNonNegative(input.polarMomentGmm2, "polarMomentGmm2");
  assertFiniteNonNegative(input.minNeckThicknessMm, "minNeckThicknessMm");
  assertFiniteNonNegative(
    input.centerOfMassOffsetMm,
    "centerOfMassOffsetMm",
  );
  const maximumPolarMomentGmm2 =
    input.totalMassG * MAX_SCHEMA_RADIUS_MM ** 2;
  const polarMomentEpsilon =
    Math.max(1, maximumPolarMomentGmm2) * PHYSICAL_BOUND_EPSILON;
  if (
    input.polarMomentGmm2 >
    maximumPolarMomentGmm2 + polarMomentEpsilon
  ) {
    throw new RangeError(
      "polarMomentGmm2 exceeds the schema-radius physical bound",
    );
  }
  if (input.centerOfMassOffsetMm > MAX_SCHEMA_RADIUS_MM) {
    throw new RangeError(
      `centerOfMassOffsetMm must not exceed ${MAX_SCHEMA_RADIUS_MM}`,
    );
  }
  if (input.minNeckThicknessMm > MAX_CANONICAL_NECK_MM) {
    throw new RangeError(
      `minNeckThicknessMm must not exceed ${MAX_CANONICAL_NECK_MM}`,
    );
  }
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

export function effectiveLayerRoundness(
  layer: Pick<Layer, "shape" | "cornerRoundness">,
): number {
  return layer.shape === "circle" ? 1 : layer.cornerRoundness;
}

function normalizedRadiusOfGyration(input: PerformanceInput): number {
  // sqrt(I / m) measures how far the mass is distributed from the spin axis.
  return (
    Math.sqrt(input.polarMomentGmm2 / input.totalMassG) /
    MAX_SCHEMA_RADIUS_MM
  );
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
    stability: clampScore(
      scoreStability({ offsetMm: input.centerOfMassOffsetMm }) -
        35 +
        35 * normalizedRadiusOfGyration(input),
    ),
    impactResistance: clampScore(
      10 +
        13 * input.minNeckThicknessMm +
        15 * input.averageCornerRoundness,
    ),
    modelVersion: PERFORMANCE_MODEL_VERSION,
  };
}

/**
 * Recalculates every performance input from the authoritative domain model.
 * A schema-valid draft may still fail course rules; its negative material
 * clearance is clamped to zero so it can be previewed, while validateDesign
 * remains the authority for battle eligibility.
 */
export function derivePerformanceInput(design: TopDesign): PerformanceInput {
  const { massProperties } = validateDesign(design);
  const averageCornerRoundness =
    design.layers.reduce(
      (total, layer) => total + effectiveLayerRoundness(layer),
      0,
    ) / design.layers.length;

  return {
    totalMassG: massProperties.totalMassG,
    polarMomentGmm2: massProperties.polarMomentGmm2,
    averageCornerRoundness,
    minNeckThicknessMm: Math.max(
      0,
      calculateMinimumMaterialNeckMm(design),
    ),
    centerOfMassOffsetMm: Math.hypot(
      massProperties.centerOfMassMm.x,
      massProperties.centerOfMassMm.y,
    ),
  };
}

/** Canonical prediction entry point for UI and server callers. */
export function predictDesignPerformance(
  design: TopDesign,
): PerformancePrediction {
  return predictPerformance(derivePerformanceInput(design));
}
