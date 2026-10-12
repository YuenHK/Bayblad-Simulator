import { makeDefaultDesign } from "@steam-top/domain";
import { describe, expect, it } from "vitest";
import { HighestScoringDesign } from "./highest-scoring-design";

describe("all-time student leaderboard champion design", () => {
  const record = (design = makeDefaultDesign(), total = 1, completedAtMs = 100, matchId = "a", slot = 0, identityId = "student") => ({ design, total, completedAtMs, matchId, slot, identityId, displayName: identityId });
  it("defaults to no candidate without completed history", () => {
    expect(new HighestScoringDesign().design()).toBeUndefined();
  });
  it("chooses the cumulative champion even when another student has the highest single score", () => {
    const tracker = new HighestScoringDesign();
    const high = makeDefaultDesign(); high.name = "High";
    tracker.record(record(high, 1.4, 100, "high", 0, "rare"));
    const champion = makeDefaultDesign(); champion.name = "Champion best";
    tracker.record(record(champion, 1.2, 200, "best", 0, "champion"));
    tracker.record(record(makeDefaultDesign(), 1, 300, "latest", 0, "champion"));
    expect(tracker.design()?.name).toBe("Champion best");
  });
  it("changes champion as all-time totals change and excludes empty computer identities", () => {
    const tracker = new HighestScoringDesign();
    const a = makeDefaultDesign(); a.name = "A"; const b = makeDefaultDesign(); b.name = "B";
    tracker.record(record(a, 1.4, 1, "a", 0, "a")); tracker.record(record(b, 1, 2, "b", 0, "b"));
    expect(tracker.design()?.name).toBe("A");
    tracker.record(record(b, 1, 3, "c", 0, "b")); tracker.record(record(a, 9, 4, "cpu", 0, ""));
    expect(tracker.design()?.name).toBe("B");
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
  it("ties student totals by snapshot name before identity, not by best single score", () => {
    const tracker = new HighestScoringDesign(); const a = makeDefaultDesign(); a.name = "Ada"; const b = makeDefaultDesign(); b.name = "Ben";
    tracker.record({ ...record(b, 2, 100, "b", 0, "a-id"), displayName: "Ben" });
    tracker.record({ ...record(a, 1, 200, "a1", 0, "z-id"), displayName: "Ada" });
    tracker.record({ ...record(a, 1, 300, "a2", 0, "z-id"), displayName: "Ada" });
    expect(tracker.design()?.name).toBe("Ada");
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
