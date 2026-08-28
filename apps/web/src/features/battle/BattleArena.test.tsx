import { render, screen } from "@testing-library/react";
import { makeDefaultDesign } from "@steam-top/domain";
import { describe, expect, it } from "vitest";
import { BattleArena } from "./BattleArena";

describe("BattleArena", () => {
  it("低動態模式直接顯示最新 frame 並提供 aria 摘要", () => {
    render(<BattleArena designs={[makeDefaultDesign(), makeDefaultDesign()]} frames={[
      { sequence: 1, tick: 4, player1: { x: -20, y: 0, angle: 0, angularSpeed: 20 }, player2: { x: 20, y: 0, angle: 0, angularSpeed: 18 } },
      { sequence: 2, tick: 8, player1: { x: -10, y: 2, angle: 1, angularSpeed: 15 }, player2: { x: 10, y: -2, angle: -1, angularSpeed: 14 } },
    ]} reducedMotion />);
    expect(screen.getByTestId("battle-player1")).toHaveAttribute("transform", expect.stringContaining("-10"));
    expect(screen.getByRole("status")).toHaveTextContent("第 8 tick");
  });
});
