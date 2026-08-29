import {
  designSchema,
  predictDesignPerformance,
  validateDesign,
  makeMassLayerVertices,
  polygonArea,
} from "@steam-top/domain";
import { launchGradeSchema, matchRoundWinnerSchema } from "@steam-top/protocol";
import { z } from "zod";

import { battleAuthorityKeyHash } from "./authority";
import type { NewDesign, NewDesignLayer, NewMatch, NewRound } from "./schema";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const modelVersionSchema = z.string().trim().min(1).max(64);
const scoreSchema = z.object({
  battlePoints: z.number().int().min(0).max(2),
  challengePoints: z.number().min(0).max(0.5),
  total: z.number().min(0).max(2.5),
}).strict().refine(
  ({ battlePoints, challengePoints, total }) =>
    total === battlePoints + challengePoints,
  "Score total must equal battle plus challenge points",
);

const designSnapshotInputSchema = z.object({
  snapshotId: z.uuid(),
  ownerIdentityId: z.uuid().nullable(),
  version: z.number().int().positive(),
  schemaVersion: modelVersionSchema,
  design: designSchema.extend({ id: z.uuid() }),
}).strict();

export function buildDesignSnapshotRows(
  input: z.input<typeof designSnapshotInputSchema>,
): Readonly<{
  design: NewDesign;
  layers: readonly NewDesignLayer[];
  activateBattleEligible: boolean;
}> {
  const parsed = designSnapshotInputSchema.parse(input);
  const validation = validateDesign(parsed.design);
  const performance = predictDesignPerformance(parsed.design);
  const mass = validation.massProperties;
  const designRow: NewDesign = {
    id: parsed.snapshotId,
    logicalDesignId: parsed.design.id,
    ownerIdentityId: parsed.ownerIdentityId,
    version: parsed.version,
    schemaVersion: parsed.schemaVersion,
    name: parsed.design.name,
    screwCount: parsed.design.screwLayout.count,
    screwRadiusMm: parsed.design.screwLayout.radiusMm,
    screwRotationDeg: parsed.design.screwLayout.rotationDeg,
    metalDiscDiameterMm: parsed.design.metalDiscDiameterMm,
    metalDiscPlacement: "under_bottom",
    totalMassG: mass.totalMassG,
    polarMomentGmm2: mass.polarMomentGmm2,
    centerOfMassXMm: mass.centerOfMassMm.x,
    centerOfMassYMm: mass.centerOfMassMm.y,
    performanceSpeed: performance.speed,
    performanceSpinDuration: performance.spinDuration,
    performanceStability: performance.stability,
    performanceImpactResistance: performance.impactResistance,
    performanceModelVersion: performance.modelVersion,
    // Insert draft -> insert layers -> activate inside one transaction.
    battleEligible: false,
    validationIssues: validation.issues.map(({ code }) => code),
  };
  const layers = parsed.design.layers.map((layer, layerOrder): NewDesignLayer => ({
    designId: parsed.snapshotId,
    sourceLayerId: layer.id,
    layerOrder,
    position: layer.position,
    shape: layer.shape,
    points: layer.points,
    diameterMm: layer.diameterMm,
    actualAreaMm2: Math.abs(polygonArea(makeMassLayerVertices(layer))),
    cornerRoundness: layer.cornerRoundness,
    rotationDeg: layer.rotationDeg,
    color: layer.color,
  }));
  return Object.freeze({
    design: Object.freeze(designRow),
    layers: Object.freeze(layers.map((layer) => Object.freeze(layer))),
    activateBattleEligible: validation.valid,
  });
}

const completedMatchInputSchema = z.object({
  id: z.uuid(),
  roomId: z.uuid().nullable().optional(),
  idempotencyFingerprint: hashSchema,
  player1IdentityId: z.uuid().nullable(),
  player2IdentityId: z.uuid().nullable(),
  player1DesignId: z.uuid(),
  player2DesignId: z.uuid(),
  roundWinners: z.array(matchRoundWinnerSchema).min(2).max(3),
  player1: scoreSchema,
  player2: scoreSchema,
  performanceModelVersion: modelVersionSchema,
  physicsModelVersion: modelVersionSchema,
  protocolVersion: z.number().int().positive(),
  spectatorCount: z.number().int().nonnegative(),
  completedAt: z.date(),
}).strict().superRefine((value, context) => {
  const p1 = value.roundWinners.filter((winner) => winner === "player1").length;
  const p2 = value.roundWinners.length - p1;
  const finalWinner = value.roundWinners.at(-1);
  if (
    (p1 !== 2 && p2 !== 2) ||
    finalWinner !== (p1 === 2 ? "player1" : "player2") ||
    value.player1.battlePoints !== p1 ||
    value.player2.battlePoints !== p2
  ) {
    context.addIssue({ code: "custom", message: "Invalid completed best-of-three score" });
  }
});

