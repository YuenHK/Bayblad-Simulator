import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { makeDefaultDesign } from "@steam-top/domain";
import { DesignerPage } from "./DesignerPage";

it("shows each board separately at the same scale with unique cutout masks", () => {
  render(<DesignerPage />);
  const views = ["頂層", "中層", "底層"].map(label => screen.getByRole("img", { name: `${label}俯視圖` }));
  expect(new Set(views.map(svg => svg.getAttribute("viewBox"))).size).toBe(1);
  for (const [index, svg] of views.entries()) {
    expect(within(svg).getAllByTestId("layer-path")).toHaveLength(1);
    expect(within(svg).getByTestId("layer-path")).toHaveAttribute("data-position", ["top", "middle", "bottom"][index]);
    expect(within(svg).getAllByTestId("screw-hole")).toHaveLength(makeDefaultDesign().screwLayout.count);
    expect(within(svg).getByTestId("axle-hole")).toBeInTheDocument();
  }
  const ids = views.map(svg => within(svg).getByTestId("acrylic-cutout-mask").getAttribute("id"));
  expect(new Set(ids).size).toBe(3);
});
