import { designSchema, type Layer, type TopDesign } from "./design";
import { makeLayerVertices, maxDiameter, type Point } from "./geometry";
import {
  ASSEMBLY,
  MATERIALS,
  calculateMassProperties,
  type MassProperties,
} from "./mass";

export type RuleIssueCode =
  | "DIAMETER_OVER_60"
  | "HEIGHT_OVER_40"
  | "WEIGHT_OVER_60"
  | "SCREW_OUTSIDE_LAYER"
  | "SCREW_HITS_AXLE"
  | "NECK_TOO_THIN"
  | "METAL_DISC_OUTSIDE_BOTTOM";

export type RuleIssue = Readonly<{
  code: RuleIssueCode;
  layerId: string | null;
  field: string;
  message: string;
}>;

export type DesignValidation = Readonly<{
  valid: boolean;
  issues: readonly RuleIssue[];
  massProperties: MassProperties;
}>;

const MAX_DIAMETER_MM = 60;
const MAX_HEIGHT_MM = 40;
const MAX_WEIGHT_G = 60;
const EPSILON = 1e-9;
const FULL_TURN = Math.PI * 2;

function globalIssue(
  code: RuleIssueCode,
  field: string,
  message: string,
): RuleIssue {
  return { code, layerId: null, field, message };
}

export function validateMassLimit(totalMassG: number): RuleIssue[] {
  if (!Number.isFinite(totalMassG)) {
    throw new TypeError("totalMassG must be finite");
  }
  return totalMassG > MAX_WEIGHT_G
    ? [
        globalIssue(
          "WEIGHT_OVER_60",
          "massProperties.totalMassG",
          "陀螺重量超過 60 克上限。",
        ),
      ]
    : [];
}