export function buildCompletedMatchRow(
  input: z.input<typeof completedMatchInputSchema>,
): NewMatch {
  const parsed = completedMatchInputSchema.parse(input);
  const winner = parsed.player1.battlePoints === 2 ? "player1" : "player2";
  return Object.freeze({
    id: parsed.id,
    ...(parsed.roomId === undefined ? {} : { roomId: parsed.roomId }),
    idempotencyFingerprint: parsed.idempotencyFingerprint,
    status: "completed",
    player1IdentityId: parsed.player1IdentityId,
    player2IdentityId: parsed.player2IdentityId,
    player1DesignId: parsed.player1DesignId,
    player2DesignId: parsed.player2DesignId,
    player1BattlePoints: parsed.player1.battlePoints,
    player2BattlePoints: parsed.player2.battlePoints,
    player1ChallengePoints: parsed.player1.challengePoints,
    player2ChallengePoints: parsed.player2.challengePoints,
    player1Total: parsed.player1.total,
    player2Total: parsed.player2.total,
    winner,
    roundWinners: parsed.roundWinners,
    performanceModelVersion: parsed.performanceModelVersion,
    physicsModelVersion: parsed.physicsModelVersion,
    protocolVersion: parsed.protocolVersion,
    spectatorCount: parsed.spectatorCount,
    completedAt: parsed.completedAt,
  });
}

export const battleResultPersistenceSchema = z.object({
  modelVersion: modelVersionSchema,
  seed: z.number().int().safe(),
  ticks: z.number().int().min(0).max(5_400),
  frames: z.array(z.unknown()),
  outcome: z.object({
    winner: z.enum(["player1", "player2", "draw"]),
    reason: z.enum(["stopped", "out-of-bounds", "timeout", "simultaneous"]),
  }).strict(),
  finalStats: z.record(z.string(), z.unknown()),
}).passthrough();

const roundInputSchema = z.object({
  id: z.uuid(),
  matchId: z.uuid(),
  externalRoundId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  roundNumber: z.number().int().min(1).max(3),
  attempt: z.number().int().positive(),
  inputFingerprint: hashSchema,
  launchGradeA: launchGradeSchema,
  launchGradeB: launchGradeSchema,
  launchAngularMultiplierA: z.number().min(0).max(2),
  launchAngularMultiplierB: z.number().min(0).max(2),
  launchLinearMultiplierA: z.number().min(0).max(2),
  launchLinearMultiplierB: z.number().min(0).max(2),
  completedAt: z.date(),
  battleResult: battleResultPersistenceSchema,
}).strict();

export function buildRoundRow(input: z.input<typeof roundInputSchema>): NewRound {
  const parsed = roundInputSchema.parse(input);
  return Object.freeze({
    id: parsed.id,
    matchId: parsed.matchId,
    externalRoundId: parsed.externalRoundId,
    authorityKeyHash: battleAuthorityKeyHash(parsed.matchId, parsed.externalRoundId),
    roundNumber: parsed.roundNumber,
    attempt: parsed.attempt,
    seed: parsed.battleResult.seed,
    outcome: parsed.battleResult.outcome.winner,
    outcomeReason: parsed.battleResult.outcome.reason,
    ticks: parsed.battleResult.ticks,
    launchGradeA: parsed.launchGradeA,
    launchGradeB: parsed.launchGradeB,
    launchAngularMultiplierA: parsed.launchAngularMultiplierA,
    launchAngularMultiplierB: parsed.launchAngularMultiplierB,
    launchLinearMultiplierA: parsed.launchLinearMultiplierA,
    launchLinearMultiplierB: parsed.launchLinearMultiplierB,
    physicsModelVersion: parsed.battleResult.modelVersion,
    inputFingerprint: parsed.inputFingerprint,
    battleResultJson: parsed.battleResult,
    completedAt: parsed.completedAt,
  });
}
