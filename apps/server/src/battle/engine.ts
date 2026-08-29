import {
  designSchema,
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
import { Circle, Edge, Polygon, Vec2, World, type Body, type Contact } from "planck";

import {
  buildCollisionOutlineVertices,
  buildCollisionProxyVertices,
  COLLISION_OUTLINE_MAX_ERROR_MM,
} from "./collision-proxy";
import type { LaunchJudgement } from "./launch";
import { ensurePlanckSiTuning } from "./planck-config";
import { DeterministicPrng } from "./prng";

export {
  buildCollisionOutlineVertices,
  buildCollisionProxyVertices,
  COLLISION_OUTLINE_MAX_ERROR_MM,
} from "./collision-proxy";

export const PHYSICS_MODEL_VERSION = "2.0.0" as const;
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
const MAX_LEGAL_TOP_RADIUS_MM = 30;
const ARENA_WALL_MARGIN_MM = 5;
// The solid wall is deliberately outside the authoritative centre boundary:
// even a maximum legal top crosses 70 mm before its silhouette reaches Planck.
const ARENA_WALL_RADIUS_M = (
  ARENA_CENTER_SAFE_RADIUS_MM + MAX_LEGAL_TOP_RADIUS_MM + ARENA_WALL_MARGIN_MM
) * METRES_PER_MM;
const ARENA_WALL_SEGMENTS = 64;
const VELOCITY_ITERATIONS = 8;
const POSITION_ITERATIONS = 3;
const MAX_CORRELATION_LENGTH = 128;
const TIMEOUT_TIE_TOLERANCE = 0.03;
const LAUNCH_GRADES = new Set<LaunchGrade>(launchGradeSchema.options);
const WALL_CATEGORY = 0x0002;
const TOP_SENSOR_CATEGORY = 0x0004;
const TOP_WALL_PROXY_CATEGORY = 0x0008;
export const DEFAULT_BATTLE_CACHE_TTL_MS = 5 * 60_000;
export const DEFAULT_BATTLE_CACHE_MAX_ENTRIES = 128;
export const DEFAULT_BATTLE_MAX_CONCURRENT = 2;
export const DEFAULT_BATTLE_MAX_QUEUED = 64;
export const DEFAULT_ASYNC_YIELD_BUDGET_MS = 8;
export const DEFAULT_RESULT_STORE_MAX_RESULTS = 128;
export const DEFAULT_RESULT_STORE_MAX_RECORDS = 256;

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
  collisionVerticesM: readonly Readonly<Point>[];
  collisionOutlineVerticesM: readonly Readonly<Point>[];
}>;

export type BattleFinalStats = Readonly<{
  player1: Readonly<{ angularSpeed: number; speedMps: number; energyJ: number; stoppedTicks: number; impactRetentionProduct: number }>;
  player2: Readonly<{ angularSpeed: number; speedMps: number; energyJ: number; stoppedTicks: number; impactRetentionProduct: number }>;
  topTopContactCount: number;
  topTopBeginContactEpisodes: number;
  topTopImpactApplications: number;
}>;

export type BattleResult = Readonly<{
  modelVersion: typeof PHYSICS_MODEL_VERSION;
  seed: number;
  ticks: number;
  frames: readonly BattleFrame[];
  outcome: BattleOutcome;
  finalStats: BattleFinalStats;
}>;

export type StoredBattleResult = Readonly<{
  fingerprint: string;
  result?: BattleResult;
}>;

/**
 * Authoritative completed-round boundary. Production composition must inject
 * a durable implementation; saveIfAbsent is an atomic put-if-absent contract.
 */
export interface ResultRepository {
  get(correlationKey: string): Promise<StoredBattleResult | undefined>;
  /** Optional distributed lease. Production repositories use it to avoid duplicate simulations. */
  claim?(correlationKey: string, fingerprint: string): Promise<"acquired" | StoredBattleResult>;
  release?(correlationKey: string, fingerprint: string): Promise<void>;
  renewLease?(correlationKey: string, fingerprint: string): Promise<boolean>;
  readonly leaseRenewIntervalMs?: number;
  saveIfAbsent(correlationKey: string, value: StoredBattleResult): Promise<StoredBattleResult>;
}

/**
 * Best-effort repository for tests/local processes only. Both full results and
 * SHA-256 tombstones are bounded; once a whole record is LRU-evicted it no
 * longer provides authority. Production must inject persistent storage.
 */
export class InMemoryCompletedRoundStore implements ResultRepository {
  readonly #records = new Map<string, StoredBattleResult>();
  readonly #maxResults: number;
  readonly #maxRecords: number;
  #fullResultCount = 0;