export function validateHeightLimit(heightMm: number): RuleIssue[] {
  if (!Number.isFinite(heightMm) || heightMm < 0) {
    throw new TypeError("heightMm must be finite and non-negative");
  }
  return heightMm > MAX_HEIGHT_MM
    ? [
        globalIssue(
          "HEIGHT_OVER_40",
          "heightMm",
          "陀螺高度超過 40 毫米上限。",
        ),
      ]
    : [];
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx ** 2 + dy ** 2;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
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
  for (
    let index = 0, previous = vertices.length - 1;
    index < vertices.length;
    previous = index, index += 1
  ) {
    const currentVertex = vertices[index];
    const previousVertex = vertices[previous];
    if (currentVertex === undefined || previousVertex === undefined) {
      continue;
    }
    if (
      currentVertex.y > point.y !== previousVertex.y > point.y &&
      point.x <
        ((previousVertex.x - currentVertex.x) *
          (point.y - currentVertex.y)) /
          (previousVertex.y - currentVertex.y) +
          currentVertex.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function minimumBoundaryDistance(
  point: Point,
  vertices: readonly Point[],
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    if (start !== undefined && end !== undefined) {
      minimum = Math.min(minimum, distanceToSegment(point, start, end));
    }
  }
  return minimum;
}

function circleClearance(
  center: Point,
  radiusMm: number,
  vertices: readonly Point[],
): number {
  const boundaryDistance = minimumBoundaryDistance(center, vertices);
  return pointIsInsidePolygon(center, vertices)
    ? boundaryDistance - radiusMm
    : -boundaryDistance - radiusMm;
}

function layerCircleClearance(
  layer: Layer,
  center: Point,
  radiusMm: number,
  vertices: readonly Point[],
): number {
  if (layer.shape === "circle") {
    return layer.diameterMm / 2 - Math.hypot(center.x, center.y) - radiusMm;
  }
  return circleClearance(center, radiusMm, vertices);
}

function screwCenters(design: TopDesign): Point[] {
  const rotation = (design.screwLayout.rotationDeg * Math.PI) / 180;
  return Array.from({ length: design.screwLayout.count }, (_, index) => {
    const angle = rotation + (index / design.screwLayout.count) * FULL_TURN;
    return {
      x: Math.cos(angle) * design.screwLayout.radiusMm,
      y: Math.sin(angle) * design.screwLayout.radiusMm,
    };
  });
}

function interScrewGaps(centers: readonly Point[]): number[] {
  const gaps: number[] = [];
  for (let leftIndex = 0; leftIndex < centers.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < centers.length; rightIndex += 1) {
      const left = centers[leftIndex];
      const right = centers[rightIndex];
      if (left === undefined || right === undefined) {
        continue;
      }
      const gap =
        Math.hypot(left.x - right.x, left.y - right.y) -
        2 * ASSEMBLY.screwHoleRadiusMm;
      gaps.push(gap);
    }
  }
  return gaps;
}

type LayerMaterialClearances = Readonly<{
  screwClearances: readonly number[];
  axleClearance: number;
}>;

type MaterialClearances = Readonly<{
  layers: readonly LayerMaterialClearances[];
  axleGap: number;
  interScrewGaps: readonly number[];
}>;

function calculateMaterialClearances(design: TopDesign): MaterialClearances {
  const centers = screwCenters(design);
  return {
    layers: design.layers.map((layer) => {
      const vertices = makeLayerVertices(layer);
      return {
        screwClearances: centers.map((center) =>
          layerCircleClearance(
            layer,
            center,
            ASSEMBLY.screwHoleRadiusMm,
            vertices,
          ),
        ),
        axleClearance: layerCircleClearance(
          layer,
          { x: 0, y: 0 },
          ASSEMBLY.axleHoleRadiusMm,
          vertices,
        ),
      };
    }),
    axleGap:
      design.screwLayout.radiusMm -
      ASSEMBLY.axleHoleRadiusMm -
      ASSEMBLY.screwHoleRadiusMm,
    interScrewGaps: interScrewGaps(centers),
  };
}

function minimumMaterialClearance(clearances: MaterialClearances): number {
  return Math.min(
    clearances.axleGap,
    ...clearances.interScrewGaps,
    ...clearances.layers.flatMap(({ screwClearances, axleClearance }) => [
      ...screwClearances,
      axleClearance,
    ]),
  );
}

export function calculateMinimumMaterialNeckMm(input: TopDesign): number {
  const design = designSchema.parse(input);
  return minimumMaterialClearance(calculateMaterialClearances(design));
}

export function validateDesign(input: TopDesign): DesignValidation {
  const design = designSchema.parse(input);
  const massProperties = calculateMassProperties(design);
  const issues: RuleIssue[] = [];
  const materialClearances = calculateMaterialClearances(design);

  for (const [layerIndex, layer] of design.layers.entries()) {
    const vertices = makeLayerVertices(layer);
    if (maxDiameter(vertices) > MAX_DIAMETER_MM + EPSILON) {
      issues.push({
        code: "DIAMETER_OVER_60",
        layerId: layer.id,
        field: "layers.diameterMm",
        message: "層板直徑超過 60 毫米上限。",
      });
    }

    const layerClearances = materialClearances.layers[layerIndex];
    if (layerClearances === undefined) {
      throw new RangeError("Missing material clearances for design layer");
    }
    const hasOutsideScrew = layerClearances.screwClearances.some(
      (clearance) => clearance < -EPSILON,
    );
    const hasThinNeck = layerClearances.screwClearances.some(
      (clearance) =>
        clearance >= -EPSILON &&
        clearance + EPSILON < ASSEMBLY.minimumMaterialNeckMm,
    );
    if (hasOutsideScrew) {
      issues.push({
        code: "SCREW_OUTSIDE_LAYER",
        layerId: layer.id,
        field: "screwLayout",
        message: "螺絲孔未完整落在這一層的輪廓內。",
      });
    }

    if (
      hasThinNeck ||
      layerClearances.axleClearance + EPSILON <
        ASSEMBLY.minimumMaterialNeckMm
    ) {
      issues.push({
        code: "NECK_TOO_THIN",
        layerId: layer.id,
        field: "layers",
        message: "孔與層板輪廓之間的材料厚度不足。",
      });
    }
  }

  if (materialClearances.axleGap < -EPSILON) {
    issues.push(
      globalIssue(
        "SCREW_HITS_AXLE",
        "screwLayout.radiusMm",
        "螺絲孔與中央軸孔重疊。",
      ),
    );
  } else if (
    materialClearances.axleGap + EPSILON < ASSEMBLY.minimumMaterialNeckMm
  ) {
    issues.push(
      globalIssue(
        "NECK_TOO_THIN",
        "screwLayout.radiusMm",
        "螺絲孔與中央軸孔之間的材料厚度不足。",
      ),
    );
  }
  if (
    materialClearances.interScrewGaps.some(
      (gap) => gap + EPSILON < ASSEMBLY.minimumMaterialNeckMm,
    )
  ) {
    issues.push(
      globalIssue(
        "NECK_TOO_THIN",
        "screwLayout",
        "螺絲孔之間的材料厚度不足。",
      ),
    );
  }

  if (design.metalDiscDiameterMm > 0) {
    const bottomVertices = makeLayerVertices(design.layers[2]);
    const metalClearance = layerCircleClearance(
      design.layers[2],
      { x: 0, y: 0 },
      design.metalDiscDiameterMm / 2,
      bottomVertices,
    );
    if (metalClearance < -EPSILON) {
      issues.push({
        code: "METAL_DISC_OUTSIDE_BOTTOM",
        layerId: design.layers[2].id,
        field: "metalDiscDiameterMm",
        message: "金屬碟未完整落在最底層輪廓內。",
      });
    }
  }

  const fixedHeightMm =
    design.layers.length * MATERIALS.layerThicknessMm +
    (design.metalDiscDiameterMm > 0 ? MATERIALS.metalDiscThicknessMm : 0);
  issues.push(...validateHeightLimit(fixedHeightMm));
  issues.push(...validateMassLimit(massProperties.totalMassG));

  return {
    valid: issues.length === 0,
    issues,
    massProperties,
  };
}
