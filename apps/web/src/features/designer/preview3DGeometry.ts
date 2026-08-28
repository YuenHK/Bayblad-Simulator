import {
  ASSEMBLY,
  MATERIALS,
  makeLayerVertices,
  type Layer,
  type TopDesign,
} from "@steam-top/domain";
import { CylinderGeometry, Path, Shape } from "three";

import { screwCenters } from "./previewGeometry";

const FULL_TURN = Math.PI * 2;

export function makeAcrylicShape(layer: Layer, design: TopDesign): Shape {
  const vertices = makeLayerVertices(layer);
  const first = vertices[0];
  const shape = new Shape();
  if (first === undefined) return shape;
  shape.moveTo(first.x, first.y);
  for (const vertex of vertices.slice(1)) shape.lineTo(vertex.x, vertex.y);
  shape.closePath();

  const axle = new Path();
  axle.absarc(0, 0, ASSEMBLY.axleHoleRadiusMm, 0, FULL_TURN, true);
  shape.holes.push(axle);
  for (const center of screwCenters(design)) {
    const screw = new Path();
    screw.absarc(
      center.x,
      center.y,
      ASSEMBLY.screwHoleRadiusMm,
      0,
      FULL_TURN,
      true,
    );
    shape.holes.push(screw);
  }
  return shape;
}

export function makeSolidMetalDiscGeometry(
  diameterMm: number,
): CylinderGeometry {
  return new CylinderGeometry(
    diameterMm / 2,
    diameterMm / 2,
    MATERIALS.metalDiscThicknessMm,
    64,
  );
}
