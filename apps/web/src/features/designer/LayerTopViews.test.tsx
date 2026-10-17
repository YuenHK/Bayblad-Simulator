import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { DesignerPage } from "./DesignerPage";

it("shows only the selected board at a common scale", async () => {
  render(<DesignerPage />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "俯視圖" }));
  const boxes: (string | null)[] = [];
  for (const [index, label] of ["頂層", "中層", "底層"].entries()) {
    await user.click(screen.getByRole("button", { name: `編輯${label}` }));
    const svg = screen.getByRole("img", { name: `${label}俯視圖` });
    boxes.push(svg.getAttribute("viewBox"));
    for (const other of ["頂層", "中層", "底層"].filter(x => x !== label)) expect(screen.queryByRole("img", { name: `${other}俯視圖` })).not.toBeInTheDocument();
    expect(within(svg).getAllByTestId("layer-path")).toHaveLength(1);
    expect(within(svg).getByTestId("layer-path")).toHaveAttribute("data-position", ["top", "middle", "bottom"][index]);
    expect(within(svg).getAllByTestId("screw-hole")).toHaveLength(4);
    expect(within(svg).getByTestId("axle-hole")).toBeInTheDocument();
  }
  expect(new Set(boxes).size).toBe(1);
});

it("enlarges designer exploded boards threefold", async () => {
  render(<DesignerPage />);
  await userEvent.setup().click(screen.getByRole("tab", { name: "分解圖" }));
  for (const layer of screen.getAllByTestId("exploded-layer")) expect(layer.getAttribute("transform")).toContain("scale(2.16 1.02)");
});
