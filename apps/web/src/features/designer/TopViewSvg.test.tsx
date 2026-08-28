import { fireEvent, render, screen, within } from "@testing-library/react";
import { MATERIALS, makeDefaultDesign, type TopDesign } from "@steam-top/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtrudeGeometry, OrthographicCamera } from "three";
import { lazy, Suspense } from "react";

const { mockCanvasState, mockUseThree } = vi.hoisted(() => ({
  mockCanvasState: { renderFirstChild: false },
  mockUseThree: vi.fn(),
}));

vi.mock("@react-three/fiber", async () => {
  const { Children } = await import("react");
  return {
  Canvas: ({ children, frameloop, dpr }: {
    children?: React.ReactNode;
    frameloop?: string;
    dpr?: number | readonly [number, number];
  }) => (
    <div
      data-testid="mock-webgl-canvas"
      data-frameloop={frameloop}
      data-dpr={JSON.stringify(dpr)}
    >
      {mockCanvasState.renderFirstChild
        ? Children.toArray(children)[0]
        : null}
    </div>
  ),
  useThree: mockUseThree,
  };
});

import { ExplodedView } from "./ExplodedView";
import {
  METAL_DISC_CENTER_Z,
  CenteredModel,
  FitOrthographicCamera,
  InvalidateOnSceneChange,
  TopPreview3D,
  WebGLContextLossHandler,
  layerStackZ,
} from "./TopPreview3D";
import { TopViewSvg } from "./TopViewSvg";
import {
  clampPreviewZoom,
  rotatePreview,
  selectGesturePointers,
  zoomFromPinch,
} from "./previewGestures";
import {
  PREVIEW_FIT_PADDING,
  calculateOrthographicFit,
  calculatePreviewBounds,
} from "./previewBounds";
import {
  makeAcrylicShape,
  makeSolidMetalDiscGeometry,
} from "./preview3DGeometry";
import { PreviewErrorBoundary } from "./PreviewErrorBoundary";

