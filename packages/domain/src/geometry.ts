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

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function radialFactor(
  shape: Layer["shape"],
  points: number,
  angle: number,
  cornerRoundness: number,
): number {
  const safePoints = Math.max(3, Math.round(finiteOrZero(points)));
  const safeAngle = finiteOrZero(angle);
  const roundness = Math.min(1, Math.max(0, finiteOrZero(cornerRoundness)));

  if (shape === "circle") {
    return 1;
  }

  if (shape === "polygon") {
    const sector = FULL_TURN / safePoints;
    const halfSector = sector / 2;
    const localAngle =
      ((safeAngle + halfSector) % sector + sector) % sector - halfSector;
    const polygonFactor = Math.cos(halfSector) / Math.cos(localAngle);

    return polygonFactor * (1 - roundness) + roundness;
  }

  if (shape === "star") {
    const innerFactor = 0.58 + 0.22 * roundness;
    const peak = (1 + Math.cos(safePoints * safeAngle)) / 2;
    const smoothPeak = Math.pow(peak, 1 + 2 * (1 - roundness));

    return innerFactor + (1 - innerFactor) * smoothPeak;
  }

  const amplitude = 0.1 * (1 - roundness / 2);
  return 1 - amplitude / 2 + (amplitude / 2) * Math.cos(safePoints * safeAngle);
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
      finiteOrZero(current.x) * finiteOrZero(next.y) -
      finiteOrZero(next.x) * finiteOrZero(current.y);
  }

  return finiteOrZero(Math.abs(signedDoubleArea) / 2);
}

export function maxDiameter(vertices: readonly Point[]): number {
  let maximumRadius = 0;
  for (const vertex of vertices) {
    maximumRadius = Math.max(
      maximumRadius,
      Math.hypot(finiteOrZero(vertex.x), finiteOrZero(vertex.y)),
    );
  }

  return finiteOrZero(maximumRadius * 2);
}

export function minRadialThickness(vertices: readonly Point[]): number {
  if (vertices.length === 0) {
    return 0;
  }

  let minimumRadius = Number.POSITIVE_INFINITY;
  for (const vertex of vertices) {
    minimumRadius = Math.min(
      minimumRadius,
      Math.hypot(finiteOrZero(vertex.x), finiteOrZero(vertex.y)),
    );
  }

  return finiteOrZero(minimumRadius * 2);
}
