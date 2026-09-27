import { describe, expect, it } from "vitest";
import { publicBattleDesignSchema } from "./events";

const vertices = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
const layer = { id: "layer", shape: "custom", points: 6, diameterMm: Math.hypot(10, 10) * 2, cornerRoundness: 0, rotationDeg: 0, color: "#2563eb", outline: { version: 1, vertices, mirror: "none" } };
const design = { layers: ["top", "middle", "bottom"].map(position => ({ ...layer, id: position, position })), screwLayout: { count: 3, radiusMm: 6, rotationDeg: 0 }, metalDiscDiameterMm: 0 };

describe("public custom battle geometry", () => {
  it("preserves custom outlines in the public design", () => {
    expect(publicBattleDesignSchema.parse(design)).toEqual(design);
  });
  it("rejects custom geometry without an outline or with a forged diameter", () => {
    expect(publicBattleDesignSchema.safeParse({ ...design, layers: design.layers.map(l => ({ ...l, outline: undefined })) }).success).toBe(false);
    expect(publicBattleDesignSchema.safeParse({ ...design, layers: design.layers.map(l => ({ ...l, diameterMm: 60 })) }).success).toBe(false);
  });
});
