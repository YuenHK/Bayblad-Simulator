import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { adminHighScoringDesignsPageSchema } from "@steam-top/protocol";
import { HighScoringDesigns } from "./HighScoringDesigns";
import { RecordsTable } from "./RecordsTable";

it("renders all custom layer outlines and rotation with the historical scoring context", async () => {
  const data = adminHighScoringDesignsPageSchema.parse({ rows: [{
    designId: "550e8400-e29b-41d4-a716-446655440001", performanceModelVersion: "p1", physicsModelVersion: "v2", sampleSize: 1, participantObservations: 2, averageScore: 1.5,
    design: { layers: ["top", "middle", "bottom"].map(position => ({ position, shape: "custom", points: null, diameterMm: 28.284, actualAreaMm2: 400, holeCount: 3, rotationDeg: 30, cornerRoundness: 0, outline: { version: 1, mirror: "leftRight", vertices: [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }] } })), totalMassG: 10, metalDiscDiameterMm: 0, centerOfMassOffsetMm: 0, momentOfInertiaGmm2: 1000 },
  }], total: 1, page: 1, pageSize: 25 });
  Object.assign(data.rows[0]!.design, { screwRadiusMm: 0, screwRotationDeg: 0 });
  const { container } = render(<HighScoringDesigns data={data} onPage={() => undefined} />);
  await userEvent.click(screen.getByText("三層設計及装配參數"));
  expect(screen.getAllByRole("img", { name: "自定造型輪廓" })).toHaveLength(3);
  expect(container.querySelectorAll('polygon[transform="rotate(30)"]')).toHaveLength(3);
  expect(screen.getByText("1 場／2 次")).toBeInTheDocument();
  expect(screen.getByText("1.50")).toBeInTheDocument();
  expect(screen.getByText(/總重量 10 g/)).toBeInTheDocument();
  expect(screen.getByText(/螺絲孔半徑 0 mm/)).toBeInTheDocument();
  expect(screen.getByText(/螺絲組旋轉 0°/)).toBeInTheDocument();
  render(<RecordsTable data={{ rows: [{ rowId: "match:player1", matchId: "match", slot: "player1", occurredAt: "2026-09-01T00:00:00.000Z", identityId: null, className: null, identity: "學生", deviceName: null, design: data.rows[0]!.design, totalScore: 1.5 }], total: 1, page: 1, pageSize: 25 }} filters={{ from: "2026-09-01", to: "2026-09-01", className: "", identity: "", device: "", parameter: "", page: 1, pageSize: 25 }} onFilters={() => undefined} selectedIdentities={new Set()} onSelectIdentity={() => undefined} />);
  expect(screen.getAllByText(/螺絲孔半徑 0 mm/)).toHaveLength(2);
  expect(screen.getAllByText(/螺絲組旋轉 0°/)).toHaveLength(2);
});