  constructor(options: Readonly<{ maxResults?: number; maxRecords?: number }> = {}) {
    this.#maxResults = options.maxResults ?? DEFAULT_RESULT_STORE_MAX_RESULTS;
    this.#maxRecords = options.maxRecords ?? DEFAULT_RESULT_STORE_MAX_RECORDS;
    if (!Number.isSafeInteger(this.#maxResults) || this.#maxResults < 1) {
      throw new RangeError("maxResults must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxRecords) || this.#maxRecords < this.#maxResults) {
      throw new RangeError("maxRecords must be a safe integer no smaller than maxResults");
    }
  }

  get recordCount(): number {
    return this.#records.size;
  }

  get fullResultCount(): number {
    return this.#fullResultCount;
  }

  #getSync(key: string): StoredBattleResult | undefined {
    const stored = this.#records.get(key);
    if (stored === undefined) return undefined;
    this.#records.delete(key);
    this.#records.set(key, stored);
    return structuredClone(stored);
  }

  #saveIfAbsentSync(key: string, value: StoredBattleResult): StoredBattleResult {
    const existing = this.#getSync(key);
    if (existing !== undefined) return existing;
    if (!/^[a-f0-9]{64}$/.test(value.fingerprint)) {
      throw new TypeError("fingerprint must be a SHA-256 hex digest");
    }
    const stored = structuredClone(value);
    this.#records.set(key, stored);
    if (stored.result !== undefined) this.#fullResultCount += 1;
    while (this.#fullResultCount > this.#maxResults) {
      const oldestFullResult = [...this.#records].find(([, record]) => record.result !== undefined);
      if (oldestFullResult === undefined) break;
      const [oldestKey, record] = oldestFullResult;
      this.#records.set(oldestKey, { fingerprint: record.fingerprint });
      this.#fullResultCount -= 1;
    }
    while (this.#records.size > this.#maxRecords) {
      const oldest = this.#records.entries().next().value as [string, StoredBattleResult] | undefined;
      if (oldest === undefined) break;
      this.#records.delete(oldest[0]);
      if (oldest[1].result !== undefined) this.#fullResultCount -= 1;
    }
    return structuredClone(this.#records.get(key)!);
  }

  async get(key: string): Promise<StoredBattleResult | undefined> {
    return this.#getSync(key);
  }

  async saveIfAbsent(key: string, value: StoredBattleResult): Promise<StoredBattleResult> {
    return this.#saveIfAbsentSync(key, value);
  }

  /** Test-only synchronous adapter; never use this as a production authority. */
  getForTesting(key: string): StoredBattleResult | undefined {
    return this.#getSync(key);
  }

  /** Test-only synchronous adapter; never use this as a production authority. */
  saveIfAbsentForTesting(key: string, value: StoredBattleResult): StoredBattleResult {
    return this.#saveIfAbsentSync(key, value);
  }
}

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

export type ImpactPhysics = Readonly<{
  friction: number;
  restitution: number;
  angularRetention: number;
}>;

/** Maps the canonical 0..100 score to bounded, monotonic Planck/contact values. */
export function impactPhysicsFromScore(score: number): ImpactPhysics {
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new RangeError("impactResistance must be finite and between 0 and 100");
  }
  return Object.freeze({
    friction: 0.04 - score * 0.0003,
    restitution: 0.25 + score * 0.0025,
    angularRetention: 0.82 + score * 0.0016,
  });
}

export function retainAngularSpeedAfterImpact(angularSpeed: number, impactResistance: number): number {
  if (!Number.isFinite(angularSpeed)) {
    throw new RangeError("angularSpeed must be finite");
  }
  return angularSpeed * impactPhysicsFromScore(impactResistance).angularRetention;
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested as object);
    }
  }
  return value;
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
  const collisionProxyMm = buildCollisionProxyVertices(design);
  const collisionOutlineMm = buildCollisionOutlineVertices(design);
  const collisionVerticesM = collisionProxyMm.map(({ x, y }) => ({
    x: x * METRES_PER_MM,
    y: y * METRES_PER_MM,
  }));
  const collisionOutlineVerticesM = collisionOutlineMm.map(({ x, y }) => ({
    x: x * METRES_PER_MM,
    y: y * METRES_PER_MM,
  }));
  const envelopeRadiiM = Array.from({ length: ENVELOPE_SEGMENTS }, (_, index) => {
    const angle = (index / ENVELOPE_SEGMENTS) * Math.PI * 2;
    return Math.max(...collisionVerticesM.map(({ x, y }) => x * Math.cos(angle) + y * Math.sin(angle)));
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
    collisionVerticesM,
    collisionOutlineVerticesM,
  };
  if (
    !Number.isFinite(prepared.massKg) || prepared.massKg <= 0 ||
    !Number.isFinite(prepared.polarInertiaKgM2) || prepared.polarInertiaKgM2 <= 0 ||
    !prepared.envelopeRadiiM.every((radius) => Number.isFinite(radius) && radius > 0) ||
    !prepared.collisionVerticesM.flatMap(({ x, y }) => [x, y]).every(Number.isFinite) ||
    !prepared.collisionOutlineVerticesM.flatMap(({ x, y }) => [x, y]).every(Number.isFinite)
  ) {
    throw new RangeError("Authoritative physical properties must be finite and positive");
  }
  return deepFreeze(prepared) as PreparedBattleTop;
}

