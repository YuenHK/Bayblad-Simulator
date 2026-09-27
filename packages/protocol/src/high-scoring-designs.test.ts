import { expect, it } from "vitest";
import { adminHighScoringDesignsPageSchema } from "./events";

const row = {
  designId: "550e8400-e29b-41d4-a716-446655440001", performanceModelVersion: "perf-1", physicsModelVersion: "physics-1", sampleSize: 1, participantObservations: 2, averageScore: 1.5,
  design: { layers: ["top", "middle", "bottom"].map(position => ({ position, shape: "custom", points: null, diameterMm: 28.284, actualAreaMm2: 400, holeCount: 3, rotationDeg: 30, cornerRoundness: 0, outline: { version: 1, mirror: "leftRight", vertices: [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }] } })), totalMassG: 10, metalDiscDiameterMm: 0, centerOfMassOffsetMm: 0, momentOfInertiaGmm2: 1000 },
};
it("preserves complete design geometry and model/sample semantics", () => {
  const page = { rows: [row], total: 1, page: 1, pageSize: 25 };
  expect(adminHighScoringDesignsPageSchema.parse(page)).toEqual(page);
  for (const invalid of [{ sampleSize: 0 }, { participantObservations: 0 }, { physicsModelVersion: "" }, { performanceModelVersion: "" }, { designId: "not-an-id" }, { averageScore: Infinity }, { design: { ...row.design, layers: row.design.layers.slice(1) } }]) {
    expect(adminHighScoringDesignsPageSchema.safeParse({ ...page, rows: [{ ...row, ...invalid }] }).success).toBe(false);
  }
});
it("accepts optional screw assembly radius and rotation including zero", () => {
  const page = { rows: [{ ...row, design: { ...row.design, screwRadiusMm: 0, screwRotationDeg: 0 } }], total: 1, page: 1, pageSize: 25 };
  expect(adminHighScoringDesignsPageSchema.safeParse(page).success).toBe(true);
  expect(adminHighScoringDesignsPageSchema.parse(page)).toEqual(page);
});
