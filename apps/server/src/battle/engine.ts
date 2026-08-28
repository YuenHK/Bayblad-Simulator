import {
  designSchema,
  makeLayerVertices,
  predictDesignPerformance,
  validateDesign,
  type PerformancePrediction,
  type Point,
  type TopDesign,
} from "@steam-top/domain";
import {
  BATTLE_ANGULAR_SPEED_MAX,
  BATTLE_ANGULAR_SPEED_MIN,
  BATTLE_POSITION_MAX_MM,
  BATTLE_POSITION_MIN_MM,
  launchGradeSchema,
  type BattleBody as ProtocolBattleBody,
  type LaunchGrade,
} from "@steam-top/protocol";
import { Edge, Polygon, Settings, Vec2, World, type Body } from "planck";

import type { LaunchJudgement } from "./launch";
import { DeterministicPrng } from "./prng";

export const PHYSICS_MODEL_VERSION = "1.0.0" as const;
export const STEP_SECONDS = 1 / 60;
export const MAX_ROUND_SECONDS = 90;
export const BROADCAST_EVERY_TICKS = 4;
export const ARENA_CENTER_SAFE_RADIUS_MM = 70;
export const STOP_ANGULAR_SPEED_RAD_PER_SECOND = 8;
export const STOPPED_TICKS = 30;
export const ENVELOPE_SEGMENTS = 32;

const MAX_TICKS = MAX_ROUND_SECONDS / STEP_SECONDS;
const METRES_PER_MM = 0.001;
const KG_PER_G = 0.001;
const KG_M2_PER_G_MM2 = 1e-9;
const ARENA_WALL_RADIUS_M = 0.1;
const ARENA_WALL_SEGMENTS = 64;
const VELOCITY_ITERATIONS = 8;
const POSITION_ITERATIONS = 3;
const MAX_CORRELATION_LENGTH = 128;
const TIMEOUT_TIE_TOLERANCE = 0.03;
const LAUNCH_GRADES = new Set<LaunchGrade>(launchGradeSchema.options);

// Planck's metre-scale defaults use a 5 mm slop / 10 mm polygon skin. These
// documented tuning values preserve SI units while resolving 40-60 mm objects.
Settings.linearSlop = 0.00005;
Settings.aabbExtension = 0.001;
Settings.maxLinearCorrection = 0.01;

export type BattleBodyFrame = Readonly<ProtocolBattleBody>;

export type BattleFrame = Readonly<{
  tick: number;
  player1: BattleBodyFrame;
  player2: BattleBodyFrame;
}>;

export type BattleOutcome = Readonly<{
  winner: "player1" | "player2" | "draw";
  reason: "stopped" | "out-of-bounds" | "timeout" | "simultaneous";
}>;

export type PreparedBattleTop = Readonly<{
  massKg: number;
  centerOfMassM: Readonly<Point>;
  polarInertiaKgM2: number;
  performance: Readonly<PerformancePrediction>;
  envelopeRadiiM: readonly number[];
}>;

export type BattleFinalStats = Readonly<{
  player1: Readonly<{ angularSpeed: number; speedMps: number; energyJ: number; stoppedTicks: number }>;
  player2: Readonly<{ angularSpeed: number; speedMps: number; energyJ: number; stoppedTicks: number }>;
}>;

export type BattleResult = Readonly<{
  modelVersion: typeof PHYSICS_MODEL_VERSION;
  seed: number;
  ticks: number;
  frames: readonly BattleFrame[];
  outcome: BattleOutcome;
  finalStats: BattleFinalStats;
}>;

export type BattleInputs = Readonly<{
  player1: TopDesign;
  player2: TopDesign;
  launchA: LaunchJudgement;
  launchB: LaunchJudgement;
  seed: number;
}>;

export type EliminationSample = Readonly<{
  player1StoppedTicks: number;
  player2StoppedTicks: number;
  player1RadiusMm: number;
  player2RadiusMm: number;
}>;

export type EliminationResult = Readonly<{
  player1: boolean;
  player2: boolean;
  reason: "stopped" | "out-of-bounds" | "simultaneous" | null;
}>;

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested as object);
    }
  }
  return value;
}

