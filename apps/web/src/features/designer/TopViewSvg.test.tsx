import { fireEvent, render, screen, within } from "@testing-library/react";
import { makeDefaultDesign, type TopDesign } from "@steam-top/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("@react-three/fiber", () => ({
  Canvas: () => <div data-testid="mock-webgl-canvas" />,
}));

import { ExplodedView } from "./ExplodedView";
import {
  METAL_DISC_CENTER_Z,
  TopPreview3D,
  layerStackZ,
} from "./TopPreview3D";
import { TopViewSvg } from "./TopViewSvg";
import {
  clampPreviewZoom,
  rotatePreview,
  selectGesturePointers,
  zoomFromPinch,
} from "./previewGestures";

function designFixture(): TopDesign {
  const design = makeDefaultDesign();
  return {
    ...design,
    layers: [
      { ...design.layers[0], id: "blue-top", color: "#112233", diameterMm: 60 },
      { ...design.layers[1], id: "green-middle", color: "#445566" },
      { ...design.layers[2], id: "red-bottom", color: "#778899" },
    ],
    screwLayout: { count: 5, radiusMm: 14, rotationDeg: 18 },
  };
}

describe("TopViewSvg", () => {
  it("以固定 viewBox 顯示三層封閉路徑、實際層次與顏色", () => {
    const design = designFixture();
    const { container } = render(<TopViewSvg design={design} />);
    const svg = screen.getByRole("img", { name: "陀螺俯視圖" });
    const paths = within(svg).getAllByTestId("layer-path");

    expect(svg).toHaveAttribute("viewBox", "-34 -34 68 68");
    expect(paths).toHaveLength(3);
    expect(paths.map((path) => path.getAttribute("data-layer-id"))).toEqual([
      "red-bottom",
      "green-middle",
      "blue-top",
    ]);
    expect(paths.map((path) => path.getAttribute("data-position"))).toEqual([
      "bottom",
      "middle",
      "top",
    ]);
    expect(paths.map((path) => path.getAttribute("fill"))).toEqual([
      "#778899",
      "#445566",
      "#112233",
    ]);
    for (const path of paths) {
      expect(path.getAttribute("d")).toMatch(/^M .+ Z$/);
      expect(path).toHaveAttribute("vector-effect", "non-scaling-stroke");
    }
    const sixtyMillimetrePath = paths.find(
      (path) => path.getAttribute("data-layer-id") === "blue-top",
    )!;
    const coordinates = sixtyMillimetrePath.getAttribute("d")!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(Math.max(...coordinates.map(Math.abs))).toBeLessThanOrEqual(30.001);
    expect(Math.max(...coordinates.map(Math.abs))).toBeGreaterThanOrEqual(30);
    expect(container.querySelector("title")).toHaveTextContent("陀螺俯視圖");
    expect(container.querySelector("desc")).toHaveTextContent("頂層、中層、底層");
  });

  it("只畫一套共用螺絲孔和中央軸", () => {
    render(<TopViewSvg design={designFixture()} />);

    expect(screen.getAllByTestId("screw-hole")).toHaveLength(5);
    expect(screen.getByTestId("axle-hole")).toBeInTheDocument();
  });

  it("沒有金屬碟時不畫，有金屬碟時只畫一個置中無孔圓", () => {
    const design = designFixture();
    const { rerender } = render(<TopViewSvg design={design} />);
    expect(screen.queryByTestId("metal-disc")).not.toBeInTheDocument();

    rerender(<TopViewSvg design={{ ...design, metalDiscDiameterMm: 30 }} />);
    const metal = screen.getByTestId("metal-disc");
    expect(metal).toHaveAttribute("cx", "0");
    expect(metal).toHaveAttribute("cy", "0");
    expect(metal).toHaveAttribute("r", "15");
    expect(metal).not.toHaveAttribute("aria-label", expect.stringMatching(/孔/));
    expect(within(metal).queryByTestId("screw-hole")).not.toBeInTheDocument();
  });
});

