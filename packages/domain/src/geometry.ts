import { layerSchema, type Layer } from "./design";

export type Point = Readonly<{ x: number; y: number }>;

type GeometryInput = Pick<
  Layer,
  "shape" | "points" | "diameterMm" | "cornerRoundness" | "rotationDeg"
>;

const geometryInputSchema = layerSchema.pick({
  shape: true,
  points: true,
  diameterMm: true,
  cornerRoundness: true,
  rotationDeg: true,
});

const FULL_TURN = Math.PI * 2;

function assertNever(value: never): never {
  throw new TypeError(`Unsupported layer shape: ${String(value)}`);
}

function assertFiniteVertices(vertices: readonly Point[]): void {
  for (const vertex of vertices) {
    if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) {
      throw new TypeError("Geometry vertices must contain finite coordinates");
    }
  }
}

function finiteResult(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("Geometry calculation exceeded the finite number range");
  }
  return value;
}

export function radialFactor(
  shape: Layer["shape"],
  points: number,
  angle: number,
  cornerRoundness: number,
): number {
  if (!Number.isInteger(points) || points < 3 || points > 16) {
    throw new TypeError("points must be an integer from 3 to 16");
  }
  if (!Number.isFinite(angle)) {
    throw new TypeError("angle must be finite");
  }
  if (
    !Number.isFinite(cornerRoundness) ||
    cornerRoundness < 0 ||
    cornerRoundness > 1
  ) {
    throw new TypeError("cornerRoundness must be finite and between 0 and 1");
  }

  switch (shape) {
    case "circle":
      return 1;
    case "polygon": {
      const regularPolygonDepth = 1 - Math.cos(Math.PI / points);
      const roundedDepth = regularPolygonDepth * (1 - 0.85 * cornerRoundness);
      return finiteResult(
        1 - (roundedDepth * (1 - Math.cos(points * angle))) / 2,
      );
    }
    case "star": {
      const innerFactor = 0.58 + 0.22 * cornerRoundness;
      const peak = (1 + Math.cos(points * angle)) / 2;
      const smoothPeak = Math.pow(
        peak,
        1 + 2 * (1 - cornerRoundness),
      );
      return finiteResult(innerFactor + (1 - innerFactor) * smoothPeak);
    }
    case "wave": {
      const amplitude = 0.1 * (1 - cornerRoundness / 2);
      return finiteResult(
        1 - amplitude / 2 + (amplitude / 2) * Math.cos(points * angle),
      );
    }
    default:
      return assertNever(shape);
  }
}

export function makeLayerVertices(input: GeometryInput): Point[] {
  const parsed = geometryInputSchema.parse(input);
  const count =
    parsed.shape === "circle" ? 64 : Math.max(parsed.points * 8, 32);
  const outerRadius = parsed.diameterMm / 2;
  const rotation = (parsed.rotationDeg * Math.PI) / 180;

  return Array.from({ length: count }, (_, index) => {
    const localAngle = (index / count) * FULL_TURN;
    const radius =
      outerRadius *
      radialFactor(
        parsed.shape,
        parsed.points,
        localAngle,
        parsed.cornerRoundness,
      );
    const rotatedAngle = localAngle + rotation;

    return {
      x: Math.cos(rotatedAngle) * radius,
      y: Math.sin(rotatedAngle) * radius,
    };
  });
}

export function polygonArea(vertices: readonly Point[]): number {
  assertFiniteVertices(vertices);
  if (vertices.length < 3) {
    return 0;
  }

  let signedDoubleArea = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    if (current === undefined || next === undefined) {
      continue;
    }
    signedDoubleArea +=
      current.x * next.y - next.x * current.y;
  }

  return finiteResult(Math.abs(signedDoubleArea) / 2);
}

export function maxDiameter(vertices: readonly Point[]): number {
  assertFiniteVertices(vertices);
  let maximumRadius = 0;
  for (const vertex of vertices) {
    maximumRadius = Math.max(
      maximumRadius,
      Math.hypot(vertex.x, vertex.y),
    );
  }

  return finiteResult(maximumRadius * 2);
}

type PolarPoint = Readonly<{ angle: number; radius: number }>;

function normaliseAngle(angle: number): number {
  return ((angle % FULL_TURN) + FULL_TURN) % FULL_TURN;
}

function makePolarProfile(vertices: readonly Point[]): PolarPoint[] {
  const byAngle = new Map<number, number>();
  for (const vertex of vertices) {
    const angle = normaliseAngle(Math.atan2(vertex.y, vertex.x));
    const radius = Math.hypot(vertex.x, vertex.y);
    byAngle.set(angle, Math.max(byAngle.get(angle) ?? 0, radius));
  }

  return [...byAngle]
    .map(([angle, radius]) => ({ angle, radius }))
    .sort((left, right) => left.angle - right.angle);
}

function radiusAtAngle(profile: readonly PolarPoint[], angle: number): number {
  if (profile.length === 0) {
    return 0;
  }
  if (profile.length === 1) {
    return profile[0]?.radius ?? 0;
  }

  const target = normaliseAngle(angle);
  for (let index = 0; index < profile.length; index += 1) {
    const left = profile[index];
    const right = profile[(index + 1) % profile.length];
    if (left === undefined || right === undefined) {
      continue;
    }
    const rightAngle = index === profile.length - 1 ? right.angle + FULL_TURN : right.angle;
    const adjustedTarget = target < left.angle ? target + FULL_TURN : target;
    if (adjustedTarget <= rightAngle) {
      const span = rightAngle - left.angle;
      const ratio = span === 0 ? 0 : (adjustedTarget - left.angle) / span;
      return left.radius + (right.radius - left.radius) * ratio;
    }
  }

  return profile[0]?.radius ?? 0;
}

/**
 * Returns the minimum material span through the axle centre between opposite
 * radial boundary intersections. It is not a local feature-distance measure.
 */
export function minRadialThickness(vertices: readonly Point[]): number {
  assertFiniteVertices(vertices);
  if (vertices.length === 0) {
    return 0;
  }

  const profile = makePolarProfile(vertices);
  const candidateAngles = profile.flatMap(({ angle }) => [
    angle,
    normaliseAngle(angle - Math.PI),
  ]);
  let minimumSpan = Number.POSITIVE_INFINITY;
  for (const angle of candidateAngles) {
    minimumSpan = Math.min(
      minimumSpan,
      radiusAtAngle(profile, angle) + radiusAtAngle(profile, angle + Math.PI),
    );
  }

  return finiteResult(minimumSpan);
}
