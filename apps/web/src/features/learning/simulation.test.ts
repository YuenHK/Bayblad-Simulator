import { expect, it } from "vitest";
import { makeDefaultDesign } from "@steam-top/domain";
import { runLearningSimulation } from "./simulation";

it("repeats the same fixed opponent, launch and seed deterministically", () => {
  const design = makeDefaultDesign();
  const a = runLearningSimulation(design);
  const b = runLearningSimulation(design);
  expect(a.summary).toEqual(b.summary);
  expect(a.battle.frames).toEqual(b.battle.frames);
  expect(a.battle.seed).toBe(314159);
  expect(a.summary.seconds).toBe(a.battle.ticks / 60);
});
