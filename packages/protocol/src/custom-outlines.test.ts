import { describe, expect, it } from "vitest";
import { publicBattleDesignSchema, adminDesignParametersSchema } from "./events";

const vertices = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
const layer = { id: "layer", shape: "custom", points: 6, diameterMm: Math.hypot(10, 10) * 2, cornerRoundness: 0, rotationDeg: 0, color: "#2563eb", outline: { version: 1, vertices, mirror: "none" } };
const design = { layers: ["top", "middle", "bottom"].map(position => ({ ...layer, id: position, position })), screwLayout: { count: 3, radiusMm: 6, rotationDeg: 0 }, metalDiscDiameterMm: 0 };

describe("public custom battle geometry", () => {
  it("allows teacher records to mark custom corner counts not applicable", () => {
    const parameters = { layers: design.layers.map(l => ({ position: l.position, shape: l.shape, points: null, diameterMm: l.diameterMm, actualAreaMm2: 400, holeCount: 3, rotationDeg: 0, cornerRoundness: 0, outline: l.outline })), totalMassG: 10, metalDiscDiameterMm: 0, centerOfMassOffsetMm: 0, momentOfInertiaGmm2: 1000 };
    expect(adminDesignParametersSchema.parse(parameters)).toEqual(parameters);
  });
  it("preserves custom outlines in the public design", () => {
    expect(publicBattleDesignSchema.parse(design)).toEqual(design);
  });
  it("rejects custom geometry without an outline or with a forged diameter", () => {
    expect(publicBattleDesignSchema.safeParse({ ...design, layers: design.layers.map(l => ({ ...l, outline: undefined })) }).success).toBe(false);
    expect(publicBattleDesignSchema.safeParse({ ...design, layers: design.layers.map(l => ({ ...l, diameterMm: 60 })) }).success).toBe(false);
  });
});
