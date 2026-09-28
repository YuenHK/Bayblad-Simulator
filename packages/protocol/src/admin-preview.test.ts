import { expect, it } from "vitest";
import { adminLeaderboardRowSchema, adminDesignParametersSchema } from "./events";
it("preserves historical colors and the best-match design in leaderboard records", () => {
  const design = { layers: ["top","middle","bottom"].map(position => ({ position, shape:"circle", points:6, diameterMm:50, actualAreaMm2:1000, holeCount:4, rotationDeg:0, cornerRoundness:0, color:"#123456" })), totalMassG:30, metalDiscDiameterMm:0, centerOfMassOffsetMm:0, momentOfInertiaGmm2:1000, screwRadiusMm:15, screwRotationDeg:0 };
  expect(adminDesignParametersSchema.safeParse(design).success).toBe(true);
  const bestDesign = { design, matchId:"match", occurredAt:"2026-09-28T00:00:00.000Z", score:2.5 };
  expect(adminLeaderboardRowSchema.parse({ identityId:"550e8400-e29b-41d4-a716-446655440000",displayName:"Test",className:null,battleScore:2,challengeScore:.5,totalScore:2.5,matches:1,rank:1,bestDesign }).bestDesign).toEqual(bestDesign);
});
