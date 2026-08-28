import {
  designSchema,
  makeLayerVertices,
  radialFactor,
  type Point,
  type TopDesign,
} from "@steam-top/domain";

export const MAX_COLLISION_PROXY_VERTICES = 8;
export const COLLISION_OUTLINE_MAX_ERROR_MM = 0.35;
const ADAPTIVE_TARGET_ERROR_MM = 0.08;
const FULL_TURN = Math.PI * 2;

function normaliseAngle(angle: number): number {
  return ((angle % FULL_TURN) + FULL_TURN) % FULL_TURN;
}

function radiusForDesign(design: TopDesign, angle: number): number {
  return Math.max(...design.layers.map((layer) => {
    const rotation = layer.rotationDeg * Math.PI / 180;
    return layer.diameterMm / 2 * radialFactor(
      layer.shape,
      layer.points,
      angle - rotation,
      layer.cornerRoundness,
    );
  }));
}

function pointForDesign(design: TopDesign, angle: number): Point {
  const radius = radiusForDesign(design, angle);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function radialDistanceToSegment(angle: number, start: Point, end: Point): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const edgeX = end.x - start.x;
  const edgeY = end.y - start.y;
  const denominator = dx * edgeY - dy * edgeX;
  if (Math.abs(denominator) < 1e-12) return 0;
  return (start.x * edgeY - start.y * edgeX) / denominator;
}

/** Adaptive star-shaped union outline in millimetres for sensor-only top contact. */
export function buildCollisionOutlineVertices(input: TopDesign): readonly Point[] {
  const design = designSchema.parse(input);
  const candidateAngles = new Set<number>();
  for (let index = 0; index < 32; index += 1) candidateAngles.add(index * FULL_TURN / 32);
  for (const layer of design.layers) {
    const rotation = layer.rotationDeg * Math.PI / 180;
    for (let index = 0; index < layer.points * 2; index += 1) {
      candidateAngles.add(normaliseAngle(rotation + index * Math.PI / layer.points));
    }
  }
  let angles = [...candidateAngles].sort((left, right) => left - right);
  for (let pass = 0; pass < 8; pass += 1) {
    const additions: number[] = [];
    for (let index = 0; index < angles.length; index += 1) {
      const startAngle = angles[index]!;
      const rawEnd = angles[(index + 1) % angles.length]!;
      const endAngle = index === angles.length - 1 ? rawEnd + FULL_TURN : rawEnd;
      const start = pointForDesign(design, startAngle);
      const end = pointForDesign(design, endAngle);
      for (const ratio of [0.25, 0.5, 0.75]) {
        const sampleAngle = startAngle + (endAngle - startAngle) * ratio;
        const actualRadius = radiusForDesign(design, sampleAngle);
        const polygonRadius = radialDistanceToSegment(sampleAngle, start, end);
        if (Math.abs(actualRadius - polygonRadius) > ADAPTIVE_TARGET_ERROR_MM) {
          additions.push(normaliseAngle(sampleAngle));
        }
      }
    }
    if (additions.length === 0) break;
    angles = [...new Set([...angles, ...additions])].sort((left, right) => left - right);
  }
  return Object.freeze(angles.map((angle) => Object.freeze(pointForDesign(design, angle))));
}

function cross(origin: Point, left: Point, right: Point): number {
  return (left.x - origin.x) * (right.y - origin.y) -
    (left.y - origin.y) * (right.x - origin.x);
}

function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points]
    .sort((left, right) => left.x - right.x || left.y - right.y)
    .filter((point, index, values) =>
      index === 0 || point.x !== values[index - 1]?.x || point.y !== values[index - 1]?.y,
    );
  if (sorted.length < 3) throw new RangeError("Collision proxy requires three unique points");
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index]!;
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function reduceHull(hull: readonly Point[]): Point[] {
  if (hull.length <= MAX_COLLISION_PROXY_VERTICES) return [...hull];
  let anchor = hull[0]!;
  for (const point of hull.slice(1)) {
    const radius = Math.hypot(point.x, point.y);
    const anchorRadius = Math.hypot(anchor.x, anchor.y);
    if (radius > anchorRadius || (radius === anchorRadius && Math.atan2(point.y, point.x) < Math.atan2(anchor.y, anchor.x))) {
      anchor = point;
    }
  }
  const anchorAngle = Math.atan2(anchor.y, anchor.x);
  const selectedIndices = new Set<number>();
  for (let directionIndex = 0; directionIndex < MAX_COLLISION_PROXY_VERTICES; directionIndex += 1) {
    const direction = anchorAngle + directionIndex * Math.PI * 2 / MAX_COLLISION_PROXY_VERTICES;
    let bestIndex = 0;
    let bestProjection = Number.NEGATIVE_INFINITY;
    for (const [index, point] of hull.entries()) {
      const projection = point.x * Math.cos(direction) + point.y * Math.sin(direction);
      if (projection > bestProjection) {
        bestProjection = projection;
        bestIndex = index;
      }
    }
    selectedIndices.add(bestIndex);
  }
  const result = [...selectedIndices].sort((left, right) => left - right).map((index) => hull[index]!);
  if (result.length < 3) throw new RangeError("Collision proxy reduction became degenerate");
  return result;
}

/** Convex, rotation-stable union proxy in millimetres for all three design layers. */
export function buildCollisionProxyVertices(input: TopDesign): readonly Point[] {
  const design = designSchema.parse(input);
  const points = design.layers.flatMap((layer) => makeLayerVertices(layer));
  const proxy = reduceHull(convexHull(points)).map(({ x, y }) => Object.freeze({ x, y }));
  return Object.freeze(proxy);
}
