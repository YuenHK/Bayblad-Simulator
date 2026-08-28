import { describe, expect, it } from "vitest";

import {
  battleBodySchema,
  type LaunchGrade,
} from "@steam-top/protocol";
import {
  designSchema,
  type TopDesign,
} from "@steam-top/domain";

import {
  ARENA_CENTER_SAFE_RADIUS_MM,
  BattleEngine,
  BROADCAST_EVERY_TICKS,
  MAX_ROUND_SECONDS,
  PHYSICS_MODEL_VERSION,
  STEP_SECONDS,
  STOPPED_TICKS,
  classifyEliminations,
  impactPhysicsFromScore,
  retainAngularSpeedAfterImpact,
  prepareBattleTop,
  resolveTimeoutOutcome,
  simulateMatchRound,
  type BattleInputs,
} from "./engine";
import { DeterministicPrng } from "./prng";

const launch = (
  grade: LaunchGrade = "Great",
  angularMultiplier = 1,
  impulseMultiplier = 1,
) => ({ grade, angularMultiplier, impulseMultiplier });

const design = (overrides: Partial<TopDesign> = {}): TopDesign =>
  designSchema.parse({
    id: "design-a",
    name: "測試陀螺",
    layers: [
      { id: "top", position: "top", shape: "circle", points: 6, diameterMm: 48, cornerRoundness: 0.5, rotationDeg: 0, color: "#2563eb" },
      { id: "middle", position: "middle", shape: "circle", points: 6, diameterMm: 56, cornerRoundness: 0.5, rotationDeg: 0, color: "#60a5fa" },
      { id: "bottom", position: "bottom", shape: "circle", points: 6, diameterMm: 50, cornerRoundness: 0.5, rotationDeg: 0, color: "#bfdbfe" },
    ],
    screwLayout: { count: 4, radiusMm: 15, rotationDeg: 0 },
    metalDiscDiameterMm: 0,
    ...overrides,
  });

const player1 = design();
const player2 = design({
  id: "design-b",
  name: "測試陀螺 B",
  layers: design().layers.map((layer) => ({
    ...layer,
    id: `${layer.id}-b`,
    rotationDeg: 15,
  })) as TopDesign["layers"],
});
const enduranceTop = design({
  id: "endurance",
  name: "耐力型",
  layers: design().layers.map((layer) => ({ ...layer, id: `${layer.id}-endurance`, diameterMm: 60 })) as TopDesign["layers"],
});
const lightTop = design({
  id: "light",
  name: "輕量型",
  layers: design().layers.map((layer) => ({ ...layer, id: `${layer.id}-light`, diameterMm: 40 })) as TopDesign["layers"],
  screwLayout: { count: 4, radiusMm: 12, rotationDeg: 0 },
});
const lowImpactTop = design({
  id: "low-impact",
  name: "低抗撞型",
  layers: design().layers.map((layer) => ({
    ...layer,
    id: `${layer.id}-low-impact`,
    shape: "star",
    diameterMm: 60,
    cornerRoundness: 0,
  })) as TopDesign["layers"],
  screwLayout: { count: 4, radiusMm: 12, rotationDeg: 0 },
});

const inputs = (seed = 12345): BattleInputs => ({
  player1,
  player2,
  launchA: launch(),
  launchB: launch(),
  seed,
});

