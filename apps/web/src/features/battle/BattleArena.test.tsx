import { render, screen } from "@testing-library/react";
import { makeDefaultDesign } from "@steam-top/domain";
import { describe, expect, it } from "vitest";
import { BattleArena } from "./BattleArena";

describe("BattleArena", () => {
  it("渲染競技場能量環、殘影及碰撞效果層", () => {
    const frames = [
      { sequence: 1, tick: 1, player1: { x: -24, y: 0, angle: 0, angularSpeed: 22 }, player2: { x: 24, y: 0, angle: 0, angularSpeed: 20 } },
      { sequence: 2, tick: 2, player1: { x: -5, y: 0, angle: 1, angularSpeed: 21 }, player2: { x: 5, y: 0, angle: -1, angularSpeed: 19 } },
    ];
    const { container } = render(<BattleArena designs={[makeDefaultDesign(), makeDefaultDesign()]} frames={frames} />);
    expect(container.querySelectorAll(".arena-energy-ring").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll(".top-trail")).toHaveLength(2);
    expect(container.querySelector(".battle-effects-layer")).toBeInTheDocument();
    expect(container.querySelector("[data-effect-id='impact-2']")).toBeInTheDocument();
  });
  it("精簡品質限制每次碰撞的火花數量", () => {
    const frames = [
      { sequence: 5, tick: 5, player1: { x: -24, y: 0, angle: 0, angularSpeed: 22 }, player2: { x: 24, y: 0, angle: 0, angularSpeed: 20 } },
      { sequence: 6, tick: 6, player1: { x: -5, y: 0, angle: 1, angularSpeed: 21 }, player2: { x: 5, y: 0, angle: -1, angularSpeed: 19 } },
    ];
    const { container } = render(<BattleArena designs={[makeDefaultDesign(), makeDefaultDesign()]} frames={frames} quality="reduced" />);
    expect(container.querySelectorAll("[data-effect-id='impact-6'] line")).toHaveLength(5);
  });

  it("碰撞後數個影格仍保留火花，並繪出移動殘影", () => {
    const frames = [
      { sequence: 1, tick: 4, player1: { x: -24, y: 0, angle: 0, angularSpeed: 22 }, player2: { x: 24, y: 0, angle: 0, angularSpeed: 20 } },
      { sequence: 2, tick: 8, player1: { x: -5, y: 0, angle: 1, angularSpeed: 21 }, player2: { x: 5, y: 0, angle: -1, angularSpeed: 19 } },
      { sequence: 3, tick: 12, player1: { x: -12, y: 4, angle: 2, angularSpeed: 20 }, player2: { x: 13, y: -4, angle: -2, angularSpeed: 18 } },
    ];
    const { container } = render(<BattleArena designs={[makeDefaultDesign(), makeDefaultDesign()]} frames={frames} />);
    expect(container.querySelector("[data-effect-id='impact-2']")).toBeInTheDocument();
    expect(container.querySelectorAll(".top-afterimage").length).toBeGreaterThanOrEqual(4);
  });

  it("有賽果時在競技場顯示勝負演出", () => {
    const frames = [{ sequence: 1, tick: 4, player1: { x: -10, y: 0, angle: 0, angularSpeed: 12 }, player2: { x: 10, y: 0, angle: 0, angularSpeed: 0 } }];
    render(<BattleArena designs={[makeDefaultDesign(), makeDefaultDesign()]} frames={frames} winner="player1" />);
    expect(screen.getByTestId("arena-victory")).toHaveTextContent("玩家一勝出");
  });

  it("低動態模式直接顯示最新 frame 並提供 aria 摘要", () => {
    render(<BattleArena designs={[makeDefaultDesign(), makeDefaultDesign()]} frames={[
      { sequence: 1, tick: 4, player1: { x: -20, y: 0, angle: 0, angularSpeed: 20 }, player2: { x: 20, y: 0, angle: 0, angularSpeed: 18 } },
      { sequence: 2, tick: 8, player1: { x: -10, y: 2, angle: 1, angularSpeed: 15 }, player2: { x: 10, y: -2, angle: -1, angularSpeed: 14 } },
    ]} reducedMotion />);
    expect(screen.getByTestId("battle-player1")).toHaveAttribute("transform", expect.stringContaining("-10"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("對戰進行中")).toBeInTheDocument();
  });
});
