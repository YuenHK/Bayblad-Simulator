import {
  designSchema,
  makeLayerVertices,
  type Point,
  type TopDesign,
} from "@steam-top/domain";

export const MAX_COLLISION_PROXY_VERTICES = 8;

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
