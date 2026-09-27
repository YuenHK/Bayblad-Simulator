import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LayerRecord } from "./LayerRecord";

describe("teacher layer records", () => {
  it("shows custom geometry and mirror mode without treating sampled points as corners", () => {
    const { container } = render(<LayerRecord layer={{ position: "top", shape: "custom", points: null, diameterMm: 28.284, actualAreaMm2: 360, holeCount: 4, rotationDeg: 30, cornerRoundness: 0, outline: { version: 1, mirror: "leftRight", vertices: [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }] } }} />);
    expect(container.textContent).toContain("左右鏡像");
    expect(container.textContent).not.toContain("null角");
    expect(container.textContent).not.toContain("圓角");
    expect(screen.getByRole("img", { name: "自定造型輪廓" })).toBeTruthy();
    expect(container.querySelector("polygon")?.getAttribute("points")).toBe("-10,-10 10,-10 10,10 -10,10");
    expect(container.querySelector("polygon")?.getAttribute("transform")).toBe("rotate(30)");
  });
  it("keeps basic layer parameters without a custom thumbnail", () => {
    const { container } = render(<LayerRecord layer={{ position: "top", shape: "polygon", points: 6, diameterMm: 40, actualAreaMm2: 900, holeCount: 4, rotationDeg: 0, cornerRoundness: 0.5 }} />);
    expect(container.textContent).toContain("6角");
    expect(container.textContent).toContain("圓角0.5");
    expect(container.querySelector("svg")).toBeNull();
  });
});
