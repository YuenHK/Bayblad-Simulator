import { describe, expect, it } from "vitest";
import { deriveBattleEffects, gradePresentation } from "./battleEffects";

describe("battle effects", () => {
  it("完整映射伺服器判定到雙語文案及音效角色", () => {
    expect(gradePresentation("Perfect")).toMatchObject({ label: "PERFECT", chinese: "完美", tone: "perfect" });
    expect(gradePresentation("Great")).toMatchObject({ label: "GREAT", chinese: "準確", tone: "great" });
    expect(gradePresentation("Good")).toMatchObject({ label: "GOOD", chinese: "偏差", tone: "good" });
    expect(gradePresentation("Miss")).toMatchObject({ label: "MISS", chinese: "失誤", tone: "miss" });
  });

  it("以sequence產生穩定的高速碰撞事件", () => {
    const previous = { sequence: 10, tick: 10, player1: { x: -24, y: 0, angle: 0, angularSpeed: 22 }, player2: { x: 24, y: 0, angle: 0, angularSpeed: 20 } };
    const latest = { sequence: 11, tick: 11, player1: { x: -5, y: 0, angle: 1, angularSpeed: 21 }, player2: { x: 5, y: 0, angle: -1, angularSpeed: 19 } };
    expect(deriveBattleEffects(previous, latest)).toContainEqual(expect.objectContaining({ id: "impact-11", type: "heavy-impact" }));
    expect(deriveBattleEffects(previous, latest)).toEqual(deriveBattleEffects(previous, latest));
  });

  it("接近場邊且仍移動時產生摩擦事件", () => {
    const previous = { sequence: 20, tick: 20, player1: { x: 88, y: 0, angle: 0, angularSpeed: 10 }, player2: { x: 0, y: 0, angle: 0, angularSpeed: 8 } };
    const latest = { sequence: 21, tick: 21, player1: { x: 94, y: 2, angle: 1, angularSpeed: 9 }, player2: { x: 1, y: 0, angle: 1, angularSpeed: 7 } };
    expect(deriveBattleEffects(previous, latest)).toContainEqual(expect.objectContaining({ id: "rim-player1-21", type: "rim" }));
  });
});
