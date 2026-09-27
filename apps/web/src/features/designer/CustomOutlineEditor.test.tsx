import { fireEvent, render, screen } from "@testing-library/react";
import { useReducer, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { makeDefaultDesign } from "@steam-top/domain";
import { CustomOutlineEditor } from "./CustomOutlineEditor";
import { createOutlineDraft, recordStroke } from "./customOutlineDraft";
import { LayerControls } from "./LayerControls";
import { designerReducer } from "./useDesigner";

const square = [
  { x: -20, y: -20 },
  { x: 20, y: -20 },
  { x: 20, y: 20 },
  { x: -20, y: 20 },
  { x: -20, y: -20 },
];
describe("輪廓編輯器", () => {
  it("中斷筆劃停留草稿，顯示錯誤且不能套用", () => {
    const onApply = vi.fn();
    function Harness() {
      const [draft, onChange] = useState(createOutlineDraft());
      return (
        <CustomOutlineEditor
          draft={draft}
          onChange={onChange}
          onApply={onApply}
        />
      );
    }
    render(<Harness />);
    const canvas = screen.getByLabelText("自定輪廓畫布");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 88,
      height: 88,
      right: 88,
      bottom: 88,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    for (const type of ["pointerdown", "pointercancel"]) {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, {
        pointerId: 2,
        pointerType: "pen",
        clientX: 20,
        clientY: 20,
        button: 0,
      });
      fireEvent(canvas, event);
    }
    expect(screen.getByRole("alert")).toHaveTextContent("筆劃已中斷");
    expect(screen.getByRole("button", { name: "套用自定造型" })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });
  it("基礎草稿可保存及明確套用，原自定草稿仍可取回", () => {
    const design = makeDefaultDesign();
    design.layers[0] = {
      ...design.layers[0],
      shape: "custom",
      outline: { version: 1, mirror: "none", vertices: square.slice(0, -1) },
      diameterMm: 2 * Math.hypot(20, 20),
    };
    function Harness() {
      const [state, dispatch] = useReducer(designerReducer, design);
      return (
        <>
          <output aria-label="已套用造型">{state.layers[0].shape}</output>
          <LayerControls
            layer={state.layers[0]}
            dispatch={dispatch}
            onFieldValidityChange={vi.fn()}
          />
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "基礎造型" }));
    fireEvent.change(screen.getByLabelText("形狀"), {
      target: { value: "star" },
    });
    expect(screen.getByLabelText("已套用造型")).toHaveTextContent("custom");
    fireEvent.click(screen.getByRole("button", { name: "自定造型" }));
    fireEvent.click(screen.getByRole("button", { name: "基礎造型" }));
    expect(screen.getByLabelText("形狀")).toHaveValue("star");
    fireEvent.click(screen.getByRole("button", { name: "套用基礎造型" }));
    expect(screen.getByLabelText("已套用造型")).toHaveTextContent("star");
    fireEvent.click(screen.getByRole("button", { name: "自定造型" }));
    expect(screen.getByRole("button", { name: "套用自定造型" })).toBeEnabled();
  });
  it("縮小令輪廓侵入軸孔時顯示未套用原因", () => {
    const design = makeDefaultDesign(),
      dispatch = vi.fn();
    const vertices = [
      { x: -4, y: -15 },
      { x: 30, y: -15 },
      { x: 30, y: 15 },
      { x: -4, y: 15 },
    ];
    const layer = {
      ...design.layers[0],
      shape: "custom" as const,
      outline: { version: 1 as const, mirror: "none" as const, vertices },
      diameterMm: 2 * Math.hypot(30, 15),
    };
    render(
      <LayerControls
        layer={layer}
        dispatch={dispatch}
        onFieldValidityChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("直徑（mm）"), {
      target: { value: "20" },
    });
    expect(screen.getByText(/縮放未套用/)).toBeVisible();
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("直徑（mm）")).toHaveValue(layer.diameterMm);
  });
  it("螺絲孔參考與設計的 2 mm 半徑一致", () => {
    const design = makeDefaultDesign();
    const { container } = render(
      <CustomOutlineEditor
        draft={createOutlineDraft()}
        onChange={vi.fn()}
        onApply={vi.fn()}
        screwLayout={design.screwLayout}
      />,
    );
    expect(container.querySelectorAll('circle[r="2"]')).toHaveLength(4);
  });
  it("預覽、清除及復原不套用；只有有效確認才套用", () => {
    const onApply = vi.fn();
    function Harness() {
      const [draft, onChange] = useState(
        recordStroke(createOutlineDraft(), square),
      );
      return (
        <CustomOutlineEditor
          draft={draft}
          onChange={onChange}
          onApply={onApply}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "清除草稿" }));
    expect(screen.getByRole("button", { name: "套用自定造型" })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "復原筆劃" }));
    fireEvent.click(screen.getByRole("button", { name: "套用自定造型" }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply.mock.calls[0]![0].vertices).toHaveLength(4);
  });
  it("觸控筆劃捕捉指標並轉為 y 向上的 mm 座標", () => {
    const onApply = vi.fn();
    function Harness() {
      const [draft, onChange] = useState(createOutlineDraft());
      return (
        <CustomOutlineEditor
          draft={draft}
          onChange={onChange}
          onApply={onApply}
        />
      );
    }
    render(<Harness />);
    const canvas = screen.getByLabelText("自定輪廓畫布");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 88,
      height: 88,
      right: 88,
      bottom: 88,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const capture = vi.fn();
    Object.defineProperty(canvas, "setPointerCapture", {
      value: capture,
      configurable: true,
    });
    for (const [type, x, y] of [
      ["pointerdown", 24, 64],
      ["pointermove", 64, 64],
      ["pointermove", 64, 24],
      ["pointermove", 24, 24],
      ["pointerup", 24, 64],
    ] as const) {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, {
        pointerId: 7,
        pointerType: "touch",
        clientX: x,
        clientY: y,
        button: 0,
      });
      fireEvent(canvas, event);
    }
    expect(capture).toHaveBeenCalledWith(7);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "套用自定造型" }));
    expect(onApply.mock.calls[0]![0].vertices).toContainEqual({ x: 20, y: 20 });
  });
  it("切換造型及層板保存各層草稿，進入自定造型不變更設計", () => {
    const design = makeDefaultDesign(),
      dispatch = vi.fn(),
      validity = vi.fn();
    const { rerender } = render(
      <LayerControls
        layer={design.layers[0]}
        dispatch={dispatch}
        onFieldValidityChange={validity}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "自定造型" }));
    fireEvent.change(screen.getByLabelText("鏡射方式"), {
      target: { value: "leftRight" },
    });
    fireEvent.click(screen.getByRole("button", { name: "基礎造型" }));
    fireEvent.click(screen.getByRole("button", { name: "自定造型" }));
    expect(screen.getByLabelText("鏡射方式")).toHaveValue("leftRight");
    rerender(
      <LayerControls
        layer={design.layers[1]}
        dispatch={dispatch}
        onFieldValidityChange={validity}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "自定造型" }));
    expect(screen.getByLabelText("鏡射方式")).toHaveValue("none");
    rerender(
      <LayerControls
        layer={design.layers[0]}
        dispatch={dispatch}
        onFieldValidityChange={validity}
      />,
    );
    expect(screen.getByLabelText("鏡射方式")).toHaveValue("leftRight");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
