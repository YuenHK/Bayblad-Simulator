import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignerPage } from "./DesignerPage";

afterEach(() => {
  Reflect.deleteProperty(document, "elementFromPoint");
});

function stubElementFromPoint(
  resolve: (x: number, y: number) => Element | null,
): void {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: resolve,
  });
}

async function replaceNumber(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string,
): Promise<void> {
  const input = screen.getByLabelText(label);
  await user.clear(input);
  await user.type(input, value);
}

describe("DesignerPage", () => {
  it("初始設計符合規格並可參戰", () => {
    render(<DesignerPage />);

    expect(
      screen.getByRole("button", { name: "規格通過，可參戰" }),
    ).toBeEnabled();
    expect(screen.getByText("設計符合課堂規格")).toBeVisible();
    expect(screen.getAllByRole("option", { name: /頂層|中層|底層/ })).toHaveLength(3);
  });

  it("輸入 61 mm 時立即顯示直徑警告並停用參戰", async () => {
    const user = userEvent.setup();
    render(<DesignerPage />);

    await user.selectOptions(screen.getByLabelText("目前編輯層"), "top");
    await replaceNumber(user, "直徑（mm）", "61");

    expect(screen.getByText("最大直徑為 60 mm")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "規格未通過，請先修正" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "規格未通過，請先修正" }),
    ).toHaveAttribute("aria-describedby", "validation-status");
  });

  it("可更新形狀、角數、直徑、圓角、旋轉及顏色", async () => {
    const user = userEvent.setup();
    render(<DesignerPage />);

    await user.selectOptions(screen.getByLabelText("形狀"), "star");
    await replaceNumber(user, "角數", "9");
    await replaceNumber(user, "直徑（mm）", "58");
    await replaceNumber(user, "圓角程度", "0.25");
    await replaceNumber(user, "旋轉角度（度）", "45");
    await user.click(screen.getByLabelText("顏色"));
    await user.clear(screen.getByLabelText("顏色"));
    await user.type(screen.getByLabelText("顏色"), "#123456");

    expect(screen.getByLabelText("形狀")).toHaveValue("star");
    expect(screen.getByLabelText("角數")).toHaveValue(9);
    expect(screen.getByLabelText("直徑（mm）")).toHaveValue(58);
    expect(screen.getByLabelText("圓角程度")).toHaveValue(0.25);
    expect(screen.getByLabelText("旋轉角度（度）")).toHaveValue(45);
    expect(screen.getByLabelText("顏色")).toHaveValue("#123456");
  });

  it("圓形明示角數及圓角無作用", () => {
    render(<DesignerPage />);

    expect(screen.getByLabelText("角數")).toBeDisabled();
    expect(screen.getByLabelText("圓角程度")).toBeDisabled();
    expect(screen.getByText("圓形不使用角數及圓角程度。")).toBeVisible();
  });

  it("重排完整層資料並同步頂中底位置", async () => {
    const user = userEvent.setup();
    const { container } = render(<DesignerPage />);

    const idsBefore = Array.from(container.querySelectorAll("[data-layer-id]"), (item) =>
      item.getAttribute("data-layer-id"),
    );
    await user.selectOptions(screen.getByLabelText("目前編輯層"), "middle");
    await replaceNumber(user, "直徑（mm）", "42");
    await user.click(screen.getByRole("button", { name: "將目前層上移" }));

    const summaries = screen.getAllByRole("listitem");
    expect(within(summaries[0]!).getByText("頂層")).toBeVisible();
    expect(within(summaries[0]!).getByText("42 mm")).toBeVisible();
    expect(screen.getByLabelText("目前編輯層")).toHaveValue("top");
    expect(screen.getByText("中層層板已移至頂層")).toHaveAttribute(
      "aria-live",
      "polite",
    );

    const idsAfter = Array.from(container.querySelectorAll("[data-layer-id]"), (item) =>
      item.getAttribute("data-layer-id"),
    );
    expect(idsAfter).toHaveLength(3);
    expect(new Set(idsAfter).size).toBe(3);
    expect(idsAfter.toSorted()).toEqual(idsBefore.toSorted());
  });

  it("可用 Pointer Events 拖動手柄重排而不遺失層資料或選中層", async () => {
    const user = userEvent.setup();
    const { container } = render(<DesignerPage />);
    const idsBefore = Array.from(container.querySelectorAll("[data-layer-id]"), (item) =>
      item.getAttribute("data-layer-id"),
    );

    await user.selectOptions(screen.getByLabelText("目前編輯層"), "middle");
    await replaceNumber(user, "直徑（mm）", "42");
    const targetLayer = screen.getAllByRole("listitem")[0]!;
    const sourceHandle = screen.getByRole("button", {
      name: "拖動中層以重新排序",
    });
    expect(sourceHandle).toHaveAttribute("data-source-layer-id", idsBefore[1]);
    stubElementFromPoint((x, y) =>
      x === 24 && y === 18 ? targetLayer : null,
    );
    fireEvent.pointerDown(sourceHandle, { pointerId: 7 });
    fireEvent.pointerMove(sourceHandle, {
      pointerId: 7,
      clientX: 24,
      clientY: 18,
    });
    fireEvent.pointerUp(sourceHandle, { pointerId: 7 });

    const summaries = screen.getAllByRole("listitem");
    expect(within(summaries[0]!).getByText("42 mm")).toBeVisible();
    expect(screen.getByLabelText("目前編輯層")).toHaveValue("top");
    expect(screen.getByLabelText("直徑（mm）")).toHaveValue(42);
    const idsAfter = Array.from(container.querySelectorAll("[data-layer-id]"), (item) =>
      item.getAttribute("data-layer-id"),
    );
    expect(idsAfter).toHaveLength(3);
    expect(new Set(idsAfter).size).toBe(3);
    expect(idsAfter.toSorted()).toEqual(idsBefore.toSorted());
  });

  it("取消 Pointer 拖動會安全清除狀態且不再重排", () => {
    const { container } = render(<DesignerPage />);
    const idsBefore = Array.from(container.querySelectorAll("[data-layer-id]"), (item) =>
      item.getAttribute("data-layer-id"),
    );
    const topHandle = screen.getByRole("button", {
      name: "拖動頂層以重新排序",
    });

    stubElementFromPoint(() => null);
    fireEvent.pointerDown(topHandle, { pointerId: 9 });
    fireEvent.pointerMove(topHandle, {
      pointerId: 9,
      clientX: 12,
      clientY: 12,
    });
    fireEvent.pointerCancel(topHandle, { pointerId: 9 });
    stubElementFromPoint(() => screen.getAllByRole("listitem")[2]!);
    fireEvent.pointerMove(topHandle, {
      pointerId: 9,
      clientX: 90,
      clientY: 90,
    });

    const idsAfter = Array.from(container.querySelectorAll("[data-layer-id]"), (item) =>
      item.getAttribute("data-layer-id"),
    );
    expect(idsAfter).toEqual(idsBefore);
    expect(screen.getByRole("heading", { name: "陀螺設計器" })).toBeVisible();
  });

  it("只接受 active pointer 並可靠釋放 capture 及 window listeners", async () => {
    const user = userEvent.setup();
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const { container } = render(<DesignerPage />);
    await user.selectOptions(screen.getByLabelText("目前編輯層"), "middle");

    const idsBefore = Array.from(container.querySelectorAll("[data-layer-id]"), (item) =>
      item.getAttribute("data-layer-id"),
    );
    const firstHandle = screen.getByRole("button", {
      name: "拖動中層以重新排序",
    });
    const secondHandle = screen.getByRole("button", {
      name: "拖動頂層以重新排序",
    });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(firstHandle, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });
    stubElementFromPoint(() => screen.getAllByRole("listitem")[0]!);

    fireEvent.pointerDown(firstHandle, { pointerId: 11 });
    fireEvent.pointerDown(secondHandle, { pointerId: 22 });
    fireEvent.pointerMove(secondHandle, {
      pointerId: 22,
      clientX: 30,
      clientY: 30,
    });
    fireEvent.pointerUp(secondHandle, { pointerId: 22 });
    fireEvent.pointerCancel(window, { pointerId: 22 });

    expect(firstHandle).toHaveAttribute("aria-pressed", "true");
    expect(
      container.querySelectorAll("[data-layer-id]")[0]?.getAttribute("data-layer-id"),
    ).toBe(idsBefore[0]);

    fireEvent.pointerMove(firstHandle, {
      pointerId: 11,
      clientX: 30,
      clientY: 30,
    });
    fireEvent.pointerUp(firstHandle, { pointerId: 11 });

    expect(
      container.querySelectorAll("[data-layer-id]")[0]?.getAttribute("data-layer-id"),
    ).toBe(idsBefore[1]);
    expect(setPointerCapture).toHaveBeenCalledTimes(1);
    expect(setPointerCapture).toHaveBeenCalledWith(11);
    expect(releasePointerCapture).toHaveBeenCalledTimes(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(11);
    expect(removeListener).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("pointercancel", expect.any(Function));
    expect(addListener).toHaveBeenCalledWith("pointerup", expect.any(Function));
  });

  it("只有一組共用螺絲控制並即時顯示違規", async () => {
    const user = userEvent.setup();
    render(<DesignerPage />);

    expect(screen.getAllByLabelText("螺絲數量")).toHaveLength(1);
    expect(screen.getAllByLabelText("螺絲半徑（mm）")).toHaveLength(1);
    expect(screen.getAllByLabelText("螺絲旋轉角度（度）")).toHaveLength(1);
    await replaceNumber(user, "螺絲半徑（mm）", "5");

    expect(screen.getByText("螺絲孔與軸心重疊")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "規格未通過，請先修正" }),
    ).toBeDisabled();
  });

  it("金屬碟只提供沒有或預設直徑並清楚交代裝配方式", async () => {
    const user = userEvent.setup();
    render(<DesignerPage />);

    const metalDisc = screen.getByLabelText("金屬碟直徑");
    expect(within(metalDisc).getAllByRole("option")).toHaveLength(7);
    expect(within(metalDisc).getByRole("option", { name: "沒有" })).toBeVisible();
    for (const diameter of [10, 20, 30, 40, 50, 55]) {
      expect(within(metalDisc).getByRole("option", { name: `${diameter} mm` })).toBeVisible();
    }
    await user.selectOptions(metalDisc, "30");
    expect(metalDisc).toHaveValue("30");
    expect(
      screen.getByText("只置於最底層下方，由軸心夾住，不設螺絲孔"),
    ).toBeVisible();
  });

  it("顯示即時物理量及四項相對表現但不顯示建議或最佳化", () => {
    render(<DesignerPage />);

    expect(screen.getByText("重量", { selector: "dt" })).toBeVisible();
    expect(screen.getByText("重心偏移", { selector: "dt" })).toBeVisible();
    expect(screen.getByText("轉動慣量", { selector: "dt" })).toBeVisible();
    expect(screen.getByText("速度", { selector: "dt" })).toBeVisible();
    expect(screen.getByText("旋轉時間", { selector: "dt" })).toBeVisible();
    expect(screen.getByText("穩定性", { selector: "dt" })).toBeVisible();
    expect(screen.getByText("抗撞能力", { selector: "dt" })).toBeVisible();
    expect(screen.getAllByText(/\d+(\.\d+)?/).length).toBeGreaterThan(3);
    expect(screen.queryByText(/建議|最佳/)).not.toBeInTheDocument();
  });

  it("暫時清空數值欄位不會令頁面崩潰", async () => {
    const user = userEvent.setup();
    render(<DesignerPage />);

    await user.clear(screen.getByLabelText("直徑（mm）"));

    expect(screen.getByRole("heading", { name: "陀螺設計器" })).toBeVisible();
    expect(screen.getByLabelText("直徑（mm）")).toHaveValue(null);
    expect(screen.getByLabelText("直徑（mm）")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("請輸入 20 至 80 的有效數值")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "規格未通過，請先修正" }),
    ).toBeDisabled();
  });

  it("超出 schema 範圍的暫態數值會標示錯誤並停用參戰", async () => {
    const user = userEvent.setup();
    render(<DesignerPage />);

    await replaceNumber(user, "直徑（mm）", "999");

    expect(screen.getByLabelText("直徑（mm）")).toHaveValue(999);
    expect(screen.getByLabelText("直徑（mm）")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("請輸入 20 至 80 的有效數值")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "規格未通過，請先修正" }),
    ).toBeDisabled();
  });

  it("角數不接受小數或 step mismatch", async () => {
    const user = userEvent.setup();
    render(<DesignerPage />);
    await user.selectOptions(screen.getByLabelText("形狀"), "polygon");

    fireEvent.change(screen.getByLabelText("角數"), {
      target: { value: "3.5" },
    });

    expect(screen.getByLabelText("角數")).toHaveValue(3.5);
    expect(screen.getByLabelText("角數")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("請輸入 3 至 16 的有效整數")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "規格未通過，請先修正" }),
    ).toBeDisabled();
  });

  it("切換至 canonical value 相同的另一層會重設 draft 並清除舊錯誤", async () => {
    const user = userEvent.setup();
    render(<DesignerPage />);
    await replaceNumber(user, "直徑（mm）", "55");
    await user.selectOptions(screen.getByLabelText("目前編輯層"), "middle");
    await user.clear(screen.getByLabelText("直徑（mm）"));
    expect(screen.getByLabelText("直徑（mm）")).toHaveAttribute("aria-invalid", "true");

    await user.selectOptions(screen.getByLabelText("目前編輯層"), "top");

    expect(screen.getByLabelText("直徑（mm）")).toHaveValue(55);
    expect(screen.getByLabelText("直徑（mm）")).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("請輸入 20 至 80 的有效數值")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "規格通過，可參戰" }),
    ).toBeEnabled();
  });

  it("主要控制都有可存取標籤及鍵盤按鈕", () => {
    render(<DesignerPage />);

    for (const label of [
      "目前編輯層",
      "形狀",
      "角數",
      "直徑（mm）",
      "圓角程度",
      "旋轉角度（度）",
      "顏色",
      "螺絲數量",
      "螺絲半徑（mm）",
      "螺絲旋轉角度（度）",
      "金屬碟直徑",
    ]) {
      expect(screen.getByLabelText(label)).toBeVisible();
    }
    expect(screen.getByRole("button", { name: "將目前層上移" })).toBeVisible();
    expect(screen.getByRole("button", { name: "將目前層下移" })).toBeVisible();
  });
});
