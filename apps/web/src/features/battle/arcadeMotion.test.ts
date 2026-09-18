import { expect, it } from "vitest";
import { arcadePose, impactState, shatterProgress } from "./arcadeMotion";

it("repeatedly collides and rebounds deterministically within the arena", () => {
  for (let cycle=0; cycle<10; cycle++) {
    const start=arcadePose(cycle*2200, [24,30]);
    const hit=arcadePose(cycle*2200+1100, [24,30]);
    const rebound=arcadePose(cycle*2200+1700, [24,30]);
    const distance=(p:ReturnType<typeof arcadePose>)=>Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);
    expect(distance(hit)).toBeCloseTo(54,5);
    expect(distance(start)).toBeGreaterThan(distance(hit)+25);
    expect(distance(rebound)).toBeGreaterThan(distance(hit)+25);
    expect(hit).toEqual(arcadePose(cycle*2200+1100,[24,30]));
    for (const [i,p] of rebound.entries()) expect(Math.hypot(p.x,p.y)+[24,30][i]!).toBeLessThan(105);
    expect(impactState(cycle*2200+1100).active).toBe(true);
  }
});
it("shatters only the defeated top after impact, never a draw", () => {
  expect(shatterProgress(29099,"player1","player2")).toBe(0);
  expect(shatterProgress(29500,"player1","player2")).toBeGreaterThan(0);
  expect(shatterProgress(30000,"player1","player2")).toBe(1);
  expect(shatterProgress(29500,"player1","player1")).toBe(0);
  expect(shatterProgress(29500,"draw","player1")).toBe(0);
  expect(shatterProgress(29500,undefined,"player1")).toBe(0);
});
