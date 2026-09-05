import { describe, expect, it } from "vitest";
import { presentationFrame, ROUND_DURATION_MS, SUMMON_AT_MS, ZODIAC_SKILLS } from "./presentation";
import type { BattleResult } from "./engine";

describe("60 second cinematic trajectory", () => {
  const result = { ticks: 120, frames: [
    { tick: 0, player1: { x: -50, y: 0, angle: 0, angularSpeed: 20 }, player2: { x: 50, y: 0, angle: 0, angularSpeed: 20 } },
    { tick: 120, player1: { x: 0, y: 10, angle: 20, angularSpeed: 10 }, player2: { x: 0, y: -10, angle: 20, angularSpeed: 0 } },
  ] } satisfies Pick<BattleResult, "ticks" | "frames">;
  it("preserves both endpoints and interpolates instead of freezing a short physics result", () => {
    expect(presentationFrame(result, 0)).toEqual(result.frames[0]);
    expect(presentationFrame(result, 60000)).toEqual(result.frames[1]);
    expect(presentationFrame(result, 30000).player1.x).toBe(-25);
    expect(presentationFrame(result, 48000).player1.x).toBe(-10);
  });
  it("includes all zodiac choices and keeps the finale inside the minute", () => {
    expect(ROUND_DURATION_MS).toBe(60000);
    expect(SUMMON_AT_MS).toBe(48000);
    expect(new Set(ZODIAC_SKILLS).size).toBe(12);
  });
});
