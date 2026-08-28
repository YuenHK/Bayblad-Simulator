import { makeDefaultDesign } from "@steam-top/domain";
import { describe, expect, it } from "vitest";
import { DesignRegistry, DesignRegistryError } from "./design-registry";

describe("DesignRegistry", () => {
  it("revalidates a course-valid design, recomputes authority values, and binds it to its session", () => {
    const registry = new DesignRegistry({ createDesignId: () => "10000000-0000-4000-8000-000000000001" });
    const design = makeDefaultDesign();
    const stored = registry.register("session-a", design);

    expect(stored.designId).toBe("10000000-0000-4000-8000-000000000001");
    expect(stored.massG).toBeGreaterThan(0);
    expect(stored.performance.speed).toBeGreaterThanOrEqual(0);
    expect(registry.requireOwned("session-a", stored.designId).design).toEqual(design);
    expect(() => registry.requireOwned("session-b", stored.designId)).toThrowError(
      new DesignRegistryError("DESIGN_NOT_OWNED"),
    );
  });

  it("rejects malformed and course-invalid drafts", () => {
    const registry = new DesignRegistry();
    expect(() => registry.register("session-a", { nope: true })).toThrowError(DesignRegistryError);

    const invalid = makeDefaultDesign();
    invalid.layers[1].diameterMm = 80;
    expect(() => registry.register("session-a", invalid)).toThrowError(
      new DesignRegistryError("DESIGN_INVALID"),
    );
    expect(() => registry.register("session-a", { ...makeDefaultDesign(), clientMassG: 1 })).toThrowError(
      new DesignRegistryError("DESIGN_INVALID"),
    );
    const nestedExtra = makeDefaultDesign();
    (nestedExtra.layers[0] as unknown as Record<string, unknown>).clientSpeed = 100;
    expect(() => registry.register("session-a", nestedExtra)).toThrowError(
      new DesignRegistryError("DESIGN_INVALID"),
    );
  });

  it("returns immutable defensive values", () => {
    const registry = new DesignRegistry({ createDesignId: () => "10000000-0000-4000-8000-000000000002" });
    const stored = registry.register("session-a", makeDefaultDesign());
    stored.design.name = "tampered";
    expect(registry.requireOwned("session-a", stored.designId).design.name).toBe("我的陀螺");
    const visual = registry.publicBattleDesign("session-a", stored.designId);
    visual.layers[0].color = "#000000";
    expect(registry.publicBattleDesign("session-a", stored.designId).layers[0].color).not.toBe("#000000");
    expect(visual).not.toHaveProperty("ownerSessionId");
    expect(visual).not.toHaveProperty("performance");
  });

  it("bounds per-owner/global storage, retries UUID collisions, and never evicts pinned designs", () => {
    let now = 0;
    const ids = [
      "10000000-0000-4000-8000-000000000010",
      "10000000-0000-4000-8000-000000000010",
      "10000000-0000-4000-8000-000000000011",
      "10000000-0000-4000-8000-000000000012",
    ];
    const registry = new DesignRegistry({
      now: () => now,
      createDesignId: () => ids.shift()!,
      maxGlobal: 2,
      maxPerOwner: 2,
      ttlMs: 100,
    });
    const first = registry.register("a", makeDefaultDesign());
    const second = registry.register("a", makeDefaultDesign());
    expect(second.designId).not.toBe(first.designId);
    expect(() => registry.register("a", makeDefaultDesign())).toThrowError(
      new DesignRegistryError("DESIGN_QUOTA_EXCEEDED"),
    );
    registry.pin("a", first.designId);
    now = 101;
    expect(registry.register("b", makeDefaultDesign()).designId).toBe("10000000-0000-4000-8000-000000000012");
    expect(registry.requireOwned("a", first.designId).designId).toBe(first.designId);
    registry.unpin("a", first.designId);
    expect(registry.cleanupOwner("a")).toBe(1);
    expect(registry.debugCounts()).toEqual({ total: 1, owners: 1, pinned: 0 });
  });

  it("evicts the least recently used unpinned design at global capacity", () => {
    let now = 0;
    let sequence = 20;
    const registry = new DesignRegistry({
      now: () => now,
      createDesignId: () => `10000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
      maxGlobal: 2,
      ttlMs: 10_000,
    });
    const oldest = registry.register("a", makeDefaultDesign());
    now = 1;
    const kept = registry.register("b", makeDefaultDesign());
    now = 2;
    registry.requireOwned("a", oldest.designId);
    now = 3;
    registry.register("c", makeDefaultDesign());
    expect(registry.requireOwned("a", oldest.designId).designId).toBe(oldest.designId);
    expect(() => registry.requireOwned("b", kept.designId)).toThrowError(new DesignRegistryError("DESIGN_NOT_FOUND"));
  });
});
