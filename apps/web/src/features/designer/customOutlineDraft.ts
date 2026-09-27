import {
  reflectOutlineStroke,
  type CustomOutline,
  type OutlineMirrorMode,
  type Point,
} from "@steam-top/domain";

export const MAX_RAW_POINTS = 4096;
type Stroke = { raw: Point[]; error?: string | undefined };
export type OutlineDraft = Stroke & {
  mirror: OutlineMirrorMode;
  simplifyMm: number;
  smoothing: number;
  past: Stroke[];
  future: Stroke[];
};
export function createOutlineDraft(outline?: CustomOutline): OutlineDraft {
  // Stored outlines are complete rings. Begin in full-outline mode; the saved
  // mirror metadata is not a source stroke and must never be reflected again.
  const vertices = outline?.vertices ?? [];
  return {
    raw: vertices.length ? [...vertices, vertices[0]!] : [],
    mirror: "none",
    simplifyMm: 0.3,
    smoothing: 0,
    past: [],
    future: [],
  };
}
export function recordStroke(
  draft: OutlineDraft,
  raw: Point[],
  error?: string,
): OutlineDraft {
  return {
    ...draft,
    raw: raw.slice(0, MAX_RAW_POINTS),
    error:
      error ??
      (raw.length > MAX_RAW_POINTS
        ? "筆劃超過 4096 點，請重新繪畫較短筆劃。"
        : undefined),
    past: [...draft.past.slice(-19), { raw: draft.raw, error: draft.error }],
    future: [],
  };
}
export function undoStroke(draft: OutlineDraft): OutlineDraft {
  const stroke = draft.past.at(-1);
  return stroke
    ? {
        ...draft,
        ...stroke,
        past: draft.past.slice(0, -1),
        future: [{ raw: draft.raw, error: draft.error }, ...draft.future],
      }
    : draft;
}
export function redoStroke(draft: OutlineDraft): OutlineDraft {
  const stroke = draft.future[0];
  return stroke
    ? {
        ...draft,
        ...stroke,
        past: [...draft.past, { raw: draft.raw, error: draft.error }],
        future: draft.future.slice(1),
      }
    : draft;
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3 || tolerance <= 0) return points;
  const keep = new Set([0, points.length - 1]);
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const a = points[first!]!,
      b = points[last!]!;
    let max = tolerance,
      index = -1;
    for (let i = first! + 1; i < last!; i++) {
      const p = points[i]!,
        dx = b.x - a.x,
        dy = b.y - a.y;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
        ),
      );
      const d = distance(p, { x: a.x + t * dx, y: a.y + t * dy });
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index >= 0) {
      keep.add(index);
      stack.push([first!, index], [index, last!]);
    }
  }
  return points.filter((_, i) => keep.has(i));
}
const errors: Record<string, string> = {
  vertex_count: "輪廓須有 3 至 256 點；請增加簡化程度或重新繪畫。",
  non_finite: "座標無效，請重新繪畫。",
  radius_exceeded: "輪廓不可超出半徑 40 mm。",
  duplicate_vertex: "輪廓包含重複點，請重新繪畫。",
  zero_area: "輪廓沒有面積。",
  self_intersection: "輪廓不可交叉或重疊。",
  axle_clearance: "輪廓須包圍固定軸心，並與軸孔保留足夠距離。",
  mirror_mode: "鏡射模式無效。",
  mirror_endpoints: "請將兩端畫至指定的不同邊界（吸附距離 3 mm）。",
  mirror_domain: "請只在標示的半邊或扇區內繪畫。",
};
export function snappedStroke(draft: OutlineDraft): Point[] | null {
  const points = draft.raw.map((p) => ({ ...p }));
  if (points.length < 2) return null;
  const first = points[0]!,
    last = points[points.length - 1]!;
  if (draft.mirror === "none") {
    if (distance(first, last) > 3) return null;
    points[points.length - 1] = { ...first };
  } else if (draft.mirror === "leftRight" || draft.mirror === "topBottom") {
    const key = draft.mirror === "leftRight" ? "x" : "y";
    if (Math.abs(first[key]) > 3 || Math.abs(last[key]) > 3) return null;
    first[key] = 0;
    last[key] = 0;
  } else {
    const a = (2 * Math.PI) / draft.mirror;
    const project = (p: Point, angle: number): Point => {
      const r = Math.max(0, p.x * Math.cos(angle) + p.y * Math.sin(angle));
      return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
    };
    const forward =
      distance(first, project(first, 0)) + distance(last, project(last, a));
    const reverse =
      distance(first, project(first, a)) + distance(last, project(last, 0));
    const start = project(first, forward <= reverse ? 0 : a),
      end = project(last, forward <= reverse ? a : 0);
    if (distance(first, start) > 3 || distance(last, end) > 3) return null;
    points[0] = start;
    points[points.length - 1] = end;
  }
  return points;
}
export type OutlinePreview =
  | { valid: true; outline: CustomOutline; diameterMm: number }
  | { valid: false; error: string };
export function previewOutline(draft: OutlineDraft): OutlinePreview {
  if (draft.error) return { valid: false, error: draft.error };
  if (draft.raw.length > MAX_RAW_POINTS)
    return { valid: false, error: "筆劃超過 4096 點。" };
  let points = snappedStroke(draft);
  if (!points)
    return {
      valid: false,
      error:
        draft.mirror === "none"
          ? "請畫一筆閉合輪廓，終點距離起點須在 3 mm 內。"
          : errors.mirror_endpoints!,
    };
  // Smooth a derived copy. The captured stroke and boundary endpoints remain intact.
  points = points.map((p, i, all) =>
    i === 0 || i === all.length - 1
      ? p
      : {
          x:
            p.x * (1 - draft.smoothing) +
            ((all[i - 1]!.x + all[i + 1]!.x) * draft.smoothing) / 2,
          y:
            p.y * (1 - draft.smoothing) +
            ((all[i - 1]!.y + all[i + 1]!.y) * draft.smoothing) / 2,
        },
  );
  points = simplify(points, draft.simplifyMm);
  if (draft.mirror === "none") points = points.slice(0, -1);
  const result = reflectOutlineStroke(points, draft.mirror);
  if (!result.valid) return { valid: false, error: errors[result.code]! };
  const diameterMm =
    2 * Math.max(...result.points.map((p) => Math.hypot(p.x, p.y)));
  if (diameterMm < 20 || diameterMm > 80 + 1e-9)
    return { valid: false, error: "輪廓的軸心包絡直徑須介乎 20 至 80 mm。" };
  return {
    valid: true,
    outline: { version: 1, vertices: result.points, mirror: draft.mirror },
    diameterMm: Math.min(80, diameterMm),
  };
}