function validateLaunch(value: LaunchJudgement): void {
  if (
    !LAUNCH_GRADES.has(value.grade) ||
    !Number.isFinite(value.angularMultiplier) || value.angularMultiplier < 0 || value.angularMultiplier > 2 ||
    !Number.isFinite(value.impulseMultiplier) || value.impulseMultiplier < 0 || value.impulseMultiplier > 2
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
      {
        friction: 0.15,
        restitution: 0.55,
        filterCategoryBits: WALL_CATEGORY,
        filterMaskBits: TOP_WALL_PROXY_CATEGORY,
      },
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
  const impactPhysics = impactPhysicsFromScore(top.performance.impactResistance);
  body.createFixture(
    new Polygon(top.collisionVerticesM.map(({ x, y }) => Vec2(x, y))),
    {
      density: 0,
      friction: 0.12,
      restitution: 0.4,
      filterCategoryBits: TOP_WALL_PROXY_CATEGORY,
      filterMaskBits: WALL_CATEGORY,
    },
  );
  body.createFixture(
    new Circle(Math.max(...top.collisionOutlineVerticesM.map(({ x, y }) => Math.hypot(x, y)))),
    {
      density: 0,
      isSensor: true,
      filterCategoryBits: TOP_SENSOR_CATEGORY,
      filterMaskBits: TOP_SENSOR_CATEGORY,
    },
  );
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

function contactIsBetween(contact: Contact, body1: Body, body2: Body): boolean {
  const fixtureBodyA = contact.getFixtureA().getBody();
  const fixtureBodyB = contact.getFixtureB().getBody();
  return (fixtureBodyA === body1 && fixtureBodyB === body2) ||
    (fixtureBodyA === body2 && fixtureBodyB === body1);
}

function applyCustomTopImpulse(
  body1: Body,
  body2: Body,
  impact1: ImpactPhysics,
  impact2: ImpactPhysics,
): void {
  const position1 = body1.getPosition();
  const position2 = body2.getPosition();
  const dx = position2.x - position1.x;
  const dy = position2.y - position1.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance <= Number.EPSILON) return;
  const nx = dx / distance;
  const ny = dy / distance;
  const velocity1 = body1.getLinearVelocity();
  const velocity2 = body2.getLinearVelocity();
  const relativeX = velocity2.x - velocity1.x;
  const relativeY = velocity2.y - velocity1.y;
  const closingSpeed = relativeX * nx + relativeY * ny;
  if (closingSpeed >= 0) return;
  const inverseMass1 = 1 / body1.getMass();
  const inverseMass2 = 1 / body2.getMass();
  const restitution = (impact1.restitution + impact2.restitution) / 2;
  const normalImpulse = -(1 + restitution) * closingSpeed / (inverseMass1 + inverseMass2);
  const tx = -ny;
  const ty = nx;
  const tangentSpeed = relativeX * tx + relativeY * ty;
  const unconstrainedTangent = -tangentSpeed / (inverseMass1 + inverseMass2);
  const frictionLimit = (impact1.friction + impact2.friction) / 2 * normalImpulse;
  const tangentImpulse = Math.max(-frictionLimit, Math.min(frictionLimit, unconstrainedTangent));
  const impulseX = normalImpulse * nx + tangentImpulse * tx;
  const impulseY = normalImpulse * ny + tangentImpulse * ty;
  body1.setLinearVelocity(Vec2(
    velocity1.x - impulseX * inverseMass1,
    velocity1.y - impulseY * inverseMass1,
  ));
  body2.setLinearVelocity(Vec2(
    velocity2.x + impulseX * inverseMass2,
    velocity2.y + impulseY * inverseMass2,
  ));
}

function transformedOutline(
  vertices: readonly Readonly<Point>[],
  position: Readonly<Point>,
  angle: number,
): Point[] {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return vertices.map(({ x, y }) => ({
    x: position.x + x * cosine - y * sine,
    y: position.y + x * sine + y * cosine,
  }));
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = orient(a, b, c);
  const abD = orient(a, b, d);
  const cdA = orient(c, d, a);
  const cdB = orient(c, d, b);
  return ((abC >= 0 && abD <= 0) || (abC <= 0 && abD >= 0)) &&
    ((cdA >= 0 && cdB <= 0) || (cdA <= 0 && cdB >= 0));
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    if ((a.y > point.y) !== (b.y > point.y) &&
      point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

type OutlineEdge = Readonly<{
  start: Point;
  end: Point;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}>;

function outlineEdges(outline: readonly Point[]): OutlineEdge[] {
  return outline.map((start, index) => {
    const end = outline[(index + 1) % outline.length]!;
    return {
      start,
      end,
      minX: Math.min(start.x, end.x),
      maxX: Math.max(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxY: Math.max(start.y, end.y),
    };
  });
}

function gridCoordinate(value: number, cellSize: number): number {
  return Math.floor(value / cellSize);
}

function gridKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function edgesIntersectUsingGrid(edges1: readonly OutlineEdge[], edges2: readonly OutlineEdge[]): boolean {
  const minimumX = Math.min(...edges2.map(({ minX }) => minX));
  const maximumX = Math.max(...edges2.map(({ maxX }) => maxX));
  const minimumY = Math.min(...edges2.map(({ minY }) => minY));
  const maximumY = Math.max(...edges2.map(({ maxY }) => maxY));
  const cellSize = Math.max(maximumX - minimumX, maximumY - minimumY) / 16;
  if (!Number.isFinite(cellSize) || cellSize <= 0) return false;
  const grid = new Map<string, number[]>();
  for (const [index, edge] of edges2.entries()) {
    for (let x = gridCoordinate(edge.minX, cellSize); x <= gridCoordinate(edge.maxX, cellSize); x += 1) {
      for (let y = gridCoordinate(edge.minY, cellSize); y <= gridCoordinate(edge.maxY, cellSize); y += 1) {
        const key = gridKey(x, y);
        const bucket = grid.get(key);
        if (bucket === undefined) grid.set(key, [index]);
        else bucket.push(index);
      }
    }
  }
  const seen = new Uint32Array(edges2.length);
  for (const [edgeIndex, edge1] of edges1.entries()) {
    const marker = edgeIndex + 1;
    for (let x = gridCoordinate(edge1.minX, cellSize); x <= gridCoordinate(edge1.maxX, cellSize); x += 1) {
      for (let y = gridCoordinate(edge1.minY, cellSize); y <= gridCoordinate(edge1.maxY, cellSize); y += 1) {
        const candidates = grid.get(gridKey(x, y));
        if (candidates === undefined) continue;
        for (const candidateIndex of candidates) {
          if (seen[candidateIndex] === marker) continue;
          seen[candidateIndex] = marker;
          const edge2 = edges2[candidateIndex]!;
          if (
            edge1.maxX < edge2.minX || edge2.maxX < edge1.minX ||
            edge1.maxY < edge2.minY || edge2.maxY < edge1.minY
          ) continue;
          if (segmentsIntersect(edge1.start, edge1.end, edge2.start, edge2.end)) return true;
        }
      }
    }
  }
  return false;
}

/** Exact concave-polygon overlap used after Planck's sensor broad phase. */
export function collisionOutlinesOverlap(
  vertices1: readonly Readonly<Point>[],
  pose1: Readonly<{ position: Readonly<Point>; angle: number }>,
  vertices2: readonly Readonly<Point>[],
  pose2: Readonly<{ position: Readonly<Point>; angle: number }>,
): boolean {
  const outline1 = transformedOutline(vertices1, pose1.position, pose1.angle);
  const outline2 = transformedOutline(vertices2, pose2.position, pose2.angle);
  if (edgesIntersectUsingGrid(outlineEdges(outline1), outlineEdges(outline2))) return true;
  return pointInPolygon(outline1[0]!, outline2) || pointInPolygon(outline2[0]!, outline1);
}

function exactOutlinesOverlap(body1: Body, top1: PreparedBattleTop, body2: Body, top2: PreparedBattleTop): boolean {
  return collisionOutlinesOverlap(
    top1.collisionOutlineVerticesM,
    { position: body1.getPosition(), angle: body1.getAngle() },
    top2.collisionOutlineVerticesM,
    { position: body2.getPosition(), angle: body2.getAngle() },
  );
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

function physicalPlayerKey(designInput: TopDesign, launch: LaunchJudgement): string {
  let design: TopDesign;
  try {
    design = designSchema.parse(designInput);
  } catch (error) {
    throw new TypeError(`Invalid design schema: ${error instanceof Error ? error.message : "unknown"}`);
  }
  return stableStringify({
    layers: design.layers.map((layer) => ({
      position: layer.position,
      shape: layer.shape,
      points: layer.points,
      diameterMm: layer.diameterMm,
      cornerRoundness: layer.cornerRoundness,
      rotationDeg: layer.rotationDeg,
    })),
    screwLayout: design.screwLayout,
    metalDiscDiameterMm: design.metalDiscDiameterMm,
    launch: {
      grade: launch.grade,
      angularMultiplier: launch.angularMultiplier,
      impulseMultiplier: launch.impulseMultiplier,
    },
  });
}

function seedHashBit(seed: number): number {
  let value = seed >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value & 1;
}

function swapWinner(winner: BattleOutcome["winner"]): BattleOutcome["winner"] {
  return winner === "player1" ? "player2" : winner === "player2" ? "player1" : "draw";
}

function mapInternalResult(result: BattleResult, swapped: boolean): BattleResult {
  if (!swapped) return result;
  return {
    ...result,
    frames: result.frames.map((frame) => ({
      tick: frame.tick,
      player1: frame.player2,
      player2: frame.player1,
    })),
    outcome: { ...result.outcome, winner: swapWinner(result.outcome.winner) },
    finalStats: {
      ...result.finalStats,
      player1: result.finalStats.player2,
      player2: result.finalStats.player1,
    },
  };
}

function* simulateMatchRoundSteps(
  player1Design: TopDesign,
  player2Design: TopDesign,
  options: Readonly<{ seed: number; launchA: LaunchJudgement; launchB: LaunchJudgement }>,
): Generator<void, BattleResult, void> {
  ensurePlanckSiTuning();
  const key1 = physicalPlayerKey(player1Design, options.launchA);
  const key2 = physicalPlayerKey(player2Design, options.launchB);
  const swapped = key1 > key2 || (key1 === key2 && seedHashBit(options.seed) === 1);
  const internalPlayer1 = swapped ? player2Design : player1Design;
  const internalPlayer2 = swapped ? player1Design : player2Design;
  const internalLaunch1 = swapped ? options.launchB : options.launchA;
  const internalLaunch2 = swapped ? options.launchA : options.launchB;
  const prng = new DeterministicPrng(options.seed);
  validateLaunch(internalLaunch1);
  validateLaunch(internalLaunch2);
  const top1 = prepareBattleTop(internalPlayer1);
  const top2 = prepareBattleTop(internalPlayer2);
  const world = new World(Vec2(0, 0));
  createArena(world);

  // Perturbations are deliberately bounded to +/-1% magnitude and +/-2 degrees.
  const headingJitter = prng.nextRange(-Math.PI / 90, Math.PI / 90);
  const positionJitter = prng.nextRange(-0.0005, 0.0005);
  const impulseJitter = prng.nextRange(0.99, 1.01);
  const mirroredImpulseJitter = 2 - impulseJitter;
  const baseAngular1 = 45 + top1.performance.spinDuration * 0.55 + top1.performance.stability * 0.1;
  const baseAngular2 = 45 + top2.performance.spinDuration * 0.55 + top2.performance.stability * 0.1;
  const baseSpeed1 = 0.05 + top1.performance.speed * 0.0008;
  const baseSpeed2 = 0.05 + top2.performance.speed * 0.0008;
  const body1 = createTopBody(
    world,
    top1,
    { x: -0.04, y: positionJitter },
    headingJitter,
    baseAngular1 * internalLaunch1.angularMultiplier,
    { x: Math.cos(headingJitter) * baseSpeed1 * internalLaunch1.impulseMultiplier * impulseJitter, y: Math.sin(headingJitter) * baseSpeed1 * internalLaunch1.impulseMultiplier * impulseJitter },
  );
  const body2 = createTopBody(
    world,
    top2,
    { x: 0.04, y: -positionJitter },
    Math.PI + headingJitter,
    -baseAngular2 * internalLaunch2.angularMultiplier,
    { x: -Math.cos(headingJitter) * baseSpeed2 * internalLaunch2.impulseMultiplier * mirroredImpulseJitter, y: -Math.sin(headingJitter) * baseSpeed2 * internalLaunch2.impulseMultiplier * mirroredImpulseJitter },
  );

  const frames: BattleFrame[] = [makeFrame(0, body1, body2)];
  let stoppedTicks1 = 0;
  let stoppedTicks2 = 0;
  const retainedSpin1 = Math.abs(body1.getAngularVelocity()) * (top1.performance.spinDuration / 100) ** 2 * 0.15;
  const retainedSpin2 = Math.abs(body2.getAngularVelocity()) * (top2.performance.spinDuration / 100) ** 2 * 0.15;
  let ticks = 0;
  let outcome: BattleOutcome | null = null;
  let activeTopContactFixtures = 0;
  let exactTopContactActive = false;
  let topTopContactCount = 0;
  let topTopBeginContactEpisodes = 0;
  let topTopImpactApplications = 0;
  let impactRetentionProduct1 = 1;
  let impactRetentionProduct2 = 1;
  const impact1 = impactPhysicsFromScore(top1.performance.impactResistance);
  const impact2 = impactPhysicsFromScore(top2.performance.impactResistance);

  world.on("begin-contact", (contact) => {
    if (!contactIsBetween(contact, body1, body2)) return;
    activeTopContactFixtures += 1;
  });
  world.on("end-contact", (contact) => {
    if (!contactIsBetween(contact, body1, body2)) return;
    activeTopContactFixtures = Math.max(0, activeTopContactFixtures - 1);
  });

  for (let tick = 1; tick <= MAX_TICKS; tick += 1) {
    world.step(STEP_SECONDS, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
    const exactContact = activeTopContactFixtures > 0 && exactOutlinesOverlap(body1, top1, body2, top2);
    if (exactContact && !exactTopContactActive) {
      topTopBeginContactEpisodes += 1;
      applyCustomTopImpulse(body1, body2, impact1, impact2);
      body1.setAngularVelocity(retainAngularSpeedAfterImpact(body1.getAngularVelocity(), top1.performance.impactResistance));
      body2.setAngularVelocity(retainAngularSpeedAfterImpact(body2.getAngularVelocity(), top2.performance.impactResistance));
      impactRetentionProduct1 *= impact1.angularRetention;
      impactRetentionProduct2 *= impact2.angularRetention;
      topTopContactCount += 1;
      topTopImpactApplications += 1;
    }
    exactTopContactActive = exactContact;
    // A flat 2D silhouette has no gyroscopic precession, so raw contact torque can
    // erase all spin in one solver step. A short, domain-derived endurance floor
    // models that omitted effect while Planck remains authoritative for collisions.
    const enduranceDecay = Math.exp(-2 * tick * STEP_SECONDS);
    body1.setAngularVelocity(Math.max(Math.abs(body1.getAngularVelocity()), retainedSpin1 * impactRetentionProduct1 * enduranceDecay));
    body2.setAngularVelocity(-Math.max(Math.abs(body2.getAngularVelocity()), retainedSpin2 * impactRetentionProduct2 * enduranceDecay));
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
    yield;
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
  return mapInternalResult({
    modelVersion: PHYSICS_MODEL_VERSION,
    seed: options.seed,
    ticks,
    frames,
    outcome,
    finalStats: {
      player1: { angularSpeed: body1.getAngularVelocity(), speedMps: body1.getLinearVelocity().length(), energyJ: energy1, stoppedTicks: stoppedTicks1, impactRetentionProduct: impactRetentionProduct1 },
      player2: { angularSpeed: body2.getAngularVelocity(), speedMps: body2.getLinearVelocity().length(), energyJ: energy2, stoppedTicks: stoppedTicks2, impactRetentionProduct: impactRetentionProduct2 },
      topTopContactCount,
      topTopBeginContactEpisodes,
      topTopImpactApplications,
    },
  }, swapped);
}

export function simulateMatchRound(
  player1Design: TopDesign,
  player2Design: TopDesign,
  options: Readonly<{ seed: number; launchA: LaunchJudgement; launchB: LaunchJudgement }>,
): BattleResult {
  const simulation = simulateMatchRoundSteps(player1Design, player2Design, options);
  while (true) {
    const step = simulation.next();
    if (step.done) return step.value;
  }
}

export async function simulateMatchRoundAsync(
  player1Design: TopDesign,
  player2Design: TopDesign,
  options: Readonly<{ seed: number; launchA: LaunchJudgement; launchB: LaunchJudgement }>,
  asyncOptions: Readonly<{
    chunkTicks?: number;
    yieldBudgetMs?: number;
    signal?: AbortSignal;
  }> = {},
): Promise<BattleResult> {
  const chunkTicks = asyncOptions.chunkTicks ?? 120;
  const yieldBudgetMs = asyncOptions.yieldBudgetMs ?? DEFAULT_ASYNC_YIELD_BUDGET_MS;
  if (!Number.isSafeInteger(chunkTicks) || chunkTicks < 1 || chunkTicks > MAX_TICKS) {
    throw new RangeError("chunkTicks must be a safe integer within one round");
  }
  if (!Number.isFinite(yieldBudgetMs) || yieldBudgetMs <= 0 || yieldBudgetMs > 50) {
    throw new RangeError("yieldBudgetMs must be finite, positive, and at most 50 ms");
  }
  throwIfAborted(asyncOptions.signal);
  const simulation = simulateMatchRoundSteps(player1Design, player2Design, options);
  while (true) {
    const chunkStartedAt = performance.now();
    for (let index = 0; index < chunkTicks; index += 1) {
      throwIfAborted(asyncOptions.signal);
      const step = simulation.next();
      if (step.done) return step.value;
      if (performance.now() - chunkStartedAt >= yieldBudgetMs) break;
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    throwIfAborted(asyncOptions.signal);
  }
}

function abortError(): Error {
  const error = new Error("Battle simulation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

/** Dependency-free SHA-256 used to bound canonical input fingerprints. */
export function sha256Hex(value: string): string {
  const source = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const bitLength = BigInt(source.length) * 8n;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Number(bitLength >> 32n));
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffff_ffffn));
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + sum1 + choice + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      [a, b, c, d, e, f, g, h] = [(temporary1 + temporary2) >>> 0, a, b, c, (d! + temporary1) >>> 0, e, f, g];
    }
    for (let index = 0; index < 8; index += 1) hash[index] = (hash[index]! + [a, b, c, d, e, f, g, h][index]!) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function battleInputFingerprint(canonical: BattleInputs): string {
  return sha256Hex(stableStringify(canonical));
}

function canonicalizeBattleInputs(inputs: BattleInputs): BattleInputs {
  // Constructor validates the complete uint32 seed contract without consuming it.
  new DeterministicPrng(inputs.seed);
  validateLaunch(inputs.launchA);
  validateLaunch(inputs.launchB);
  return {
    player1: designSchema.parse(inputs.player1),
    player2: designSchema.parse(inputs.player2),
    launchA: {
      grade: inputs.launchA.grade,
      angularMultiplier: inputs.launchA.angularMultiplier,
      impulseMultiplier: inputs.launchA.impulseMultiplier,
    },
    launchB: {
      grade: inputs.launchB.grade,
      angularMultiplier: inputs.launchB.angularMultiplier,
      impulseMultiplier: inputs.launchB.impulseMultiplier,
    },
    seed: inputs.seed,
  };
}

function correlationKey(matchId: string, roundId: string): string {
  for (const value of [matchId, roundId]) {
    if (value.length < 1 || value.length > MAX_CORRELATION_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new RangeError("Invalid correlation key");
    }
  }
  return `${matchId.length}:${matchId}${roundId.length}:${roundId}`;
}

type CacheEntry = {
  fingerprint: string;
  result: BattleResult;
  closed: boolean;
  expiresAtMs: number;
};
type ScheduledBattleJob = {
  key: string;
  fingerprint: string;
  canonical: BattleInputs;
  controller: AbortController;
  promise: Promise<BattleResult>;
  resolve: (result: BattleResult) => void;
  reject: (reason: unknown) => void;
  state: "queued" | "running" | "settled";
};
type PendingRepositoryLookup = {
  fingerprint: string;
  promise: Promise<BattleResult>;
  canceled: boolean;
};

export class BattleEngine {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, ScheduledBattleJob>();
  readonly #pendingRepositoryLookups = new Map<string, PendingRepositoryLookup>();
  readonly #queue: ScheduledBattleJob[] = [];
  readonly #chunkTicks: number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  readonly #yieldBudgetMs: number;
  readonly #resultRepository: ResultRepository;
  readonly #now: () => number;
  #simulationCount = 0;
  #runningCount = 0;

  constructor(options: Readonly<{
    chunkTicks?: number;
    ttlMs?: number;
    maxEntries?: number;
    maxConcurrent?: number;
    maxQueued?: number;
    yieldBudgetMs?: number;
    resultRepository: ResultRepository;
    now?: () => number;
  }>) {
    if (options?.resultRepository === undefined) {
      throw new TypeError("BattleEngine requires an explicit resultRepository");
    }
    this.#chunkTicks = options.chunkTicks ?? 120;
    this.#ttlMs = options.ttlMs ?? DEFAULT_BATTLE_CACHE_TTL_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_BATTLE_CACHE_MAX_ENTRIES;
    this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_BATTLE_MAX_CONCURRENT;
    this.#maxQueued = options.maxQueued ?? DEFAULT_BATTLE_MAX_QUEUED;
    this.#yieldBudgetMs = options.yieldBudgetMs ?? DEFAULT_ASYNC_YIELD_BUDGET_MS;
    this.#resultRepository = options.resultRepository;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#chunkTicks) || this.#chunkTicks < 1 || this.#chunkTicks > MAX_TICKS) {
      throw new RangeError("chunkTicks must be a safe integer within one round");
    }
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new RangeError("ttlMs must be finite and positive");
    }
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxConcurrent) || this.#maxConcurrent < 1) {
      throw new RangeError("maxConcurrent must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxQueued) || this.#maxQueued < 0) {
      throw new RangeError("maxQueued must be a non-negative safe integer");
    }
    if (!Number.isFinite(this.#yieldBudgetMs) || this.#yieldBudgetMs <= 0 || this.#yieldBudgetMs > 50) {
      throw new RangeError("yieldBudgetMs must be finite, positive, and at most 50 ms");
    }
    this.#readNow();
  }

  get simulationCount(): number {
    return this.#simulationCount;
  }

  get cacheSize(): number {
    this.#pruneExpired();
    return this.#cache.size;
  }

  get runningCount(): number {
    return this.#runningCount;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) throw new RangeError("now() must return a finite number");
    return value;
  }

  #pruneExpired(): void {
    const now = this.#readNow();
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAtMs <= now) this.#cache.delete(key);
    }
  }

  #getCached(key: string, fingerprint: string): CacheEntry | undefined {
    this.#pruneExpired();
    const entry = this.#cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.fingerprint !== fingerprint) throw new Error("Battle correlation conflict");
    // Map insertion order is the LRU order; a hit becomes most-recently used.
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    return entry;
  }

  #storeCached(key: string, fingerprint: string, result: BattleResult): void {
    this.#pruneExpired();
    this.#cache.delete(key);
    this.#cache.set(key, {
      fingerprint,
      result: structuredClone(result),
      closed: false,
      expiresAtMs: this.#readNow() + this.#ttlMs,
    });
    while (this.#cache.size > this.#maxEntries) {
      const oldestKey = this.#cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.#cache.delete(oldestKey);
    }
  }

  #resultFromStored(stored: StoredBattleResult, fingerprint: string): BattleResult {
    if (stored.fingerprint !== fingerprint) throw new Error("Battle correlation conflict");
    if (stored.result === undefined) {
      throw new Error("Authoritative battle result expired; replay is forbidden");
    }
    return structuredClone(stored.result);
  }

  async #getAuthoritative(
    key: string,
    fingerprint: string,
    canceled: () => boolean = () => false,
  ): Promise<BattleResult | undefined> {
    const stored = await this.#resultRepository.get(key);
    if (canceled()) throw abortError();
    if (stored === undefined) return undefined;
    const result = this.#resultFromStored(stored, fingerprint);
    this.#storeCached(key, fingerprint, result);
    return result;
  }

  async #saveAuthoritative(key: string, fingerprint: string, result: BattleResult): Promise<BattleResult> {
    const stored = await this.#resultRepository.saveIfAbsent(key, { fingerprint, result });
    return this.#resultFromStored(stored, fingerprint);
  }

  #localRepositoryForTesting(): InMemoryCompletedRoundStore {
    if (!(this.#resultRepository instanceof InMemoryCompletedRoundStore)) {
      throw new Error("simulateOnce is a test-only API requiring InMemoryCompletedRoundStore");
    }
    return this.#resultRepository;
  }

  #getAuthoritativeForTesting(key: string, fingerprint: string): BattleResult | undefined {
    const stored = this.#localRepositoryForTesting().getForTesting(key);
    if (stored === undefined) return undefined;
    const result = this.#resultFromStored(stored, fingerprint);
    this.#storeCached(key, fingerprint, result);
    return result;
  }

  #saveAuthoritativeForTesting(key: string, fingerprint: string, result: BattleResult): BattleResult {
    const stored = this.#localRepositoryForTesting().saveIfAbsentForTesting(key, { fingerprint, result });
    return this.#resultFromStored(stored, fingerprint);
  }

  /** @deprecated Test-only local/cache adapter. Production must use simulateOnceAsync. */
  simulateOnce(matchId: string, roundId: string, inputs: BattleInputs): BattleResult {
    this.#localRepositoryForTesting();
    const key = correlationKey(matchId, roundId);
    const canonical = canonicalizeBattleInputs(inputs);
    const fingerprint = battleInputFingerprint(canonical);
    const existing = this.#getCached(key, fingerprint);
    if (existing !== undefined) {
      return structuredClone(existing.result);
    }
    const authoritative = this.#getAuthoritativeForTesting(key, fingerprint);
    if (authoritative !== undefined) return authoritative;
    const active = this.#inFlight.get(key);
    if (active !== undefined) throw new Error("Active battle correlation conflict");
    if (this.#pendingRepositoryLookups.has(key)) throw new Error("Active battle correlation conflict");
    const simulated = simulateMatchRound(canonical.player1, canonical.player2, canonical);
    const result = this.#saveAuthoritativeForTesting(key, fingerprint, simulated);
    this.#storeCached(key, fingerprint, result);
    this.#simulationCount += 1;
    return structuredClone(result);
  }

  /** Production handlers should use this cooperative, bounded async path. */
  async simulateOnceAsync(
    matchId: string,
    roundId: string,
    inputs: BattleInputs,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<BattleResult> {
    const key = correlationKey(matchId, roundId);
    const canonical = canonicalizeBattleInputs(inputs);
    const fingerprint = battleInputFingerprint(canonical);
    const existing = this.#getCached(key, fingerprint);
    if (existing !== undefined) {
      return structuredClone(existing.result);
    }
    const active = this.#inFlight.get(key);
    if (active !== undefined) {
      if (active.fingerprint !== fingerprint) throw new Error("Active battle correlation conflict");
      return this.#awaitForCaller(active.promise, options.signal);
    }
    const existingLookup = this.#pendingRepositoryLookups.get(key);
    if (existingLookup !== undefined) {
      if (existingLookup.fingerprint !== fingerprint) throw new Error("Active battle correlation conflict");
      return this.#awaitForCaller(existingLookup.promise, options.signal);
    }
    throwIfAborted(options.signal);
    if (this.#pendingRepositoryLookups.size >= this.#maxConcurrent + this.#maxQueued) {
      throw new Error("Battle scheduler capacity exceeded");
    }
    const pending: PendingRepositoryLookup = {
      fingerprint,
      canceled: false,
      promise: Promise.resolve(undefined as never),
    };
    pending.promise = this.#resolveRepositoryLookup(pending, key, fingerprint, canonical);
    this.#pendingRepositoryLookups.set(key, pending);
    const removePending = () => {
      if (this.#pendingRepositoryLookups.get(key) === pending) this.#pendingRepositoryLookups.delete(key);
    };
    void pending.promise.then(removePending, removePending);
    return this.#awaitForCaller(pending.promise, options.signal);
  }

  async #resolveRepositoryLookup(
    pending: PendingRepositoryLookup,
    key: string,
    fingerprint: string,
    canonical: BattleInputs,
  ): Promise<BattleResult> {
    const authoritative = await this.#getAuthoritative(key, fingerprint, () => pending.canceled);
    if (pending.canceled) throw abortError();
    if (authoritative !== undefined) return authoritative;
    if (this.#resultRepository.claim) {
      const claim = await this.#resultRepository.claim(key, fingerprint);
      if (claim !== "acquired") {
        const claimed = this.#resultFromStored(claim, fingerprint);
        this.#storeCached(key, fingerprint, claimed);
        return claimed;
      }
    }
    const active = this.#inFlight.get(key);
    if (active !== undefined) {
      if (active.fingerprint !== fingerprint) throw new Error("Active battle correlation conflict");
      return active.promise;
    }
    return this.#scheduleJob(key, fingerprint, canonical);
  }

  #scheduleJob(key: string, fingerprint: string, canonical: BattleInputs): Promise<BattleResult> {
    if (this.#runningCount >= this.#maxConcurrent && this.#queue.length >= this.#maxQueued) {
      throw new Error("Battle scheduler capacity exceeded");
    }
    let resolve!: (result: BattleResult) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<BattleResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const job: ScheduledBattleJob = {
      key,
      fingerprint,
      canonical,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
      state: "queued",
    };
    this.#inFlight.set(key, job);
    if (this.#runningCount < this.#maxConcurrent) this.#startJob(job);
    else this.#queue.push(job);
    return promise;
  }

  async #awaitForCaller(promise: Promise<BattleResult>, signal: AbortSignal | undefined): Promise<BattleResult> {
    throwIfAborted(signal);
    if (signal === undefined) return structuredClone(await promise);
    return new Promise<BattleResult>((resolve, reject) => {
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        reject(abortError());
      };
      signal.addEventListener("abort", abort, { once: true });
      void promise.then((result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(structuredClone(result));
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      });
    });
  }

  #cancelJob(job: ScheduledBattleJob): void {
    if (job.state === "settled") return;
    if (job.state === "queued") {
      const queuedIndex = this.#queue.indexOf(job);
      if (queuedIndex >= 0) this.#queue.splice(queuedIndex, 1);
      job.state = "settled";
      this.#inFlight.delete(job.key);
      job.reject(abortError());
      return;
    }
    job.controller.abort();
  }

  #startJob(job: ScheduledBattleJob): void {
    if (job.state !== "queued") return;
    job.state = "running";
    this.#runningCount += 1;
    this.#simulationCount += 1;
    let renewing = false;
    const renewTimer = this.#resultRepository.renewLease ? setInterval(() => {
      if (renewing || job.controller.signal.aborted) return;
      renewing = true;
      void this.#resultRepository.renewLease!(job.key, job.fingerprint).then((renewed) => { if (!renewed) job.controller.abort(); }, () => job.controller.abort()).finally(() => { renewing = false; });
    }, this.#resultRepository.leaseRenewIntervalMs ?? 5_000) : null;
    renewTimer?.unref();
    void (async () => {
      try {
        const result = await simulateMatchRoundAsync(job.canonical.player1, job.canonical.player2, job.canonical, {
          chunkTicks: this.#chunkTicks,
          yieldBudgetMs: this.#yieldBudgetMs,
          signal: job.controller.signal,
        });
        if (job.controller.signal.aborted) throw abortError();
        const authoritative = await this.#saveAuthoritative(job.key, job.fingerprint, result);
        if (job.controller.signal.aborted) throw abortError();
        if (!job.controller.signal.aborted) this.#storeCached(job.key, job.fingerprint, authoritative);
        job.resolve(authoritative);
      } catch (error) {
        if (this.#resultRepository.release) {
          try { await this.#resultRepository.release(job.key, job.fingerprint); } catch { /* preserve simulation error */ }
        }
        job.reject(error);
      } finally {
        if (renewTimer) clearInterval(renewTimer);
        job.state = "settled";
        this.#runningCount -= 1;
        this.#inFlight.delete(job.key);
        this.#startNextJob();
      }
    })();
  }

  #startNextJob(): void {
    while (this.#runningCount < this.#maxConcurrent) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      if (next.state === "queued") this.#startJob(next);
    }
  }

  close(matchId: string, roundId: string): void {
    this.#pruneExpired();
    const entry = this.#cache.get(correlationKey(matchId, roundId));
    if (entry === undefined) throw new Error("Battle result not found");
    entry.closed = true;
  }

  cleanup(matchId: string, roundId: string): boolean {
    this.#pruneExpired();
    const key = correlationKey(matchId, roundId);
    const removed = this.#cache.delete(key);
    const active = this.#inFlight.get(key);
    const pending = this.#pendingRepositoryLookups.get(key);
    if (pending !== undefined) pending.canceled = true;
    if (active !== undefined) this.#cancelJob(active);
    return removed || active !== undefined || pending !== undefined;
  }
}
