import { describe, expect, it } from "vitest";
import {
  canonicalizeOutline,
  reflectOutlineStroke,
  validateCustomOutline,
} from "./customOutline";

const square = [
  { x: -10, y: -10 },
  { x: 10, y: -10 },
  { x: 10, y: 10 },
  { x: -10, y: 10 },
];
const polar = (r: number, a: number) => ({
  x: r * Math.cos(a),
  y: r * Math.sin(a),
});

describe("custom outlines", () => {
  it("accepts ordinary, concave, and off-center outlines", () => {
    expect(validateCustomOutline(square)).toEqual({ valid: true });
    expect(
      validateCustomOutline([
        { x: -15, y: -15 },
        { x: 15, y: -15 },
        { x: 15, y: 15 },
        { x: 8, y: 8 },
        { x: -15, y: 15 },
      ]),
    ).toEqual({ valid: true });
    expect(
      validateCustomOutline(square.map((p) => ({ x: p.x + 4, y: p.y + 2 }))),
    ).toEqual({ valid: true });
  });
  it.each([
    [[], "vertex_count"],
    [
      Array.from({ length: 257 }, (_, i) => polar(20, (i * 2 * Math.PI) / 257)),
      "vertex_count",
    ],
    [[{ x: NaN, y: 0 }, ...square], "non_finite"],
    [[{ x: 41, y: 0 }, ...square], "radius_exceeded"],
    [[square[0], square[0], ...square.slice(1)], "duplicate_vertex"],
    [[square[0], square[2], square[1], square[3]], "self_intersection"],
    [
      [
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 0, y: -10 },
        { x: 10, y: 10 },
        { x: -10, y: 10 },
      ],
      "self_intersection",
    ],
    [
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
      ],
      "zero_area",
    ],
    [square.map((p) => ({ x: p.x + 20, y: p.y })), "axle_clearance"],
    [
      [
        { x: -3.25, y: -10 },
        { x: 10, y: -10 },
        { x: 10, y: 10 },
        { x: -3.25, y: 10 },
      ],
      "axle_clearance",
    ],
  ])("rejects invalid outline %#", (points, code) => {
    expect(validateCustomOutline(points as typeof square)).toEqual({
      valid: false,
      code,
    });
  });
  it("canonicalizes cyclic/winding equivalents without translation, scaling or mutation", () => {
    const original = square.map((p) => ({ x: p.x + 4, y: p.y + 2 }));
    const saved = structuredClone(original);
    const shifted = [...original.slice(2), ...original.slice(0, 2)].reverse();
    expect(canonicalizeOutline(shifted)).toEqual(original);
    expect(original).toEqual(saved);
    expect(canonicalizeOutline(original)[0]).not.toBe(original[0]);
  });
  it("none preserves the complete concave outline", () => {
    const points = [...square.slice(0, 3), { x: 0, y: 7 }, square[3]!];
    expect(reflectOutlineStroke(points, "none")).toEqual({
      valid: true,
      points: canonicalizeOutline(points),
    });
  });
  it("throws concrete validation errors when canonicalizing invalid points", () => {
    expect(() => canonicalizeOutline([{ x: NaN, y: 0 }, ...square])).toThrow(
      "non_finite",
    );
    expect(reflectOutlineStroke(square, "bad" as never)).toEqual({
      valid: false,
      code: "mirror_mode",
    });
  });
  it("reflects right-side strokes across the y axis", () => {
    const result = reflectOutlineStroke(
      [
        { x: 0, y: -10 },
        { x: 8, y: -6 },
        { x: 6, y: 0 },
        { x: 10, y: 8 },
        { x: 0, y: 12 },
      ],
      "leftRight",
    );
    expect(result).toEqual({
      valid: true,
      points: canonicalizeOutline([
        { x: 0, y: -10 },
        { x: 8, y: -6 },
        { x: 6, y: 0 },
        { x: 10, y: 8 },
        { x: 0, y: 12 },
        { x: -10, y: 8 },
        { x: -6, y: 0 },
        { x: -8, y: -6 },
      ]),
    });
  });
  it("reflects upper strokes across x axis in y-up coordinates", () => {
    const result = reflectOutlineStroke(
      [
        { x: 12, y: 0 },
        { x: 8, y: 8 },
        { x: 0, y: 6 },
        { x: -10, y: 10 },
        { x: -12, y: 0 },
      ],
      "topBottom",
    );
    expect(result).toEqual({
      valid: true,
      points: canonicalizeOutline([
        { x: 12, y: 0 },
        { x: 8, y: 8 },
        { x: 0, y: 6 },
        { x: -10, y: 10 },
        { x: -12, y: 0 },
        { x: -10, y: -10 },
        { x: 0, y: -6 },
        { x: 8, y: -8 },
      ]),
    });
  });
  it.each([4, 6, 8, 12] as const)(
    "alternates reflected sector geometry for %s",
    (n) => {
      const a = (2 * Math.PI) / n;
      const stroke = [polar(20, 0), polar(12, a / 3), polar(22, a)];
      const result = reflectOutlineStroke(stroke, n);
      expect(result.valid).toBe(true);
      if (!result.valid) return;
      const expected = Array.from({ length: n }, (_, k) => [
        polar(k % 2 === 0 ? 20 : 22, k * a),
        polar(12, k * a + (k % 2 === 0 ? a / 3 : (2 * a) / 3)),
      ]).flat();
      expect(result.points).toHaveLength(2 * n);
      for (const p of expected)
        expect(
          result.points.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-8),
        ).toBe(true);
      const start = result.points.findIndex(
        (p) => Math.hypot(p.x - 20, p.y) < 1e-8,
      );
      expected.forEach((p, i) => {
        const actual = result.points[(start + i) % result.points.length]!;
        expect(actual.x).toBeCloseTo(p.x, 8);
        expect(actual.y).toBeCloseTo(p.y, 8);
      });
      expect(reflectOutlineStroke([...stroke].reverse(), n)).toEqual(result);
      expect(validateCustomOutline(result.points)).toEqual({ valid: true });
    },
  );
  it("retains collinear legitimate vertices and accepts the 256 vertex boundary", () => {
    const points = [square[0]!, { x: 0, y: -10 }, ...square.slice(1)];
    expect(canonicalizeOutline(points)).toEqual(points);
    expect(
      validateCustomOutline(
        Array.from({ length: 256 }, (_, i) =>
          polar(20, (i * 2 * Math.PI) / 256),
        ),
      ),
    ).toEqual({ valid: true });
  });
  it("rejects nonadjacent self-touch and axle clipping by a concavity", () => {
    expect(
      validateCustomOutline([
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 10, y: 10 },
        { x: 0, y: -10 },
        { x: -10, y: 10 },
      ]),
    ).toEqual({ valid: false, code: "self_intersection" });
    expect(
      validateCustomOutline([
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 10, y: 10 },
        { x: 0, y: 2 },
        { x: -10, y: 10 },
      ]),
    ).toEqual({ valid: false, code: "axle_clearance" });
  });
  it.each([4, 6, 8, 12] as const)(
    "keeps maximum-radius mirror points valid for %s",
    (n) => {
      expect(
        reflectOutlineStroke(
          [polar(40, 0), polar(20, Math.PI / n), polar(40, (2 * Math.PI) / n)],
          n,
        ).valid,
      ).toBe(true);
    },
  );
  it("rejects illegal mirror domains and endpoints without snapping", () => {
    expect(
      reflectOutlineStroke(
        [
          { x: 1, y: -10 },
          { x: 10, y: 0 },
          { x: 0, y: 10 },
        ],
        "leftRight",
      ),
    ).toEqual({ valid: false, code: "mirror_endpoints" });
    expect(
      reflectOutlineStroke(
        [
          { x: 0, y: -10 },
          { x: -10, y: 0 },
          { x: 0, y: 10 },
        ],
        "leftRight",
      ),
    ).toEqual({ valid: false, code: "mirror_domain" });
    expect(
      reflectOutlineStroke(
        [polar(20, 0), polar(15, -0.1), polar(20, Math.PI / 2)],
        4,
      ),
    ).toEqual({ valid: false, code: "mirror_domain" });
    expect(
      reflectOutlineStroke([polar(20, 0.1), polar(20, Math.PI / 2)], 4),
    ).toEqual({ valid: false, code: "mirror_endpoints" });
  });
  it("validates reflected output including axle clearance and vertex limit", () => {
    expect(
      reflectOutlineStroke(
        [
          { x: 0, y: -2 },
          { x: 2, y: 0 },
          { x: 0, y: 2 },
        ],
        "leftRight",
      ),
    ).toEqual({ valid: false, code: "axle_clearance" });
    expect(
      reflectOutlineStroke(
        Array.from({ length: 130 }, (_, i) =>
          polar(20, -Math.PI / 2 + (i * Math.PI) / 129),
        ),
        "leftRight",
      ),
    ).toEqual({ valid: false, code: "vertex_count" });
  });
});
