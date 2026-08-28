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

  it.each([0, 0.5, 1])(
    "keeps polygon sector boundaries C1-continuous at roundness %s",
    (cornerRoundness) => {
      const epsilon = 0.00001;

      for (let points = 3; points <= 16; points += 1) {
        const sector = (Math.PI * 2) / points;
        for (let boundaryIndex = 0; boundaryIndex < points; boundaryIndex += 1) {
          const sectorBoundary = (boundaryIndex + 0.5) * sector;
          const atBoundary = radialFactor(
            "polygon",
            points,
            sectorBoundary,
            cornerRoundness,
          );
          const leftDerivative =
            (atBoundary -
              radialFactor(
                "polygon",
                points,
                sectorBoundary - epsilon,
                cornerRoundness,
              )) /
            epsilon;
          const rightDerivative =
            (radialFactor(
              "polygon",
              points,
              sectorBoundary + epsilon,
              cornerRoundness,
            ) -
              atBoundary) /
            epsilon;

          expect(leftDerivative).toBeCloseTo(rightDerivative, 3);
        }
        const vertices = makeLayerVertices({
          shape: "polygon",
          points,
          diameterMm: 60,
          cornerRoundness,
          rotationDeg: 0,
        });

        expect(vertices.flatMap(({ x, y }) => [x, y]).every(Number.isFinite)).toBe(
          true,
        );
        expect(polygonArea(vertices)).toBeGreaterThan(0);
        expect(maxDiameter(vertices)).toBeCloseTo(60, 10);
      }
    },
  );

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
      expectedArea: 1844.11731,
      expectedThickness: 48.5117,
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

  it.each([5, 7])(
    "measures the opposite-direction material span for a %s-point star",
    (points) => {
      const vertices = makeLayerVertices({
        shape: "star",
        points,
        diameterMm: 55,
        cornerRoundness: 0.7,
        rotationDeg: 0,
      });
      const twiceMinimumRadius =
        2 * Math.min(...vertices.map(({ x, y }) => Math.hypot(x, y)));
      const thickness = minRadialThickness(vertices);

      expect(thickness).toBeCloseTo(45.1961, 5);
      expect(thickness).not.toBeCloseTo(twiceMinimumRadius, 5);
    },
  );

  it("interpolates opposite radii for a non-uniform angular polygon", () => {
    const vertices = [
      { x: 10, y: 0 },
      { x: 0, y: 5 },
      { x: -7, y: 0 },
    ];

    expect(minRadialThickness(vertices)).toBeCloseTo(13.5, 10);
  });

  it.each([
    ["polygonArea", polygonArea],
    ["maxDiameter", maxDiameter],
    ["minRadialThickness", minRadialThickness],
  ] as const)("throws for non-finite coordinates in %s", (_label, metric) => {
    expect(() => metric([{ x: Number.NaN, y: 0 }])).toThrow(TypeError);
    expect(() => metric([{ x: 0, y: Number.POSITIVE_INFINITY }])).toThrow(
      TypeError,
    );
  });
});

describe("radialFactor", () => {
  it.each([
    ["shape", ["square", 6, 0, 0.5]],
    ["points below range", ["circle", 2, 0, 0.5]],
    ["points above range", ["circle", 17, 0, 0.5]],
    ["non-integer points", ["circle", 3.5, 0, 0.5]],
    ["non-finite points", ["circle", Number.NaN, 0, 0.5]],
    ["non-finite angle", ["circle", 6, Number.POSITIVE_INFINITY, 0.5]],
    ["roundness below range", ["circle", 6, 0, -0.1]],
    ["roundness above range", ["circle", 6, 0, 1.1]],
    ["non-finite roundness", ["circle", 6, 0, Number.NaN]],
  ] as const)("rejects invalid %s", (_label, args) => {
    expect(() =>
      radialFactor(
        args[0] as never,
        args[1],
        args[2],
        args[3],
      ),
    ).toThrow();
  });
});
