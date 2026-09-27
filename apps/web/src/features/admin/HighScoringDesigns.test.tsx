import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { adminHighScoringDesignsPageSchema } from "@steam-top/protocol";
import { HighScoringDesigns } from "./HighScoringDesigns";

it("renders all custom layer outlines and rotation with the historical scoring context", () => {
  const data = adminHighScoringDesignsPageSchema.parse({ rows: [{
    designId: "550e8400-e29b-41d4-a716-446655440001", performanceModelVersion: "p1", physicsModelVersion: "v2", sampleSize: 1, participantObservations: 2, averageScore: 1.5,
    design: { layers: ["top", "middle", "bottom"].map(position => ({ position, shape: "custom", points: null, diameterMm: 28.284, actualAreaMm2: 400, holeCount: 3, rotationDeg: 30, cornerRoundness: 0, outline: { version: 1, mirror: "leftRight", vertices: [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }] } })), totalMassG: 10, metalDiscDiameterMm: 0, centerOfMassOffsetMm: 0, momentOfInertiaGmm2: 1000 },
  }], total: 1, page: 1, pageSize: 25 });
  const { container } = render(<HighScoringDesigns data={data} onPage={() => undefined} />);
  expect(screen.getAllByRole("img", { name: "自定造型輪廓" })).toHaveLength(3);
  expect(container.querySelectorAll('polygon[transform="rotate(30)"]')).toHaveLength(3);
  expect(screen.getByText("1 場／2 次")).toBeInTheDocument();
  expect(screen.getByText("1.50")).toBeInTheDocument();
  expect(screen.getByText(/總重量 10 g/)).toBeInTheDocument();
});