function radiusAtAngle(vertices: readonly Point[], angle: number): number {
  let bestRadius = 0;
  let bestAngularDistance = Number.POSITIVE_INFINITY;
  for (const vertex of vertices) {
    const vertexAngle = Math.atan2(vertex.y, vertex.x);
    const distance = Math.abs(Math.atan2(Math.sin(vertexAngle - angle), Math.cos(vertexAngle - angle)));
    if (distance < bestAngularDistance) {
      bestAngularDistance = distance;
      bestRadius = Math.hypot(vertex.x, vertex.y);
    }
  }
  return bestRadius;
}

/** Rebuilds every trusted physical value from schema-valid domain geometry. */
export function prepareBattleTop(input: TopDesign): PreparedBattleTop {
  let design: TopDesign;
  try {
    design = designSchema.parse(input);
  } catch (error) {
    throw new TypeError(`Invalid design schema: ${error instanceof Error ? error.message : "unknown"}`);
  }
  const validation = validateDesign(design);
  if (!validation.valid) {
    throw new RangeError(`Invalid course design: ${validation.issues.map(({ code }) => code).join(",")}`);
  }
  // validateDesign recalculates canonical calculateMassProperties internally.
  const mass = validation.massProperties;
  const performance = predictDesignPerformance(design);
  const layers = design.layers.map((layer) => makeLayerVertices(layer));
  const envelopeRadiiM = Array.from({ length: ENVELOPE_SEGMENTS }, (_, index) => {
    const angle = (index / ENVELOPE_SEGMENTS) * Math.PI * 2;
    return Math.max(...layers.map((vertices) => radiusAtAngle(vertices, angle))) * METRES_PER_MM;
  });
  const prepared = {
    massKg: mass.totalMassG * KG_PER_G,
    centerOfMassM: {
      x: mass.centerOfMassMm.x * METRES_PER_MM,
      y: mass.centerOfMassMm.y * METRES_PER_MM,
    },
    polarInertiaKgM2: mass.polarMomentGmm2 * KG_M2_PER_G_MM2,
    performance: { ...performance },
    envelopeRadiiM,
  };
  if (
    !Number.isFinite(prepared.massKg) || prepared.massKg <= 0 ||
    !Number.isFinite(prepared.polarInertiaKgM2) || prepared.polarInertiaKgM2 <= 0 ||
    !prepared.envelopeRadiiM.every((radius) => Number.isFinite(radius) && radius > 0)
  ) {
    throw new RangeError("Authoritative physical properties must be finite and positive");
  }
  return deepFreeze(prepared) as PreparedBattleTop;
}

function validateLaunch(value: LaunchJudgement): void {
  if (
    !LAUNCH_GRADES.has(value.grade) ||
    !Number.isFinite(value.angularMultiplier) || value.angularMultiplier <= 0 || value.angularMultiplier > 2 ||
    !Number.isFinite(value.impulseMultiplier) || value.impulseMultiplier <= 0 || value.impulseMultiplier > 2
  ) {
    throw new RangeError("Invalid launch judgement or multiplier");
  }
}

function createArena(world: World): void {
  const wall = world.createBody();
  for (let index = 0; index < ARENA_WALL_SEGMENTS; index += 1) {
    const angleA = (index / ARENA_WALL_SEGMENTS) * Math.PI * 2;
    const angleB = ((index + 1) / ARENA_WALL_SEGMENTS) * Math.PI * 2;
    // Clockwise edge order makes the collision normal face the arena interior.
    wall.createFixture(
      new Edge(
        Vec2(Math.cos(angleB) * ARENA_WALL_RADIUS_M, Math.sin(angleB) * ARENA_WALL_RADIUS_M),
        Vec2(Math.cos(angleA) * ARENA_WALL_RADIUS_M, Math.sin(angleA) * ARENA_WALL_RADIUS_M),
      ),
      { friction: 0.15, restitution: 0.55 },
    );
  }
}