describe("ExplodedView", () => {
  it("頂、中、底層對齊分開，金屬碟位於最低且不含螺絲孔", () => {
    const design = { ...designFixture(), metalDiscDiameterMm: 30 };
    render(<ExplodedView design={design} />);
    const graphic = screen.getByRole("img", { name: "陀螺分解圖" });
    const groups = within(graphic).getAllByTestId("exploded-layer");

    expect(groups.map((group) => group.getAttribute("data-position"))).toEqual([
      "top",
      "middle",
      "bottom",
    ]);
    expect(groups.map((group) => Number(group.getAttribute("data-offset-y")))).toEqual([48, 112, 176]);
    expect(screen.getByTestId("exploded-metal")).toHaveAttribute("data-offset-y", "234");
    expect(within(screen.getByTestId("exploded-metal")).queryByTestId("exploded-screw-hole")).not.toBeInTheDocument();
    expect(screen.getByText("頂層")).toBeVisible();
    expect(screen.getByText("中層")).toBeVisible();
    expect(screen.getByText("底層")).toBeVisible();
    expect(screen.getByText("金屬碟")).toBeVisible();
  });
});

describe("TopPreview3D", () => {
  it("WebGL 不可用時顯示可用的分解圖及說明", () => {
    render(<TopPreview3D design={designFixture()} forceFallback />);

    expect(screen.getByText("裝置未能啟用 3D，已顯示分解圖")).toBeVisible();
    expect(screen.getByRole("img", { name: "陀螺分解圖" })).toBeVisible();
  });

  it("只探測一次 WebGL，立即 capture pointer 並在遺失 capture 後清理", () => {
    const detectWebGL = vi.fn(() => true);
    render(<TopPreview3D design={designFixture()} detectWebGL={detectWebGL} />);
    const controls = screen.getByRole("group", { name: /3D 陀螺預覽控制/ });
    const setPointerCapture = vi.fn();
    Object.defineProperty(controls, "setPointerCapture", { configurable: true, value: setPointerCapture });

    fireEvent.pointerDown(controls, { pointerId: 12, clientX: 20, clientY: 20 });
    expect(setPointerCapture).toHaveBeenCalledWith(12);
    expect(screen.getByRole("status")).toHaveTextContent("正在旋轉預覽");
    fireEvent.lostPointerCapture(controls, { pointerId: 12 });
    fireEvent.pointerDown(controls, { pointerId: 13, clientX: 30, clientY: 30 });
    expect(screen.getByRole("status")).toHaveTextContent("正在旋轉預覽");
    expect(detectWebGL).toHaveBeenCalledTimes(1);
  });

  it("可用鍵盤旋轉和縮放並公告狀態", () => {
    render(<TopPreview3D design={designFixture()} detectWebGL={() => true} />);
    const controls = screen.getByRole("group", { name: /3D 陀螺預覽控制/ });
    expect(controls).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(controls, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("已用鍵盤旋轉預覽");
    fireEvent.keyDown(controls, { key: "+" });
    expect(screen.getByRole("status")).toHaveTextContent("已用鍵盤縮放預覽");
  });

  it("以 6 mm 由底至頂堆疊層板，1 mm 金屬碟位於底層下", () => {
    expect(layerStackZ("bottom")).toBe(0);
    expect(layerStackZ("middle")).toBe(6);
    expect(layerStackZ("top")).toBe(12);
    expect(METAL_DISC_CENTER_Z).toBe(-0.5);
  });
});

describe("3D 手勢數學", () => {
  it("單指位移以 1:1 連續增量旋轉", () => {
    const rotation = rotatePreview({ x: 0.2, y: -0.1 }, { x: 12, y: -8 });
    expect(rotation.x).toBeCloseTo(0.12);
    expect(rotation.y).toBeCloseTo(0.02);
  });

  it("雙指 pinch 連續縮放並 clamp 至安全範圍", () => {
    expect(zoomFromPinch(1, 100, 125)).toBe(1.25);
    expect(zoomFromPinch(1.8, 100, 200)).toBe(2.2);
    expect(clampPreviewZoom(0.1)).toBe(0.55);
    expect(clampPreviewZoom(9)).toBe(2.2);
  });

  it("多指變動時可以新的兩指距離無跳動續接", () => {
    const pointers = new Map([
      [4, { x: 0, y: 0 }],
      [7, { x: 80, y: 0 }],
      [9, { x: 155, y: 0 }],
    ]);
    expect(selectGesturePointers(pointers)).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ]);
    const beforeLift = zoomFromPinch(1, 80, 120);
    expect(beforeLift).toBe(1.5);
    pointers.delete(4);
    expect(selectGesturePointers(pointers)).toEqual([
      { x: 80, y: 0 },
      { x: 155, y: 0 },
    ]);
    expect(zoomFromPinch(beforeLift, 75, 75)).toBe(beforeLift);
  });
});
