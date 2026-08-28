import {
  intersection,
  union,
  type MultiPolygon,
  type Polygon,
} from "polygon-clipping";

import { designSchema, type TopDesign } from "./design";
import { makeLayerVertices, type Point } from "./geometry";

export const MATERIALS = {
  acrylicDensityGPerMm3: 0.00118,
  layerThicknessMm: 6,
  metalDensityGPerMm3: 0.00785,
  metalDiscThicknessMm: 1,
} as const;

/**
 * Conservative fabrication allowances for a 6.5 mm axle clearance hole and
 * 4 mm screw clearance holes. The safety margin is solid material left between
 * a hole and another cut edge.
 */
export const ASSEMBLY = {
  axleHoleRadiusMm: 3.25,
  screwHoleRadiusMm: 2,
  minimumMaterialNeckMm: 2,
} as const;

export type MassProperties = Readonly<{
  totalMassG: number;
  centerOfMassMm: Point;
  polarMomentGmm2: number;
}>;

export type CircularCutout = Readonly<{
  center: Point;
  radiusMm: number;
}>;

type PolygonSection = Readonly<{
  areaMm2: number;
  centroidMm: Point;
  polarSecondMomentAtOriginMm4: number;
}>;

const EPSILON = 1e-9;
const FULL_TURN = Math.PI * 2;

/**
 * Partial circular holes are clipped as inscribed regular polygons. At 512
 * sides their area error is below 0.003%, while fully contained, disjoint holes
 * continue to use exact circle formulae.
 */
export const CUTOUT_CIRCLE_SEGMENTS = 512;

function assertFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive`);
  }
}

function assertFinitePoint(point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TypeError("Geometry points must be finite");
  }
}

function polygonSection(vertices: readonly Point[]): PolygonSection {
  if (vertices.length < 3) {
    throw new RangeError("Invalid geometry: a polygon needs at least three vertices");
  }

  let doubleArea = 0;
  let centroidNumeratorX = 0;
  let centroidNumeratorY = 0;
  let polarNumerator = 0;

  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    if (current === undefined || next === undefined) {
      throw new RangeError("Invalid geometry: incomplete polygon vertices");
    }
    assertFinitePoint(current);
    assertFinitePoint(next);
    const cross = current.x * next.y - next.x * current.y;
    doubleArea += cross;
    centroidNumeratorX += (current.x + next.x) * cross;
    centroidNumeratorY += (current.y + next.y) * cross;
    polarNumerator +=
      cross *
      (current.x ** 2 +
        current.x * next.x +
        next.x ** 2 +
        current.y ** 2 +
        current.y * next.y +
        next.y ** 2);
  }

  const signedArea = doubleArea / 2;
  if (!Number.isFinite(signedArea) || Math.abs(signedArea) <= EPSILON) {
    throw new RangeError("Invalid geometry: polygon area must be positive");
  }

  const orientation = Math.sign(signedArea);
  const areaMm2 = Math.abs(signedArea);
  const centroidMm = {
    x: centroidNumeratorX / (6 * signedArea),
    y: centroidNumeratorY / (6 * signedArea),
  };
  const polarSecondMomentAtOriginMm4 =
    (orientation * polarNumerator) / 12;

  if (
    !Number.isFinite(centroidMm.x) ||
    !Number.isFinite(centroidMm.y) ||
    !Number.isFinite(polarSecondMomentAtOriginMm4) ||
    polarSecondMomentAtOriginMm4 < -EPSILON
  ) {
    throw new RangeError("Invalid geometry: polygon properties are not finite");
  }

  return {
    areaMm2,
    centroidMm,
    polarSecondMomentAtOriginMm4: Math.max(
      0,
      polarSecondMomentAtOriginMm4,
    ),
  };
}

function squaredDistance(left: Point, right: Point): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx ** 2 + dy ** 2;
  if (lengthSquared === 0) {
    return Math.sqrt(squaredDistance(point, start));
  }
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        lengthSquared,
    ),
  );
  return Math.hypot(
    point.x - (start.x + projection * dx),
    point.y - (start.y + projection * dy),
  );
}

function pointIsInsidePolygon(point: Point, vertices: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index, index += 1) {
    const currentVertex = vertices[index];
    const previousVertex = vertices[previous];
    if (currentVertex === undefined || previousVertex === undefined) {
      continue;
    }
    const crossesRay =
      currentVertex.y > point.y !== previousVertex.y > point.y &&
      point.x <
        ((previousVertex.x - currentVertex.x) *
          (point.y - currentVertex.y)) /
          (previousVertex.y - currentVertex.y) +
          currentVertex.x;
    if (crossesRay) {
      inside = !inside;
    }
  }
  return inside;
}

function circleFitsInsidePolygon(
  cutout: CircularCutout,
  vertices: readonly Point[],
): boolean {
  if (!pointIsInsidePolygon(cutout.center, vertices)) {
    return false;
  }
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    if (start !== undefined && end !== undefined) {
      minimumDistance = Math.min(
        minimumDistance,
        distanceToSegment(cutout.center, start, end),
      );
    }
  }
  return minimumDistance + EPSILON >= cutout.radiusMm;
}

type RemovedSection = Readonly<{
  areaMm2: number;
  firstMomentXmm3: number;
  firstMomentYmm3: number;
  polarSecondMomentAtOriginMm4: number;
}>;

function exactCircularSection(cutouts: readonly CircularCutout[]): RemovedSection {
  return cutouts.reduce<RemovedSection>(
    (section, cutout) => {
      const areaMm2 = Math.PI * cutout.radiusMm ** 2;
      return {
        areaMm2: section.areaMm2 + areaMm2,
        firstMomentXmm3:
          section.firstMomentXmm3 + areaMm2 * cutout.center.x,
        firstMomentYmm3:
          section.firstMomentYmm3 + areaMm2 * cutout.center.y,
        polarSecondMomentAtOriginMm4:
          section.polarSecondMomentAtOriginMm4 +
          (Math.PI * cutout.radiusMm ** 4) / 2 +
          areaMm2 * (cutout.center.x ** 2 + cutout.center.y ** 2),
      };
    },
    {
      areaMm2: 0,
      firstMomentXmm3: 0,
      firstMomentYmm3: 0,
      polarSecondMomentAtOriginMm4: 0,
    },
  );
}

function cutoutsAreDisjoint(cutouts: readonly CircularCutout[]): boolean {
  for (let leftIndex = 0; leftIndex < cutouts.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < cutouts.length;
      rightIndex += 1
    ) {
      const left = cutouts[leftIndex];
      const right = cutouts[rightIndex];
      if (left === undefined || right === undefined) {
        continue;
      }
      if (
        Math.sqrt(squaredDistance(left.center, right.center)) + EPSILON <
        left.radiusMm + right.radiusMm
      ) {
        return false;
      }
    }
  }
  return true;
}

function circlePolygon(cutout: CircularCutout): Polygon {
  return [
    Array.from({ length: CUTOUT_CIRCLE_SEGMENTS }, (_, index) => {
      const angle = (index / CUTOUT_CIRCLE_SEGMENTS) * FULL_TURN;
      return [
        cutout.center.x + Math.cos(angle) * cutout.radiusMm,
        cutout.center.y + Math.sin(angle) * cutout.radiusMm,
      ];
    }),
  ];
}

function polygonFromVertices(vertices: readonly Point[]): Polygon {
  return [vertices.map(({ x, y }) => [x, y])];
}

function multiPolygonSection(multiPolygon: MultiPolygon): RemovedSection {
  let areaMm2 = 0;
  let firstMomentXmm3 = 0;
  let firstMomentYmm3 = 0;
  let polarSecondMomentAtOriginMm4 = 0;

  for (const polygon of multiPolygon) {
    for (let ringIndex = 0; ringIndex < polygon.length; ringIndex += 1) {
      const ring = polygon[ringIndex];
      if (ring === undefined || ring.length < 3) {
        continue;
      }
      const section = polygonSection(
        ring.map(([x, y]) => ({ x, y })),
      );
      const sign = ringIndex === 0 ? 1 : -1;
      areaMm2 += sign * section.areaMm2;
      firstMomentXmm3 +=
        sign * section.areaMm2 * section.centroidMm.x;
      firstMomentYmm3 +=
        sign * section.areaMm2 * section.centroidMm.y;
      polarSecondMomentAtOriginMm4 +=
        sign * section.polarSecondMomentAtOriginMm4;
    }
  }

  if (
    !Number.isFinite(areaMm2) ||
    !Number.isFinite(firstMomentXmm3) ||
    !Number.isFinite(firstMomentYmm3) ||
    !Number.isFinite(polarSecondMomentAtOriginMm4) ||
    areaMm2 < -EPSILON ||
    polarSecondMomentAtOriginMm4 < -EPSILON
  ) {
    throw new RangeError("Invalid geometry: clipped cutout properties are not finite");
  }

  return {
    areaMm2: Math.max(0, areaMm2),
    firstMomentXmm3,
    firstMomentYmm3,
    polarSecondMomentAtOriginMm4: Math.max(
      0,
      polarSecondMomentAtOriginMm4,
    ),
  };
}

function clippedCutoutSection(
  vertices: readonly Point[],
  cutouts: readonly CircularCutout[],
): RemovedSection {
  if (cutouts.length === 0) {
    return exactCircularSection([]);
  }
  if (
    cutoutsAreDisjoint(cutouts) &&
    cutouts.every((cutout) => circleFitsInsidePolygon(cutout, vertices))
  ) {
    return exactCircularSection(cutouts);
  }

  const circlePolygons = cutouts.map(circlePolygon);
  const firstCircle = circlePolygons[0];
  if (firstCircle === undefined) {
    return exactCircularSection([]);
  }
  const combinedCutouts = union(firstCircle, ...circlePolygons.slice(1));
  const clipped = intersection(polygonFromVertices(vertices), combinedCutouts);
  return multiPolygonSection(clipped);
}

export function calculatePerforatedLayerMassProperties(
  vertices: readonly Point[],
  cutouts: readonly CircularCutout[],
  thicknessMm: number,
  densityGPerMm3: number,
): MassProperties {
  assertFinitePositive(thicknessMm, "thicknessMm");
  assertFinitePositive(densityGPerMm3, "densityGPerMm3");
  const section = polygonSection(vertices);
  for (const cutout of cutouts) {
    assertFinitePoint(cutout.center);
    assertFinitePositive(cutout.radiusMm, "cutout radiusMm");
  }
  const removed = clippedCutoutSection(vertices, cutouts);
  const netArea = section.areaMm2 - removed.areaMm2;
  const firstMomentX =
    section.areaMm2 * section.centroidMm.x - removed.firstMomentXmm3;
  const firstMomentY =
    section.areaMm2 * section.centroidMm.y - removed.firstMomentYmm3;
  const polarAtOrigin =
    section.polarSecondMomentAtOriginMm4 -
    removed.polarSecondMomentAtOriginMm4;

  if (
    !Number.isFinite(netArea) ||
    !Number.isFinite(polarAtOrigin) ||
    netArea <= EPSILON ||
    polarAtOrigin < -EPSILON
  ) {
    throw new RangeError(
      "Invalid geometry: cutouts leave non-positive area or polar moment",
    );
  }

  const centroid = {
    x: firstMomentX / netArea,
    y: firstMomentY / netArea,
  };
  const polarAtCentroid =
    Math.max(0, polarAtOrigin) -
    netArea * (centroid.x ** 2 + centroid.y ** 2);
  const massPerArea = thicknessMm * densityGPerMm3;
  const result = {
    totalMassG: netArea * massPerArea,
    centerOfMassMm: centroid,
    polarMomentGmm2: polarAtCentroid * massPerArea,
  };

  if (
    !Number.isFinite(result.totalMassG) ||
    !Number.isFinite(result.centerOfMassMm.x) ||
    !Number.isFinite(result.centerOfMassMm.y) ||
    !Number.isFinite(result.polarMomentGmm2) ||
    result.totalMassG < 0 ||
    result.polarMomentGmm2 < -EPSILON
  ) {
    throw new RangeError("Invalid geometry: mass properties must be finite and non-negative");
  }

  return {
    ...result,
    polarMomentGmm2: Math.max(0, result.polarMomentGmm2),
  };
}

function screwCutouts(design: TopDesign): CircularCutout[] {
  const rotation = (design.screwLayout.rotationDeg * Math.PI) / 180;
  return Array.from({ length: design.screwLayout.count }, (_, index) => {
    const angle = rotation + (index / design.screwLayout.count) * FULL_TURN;
    return {
      center: {
        x: Math.cos(angle) * design.screwLayout.radiusMm,
        y: Math.sin(angle) * design.screwLayout.radiusMm,
      },
      radiusMm: ASSEMBLY.screwHoleRadiusMm,
    };
  });
}

export function calculateMassProperties(input: TopDesign): MassProperties {
  const design = designSchema.parse(input);
  const screws = screwCutouts(design);
  const components: MassProperties[] = design.layers.map((layer) => {
    const vertices = makeLayerVertices(layer);
    const cutouts: CircularCutout[] = [
      { center: { x: 0, y: 0 }, radiusMm: ASSEMBLY.axleHoleRadiusMm },
      ...screws,
    ];
    return calculatePerforatedLayerMassProperties(
      vertices,
      cutouts,
      MATERIALS.layerThicknessMm,
      MATERIALS.acrylicDensityGPerMm3,
    );
  });

  if (design.metalDiscDiameterMm > 0) {
    const radiusMm = design.metalDiscDiameterMm / 2;
    const mass =
      Math.PI * radiusMm ** 2 *
      MATERIALS.metalDiscThicknessMm *
      MATERIALS.metalDensityGPerMm3;
    components.push({
      totalMassG: mass,
      centerOfMassMm: { x: 0, y: 0 },
      polarMomentGmm2: mass * radiusMm ** 2 / 2,
    });
  }

  const totalMassG = components.reduce(
    (sum, component) => sum + component.totalMassG,
    0,
  );
  if (!Number.isFinite(totalMassG) || totalMassG <= 0) {
    throw new RangeError("Invalid geometry: total mass must be finite and positive");
  }
  const centerOfMassMm = {
    x:
      components.reduce(
        (sum, component) =>
          sum + component.totalMassG * component.centerOfMassMm.x,
        0,
      ) / totalMassG,
    y:
      components.reduce(
        (sum, component) =>
          sum + component.totalMassG * component.centerOfMassMm.y,
        0,
      ) / totalMassG,
  };
  const polarAtOrigin = components.reduce(
    (sum, component) =>
      sum +
      component.polarMomentGmm2 +
      component.totalMassG *
        (component.centerOfMassMm.x ** 2 + component.centerOfMassMm.y ** 2),
    0,
  );
  const polarMomentGmm2 =
    polarAtOrigin -
    totalMassG * (centerOfMassMm.x ** 2 + centerOfMassMm.y ** 2);

  if (
    !Number.isFinite(centerOfMassMm.x) ||
    !Number.isFinite(centerOfMassMm.y) ||
    !Number.isFinite(polarMomentGmm2) ||
    polarMomentGmm2 < -EPSILON
  ) {
    throw new RangeError("Invalid geometry: combined mass properties are not finite");
  }

  return {
    totalMassG,
    centerOfMassMm,
    polarMomentGmm2: Math.max(0, polarMomentGmm2),
  };
}