function createTopBody(
  world: World,
  top: PreparedBattleTop,
  position: Readonly<Point>,
  angle: number,
  angularSpeed: number,
  velocity: Readonly<Point>,
): Body {
  const body = world.createDynamicBody({
    position: Vec2(position.x, position.y),
    angle,
    bullet: true,
    allowSleep: false,
    linearDamping: 0.18 + (100 - top.performance.stability) * 0.002,
    // Canonical spinDuration maps to a bounded SI angular drag coefficient.
    angularDamping: 0.015 + (100 - top.performance.spinDuration) * 0.0001,
  });
  for (let index = 0; index < ENVELOPE_SEGMENTS; index += 1) {
    const next = (index + 1) % ENVELOPE_SEGMENTS;
    const angleA = (index / ENVELOPE_SEGMENTS) * Math.PI * 2;
    const angleB = (next / ENVELOPE_SEGMENTS) * Math.PI * 2;
    body.createFixture(
      new Polygon([
        Vec2(0, 0),
        Vec2(Math.cos(angleA) * (top.envelopeRadiiM[index] ?? 0), Math.sin(angleA) * (top.envelopeRadiiM[index] ?? 0)),
        Vec2(Math.cos(angleB) * (top.envelopeRadiiM[next] ?? 0), Math.sin(angleB) * (top.envelopeRadiiM[next] ?? 0)),
      ]),
      { density: 1, friction: 0.22, restitution: 0.5 },
    );
  }
  body.setMassData({
    mass: top.massKg,
    center: Vec2(top.centerOfMassM.x, top.centerOfMassM.y),
    // Planck expects inertia about the local origin; the domain value is about COM.
    I: top.polarInertiaKgM2 + top.massKg * (top.centerOfMassM.x ** 2 + top.centerOfMassM.y ** 2),
  });
  body.setAngularVelocity(angularSpeed);
  body.applyLinearImpulse(
    Vec2(velocity.x * top.massKg, velocity.y * top.massKg),
    body.getWorldCenter(),
    true,
  );
  return body;
}

function normaliseAngle(angle: number): number {
  const value = ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return Object.is(value, -0) ? 0 : value;
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new RangeError("Physics produced a non-finite value");
  return Math.max(minimum, Math.min(maximum, value));
}

function frameBody(body: Body): BattleBodyFrame {
  const position = body.getPosition();
  return {
    x: bounded(position.x / METRES_PER_MM, BATTLE_POSITION_MIN_MM, BATTLE_POSITION_MAX_MM),
    y: bounded(position.y / METRES_PER_MM, BATTLE_POSITION_MIN_MM, BATTLE_POSITION_MAX_MM),
    angle: normaliseAngle(body.getAngle()),
    angularSpeed: bounded(body.getAngularVelocity(), BATTLE_ANGULAR_SPEED_MIN, BATTLE_ANGULAR_SPEED_MAX),
  };
}

function makeFrame(tick: number, player1: Body, player2: Body): BattleFrame {
  return { tick, player1: frameBody(player1), player2: frameBody(player2) };
}

export function classifyEliminations(sample: EliminationSample): EliminationResult {
  const stopped1 = sample.player1StoppedTicks >= STOPPED_TICKS;
  const stopped2 = sample.player2StoppedTicks >= STOPPED_TICKS;
  const out1 = sample.player1RadiusMm > ARENA_CENTER_SAFE_RADIUS_MM;
  const out2 = sample.player2RadiusMm > ARENA_CENTER_SAFE_RADIUS_MM;
  const player1 = stopped1 || out1;
  const player2 = stopped2 || out2;
  if (player1 && player2) return { player1, player2, reason: "simultaneous" };
  if (out1 || out2) return { player1, player2, reason: "out-of-bounds" };
  if (stopped1 || stopped2) return { player1, player2, reason: "stopped" };
  return { player1, player2, reason: null };
}

function energy(body: Body, top: PreparedBattleTop): number {
  const velocity = body.getLinearVelocity();
  const linear = 0.5 * top.massKg * (velocity.x ** 2 + velocity.y ** 2);
  const rotational = 0.5 * top.polarInertiaKgM2 * body.getAngularVelocity() ** 2;
  return linear + rotational;
}

