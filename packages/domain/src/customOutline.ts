/** Millimetres in a y-up coordinate system, relative to the fixed axle origin. */
export interface OutlinePoint {
  x: number;
  y: number;
}
/** First failure, in validation order. No input geometry is silently repaired. */
export type CustomOutlineErrorCode =
  | "vertex_count"
  | "non_finite"
  | "radius_exceeded"
  | "duplicate_vertex"
  | "zero_area"
  | "self_intersection"
  | "axle_clearance"
  | "mirror_mode"
  | "mirror_endpoints"
  | "mirror_domain";
export type OutlineValidation =
  { valid: true } | { valid: false; code: CustomOutlineErrorCode };
export type OutlineMirrorMode =
  "none" | "leftRight" | "topBottom" | 4 | 6 | 8 | 12;
export type OutlineReflection =
  | { valid: true; points: OutlinePoint[] }
  | { valid: false; code: CustomOutlineErrorCode };

// Numerical guard only, not an editing/snap tolerance (all coordinates are mm).
const EPS = 1e-9;
const fail = (
  code: CustomOutlineErrorCode,
): { valid: false; code: CustomOutlineErrorCode } => ({ valid: false, code });
const cross = (a: OutlinePoint, b: OutlinePoint, c: OutlinePoint) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const same = (a: OutlinePoint, b: OutlinePoint) =>
  Math.hypot(a.x - b.x, a.y - b.y) <= EPS;
const area2 = (p: readonly OutlinePoint[]) =>
  p.reduce(
    (a, v, i) =>
      a + v.x * p[(i + 1) % p.length]!.y - v.y * p[(i + 1) % p.length]!.x,
    0,
  );
const onSegment = (a: OutlinePoint, b: OutlinePoint, p: OutlinePoint) =>
  Math.abs(cross(a, b, p)) <= EPS &&
  p.x >= Math.min(a.x, b.x) - EPS &&
  p.x <= Math.max(a.x, b.x) + EPS &&
  p.y >= Math.min(a.y, b.y) - EPS &&
  p.y <= Math.max(a.y, b.y) + EPS;
function intersects(
  a: OutlinePoint,
  b: OutlinePoint,
  c: OutlinePoint,
  d: OutlinePoint,
): boolean {
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  return (
    (((abC > EPS && abD < -EPS) || (abC < -EPS && abD > EPS)) &&
      ((cdA > EPS && cdB < -EPS) || (cdA < -EPS && cdB > EPS))) ||
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}
function checkCoordinates(
  points: readonly OutlinePoint[],
  minimum: number,
): OutlineValidation {
  if (points.length < minimum || points.length > 256)
    return fail("vertex_count");
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
    return fail("non_finite");
  // Rotation/reflection may place a mathematical 40 mm point a few ULPs over
  // the boundary. Reuse the numerical guard without moving any coordinates.
  if (points.some((p) => Math.hypot(p.x, p.y) > 40 + EPS))
    return fail("radius_exceeded");
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      if (same(points[i]!, points[j]!)) return fail("duplicate_vertex");
  return { valid: true };
}

/** An implicit closed ring: do not repeat its first vertex at the end. */
export function validateCustomOutline(
  points: readonly OutlinePoint[],
): OutlineValidation {
  const basic = checkCoordinates(points, 3);
  if (!basic.valid) return basic;
  if (points.every((p) => Math.abs(cross(points[0]!, points[1]!, p)) <= EPS))
    return fail("zero_area");
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!,
      b = points[(i + 1) % points.length]!,
      c = points[(i + 2) % points.length]!;
    // Adjacent edges may share their endpoint, but may not double back.
    if (
      Math.abs(cross(a, b, c)) <= EPS &&
      (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0
    )
      return fail("self_intersection");
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (intersects(a, b, points[j]!, points[(j + 1) % points.length]!))
        return fail("self_intersection");
    }
  }
  if (Math.abs(area2(points)) <= EPS) return fail("zero_area");
  let inside = false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!,
      b = points[(i + 1) % points.length]!;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy)),
    );
    if (Math.hypot(a.x + t * dx, a.y + t * dy) <= 3.25 + EPS)
      return fail("axle_clearance");
    if (a.y > 0 !== b.y > 0 && a.x + ((b.x - a.x) * -a.y) / (b.y - a.y) > 0)
      inside = !inside;
  }
  return inside ? { valid: true } : fail("axle_clearance");
}

