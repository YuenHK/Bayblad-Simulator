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

export function calculatePerforatedLayerMassProperties(
  vertices: readonly Point[],
  cutouts: readonly CircularCutout[],
  thicknessMm: number,
  densityGPerMm3: number,
): MassProperties {
  assertFinitePositive(thicknessMm, "thicknessMm");
  assertFinitePositive(densityGPerMm3, "densityGPerMm3");
  const section = polygonSection(vertices);
  let netArea = section.areaMm2;
  let firstMomentX = section.areaMm2 * section.centroidMm.x;
  let firstMomentY = section.areaMm2 * section.centroidMm.y;
  let polarAtOrigin = section.polarSecondMomentAtOriginMm4;

  for (const cutout of cutouts) {
    assertFinitePoint(cutout.center);
    assertFinitePositive(cutout.radiusMm, "cutout radiusMm");
    const area = Math.PI * cutout.radiusMm ** 2;
    netArea -= area;
    firstMomentX -= area * cutout.center.x;
    firstMomentY -= area * cutout.center.y;
    polarAtOrigin -=
      (Math.PI * cutout.radiusMm ** 4) / 2 +
      area * (cutout.center.x ** 2 + cutout.center.y ** 2);
  }

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
      ...screws.filter((cutout) => circleFitsInsidePolygon(cutout, vertices)),
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