export function resolveTimeoutOutcome(input: Readonly<{
  energy1: number;
  energy2: number;
  spin1: number;
  spin2: number;
}>): BattleOutcome {
  const { energy1, energy2, spin1, spin2 } = input;
  if (![energy1, energy2, spin1, spin2].every(Number.isFinite) || energy1 < 0 || energy2 < 0) {
    throw new RangeError("Timeout authority values must be finite and energies non-negative");
  }
  const authority1 = energy1 + Math.abs(spin1) * 1e-5;
  const authority2 = energy2 + Math.abs(spin2) * 1e-5;
  const scale = Math.max(authority1, authority2, Number.EPSILON);
  const winner = Math.abs(authority1 - authority2) / scale <= TIMEOUT_TIE_TOLERANCE
    ? "draw"
    : authority1 > authority2 ? "player1" : "player2";
  return { winner, reason: "timeout" };
}

export function simulateMatchRound(
  player1Design: TopDesign,
  player2Design: TopDesign,
  options: Readonly<{ seed: number; launchA: LaunchJudgement; launchB: LaunchJudgement }>,
): BattleResult {
  const prng = new DeterministicPrng(options.seed);
  validateLaunch(options.launchA);
  validateLaunch(options.launchB);
  const top1 = prepareBattleTop(player1Design);
  const top2 = prepareBattleTop(player2Design);
  const world = new World(Vec2(0, 0));
  createArena(world);

  // Perturbations are deliberately bounded to +/-1% magnitude and +/-2 degrees.
  const headingJitter1 = prng.nextRange(-Math.PI / 90, Math.PI / 90);
  const headingJitter2 = prng.nextRange(-Math.PI / 90, Math.PI / 90);
  const positionJitter1 = prng.nextRange(-0.0005, 0.0005);
  const positionJitter2 = prng.nextRange(-0.0005, 0.0005);
  const impulseJitter1 = prng.nextRange(0.99, 1.01);
  const impulseJitter2 = prng.nextRange(0.99, 1.01);
  const baseAngular1 = 90 + top1.performance.spinDuration * 1.1 + top1.performance.stability * 0.2;
  const baseAngular2 = 90 + top2.performance.spinDuration * 1.1 + top2.performance.stability * 0.2;
  const baseSpeed1 = 0.35 + top1.performance.speed * 0.004;
  const baseSpeed2 = 0.35 + top2.performance.speed * 0.004;
  const body1 = createTopBody(
    world,
    top1,
    { x: -0.032, y: positionJitter1 },
    headingJitter1,
    baseAngular1 * options.launchA.angularMultiplier,
    { x: Math.cos(headingJitter1) * baseSpeed1 * options.launchA.impulseMultiplier * impulseJitter1, y: Math.sin(headingJitter1) * baseSpeed1 * options.launchA.impulseMultiplier * impulseJitter1 },
  );
  const body2 = createTopBody(
    world,
    top2,
    { x: 0.032, y: positionJitter2 },
    Math.PI + headingJitter2,
    -baseAngular2 * options.launchB.angularMultiplier,
    { x: -Math.cos(headingJitter2) * baseSpeed2 * options.launchB.impulseMultiplier * impulseJitter2, y: -Math.sin(headingJitter2) * baseSpeed2 * options.launchB.impulseMultiplier * impulseJitter2 },
  );

  const frames: BattleFrame[] = [makeFrame(0, body1, body2)];
  let stoppedTicks1 = 0;
  let stoppedTicks2 = 0;
  const retainedSpin1 = Math.abs(body1.getAngularVelocity()) * (top1.performance.spinDuration / 100) ** 2 * 0.15;
  const retainedSpin2 = Math.abs(body2.getAngularVelocity()) * (top2.performance.spinDuration / 100) ** 2 * 0.15;
  let ticks = 0;
  let outcome: BattleOutcome | null = null;

  for (let tick = 1; tick <= MAX_TICKS; tick += 1) {
    world.step(STEP_SECONDS, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
    // A flat 2D silhouette has no gyroscopic precession, so raw contact torque can
    // erase all spin in one solver step. A short, domain-derived endurance floor
    // models that omitted effect while Planck remains authoritative for collisions.
    const enduranceDecay = Math.exp(-2 * tick * STEP_SECONDS);
    body1.setAngularVelocity(Math.max(Math.abs(body1.getAngularVelocity()), retainedSpin1 * enduranceDecay));
    body2.setAngularVelocity(-Math.max(Math.abs(body2.getAngularVelocity()), retainedSpin2 * enduranceDecay));
    ticks = tick;
    stoppedTicks1 = Math.abs(body1.getAngularVelocity()) < STOP_ANGULAR_SPEED_RAD_PER_SECOND ? stoppedTicks1 + 1 : 0;
    stoppedTicks2 = Math.abs(body2.getAngularVelocity()) < STOP_ANGULAR_SPEED_RAD_PER_SECOND ? stoppedTicks2 + 1 : 0;
    const position1 = body1.getPosition();
    const position2 = body2.getPosition();
    const elimination = classifyEliminations({
      player1StoppedTicks: stoppedTicks1,
      player2StoppedTicks: stoppedTicks2,
      player1RadiusMm: Math.hypot(position1.x, position1.y) / METRES_PER_MM,
      player2RadiusMm: Math.hypot(position2.x, position2.y) / METRES_PER_MM,
    });
    if (elimination.player1 || elimination.player2) {
      outcome = elimination.player1 && elimination.player2
        ? { winner: "draw", reason: "simultaneous" }
        : { winner: elimination.player1 ? "player2" : "player1", reason: elimination.reason ?? "stopped" };
    }
    if (tick % BROADCAST_EVERY_TICKS === 0) frames.push(makeFrame(tick, body1, body2));
    if (outcome !== null) break;
  }

  const energy1 = energy(body1, top1);
  const energy2 = energy(body2, top2);
  if (outcome === null) {
    outcome = resolveTimeoutOutcome({
      energy1,
      energy2,
      spin1: body1.getAngularVelocity(),
      spin2: body2.getAngularVelocity(),
    });
  }
  if (frames.at(-1)?.tick !== ticks) frames.push(makeFrame(ticks, body1, body2));
  return {
    modelVersion: PHYSICS_MODEL_VERSION,
    seed: options.seed,
    ticks,
    frames,
    outcome,
    finalStats: {
      player1: { angularSpeed: body1.getAngularVelocity(), speedMps: body1.getLinearVelocity().length(), energyJ: energy1, stoppedTicks: stoppedTicks1 },
      player2: { angularSpeed: body2.getAngularVelocity(), speedMps: body2.getLinearVelocity().length(), energyJ: energy2, stoppedTicks: stoppedTicks2 },
    },
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function correlationKey(matchId: string, roundId: string): string {
  for (const value of [matchId, roundId]) {
    if (value.length < 1 || value.length > MAX_CORRELATION_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new RangeError("Invalid correlation key");
    }
  }
  return `${matchId.length}:${matchId}${roundId.length}:${roundId}`;
}

type CacheEntry = { fingerprint: string; result: BattleResult; closed: boolean };

export class BattleEngine {
  readonly #cache = new Map<string, CacheEntry>();
  #simulationCount = 0;

  get simulationCount(): number {
    return this.#simulationCount;
  }

  simulateOnce(matchId: string, roundId: string, inputs: BattleInputs): BattleResult {
    const key = correlationKey(matchId, roundId);
    const fingerprint = stableStringify(inputs);
    const existing = this.#cache.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new Error("Battle correlation conflict");
      return structuredClone(existing.result);
    }
    const result = simulateMatchRound(inputs.player1, inputs.player2, inputs);
    this.#cache.set(key, { fingerprint, result: structuredClone(result), closed: false });
    this.#simulationCount += 1;
    return structuredClone(result);
  }

  close(matchId: string, roundId: string): void {
    const entry = this.#cache.get(correlationKey(matchId, roundId));
    if (entry === undefined) throw new Error("Battle result not found");
    entry.closed = true;
  }

  cleanup(matchId: string, roundId: string): boolean {
    const key = correlationKey(matchId, roundId);
    const entry = this.#cache.get(key);
    if (entry === undefined) return false;
    if (!entry.closed) throw new Error("Battle result must be closed before cleanup");
    return this.#cache.delete(key);
  }
}
