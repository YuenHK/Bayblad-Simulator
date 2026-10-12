import { makeDefaultDesign } from "@steam-top/domain";
import { describe, expect, it } from "vitest";
import { HighestScoringDesign } from "./highest-scoring-design";

describe("highest single-match design", () => {
  const record = (design = makeDefaultDesign(), total = 1, completedAtMs = 100, matchId = "a", slot = 0) => ({ design, total, completedAtMs, matchId, slot });
  it("defaults to no candidate without completed history", () => {
    expect(new HighestScoringDesign().design()).toBeUndefined();
  });
  it("chooses a rare high score rather than a popular low score or cumulative total", () => {
    const tracker = new HighestScoringDesign();
    const high = makeDefaultDesign(); high.name = "High";
    tracker.record(record(high, 1.4));
    for (let i = 0; i < 50; i++) tracker.record(record(makeDefaultDesign(), 1, 200 + i));
    expect(tracker.design()?.name).toBe("High");
  });
  it("resolves ties by latest completion then match ID and seat", () => {
    const tracker = new HighestScoringDesign();
    const candidates = [["old", 100, "a", 0], ["seat2", 200, "b", 1], ["seat1", 200, "b", 0], ["earlier-id", 200, "a", 1]] as const;
    for (const [name, time, id, slot] of candidates) {
      const design = makeDefaultDesign(); design.name = name;
      tracker.record(record(design, 1, time, id, slot));
    }
    expect(tracker.design()?.name).toBe("earlier-id");
  });
  it("ignores invalid weight and non-finite scores", () => {
    const tracker = new HighestScoringDesign();
    const invalid = makeDefaultDesign(); invalid.layers.forEach(layer => { layer.diameterMm = 80; });
    tracker.record(record(invalid, 9));
    tracker.record(record(makeDefaultDesign(), NaN));
    expect(tracker.design()).toBeUndefined();
  });
  it("ignores malformed geometry without throwing", () => {
    const tracker = new HighestScoringDesign(); const invalid = makeDefaultDesign(); invalid.layers[0].diameterMm = 200;
    expect(() => tracker.record(record(invalid, 9))).not.toThrow();
    expect(tracker.design()).toBeUndefined();
  });
  it("preserves custom outlines and isolates candidate snapshots", () => {
    const tracker = new HighestScoringDesign(); const design = makeDefaultDesign();
    design.layers[0] = { ...design.layers[0], shape: "custom", diameterMm: 28.284, outline: { version: 1, mirror: "none", vertices: [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }] } };
    const expected = structuredClone(design); tracker.record(record(design)); design.name = "mutated";
    expect(tracker.design()).toEqual(expected);
    tracker.design()!.layers[0].outline!.vertices[0]!.x = 0;
    expect(tracker.design()).toEqual(expected);
  });
});
