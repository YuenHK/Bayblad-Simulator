import { describe, expect, it } from "vitest";
import { makeDefaultDesign } from "@steam-top/domain";
import {
  createOutlineDraft,
  previewOutline,
  recordStroke,
  undoStroke,
  redoStroke,
} from "./customOutlineDraft";
import { designerReducer } from "./useDesigner";

const square = [
  { x: -20, y: -20 },
  { x: 20, y: -20 },
  { x: 20, y: 20 },
  { x: -20, y: 20 },
  { x: -20, y: -20 },
];
describe("自定輪廓草稿", () => {
  it.each([4, 6, 8, 12] as const)("%i 等分扇區產生有效完整輪廓", (mirror) => {
    const angle = (2 * Math.PI) / mirror;
    const raw = Array.from({ length: 6 }, (_, i) => ({
      x: 20 * Math.cos((angle * i) / 5),
      y: 20 * Math.sin((angle * i) / 5),
    }));
    const preview = previewOutline(
      recordStroke({ ...createOutlineDraft(), mirror }, raw),
    );
    expect(preview.valid).toBe(true);
    if (preview.valid)
      expect(preview.outline.vertices.length).toBeLessThanOrEqual(256);
  });
  it("上下鏡射與平滑只改預覽；超過 256 點不會靜默減點", () => {
    const raw = [
      { x: -20, y: 0.1 },
      { x: -20, y: 20 },
      { x: 20, y: 20 },
      { x: 20, y: 0.1 },
    ];
    const draft = recordStroke(
      { ...createOutlineDraft(), mirror: "topBottom" },
      raw,
    );
    expect(previewOutline({ ...draft, smoothing: 0.2 }).valid).toBe(true);
    expect(draft.raw).toEqual(raw);
    const circle = Array.from({ length: 301 }, (_, i) => ({
      x: 20 * Math.cos((i * 2 * Math.PI) / 300),
      y: 20 * Math.sin((i * 2 * Math.PI) / 300),
    }));
    expect(
      previewOutline(
        recordStroke({ ...createOutlineDraft(), simplifyMm: 0 }, circle),
      ).valid,
    ).toBe(false);
  });
  it("保留原始筆劃並支援復原重做及清除", () => {
    const draft = recordStroke(createOutlineDraft(), square);
    expect(previewOutline(draft).valid).toBe(true);
    expect(draft.raw).toEqual(square);
    expect(undoStroke(draft).raw).toEqual([]);
    expect(redoStroke(undoStroke(draft)).raw).toEqual(square);
    expect(recordStroke(draft, []).raw).toEqual([]);
  });
  it("鏡射筆劃結束時吸附，產生完整輪廓", () => {
    const draft = recordStroke(
      { ...createOutlineDraft(), mirror: "leftRight" },
      [
        { x: 0.4, y: 20 },
        { x: 20, y: 20 },
        { x: 20, y: -20 },
        { x: 0.3, y: -20 },
      ],
    );
    const preview = previewOutline(draft);
    expect(preview.valid).toBe(true);
    if (preview.valid)
      expect(preview.outline.vertices.some((p) => p.x === -20)).toBe(true);
    expect(draft.raw[0]!.x).toBe(0.4);
  });
  it("拒絕未閉合、超出筆劃上限、交叉及太小輪廓", () => {
    expect(
      previewOutline(recordStroke(createOutlineDraft(), square.slice(0, -1)))
        .valid,
    ).toBe(false);
    expect(
      previewOutline(
        recordStroke(
          createOutlineDraft(),
          Array.from({ length: 4097 }, () => ({ x: 20, y: 20 })),
        ),
      ).valid,
    ).toBe(false);
    expect(
      previewOutline(
        recordStroke(createOutlineDraft(), [
          square[0]!,
          square[2]!,
          square[1]!,
          square[3]!,
          square[0]!,
        ]),
      ).valid,
    ).toBe(false);
    expect(
      previewOutline(
        recordStroke(
          createOutlineDraft(),
          square.map((p) => ({ x: p.x / 4, y: p.y / 4 })),
        ),
      ).valid,
    ).toBe(false);
  });
  it("只原子套用有效輪廓，尺寸按軸心縮放而旋轉不改頂點", () => {
    const design = makeDefaultDesign();
    const preview = previewOutline(recordStroke(createOutlineDraft(), square));
    if (!preview.valid) throw Error("fixture");
    const layer = {
      ...design.layers[0],
      shape: "custom" as const,
      outline: preview.outline,
      diameterMm: preview.diameterMm,
    };
    const applied = designerReducer(design, { type: "replace-layer", layer });
    expect(applied.layers[0].shape).toBe("custom");
    const scaled = designerReducer(applied, {
      type: "update-layer",
      position: "top",
      field: "diameterMm",
      value: 40,
    });
    expect(
      Math.hypot(
        scaled.layers[0].outline!.vertices[0]!.x,
        scaled.layers[0].outline!.vertices[0]!.y,
      ),
    ).toBeCloseTo(20);
    const rotated = designerReducer(scaled, {
      type: "update-layer",
      position: "top",
      field: "rotationDeg",
      value: 30,
    });
    expect(rotated.layers[0].outline).toEqual(scaled.layers[0].outline);
    expect(
      designerReducer(applied, {
        type: "replace-layer",
        layer: { ...layer, outline: { ...preview.outline, vertices: [] } },
      }),
    ).toBe(applied);
    expect(
      designerReducer(applied, {
        type: "update-layer",
        position: "top",
        field: "diameterMm",
        value: NaN,
      }),
    ).toBe(applied);
  });
});