describe("DeterministicPrng", () => {
  it("replays the same bounded sequence from the same uint32 seed", () => {
    const first = new DeterministicPrng(0);
    const second = new DeterministicPrng(0);
    const values = Array.from({ length: 20 }, () => first.nextFloat());
    expect(values).toEqual(Array.from({ length: 20 }, () => second.nextFloat()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new DeterministicPrng(7).nextRange(-2, 3)).toBeGreaterThanOrEqual(-2);
    expect(new DeterministicPrng(7).nextRange(-2, 3)).toBeLessThan(3);
  });

  it("produces a different sequence for a different seed", () => {
    const a = new DeterministicPrng(1);
    const b = new DeterministicPrng(2);
    expect(Array.from({ length: 5 }, () => a.nextFloat())).not.toEqual(
      Array.from({ length: 5 }, () => b.nextFloat()),
    );
  });

  it.each([-1, 1.5, 0x1_0000_0000, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid seed %s",
    (seed) => expect(() => new DeterministicPrng(seed)).toThrow(/seed/i),
  );

  it("rejects invalid ranges", () => {
    const prng = new DeterministicPrng(1);
    expect(() => prng.nextRange(1, 1)).toThrow(/range/i);
    expect(() => prng.nextRange(Number.NaN, 2)).toThrow(/range/i);
  });
});

describe("authoritative Planck battle simulation", () => {
  it("maps canonical impact resistance monotonically to bounded fixture/contact physics", () => {
    const low = impactPhysicsFromScore(0);
    const middle = impactPhysicsFromScore(50);
    const high = impactPhysicsFromScore(100);
    expect(low.angularRetention).toBeCloseTo(0.82, 12);
    expect(high.angularRetention).toBeCloseTo(0.98, 12);
    expect(low.angularRetention).toBeLessThan(middle.angularRetention);
    expect(middle.angularRetention).toBeLessThan(high.angularRetention);
    expect(low.restitution).toBeLessThan(high.restitution);
    for (const value of [low, middle, high].flatMap(Object.values)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("retains more angular speed after a controlled impact at a higher score", () => {
    const low = retainAngularSpeedAfterImpact(120, 0);
    const high = retainAngularSpeedAfterImpact(120, 100);
    expect(Math.abs(high)).toBeGreaterThan(Math.abs(low));
    expect(retainAngularSpeedAfterImpact(-120, 100)).toBeCloseTo(-high, 12);
  });

  it("exports the canonical physics constants", () => {
    expect(PHYSICS_MODEL_VERSION).toBe("1.0.0");
    expect(STEP_SECONDS).toBe(1 / 60);
    expect(MAX_ROUND_SECONDS).toBe(90);
    expect(BROADCAST_EVERY_TICKS).toBe(4);
    expect(ARENA_CENTER_SAFE_RADIUS_MM).toBeLessThanOrEqual(100);
  });

  it("replays identical frames and outcome from one seed", () => {
    const first = simulateMatchRound(player1, player2, {
      seed: 12345,
      launchA: launch(),
      launchB: launch(),
    });
    const second = simulateMatchRound(player1, player2, {
      seed: 12345,
      launchA: launch(),
      launchB: launch(),
    });
    expect(second).toEqual(first);
  });

  it("uses bounded seeded perturbation without producing invalid protocol bodies", () => {
    const a = simulateMatchRound(player1, player2, { seed: 1, launchA: launch(), launchB: launch() });
    const b = simulateMatchRound(player1, player2, { seed: 2, launchA: launch(), launchB: launch() });
    expect(b.frames).not.toEqual(a.frames);
    for (const result of [a, b]) {
      expect(result.ticks).toBeLessThanOrEqual(MAX_ROUND_SECONDS / STEP_SECONDS);
      expect(result.frames[0]?.tick).toBe(0);
      expect(result.frames.at(-1)?.tick).toBe(result.ticks);
      for (const frame of result.frames) {
        expect(battleBodySchema.parse(frame.player1)).toEqual(frame.player1);
        expect(battleBodySchema.parse(frame.player2)).toEqual(frame.player2);
        expect(frame.player1.angle).toBeGreaterThanOrEqual(-Math.PI);
        expect(frame.player1.angle).toBeLessThanOrEqual(Math.PI);
      }
    }
  });

  it("broadcasts tick zero, each fourth tick, and the final tick exactly once", () => {
    const result = simulateMatchRound(player1, player2, { seed: 33, launchA: launch(), launchB: launch() });
    expect(result.frames.map(({ tick }) => tick)).toEqual([
      ...Array.from({ length: Math.floor(result.ticks / 4) + 1 }, (_, index) => index * 4),
      ...(result.ticks % 4 === 0 ? [] : [result.ticks]),
    ]);
  });

  it("recalculates immutable authoritative mass, inertia, performance, and envelope", () => {
    const prepared = prepareBattleTop(player1);
    expect(prepared.massKg).toBeGreaterThan(0);
    expect(prepared.polarInertiaKgM2).toBeGreaterThan(0);
    expect(prepared.envelopeRadiiM).toHaveLength(32);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.performance)).toBe(true);
    expect(Object.isFrozen(prepared.envelopeRadiiM)).toBe(true);
  });

  it("rejects schema-invalid and course-invalid designs instead of trusting client stats", () => {
    expect(() => simulateMatchRound({ ...player1, name: "" }, player2, { seed: 1, launchA: launch(), launchB: launch() })).toThrow(/design/i);
    const tooLarge = { ...player1, layers: player1.layers.map((layer) => ({ ...layer, diameterMm: 80 })) } as TopDesign;
    expect(() => simulateMatchRound(tooLarge, player2, { seed: 1, launchA: launch(), launchB: launch() })).toThrow(/course/i);
  });

  it.each([
    launch("Great", -0.01, 1),
    launch("Great", 2.01, 1),
    launch("Great", 1, Number.NaN),
  ])("rejects launch multipliers outside the protocol range", (invalidLaunch) => {
    expect(() => simulateMatchRound(player1, player2, { seed: 1, launchA: invalidLaunch, launchB: launch() })).toThrow(/launch/i);
  });

  it("accepts protocol-minimum zero multipliers and stops finitely after 500 ms", () => {
    const result = simulateMatchRound(player1, player2, {
      seed: 99,
      launchA: launch("Miss", 0, 0),
      launchB: launch("Miss", 0, 0),
    });
    expect(result.ticks).toBe(STOPPED_TICKS);
    expect(result.outcome).toEqual({ winner: "draw", reason: "simultaneous" });
    expect(result.frames.flatMap((frame) => [
      ...Object.values(frame.player1),
      ...Object.values(frame.player2),
    ]).every(Number.isFinite)).toBe(true);
  });

  it("records one deduplicated top contact and applies stronger retention to the high-impact top", () => {
    const highImpactTop = enduranceTop;
    const result = simulateMatchRound(highImpactTop, lowImpactTop, {
      seed: 31337,
      launchA: launch(),
      launchB: launch(),
    });
    expect(prepareBattleTop(highImpactTop).performance.impactResistance)
      .toBeGreaterThan(prepareBattleTop(lowImpactTop).performance.impactResistance);
    expect(result.finalStats.topTopContactCount).toBeGreaterThan(0);
    expect(result.finalStats.player1.impactRetentionProduct)
      .toBeGreaterThan(result.finalStats.player2.impactRetentionProduct);
  });

  it("does not mutate caller inputs", () => {
    const value = inputs(8);
    const before = structuredClone(value);
    simulateMatchRound(value.player1, value.player2, value);
    expect(value).toEqual(before);
  });
});

describe("elimination and outcome rules", () => {
  it("requires exactly 30 consecutive stopped ticks (500 ms)", () => {
    expect(STOPPED_TICKS).toBe(30);
    expect(classifyEliminations({ player1StoppedTicks: 29, player2StoppedTicks: 0, player1RadiusMm: 0, player2RadiusMm: 0 })).toEqual({ player1: false, player2: false, reason: null });
    expect(classifyEliminations({ player1StoppedTicks: 30, player2StoppedTicks: 0, player1RadiusMm: 0, player2RadiusMm: 0 })).toEqual({ player1: true, player2: false, reason: "stopped" });
  });

  it("uses centre crossing and draws simultaneous same-tick eliminations", () => {
    expect(classifyEliminations({ player1StoppedTicks: 0, player2StoppedTicks: 0, player1RadiusMm: ARENA_CENTER_SAFE_RADIUS_MM + 0.001, player2RadiusMm: 0 })).toEqual({ player1: true, player2: false, reason: "out-of-bounds" });
    expect(classifyEliminations({ player1StoppedTicks: 30, player2StoppedTicks: 0, player1RadiusMm: 0, player2RadiusMm: ARENA_CENTER_SAFE_RADIUS_MM + 1 })).toEqual({ player1: true, player2: true, reason: "simultaneous" });
  });

  it("uses a fixed three-percent timeout tie tolerance", () => {
    expect(resolveTimeoutOutcome({ energy1: 10, energy2: 9, spin1: 100, spin2: 90 })).toEqual({ winner: "player1", reason: "timeout" });
    expect(resolveTimeoutOutcome({ energy1: 10, energy2: 9.8, spin1: 100, spin2: 100 })).toEqual({ winner: "draw", reason: "timeout" });
    expect(resolveTimeoutOutcome({ energy1: 9, energy2: 10, spin1: 90, spin2: 100 })).toEqual({ winner: "player2", reason: "timeout" });
  });

  it("does not invent contact between separated SI-scale tops and reaches timeout", () => {
    const result = simulateMatchRound(lightTop, {
      ...lightTop,
      id: "light-copy",
      layers: lightTop.layers.map((layer) => ({ ...layer, id: `${layer.id}-copy` })) as TopDesign["layers"],
    }, {
      seed: 123,
      launchA: launch("Perfect", 2, 1e-9),
      launchB: launch("Perfect", 2, 1e-9),
    });
    expect(result.ticks).toBe(MAX_ROUND_SECONDS / STEP_SECONDS);
    expect(result.outcome.reason).toBe("timeout");
  });

  it("does not let five calibration seeds reverse an overwhelming launch advantage", () => {
    for (const seed of [1, 17, 31337, 0x7fff_ffff, 0xffff_ffff]) {
      const result = simulateMatchRound(player1, player2, {
        seed,
        launchA: launch("Perfect", 2, 2),
        launchB: launch("Miss", 0.01, 0.01),
      });
      expect(result.outcome.winner).not.toBe("player2");
    }
  });

  it("does not let five calibration seeds reverse a clear canonical endurance advantage", () => {
    for (const seed of [1, 17, 31337, 0x7fff_ffff, 0xffff_ffff]) {
      const result = simulateMatchRound(enduranceTop, lightTop, {
        seed,
        launchA: launch(),
        launchB: launch(),
      });
      expect(result.outcome.winner).not.toBe("player2");
    }
  });
});

describe("BattleEngine simulate-once cache", () => {
  it("simulates once for twenty spectators and returns defensive deep clones", () => {
    const engine = new BattleEngine();
    const results = Array.from({ length: 20 }, () => engine.simulateOnce("match-1", "round-1", inputs()));
    expect(engine.simulationCount).toBe(1);
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(results[0]).not.toBe(results[1]);
    expect(results[0]?.frames).not.toBe(results[1]?.frames);
  });

  it("rejects correlation conflicts and permits explicit cleanup only after close", () => {
    const engine = new BattleEngine();
    engine.simulateOnce("match-1", "round-1", inputs());
    expect(() => engine.simulateOnce("match-1", "round-1", inputs(9))).toThrow(/conflict/i);
    expect(() => engine.cleanup("match-1", "round-1")).toThrow(/closed/i);
    engine.close("match-1", "round-1");
    expect(engine.cleanup("match-1", "round-1")).toBe(true);
    engine.simulateOnce("match-1", "round-1", inputs());
    expect(engine.simulationCount).toBe(2);
  });

  it("rejects unbounded correlation keys", () => {
    const engine = new BattleEngine();
    expect(() => engine.simulateOnce("x".repeat(129), "round", inputs())).toThrow(/correlation/i);
  });
});