/** Preserves every vertex and its coordinates; throws on an invalid ring. */
export function canonicalizeOutline(
  points: readonly OutlinePoint[],
): OutlinePoint[] {
  const result = validateCustomOutline(points);
  if (!result.valid) throw new Error(`Invalid custom outline: ${result.code}`);
  const ordered = points.map((p) => ({ ...p }));
  if (area2(ordered) < 0) ordered.reverse();
  let start = 0;
  for (let i = 1; i < ordered.length; i++)
    if (
      ordered[i]!.x < ordered[start]!.x ||
      (ordered[i]!.x === ordered[start]!.x && ordered[i]!.y < ordered[start]!.y)
    )
      start = i;
  return [...ordered.slice(start), ...ordered.slice(0, start)];
}

/**
 * LR/TB strokes lie in the right/upper half-plane with endpoints on its axis.
 * Numeric modes use the first 2π/N sector, from its angle-zero ray to its end
 * ray (either drawing direction). Successive sectors alternate reflection.
 * Only generated seam copies are omitted; original stroke vertices stay intact.
 */
export function reflectOutlineStroke(
  stroke: readonly OutlinePoint[],
  mode: OutlineMirrorMode,
): OutlineReflection {
  if (!["none", "leftRight", "topBottom", 4, 6, 8, 12].includes(mode))
    return fail("mirror_mode");
  if (mode === "none") {
    const result = validateCustomOutline(stroke);
    return result.valid
      ? { valid: true, points: canonicalizeOutline(stroke) }
      : result;
  }
  const basic = checkCoordinates(stroke, 2);
  if (!basic.valid) return basic;
  const sectors = typeof mode === "number" ? mode : 2;
  if ((stroke.length - 1) * sectors > 256) return fail("vertex_count");
  let points: OutlinePoint[];
  if (mode === "leftRight" || mode === "topBottom") {
    const axis = (p: OutlinePoint) => (mode === "leftRight" ? p.x : p.y);
    if (
      Math.abs(axis(stroke[0]!)) > EPS ||
      Math.abs(axis(stroke[stroke.length - 1]!)) > EPS
    )
      return fail("mirror_endpoints");
    if (stroke.some((p) => axis(p) < -EPS)) return fail("mirror_domain");
    points = [
      ...stroke.map((p) => ({ ...p })),
      ...stroke
        .slice(1, -1)
        .reverse()
        .map((p) =>
          mode === "leftRight" ? { x: -p.x, y: p.y } : { x: p.x, y: -p.y },
        ),
    ];
  } else {
    const angle = (2 * Math.PI) / mode;
    const boundary = { x: Math.cos(angle), y: Math.sin(angle) };
    const onStart = (p: OutlinePoint) => Math.abs(p.y) <= EPS && p.x > 0;
    const onEnd = (p: OutlinePoint) =>
      Math.abs(boundary.x * p.y - boundary.y * p.x) <= EPS &&
      p.x * boundary.x + p.y * boundary.y > 0;
    let source = [...stroke];
    if (onEnd(source[0]!) && onStart(source[source.length - 1]!))
      source.reverse();
    if (!onStart(source[0]!) || !onEnd(source[source.length - 1]!))
      return fail("mirror_endpoints");
    if (
      source.some(
        (p) => p.y < -EPS || boundary.x * p.y - boundary.y * p.x > EPS,
      )
    )
      return fail("mirror_domain");
    points = [];
    for (let k = 0; k < mode; k++) {
      const sector = k % 2 === 0 ? source : [...source].reverse();
      const rotation = (k % 2 === 0 ? k : k + 1) * angle;
      const cos = Math.cos(rotation),
        sin = Math.sin(rotation);
      for (const p of sector.slice(0, -1)) {
        const y = k % 2 === 0 ? p.y : -p.y;
        points.push({ x: p.x * cos - y * sin, y: p.x * sin + y * cos });
      }
    }
  }
  const result = validateCustomOutline(points);
  return result.valid
    ? { valid: true, points: canonicalizeOutline(points) }
    : result;
}
