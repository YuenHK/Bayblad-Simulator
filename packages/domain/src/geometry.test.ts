import { describe, expect, it } from "vitest";

import {
  makeLayerVertices,
  maxDiameter,
  minRadialThickness,
  polygonArea,
  radialFactor,
} from "./geometry";

describe("makeLayerVertices", () => {
  it("generates a safe polygon inside the requested diameter", () => {
    const vertices = makeLayerVertices({
      shape: "polygon",
      points: 6,
      diameterMm: 60,
      cornerRoundness: 0.4,
      rotationDeg: 0,
    });

    expect(vertices.length).toBeGreaterThanOrEqual(24);
    expect(maxDiameter(vertices)).toBeCloseTo(60, 5);
    expect(polygonArea(vertices)).toBeGreaterThan(2000);
  });

  it("keeps a rounded star free of narrow necks", () => {
    const vertices = makeLayerVertices({
      shape: "star",
      points: 6,
      diameterMm: 55,
      cornerRoundness: 0.7,
      rotationDeg: 15,
    });

    expect(minRadialThickness(vertices)).toBeGreaterThanOrEqual(6);
  });

  it.each([
    {
      shape: "circle" as const,
      points: 7,
      diameterMm: 46,
      cornerRoundness: 0.3,
      rotationDeg: 10,
      expectedVertices: 64,
      expectedArea: 1659.23415,
      expectedThickness: 46,
    },
    {
      shape: "polygon" as const,
      points: 5,
      diameterMm: 52,
      cornerRoundness: 0.35,
      rotationDeg: 27,
      expectedVertices: 40,
      expectedArea: 1775.92459,
      expectedThickness: 45.54477,
    },
    {
      shape: "star" as const,
      points: 6,
      diameterMm: 55,
      cornerRoundness: 0.7,
      rotationDeg: 15,
      expectedVertices: 48,
      expectedArea: 1702.37015,
      expectedThickness: 40.37,
    },
    {
      shape: "wave" as const,
      points: 8,
      diameterMm: 58,
      cornerRoundness: 0.55,
      rotationDeg: 33,
      expectedVertices: 64,
      expectedArea: 2451.28588,
      expectedThickness: 53.795,
    },
  ])("returns stable finite metrics for $shape", (input) => {
    const vertices = makeLayerVertices(input);
    const area = polygonArea(vertices);
    const diameter = maxDiameter(vertices);
    const thickness = minRadialThickness(vertices);
    const factors = vertices.map((_, index) =>
      radialFactor(
        input.shape,
        input.points,
        (index / vertices.length) * Math.PI * 2,
        input.cornerRoundness,
      ),
    );

    expect(vertices).toHaveLength(input.expectedVertices);
    expect(vertices.flatMap(({ x, y }) => [x, y]).every(Number.isFinite)).toBe(true);
    expect([area, diameter, thickness, ...factors].every(Number.isFinite)).toBe(true);
    expect(area).toBeCloseTo(input.expectedArea, 4);
    expect(area).toBeGreaterThan(0);
    expect(diameter).toBeCloseTo(input.diameterMm, 10);
    expect(thickness).toBeCloseTo(input.expectedThickness, 4);
  });

  it.each([
    ["shape", { shape: "square" }],
    ["points", { points: 2 }],
    ["diameter", { diameterMm: 81 }],
    ["roundness", { cornerRoundness: 1.1 }],
    ["rotation", { rotationDeg: -1 }],
  ])("rejects an invalid %s", (_label, change) => {
    const input = {
      shape: "circle",
      points: 6,
      diameterMm: 50,
      cornerRoundness: 0.5,
      rotationDeg: 0,
      ...change,
    };

    expect(() => makeLayerVertices(input as never)).toThrow();
  });
});

describe("geometry metrics", () => {
  it("returns finite zero values for an empty polygon", () => {
    expect(polygonArea([])).toBe(0);
    expect(maxDiameter([])).toBe(0);
    expect(minRadialThickness([])).toBe(0);
  });
});
