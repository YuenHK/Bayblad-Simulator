import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { StaticDesignPreview, projectRecordDesign } from "./StaticDesignPreview";
import type { RecordRow } from "./types";
const design: RecordRow["design"] = {
  layers: ["top", "middle", "bottom"].map(position => ({ position: position as "top" | "middle" | "bottom", shape: "circle", points: 6, diameterMm: 50, actualAreaMm2: 1000, holeCount: 4, rotationDeg: 0, cornerRoundness: 0, color: "#2563eb" })),
  totalMassG: 30, metalDiscDiameterMm: 20, centerOfMassOffsetMm: 0, momentOfInertiaGmm2: 1000, screwRadiusMm: 15, screwRotationDeg: 0,
};
it("renders a static three-dimensional historical design without a WebGL context", () => {
  const faces = projectRecordDesign(design);
  expect(faces.length).toBeGreaterThan(10);
  expect(faces.every(face => !/NaN|Infinity/.test(face.points))).toBe(true);
  const { container } = render(<StaticDesignPreview design={design} />);
  expect(screen.getByRole("img", { name: "歷史陀螺靜態 3D" })).toBeInTheDocument();
  expect(container.querySelector("canvas")).toBeNull();
});
it("uses actual custom outlines and does not invent missing hole placement", () => {
  const custom = { ...design, layers: design.layers.map(layer => ({ ...layer, shape: "custom" as const, points: null, diameterMm: Math.hypot(25,25)*2, outline: { version: 1 as const, mirror: "none" as const, vertices: [{x:-25,y:-25},{x:25,y:-25},{x:25,y:25},{x:0,y:15},{x:-25,y:25}] } })) };
  expect(projectRecordDesign(custom)).not.toEqual(projectRecordDesign(design));
  const { screwRadiusMm: _, ...incomplete } = design;
  render(<StaticDesignPreview design={incomplete} />);
  expect(screen.getByText(/裝配資料不足/)).toBeInTheDocument();
});
