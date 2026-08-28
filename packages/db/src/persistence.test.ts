import { describe, expect, it } from "vitest";

import {
  buildCompletedMatchRow,
  buildDesignSnapshotRows,
  buildRoundRow,
} from "./persistence";

const design: Parameters<typeof buildDesignSnapshotRows>[0]["design"] = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "測試陀螺",
  layers: [
    { id: "top", position: "top", shape: "circle", points: 6, diameterMm: 40, cornerRoundness: 0.5, rotationDeg: 0, color: "#2563eb" },
    { id: "middle", position: "middle", shape: "polygon", points: 6, diameterMm: 50, cornerRoundness: 0.5, rotationDeg: 0, color: "#60a5fa" },
    { id: "bottom", position: "bottom", shape: "circle", points: 6, diameterMm: 45, cornerRoundness: 0.5, rotationDeg: 0, color: "#bfdbfe" },
  ],
  screwLayout: { count: 4, radiusMm: 12, rotationDeg: 0 },
  metalDiscDiameterMm: 0,
};

describe("authoritative persistence builders", () => {
  it("parses one canonical design and derives the design and three layer rows", () => {
    const rows = buildDesignSnapshotRows({
      snapshotId: "20000000-0000-4000-8000-000000000001",
      ownerIdentityId: null,
      version: 1,
      schemaVersion: "1",
      design,
    });
    expect(rows.design).toMatchObject({
      logicalDesignId: design.id,
      name: "測試陀螺",
      battleEligible: false,
      performanceModelVersion: "1.0.0",
    });
    expect(rows.activateBattleEligible).toBe(true);
    expect(rows.layers.map(({ position }) => position)).toEqual([
      "top",
      "middle",
      "bottom",
    ]);
    expect(rows.layers).toHaveLength(3);
    expect(rows.design).not.toHaveProperty("canonicalJson");
  });

  it("parses a completed score once and builds only a legal 2:0 or 2:1 row", () => {
    const input: Parameters<typeof buildCompletedMatchRow>[0] = {
      id: "30000000-0000-4000-8000-000000000001",
      idempotencyFingerprint: "a".repeat(64),
      player1DesignId: "20000000-0000-4000-8000-000000000001",
      player2DesignId: "20000000-0000-4000-8000-000000000002",
      player1IdentityId: null,
      player2IdentityId: null,
      roundWinners: ["player1", "player2", "player1"],
      player1: { battlePoints: 2, challengePoints: 0.25, total: 2.25 },
      player2: { battlePoints: 1, challengePoints: 0, total: 1 },
      performanceModelVersion: "1.0.0",
      physicsModelVersion: "2.0.0",
      protocolVersion: 1,
      spectatorCount: 4,
      completedAt: new Date("2026-08-29T00:00:00.000Z"),
    };
    const row = buildCompletedMatchRow(input);
    expect(row).toMatchObject({ status: "completed", winner: "player1" });
    expect(() => buildCompletedMatchRow({
      ...input,
      roundWinners: ["player1", "player1", "player2"],
    })).toThrow();
  });

  it("validates the battle result once and derives canonical round authority", () => {
    const input: Parameters<typeof buildRoundRow>[0] = {
      id: "40000000-0000-4000-8000-000000000001",
      matchId: "30000000-0000-4000-8000-000000000001",
      externalRoundId: "round-1",
      roundNumber: 1,
      attempt: 1,
      inputFingerprint: "b".repeat(64),
      launchGradeA: "Perfect",
      launchGradeB: "Great",
      launchAngularMultiplierA: 1.2,
      launchAngularMultiplierB: 1.1,
      launchLinearMultiplierA: 1.2,
      launchLinearMultiplierB: 1.1,
      completedAt: new Date("2026-08-29T00:00:00.000Z"),
      battleResult: {
        modelVersion: "2.0.0",
        seed: 42,
        ticks: 600,
        frames: [],
        outcome: { winner: "player1", reason: "stopped" },
        finalStats: {},
      },
    };
    const row = buildRoundRow(input);
    expect(row).toMatchObject({
      seed: 42,
      ticks: 600,
      outcome: "player1",
      physicsModelVersion: "2.0.0",
      authorityKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(() => buildRoundRow({
      ...input,
      battleResult: { ...input.battleResult, modelVersion: " " },
    })).toThrow();
  });
});
