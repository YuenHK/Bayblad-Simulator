import { describe, expect, it } from "vitest";

import {
  battleBodySchema,
  type LaunchGrade,
} from "@steam-top/protocol";
import {
  designSchema,
  maxDiameter,
  radialFactor,
  type TopDesign,
} from "@steam-top/domain";

import {
  ARENA_CENTER_SAFE_RADIUS_MM,
  BattleEngine,
  InMemoryCompletedRoundStore,
  COLLISION_OUTLINE_MAX_ERROR_MM,
  buildCollisionOutlineVertices,
  buildCollisionProxyVertices,
  BROADCAST_EVERY_TICKS,
  MAX_ROUND_SECONDS,
  PHYSICS_MODEL_VERSION,
  STEP_SECONDS,
  STOPPED_TICKS,
  classifyEliminations,
  collisionOutlinesOverlap,
  impactPhysicsFromScore,
  retainAngularSpeedAfterImpact,
  prepareBattleTop,
  resolveTimeoutOutcome,
  simulateMatchRound,
  simulateMatchRoundAsync,
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
const maximalStarTop = design({
  id: "maximal-star",
  name: "最大十六角星",
  layers: design().layers.map((layer) => ({
    ...layer,
    id: `${layer.id}-maximal-star`,
    shape: "star",
    points: 16,
    diameterMm: 60,
    cornerRoundness: 0,
    rotationDeg: 5.625,
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
  it("preserves concave canonical radial outlines within a bounded all-direction error", () => {
    const radiusOnOutline = (vertices: readonly { x: number; y: number }[], angle: number) => {
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      let best = 0;
      for (let index = 0; index < vertices.length; index += 1) {
        const a = vertices[index]!;
        const b = vertices[(index + 1) % vertices.length]!;
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const denominator = dx * ey - dy * ex;
        if (Math.abs(denominator) < 1e-12) continue;
        const rayDistance = (a.x * ey - a.y * ex) / denominator;
        const segmentRatio = (a.x * dy - a.y * dx) / denominator;
        if (rayDistance >= 0 && segmentRatio >= -1e-9 && segmentRatio <= 1 + 1e-9) {
          best = Math.max(best, rayDistance);
        }
      }
      return best;
    };
    for (const [shape, points] of [["star", 9], ["star", 16], ["wave", 9], ["wave", 16]] as const) {
      for (const rotationDeg of [0, 5.625, 23]) {
        const candidate = design({
          layers: design().layers.map((layer) => ({
            ...layer,
            id: `${shape}-${points}-${rotationDeg}-${layer.position}`,
            shape,
            points,
            diameterMm: 60,
            cornerRoundness: 0,
            rotationDeg,
          })) as TopDesign["layers"],
        });
        const outline = buildCollisionOutlineVertices(candidate);
        let maximumError = 0;
        for (let sample = 0; sample < 2_048; sample += 1) {
          const angle = sample * Math.PI * 2 / 2_048;
          const localAngle = angle - rotationDeg * Math.PI / 180;
          const expectedRadius = 30 * radialFactor(shape, points, localAngle, 0);
          maximumError = Math.max(maximumError, Math.abs(radiusOnOutline(outline, angle) - expectedRadius));
        }
        expect(maximumError).toBeLessThanOrEqual(COLLISION_OUTLINE_MAX_ERROR_MM);
      }
    }
  });

  it("simplifies the worst canonical 16-point star outline to a bounded vertex count", () => {
    expect(buildCollisionOutlineVertices(maximalStarTop).length).toBeLessThanOrEqual(192);
  });

  it("keeps the valleys of a 9-point star in the top-to-top contact outline", () => {
    const star = design({
      layers: design().layers.map((layer) => ({
        ...layer,
        id: `${layer.id}-nine-star`,
        shape: "star",
        points: 9,
        diameterMm: 60,
        cornerRoundness: 0,
        rotationDeg: 5.625,
      })) as TopDesign["layers"],
    });
    const radii = buildCollisionOutlineVertices(star).map(({ x, y }) => Math.hypot(x, y));
    expect(Math.max(...radii)).toBeCloseTo(30, 6);
    expect(Math.min(...radii)).toBeLessThan(19);
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(10);

    const outline = buildCollisionOutlineVertices(star);
    const probeOutline = buildCollisionOutlineVertices(design({
      layers: design().layers.map((layer) => ({
        ...layer,
        id: `${layer.id}-valley-probe`,
        diameterMm: 30,
      })) as TopDesign["layers"],
      screwLayout: { count: 4, radiusMm: 10, rotationDeg: 0 },
    }));
    const degrees = (value: number) => value * Math.PI / 180;
    const left = { position: { x: 0, y: 0 } };
    const right = { position: { x: 40, y: 0 }, angle: 0 };
    // Bounding circles overlap at 40 mm. A probe misses the star valley but
    // touches its peak: the contact path is not silently using the convex wall
    // proxy or broad-phase sensor radius.
    expect(collisionOutlinesOverlap(
      outline, { ...left, angle: degrees(-25.625) },
      probeOutline, right,
    )).toBe(false);
    expect(collisionOutlinesOverlap(
      outline, { ...left, angle: degrees(-5.625) },
      probeOutline, right,
    )).toBe(true);
  });

  it("builds finite convex collision proxies with <=8 vertices and rotation-stable outer diameter", () => {
    const rotations = [0, 5.625, 17, 89];
    for (const shape of ["circle", "polygon", "star", "wave"] as const) {
      for (let points = 3; points <= 16; points += 1) {
        for (const rotationDeg of rotations) {
          const candidate = design({
            layers: design().layers.map((layer) => ({
              ...layer,
              id: `${shape}-${points}-${rotationDeg}-${layer.position}`,
              shape,
              points,
              diameterMm: 60,
              cornerRoundness: 0,
              rotationDeg,
            })) as TopDesign["layers"],
          });
          const proxy = buildCollisionProxyVertices(candidate);
          expect(proxy.length).toBeGreaterThanOrEqual(3);
          expect(proxy.length).toBeLessThanOrEqual(8);
          expect(proxy.flatMap(({ x, y }) => [x, y]).every(Number.isFinite)).toBe(true);
          expect(maxDiameter(proxy)).toBeCloseTo(60, 6);
          const crosses = proxy.map((point, index) => {
            const next = proxy[(index + 1) % proxy.length]!;
            const after = proxy[(index + 2) % proxy.length]!;
            return (next.x - point.x) * (after.y - next.y) -
              (next.y - point.y) * (after.x - next.x);
          });
          expect(crosses.every((cross) => cross >= -1e-9) || crosses.every((cross) => cross <= 1e-9)).toBe(true);
        }
      }
    }
  });

  it("preserves the 60 mm radius extrema of a rotated legal 16-point star", () => {
    const rotated = design({
      layers: design().layers.map((layer) => ({
        ...layer,
        id: `${layer.id}-rotated-star`,
        shape: "star",
        points: 16,
        diameterMm: 60,
        cornerRoundness: 0,
        rotationDeg: 5.625,
      })) as TopDesign["layers"],
      screwLayout: { count: 4, radiusMm: 12, rotationDeg: 0 },
    });
    expect(maxDiameter(buildCollisionProxyVertices(rotated))).toBeCloseTo(60, 6);
  });

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
    expect(PHYSICS_MODEL_VERSION).toBe("2.0.0");
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
    expect(result.finalStats.topTopImpactApplications)
      .toBe(result.finalStats.topTopBeginContactEpisodes);
    expect(result.finalStats.player1.impactRetentionProduct)
      .toBeCloseTo(
        impactPhysicsFromScore(prepareBattleTop(highImpactTop).performance.impactResistance)
          .angularRetention ** result.finalStats.topTopImpactApplications,
        12,
      );
    expect(result.finalStats.player1.impactRetentionProduct)
      .toBeGreaterThan(result.finalStats.player2.impactRetentionProduct);
  });

  it("keeps a typical equal-design battle observable for more than one second at the median", () => {
    const ticks = [1, 2, 3, 4, 5, 6, 7].map((seed) =>
      simulateMatchRound(player1, {
        ...player1,
        id: `equal-${seed}`,
        layers: player1.layers.map((layer) => ({ ...layer, id: `${layer.id}-equal-${seed}` })) as TopDesign["layers"],
      }, { seed, launchA: launch(), launchB: launch() }).ticks,
    ).sort((left, right) => left - right);
    expect(ticks[Math.floor(ticks.length / 2)]).toBeGreaterThan(60);
    expect(ticks.every((tick) => tick <= MAX_ROUND_SECONDS / STEP_SECONDS)).toBe(true);
  });

  it("does not mutate caller inputs", () => {
    const value = inputs(8);
    const before = structuredClone(value);
    simulateMatchRound(value.player1, value.player2, value);
    expect(value).toEqual(before);
  });
});

describe("elimination and outcome rules", () => {
  it("has no player-seat bias when designs and launch judgements are swapped", () => {
    const swapWinner = (winner: "player1" | "player2" | "draw") =>
      winner === "player1" ? "player2" : winner === "player2" ? "player1" : "draw";
    for (const seed of [1, 17, 31337, 0x7fff_ffff, 0xffff_ffff]) {
      const forward = simulateMatchRound(enduranceTop, lightTop, {
        seed,
        launchA: launch("Perfect", 1.1, 1.1),
        launchB: launch("Good", 0.9, 0.9),
      });
      const reverse = simulateMatchRound(lightTop, enduranceTop, {
        seed,
        launchA: launch("Good", 0.9, 0.9),
        launchB: launch("Perfect", 1.1, 1.1),
      });
      expect(reverse.outcome.winner).toBe(swapWinner(forward.outcome.winner));
      expect(reverse.outcome.reason).toBe(forward.outcome.reason);
    }
  });

  it("distributes identical-design winners fairly across 2000 seeds", () => {
    const identical = {
      ...player1,
      id: "identical-player2",
      name: "相同設計副本",
      layers: player1.layers.map((layer) => ({
        ...layer,
        id: `${layer.id}-identical`,
        color: "#ffffff",
      })) as TopDesign["layers"],
    };
    const counts = { player1: 0, player2: 0, draw: 0 };
    for (let seed = 0; seed < 2_000; seed += 1) {
      counts[simulateMatchRound(player1, identical, {
        seed,
        launchA: launch(),
        launchB: launch(),
      }).outcome.winner] += 1;
    }
    expect(Math.abs(counts.player1 - counts.player2)).toBeLessThanOrEqual(80);
    expect(counts.player1 + counts.player2).toBeGreaterThan(1_500);
  }, 30_000);

  it("maps 200 swapped strong/weak simulations exactly back to external players", () => {
    const swapWinner = (winner: "player1" | "player2" | "draw") =>
      winner === "player1" ? "player2" : winner === "player2" ? "player1" : "draw";
    for (let seed = 0; seed < 200; seed += 1) {
      const forward = simulateMatchRound(enduranceTop, lightTop, {
        seed,
        launchA: launch("Perfect", 1.1, 1.1),
        launchB: launch("Good", 0.9, 0.9),
      });
      const reverse = simulateMatchRound(lightTop, enduranceTop, {
        seed,
        launchA: launch("Good", 0.9, 0.9),
        launchB: launch("Perfect", 1.1, 1.1),
      });
      expect(reverse.ticks).toBe(forward.ticks);
      expect(reverse.outcome).toEqual({
        winner: swapWinner(forward.outcome.winner),
        reason: forward.outcome.reason,
      });
      expect(reverse.frames).toEqual(forward.frames.map((frame) => ({
        tick: frame.tick,
        player1: frame.player2,
        player2: frame.player1,
      })));
    }
  }, 30_000);

  it("requires exactly 30 consecutive stopped ticks (500 ms)", () => {
    expect(STOPPED_TICKS).toBe(30);
    expect(classifyEliminations({ player1StoppedTicks: 29, player2StoppedTicks: 0, player1RadiusMm: 0, player2RadiusMm: 0 })).toEqual({ player1: false, player2: false, reason: null });
    expect(classifyEliminations({ player1StoppedTicks: 30, player2StoppedTicks: 0, player1RadiusMm: 0, player2RadiusMm: 0 })).toEqual({ player1: true, player2: false, reason: "stopped" });
  });

  it("uses centre crossing and draws simultaneous same-tick eliminations", () => {
    expect(classifyEliminations({ player1StoppedTicks: 0, player2StoppedTicks: 0, player1RadiusMm: ARENA_CENTER_SAFE_RADIUS_MM + 0.001, player2RadiusMm: 0 })).toEqual({ player1: true, player2: false, reason: "out-of-bounds" });
    expect(classifyEliminations({ player1StoppedTicks: 30, player2StoppedTicks: 0, player1RadiusMm: 0, player2RadiusMm: ARENA_CENTER_SAFE_RADIUS_MM + 1 })).toEqual({ player1: true, player2: true, reason: "simultaneous" });
  });

  it("has a deterministic legal path that crosses the authoritative centre boundary", () => {
    const result = simulateMatchRound(maximalStarTop, player2, {
      seed: 0,
      launchA: launch("Perfect", 2, 2),
      launchB: launch("Miss", 0.1, 0.1),
    });
    expect(result.outcome.reason).toBe("out-of-bounds");
    const finalFrame = result.frames.at(-1)!;
    expect(Math.max(
      Math.hypot(finalFrame.player1.x, finalFrame.player1.y),
      Math.hypot(finalFrame.player2.x, finalFrame.player2.y),
    )).toBeGreaterThan(ARENA_CENTER_SAFE_RADIUS_MM);
  }, 30_000);

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
  const timeoutInputs = (seed: number): BattleInputs => ({
    player1: lightTop,
    player2: {
      ...lightTop,
      id: `timeout-copy-${seed}`,
      layers: lightTop.layers.map((layer) => ({ ...layer, id: `${layer.id}-timeout-${seed}` })) as TopDesign["layers"],
    },
    seed,
    launchA: launch("Perfect", 2, 1e-9),
    launchB: launch("Perfect", 2, 1e-9),
  });

  it("cooperatively yields during a worst-case async round and exactly matches sync", async () => {
    const timeoutPlayer2 = {
      ...lightTop,
      id: "light-async-copy",
      layers: lightTop.layers.map((layer) => ({ ...layer, id: `${layer.id}-async-copy` })) as TopDesign["layers"],
    };
    const options = {
      seed: 123,
      launchA: launch("Perfect", 2, 1e-9),
      launchB: launch("Perfect", 2, 1e-9),
    };
    const sync = simulateMatchRound(lightTop, timeoutPlayer2, options);
    let heartbeats = 0;
    const heartbeat = setInterval(() => { heartbeats += 1; }, 0);
    const asyncResult = await simulateMatchRoundAsync(lightTop, timeoutPlayer2, options, { chunkTicks: 120 });
    clearInterval(heartbeat);
    expect(asyncResult).toEqual(sync);
    expect(heartbeats).toBeGreaterThan(1);
  });

  it("keeps two concurrent maximal-star rounds responsive", async () => {
    const opponent = {
      ...maximalStarTop,
      id: "maximal-star-opponent",
      layers: maximalStarTop.layers.map((layer) => ({
        ...layer,
        id: `${layer.id}-opponent`,
      })) as TopDesign["layers"],
    };
    const gaps: number[] = [];
    let previous = performance.now();
    const heartbeat = setInterval(() => {
      const current = performance.now();
      gaps.push(current - previous);
      previous = current;
    }, 5);
    const started = performance.now();
    const results = await Promise.all([
      simulateMatchRoundAsync(maximalStarTop, opponent, {
        seed: 501,
        launchA: launch(),
        launchB: launch(),
      }),
      simulateMatchRoundAsync(maximalStarTop, opponent, {
        seed: 502,
        launchA: launch(),
        launchB: launch(),
      }),
    ]);
    clearInterval(heartbeat);
    gaps.push(performance.now() - previous);
    expect(results.every(({ ticks }) => ticks > 60)).toBe(true);
    expect(gaps.length).toBeGreaterThan(0);
    expect(Math.max(...gaps)).toBeLessThan(100);
    expect(performance.now() - started).toBeLessThan(1_000);
  }, 30_000);

  it("deduplicates concurrent async spectators and rejects an active fingerprint conflict", async () => {
    const engine = new BattleEngine({ chunkTicks: 1 });
    const first = engine.simulateOnceAsync("match-async", "round-1", inputs());
    const second = engine.simulateOnceAsync("match-async", "round-1", inputs());
    await expect(engine.simulateOnceAsync("match-async", "round-1", inputs(99))).rejects.toThrow(/conflict/i);
    const [result1, result2] = await Promise.all([first, second]);
    expect(result2).toEqual(result1);
    expect(result2).not.toBe(result1);
    expect(engine.simulationCount).toBe(1);
  });

  it("simulates once for twenty spectators and returns defensive deep clones", () => {
    const engine = new BattleEngine();
    const results = Array.from({ length: 20 }, () => engine.simulateOnce("match-1", "round-1", inputs()));
    expect(engine.simulationCount).toBe(1);
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(results[0]).not.toBe(results[1]);
    expect(results[0]?.frames).not.toBe(results[1]?.frames);
  });

  it("fingerprints parsed canonical inputs so trim-equivalent retries share cache", () => {
    const engine = new BattleEngine();
    const canonical = inputs();
    const spaced = {
      ...canonical,
      player1: { ...canonical.player1, name: `  ${canonical.player1.name}  ` },
    };
    expect(engine.simulateOnce("match-canonical", "round-1", spaced)).toEqual(
      engine.simulateOnce("match-canonical", "round-1", canonical),
    );
    expect(engine.simulationCount).toBe(1);
  });

  it("expires closed results after TTL but keeps them for a short reconnect", () => {
    let now = 1_000;
    const engine = new BattleEngine({ ttlMs: 100, now: () => now });
    const first = engine.simulateOnce("match-ttl", "round-1", inputs());
    engine.close("match-ttl", "round-1");
    now += 99;
    expect(engine.simulateOnce("match-ttl", "round-1", inputs())).toEqual(first);
    expect(engine.simulationCount).toBe(1);
    now += 2;
    expect(engine.simulateOnce("match-ttl", "round-1", inputs())).toEqual(first);
    expect(engine.simulationCount).toBe(1);
  });

  it("bounds large timeout results and evicts the least recently used entry", () => {
    const engine = new BattleEngine({ maxEntries: 2 });
    engine.simulateOnce("match-a", "round", inputs(1));
    const expectedB = engine.simulateOnce("match-b", "round", inputs(2));
    engine.simulateOnce("match-a", "round", inputs(1));
    engine.simulateOnce("match-c", "round", inputs(3));
    expect(engine.cacheSize).toBe(2);
    expect(engine.simulateOnce("match-b", "round", inputs(2))).toEqual(expectedB);
    expect(engine.simulationCount).toBe(3);
    expect(engine.cacheSize).toBe(2);

    const timeoutEngine = new BattleEngine({ maxEntries: 1 });
    expect(timeoutEngine.simulateOnce("timeout-a", "round", timeoutInputs(10)).ticks).toBe(5_400);
    expect(timeoutEngine.simulateOnce("timeout-b", "round", timeoutInputs(11)).ticks).toBe(5_400);
    expect(timeoutEngine.cacheSize).toBe(1);
  });

  it("rejects correlation conflicts while explicit cleanup deletes immediately", () => {
    const engine = new BattleEngine();
    const expected = engine.simulateOnce("match-1", "round-1", inputs());
    expect(() => engine.simulateOnce("match-1", "round-1", inputs(9))).toThrow(/conflict/i);
    expect(engine.cleanup("match-1", "round-1")).toBe(true);
    expect(engine.simulateOnce("match-1", "round-1", inputs())).toEqual(expected);
    expect(engine.simulationCount).toBe(1);
  });

  it("uses an injected authoritative repository across engine lifetimes", () => {
    const repository = new InMemoryCompletedRoundStore({ maxResults: 4 });
    const firstEngine = new BattleEngine({ resultRepository: repository, maxEntries: 1 });
    const expected = firstEngine.simulateOnce("persisted-match", "round", inputs(71));
    const secondEngine = new BattleEngine({ resultRepository: repository, maxEntries: 1 });
    expect(secondEngine.simulateOnce("persisted-match", "round", inputs(71))).toEqual(expected);
    expect(secondEngine.simulationCount).toBe(0);
    expect(() => secondEngine.simulateOnce("persisted-match", "round", inputs(72))).toThrow(/conflict/i);
  });

  it("keeps bounded full results and refuses to replay an evicted authoritative tombstone", () => {
    const repository = new InMemoryCompletedRoundStore({ maxResults: 1 });
    const engine = new BattleEngine({ resultRepository: repository, maxEntries: 1 });
    engine.simulateOnce("tombstone-a", "round", inputs(81));
    engine.simulateOnce("tombstone-b", "round", inputs(82));
    expect(() => engine.simulateOnce("tombstone-a", "round", inputs(81))).toThrow(/expired|replay/i);
    expect(engine.simulationCount).toBe(2);
  });

  it("bounds concurrent and queued jobs, rejects overflow, and drains FIFO", async () => {
    const engine = new BattleEngine({ chunkTicks: 60, maxConcurrent: 1, maxQueued: 2 });
    const completionOrder: string[] = [];
    const first = engine.simulateOnceAsync("schedule-a", "round", timeoutInputs(21))
      .then((result) => { completionOrder.push("a"); return result; });
    const second = engine.simulateOnceAsync("schedule-b", "round", timeoutInputs(22))
      .then((result) => { completionOrder.push("b"); return result; });
    const third = engine.simulateOnceAsync("schedule-c", "round", timeoutInputs(23))
      .then((result) => { completionOrder.push("c"); return result; });
    expect(engine.runningCount).toBe(1);
    expect(engine.queuedCount).toBe(2);
    await expect(engine.simulateOnceAsync("schedule-overflow", "round", timeoutInputs(24)))
      .rejects.toThrow(/capacity/i);
    await Promise.all([first, second, third]);
    expect(completionOrder).toEqual(["a", "b", "c"]);
    expect(engine.simulationCount).toBe(3);
    expect(engine.runningCount).toBe(0);
    expect(engine.queuedCount).toBe(0);
  });

  it("rejects only an aborted queued caller while the authoritative job continues", async () => {
    const engine = new BattleEngine({ chunkTicks: 60, maxConcurrent: 1, maxQueued: 2 });
    const active = engine.simulateOnceAsync("abort-active", "round", timeoutInputs(31));
    const controller = new AbortController();
    const queued = engine.simulateOnceAsync("abort-queued", "round", timeoutInputs(32), {
      signal: controller.signal,
    });
    expect(engine.queuedCount).toBe(1);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await active;
    while (engine.runningCount + engine.queuedCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(engine.simulationCount).toBe(2);
    expect(engine.cacheSize).toBe(2);
  });

  it("aborting one deduplicated caller does not cancel the shared simulation", async () => {
    const engine = new BattleEngine({ chunkTicks: 60, maxConcurrent: 1 });
    const controller = new AbortController();
    const first = engine.simulateOnceAsync("spectator-abort", "round", timeoutInputs(41), {
      signal: controller.signal,
    });
    const second = engine.simulateOnceAsync("spectator-abort", "round", timeoutInputs(41));
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({ seed: 41, ticks: 5_400 });
    expect(engine.simulationCount).toBe(1);
    expect(engine.cacheSize).toBe(1);
  });

  it("authoritative cleanup cancels a running job and starts the next queued job", async () => {
    const engine = new BattleEngine({ chunkTicks: 1, maxConcurrent: 1, maxQueued: 1 });
    const active = engine.simulateOnceAsync("running-cancel", "round", timeoutInputs(41));
    const queued = engine.simulateOnceAsync("running-recovery", "round", inputs(42));
    expect(engine.cleanup("running-cancel", "round")).toBe(true);
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued).resolves.toMatchObject({ seed: 42 });
    expect(engine.simulationCount).toBe(2);
    expect(engine.cacheSize).toBe(1);
    expect(engine.runningCount).toBe(0);
  });

  it("cleanup cancels an in-flight result and does not retain it", async () => {
    const engine = new BattleEngine({ chunkTicks: 1 });
    const active = engine.simulateOnceAsync("match-cleanup", "round-1", inputs());
    const spectator = engine.simulateOnceAsync("match-cleanup", "round-1", inputs());
    expect(engine.cleanup("match-cleanup", "round-1")).toBe(true);
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    await expect(spectator).rejects.toMatchObject({ name: "AbortError" });
    expect(engine.cacheSize).toBe(0);
    expect(engine.runningCount).toBe(0);
  });

  it("cleanup cancels a queued job for every waiter and releases queue capacity", async () => {
    const engine = new BattleEngine({ chunkTicks: 60, maxConcurrent: 1, maxQueued: 1 });
    const running = engine.simulateOnceAsync("queued-cleanup-running", "round", timeoutInputs(61));
    const queued = engine.simulateOnceAsync("queued-cleanup", "round", inputs(62));
    const spectator = engine.simulateOnceAsync("queued-cleanup", "round", inputs(62));
    expect(engine.queuedCount).toBe(1);
    expect(engine.cleanup("queued-cleanup", "round")).toBe(true);
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await expect(spectator).rejects.toMatchObject({ name: "AbortError" });
    expect(engine.queuedCount).toBe(0);
    await running;
    expect(engine.simulationCount).toBe(1);
  });

  it("rejects unbounded correlation keys", () => {
    const engine = new BattleEngine();
    expect(() => engine.simulateOnce("x".repeat(129), "round", inputs())).toThrow(/correlation/i);
  });
});