afterEach(() => {
  mockCanvasState.renderFirstChild = false;
  mockUseThree.mockReset();
});

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
      expect(path.getAttribute("mask")).toMatch(/^url\(#.+-acrylic-cutouts\)$/);
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

    const mask = screen.getByTestId("acrylic-cutout-mask");
    expect(mask).toHaveAttribute("maskUnits", "userSpaceOnUse");
    expect(within(mask).getAllByTestId("screw-hole")).toHaveLength(5);
    expect(within(mask).getByTestId("axle-hole")).toHaveAttribute("fill", "black");
    for (const hole of within(mask).getAllByTestId("screw-hole")) {
      expect(hole).toHaveAttribute("fill", "black");
    }
  });

  it("mask 範圍覆蓋 80 mm 草稿層，不會額外裁成平邊", () => {
    const source = designFixture();
    const design: TopDesign = {
      ...source,
      layers: source.layers.map((layer) => ({
        ...layer,
        shape: "circle",
        diameterMm: 80,
      })) as TopDesign["layers"],
    };
    render(<TopViewSvg design={design} />);

    const mask = screen.getByTestId("acrylic-cutout-mask");
    const maskX = Number(mask.getAttribute("x"));
    const maskWidth = Number(mask.getAttribute("width"));
    const pathCoordinates = screen.getAllByTestId("layer-path")[0]!
      .getAttribute("d")!
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number);
    const maximumRadius = Math.max(...pathCoordinates.map(Math.abs));

    expect(maximumRadius).toBe(40);
    expect(maskX).toBeLessThanOrEqual(-(maximumRadius + 0.4));
    expect(maskX + maskWidth).toBeGreaterThanOrEqual(maximumRadius + 0.4);
    expect(mask.querySelector("rect")).toHaveAttribute(
      "width",
      mask.getAttribute("width"),
    );
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
    expect(metal).not.toHaveAttribute("mask");
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
    const mask = within(graphic).getByTestId("acrylic-cutout-mask");

    expect(groups.map((group) => group.getAttribute("data-position"))).toEqual([
      "top",
      "middle",
      "bottom",
    ]);
    expect(groups.map((group) => Number(group.getAttribute("data-offset-y")))).toEqual([48, 112, 176]);
    expect(within(mask).getAllByTestId("screw-hole")).toHaveLength(5);
    for (const group of groups) {
      expect(group.querySelector("path")).toHaveAttribute(
        "mask",
        expect.stringMatching(/^url\(#.+-exploded-cutouts\)$/),
      );
    }
    expect(screen.getByTestId("exploded-metal")).toHaveAttribute("data-offset-y", "234");
    expect(screen.getByTestId("exploded-metal")).not.toHaveAttribute("mask");
    expect(within(screen.getByTestId("exploded-metal")).queryByTestId("exploded-screw-hole")).not.toBeInTheDocument();
    expect(screen.getByText("頂層")).toBeVisible();
    expect(screen.getByText("中層")).toBeVisible();
    expect(screen.getByText("底層")).toBeVisible();
    expect(screen.getByText("金屬碟")).toBeVisible();
  });

  it("完整顯示 80 mm 草稿層而不受 cutout mask 裁切", () => {
    const source = designFixture();
    const design: TopDesign = {
      ...source,
      layers: source.layers.map((layer) => ({
        ...layer,
        shape: "circle",
        diameterMm: 80,
      })) as TopDesign["layers"],
    };
    render(<ExplodedView design={design} />);

    const graphic = screen.getByRole("img", { name: "陀螺分解圖" });
    const mask = within(graphic).getByTestId("acrylic-cutout-mask");
    expect(mask).toHaveAttribute("x", "-42");
    expect(mask).toHaveAttribute("y", "-42");
    expect(mask).toHaveAttribute("width", "84");
    expect(mask).toHaveAttribute("height", "84");
    expect(within(graphic).getAllByTestId("exploded-layer")).toHaveLength(3);
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

  it("提供穩定 selector 並以 demand frameloop 及受限 DPR 運作", () => {
    render(<TopPreview3D design={designFixture()} detectWebGL={() => true} />);
    expect(screen.getByTestId("top-preview-3d")).toHaveAccessibleName(
      /3D 陀螺預覽控制/,
    );
    expect(screen.getByTestId("mock-webgl-canvas")).toHaveAttribute(
      "data-frameloop",
      "demand",
    );
    expect(screen.getByTestId("mock-webgl-canvas")).toHaveAttribute(
      "data-dpr",
      "[1,1.5]",
    );
  });

  it("WebGL context loss 會 preventDefault 並立即切換分解圖", () => {
    const canvas = document.createElement("canvas");
    const addEventListener = vi.spyOn(canvas, "addEventListener");
    const removeEventListener = vi.spyOn(canvas, "removeEventListener");
    mockUseThree.mockReturnValue({ gl: { domElement: canvas } });
    mockCanvasState.renderFirstChild = true;
    render(<TopPreview3D design={designFixture()} detectWebGL={() => true} />);

    expect(addEventListener).toHaveBeenCalledWith(
      "webglcontextlost",
      expect.any(Function),
    );
    const event = new Event("webglcontextlost", { cancelable: true });
    fireEvent(canvas, event);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText("裝置未能啟用 3D，已顯示分解圖")).toBeVisible();
    expect(removeEventListener).toHaveBeenCalledWith(
      "webglcontextlost",
      expect.any(Function),
    );
  });

  it("context loss listener 在正常 unmount 時移除", () => {
    const canvas = document.createElement("canvas");
    const removeEventListener = vi.spyOn(canvas, "removeEventListener");
    mockUseThree.mockReturnValue({ gl: { domElement: canvas } });
    const onContextLost = vi.fn();
    const { unmount } = render(
      <WebGLContextLossHandler onContextLost={onContextLost} />,
    );
    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "webglcontextlost",
      expect.any(Function),
    );
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

  it("Three acrylic Shape 建立中軸及共用螺絲真孔，並可有限擠出", () => {
    const design = designFixture();
    const shape = makeAcrylicShape(design.layers[0], design);
    expect(shape.holes).toHaveLength(1 + design.screwLayout.count);
    const geometry = new ExtrudeGeometry(shape, {
      depth: MATERIALS.layerThicknessMm,
      bevelEnabled: false,
    });
    const positions = geometry.getAttribute("position");
    expect(positions.count).toBeGreaterThan(0);
    for (let index = 0; index < positions.count; index += 1) {
      expect(Number.isFinite(positions.getX(index))).toBe(true);
      expect(Number.isFinite(positions.getY(index))).toBe(true);
      expect(Number.isFinite(positions.getZ(index))).toBe(true);
    }
    geometry.dispose();
  });

  it("金屬碟使用實心 CylinderGeometry，不共用 acrylic holes", () => {
    const geometry = makeSolidMetalDiscGeometry(55);
    expect(geometry.type).toBe("CylinderGeometry");
    expect(geometry.index?.count).toBeGreaterThan(0);
    expect(geometry.parameters.height).toBe(MATERIALS.metalDiscThicknessMm);
    geometry.dispose();
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

describe("3D 預覽取景", () => {
  it("以最大 60 mm 層板和完整 0..18 mm 高度計算無金屬碟邊界", () => {
    const design = designFixture();
    const bounds = calculatePreviewBounds(design);

    expect(bounds.maxRadialExtentMm).toBeCloseTo(30);
    expect(bounds.minZMm).toBe(0);
    expect(bounds.maxZMm).toBe(18);
    expect(bounds.centerZMm).toBe(9);
    expect(bounds.boundingSphereRadiusMm).toBeCloseTo(Math.hypot(30, 9));
  });

  it("金屬碟設計包含 -1..18 mm 高度並取最大徑向範圍", () => {
    const source = designFixture();
    const design: TopDesign = {
      ...source,
      layers: source.layers.map((layer) => ({ ...layer, diameterMm: 40 })) as TopDesign["layers"],
      metalDiscDiameterMm: 55,
    };
    const bounds = calculatePreviewBounds(design);

    expect(bounds.maxRadialExtentMm).toBeCloseTo(27.5);
    expect(bounds.minZMm).toBe(-1);
    expect(bounds.maxZMm).toBe(18);
    expect(bounds.centerZMm).toBe(8.5);
    expect(bounds.boundingSphereRadiusMm).toBeCloseTo(Math.hypot(27.5, 9.5));
  });

  it.each([
    ["窄屏 390 viewport 預覽區", 328, 280],
    ["桌面預覽區", 1088, 320],
  ])("%s 的可見世界跨度包含 bounding sphere 及 padding", (_label, width, height) => {
    const bounds = calculatePreviewBounds({
      ...designFixture(),
      metalDiscDiameterMm: 55,
    });
    const fit = calculateOrthographicFit(
      width,
      height,
      bounds.boundingSphereRadiusMm,
    );
    const requiredSpan =
      bounds.boundingSphereRadiusMm * 2 * PREVIEW_FIT_PADDING;

    expect(fit.baseZoom).toBeCloseTo(
      Math.min(width, height) / requiredSpan,
    );
    expect(fit.visibleWidthMm).toBeGreaterThanOrEqual(requiredSpan - 1e-9);
    expect(fit.visibleHeightMm).toBeGreaterThanOrEqual(requiredSpan - 1e-9);
    expect(PREVIEW_FIT_PADDING).toBeGreaterThanOrEqual(1.12);
  });

  it("在 resize、design bounds 及 user zoom 變化時更新正交相機", () => {
    const camera = new OrthographicCamera(-164, 164, 140, -140, 0.1, 400);
    const updateProjectionMatrix = vi.spyOn(camera, "updateProjectionMatrix");
    const invalidate = vi.fn();
    const store = { camera, size: { width: 328, height: 280 }, invalidate };
    mockUseThree.mockReturnValue(store);
    const radius = Math.hypot(30, 9.5);
    const { rerender } = render(
      <FitOrthographicCamera boundingSphereRadiusMm={radius} userZoom={1} />,
    );

    expect(camera.zoom).toBeCloseTo(
      calculateOrthographicFit(328, 280, radius).baseZoom,
    );
    expect(updateProjectionMatrix).toHaveBeenCalled();

    store.size = { width: 1088, height: 320 };
    const largerRadius = Math.hypot(40, 9.5);
    rerender(
      <FitOrthographicCamera
        boundingSphereRadiusMm={largerRadius}
        userZoom={1.25}
      />,
    );
    expect(camera.zoom).toBeCloseTo(
      calculateOrthographicFit(1088, 320, largerRadius).baseZoom * 1.25,
    );
    expect(updateProjectionMatrix).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("設計或旋轉變化時 invalidate demand frame，靜止時不連續請求", () => {
    const invalidate = vi.fn();
    mockUseThree.mockReturnValue({ invalidate });
    const design = designFixture();
    const { rerender } = render(
      <InvalidateOnSceneChange design={design} rotation={{ x: 0, y: 0 }} />,
    );
    expect(invalidate).toHaveBeenCalledTimes(1);

    rerender(
      <InvalidateOnSceneChange design={design} rotation={{ x: 0.2, y: 0 }} />,
    );
    expect(invalidate).toHaveBeenCalledTimes(2);
    rerender(
      <InvalidateOnSceneChange
        design={{ ...design, metalDiscDiameterMm: 30 }}
        rotation={{ x: 0.2, y: 0 }}
      />,
    );
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it("先將模型中心移到原點，再由 outer group 繞原點旋轉", () => {
    const { container } = render(
      <CenteredModel centerZMm={8.5} rotation={{ x: 0.85, y: -0.55 }}>
        <span data-testid="model-content" />
      </CenteredModel>,
    );
    const outer = container.querySelector('group[name="preview-rotation-pivot"]');
    const inner = outer?.querySelector(':scope > group[name="preview-centered-model"]');

    expect(outer).toHaveAttribute("rotation", "0.85,0,-0.55");
    expect(inner).toHaveAttribute("position", "0,0,-8.5");
    expect(within(inner as HTMLElement).getByTestId("model-content")).toBeVisible();
  });
});

describe("3D lazy loading 降級", () => {
  it("實際 React.lazy import rejection 只降級預覽，可 reset 且其他控制仍可用", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const BrokenPreview = lazy(() => Promise.reject(new Error("chunk unavailable")));
    const design = designFixture();
    const { rerender } = render(
      <>
        <button type="button">其他設計控制</button>
        <PreviewErrorBoundary design={design} resetKey="3d">
          <Suspense fallback={<p>正在載入</p>}>
            <BrokenPreview />
          </Suspense>
        </PreviewErrorBoundary>
      </>,
    );

    expect(await screen.findByText("裝置未能啟用 3D，已顯示分解圖")).toBeVisible();
    expect(screen.getByRole("button", { name: "其他設計控制" })).toBeEnabled();

    rerender(
      <PreviewErrorBoundary design={design} resetKey="top">
        <p>預覽已重設</p>
      </PreviewErrorBoundary>,
    );
    expect(await screen.findByText("預覽已重設")).toBeVisible();
    consoleError.mockRestore();
  });
});
