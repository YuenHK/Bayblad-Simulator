import { expect, it } from "vitest";
import { PostgresAdminRecordsSource, adminRecordFilters } from "./records-routes";
it("supports exact identity drill-down without ambiguous name matching", () => {
  expect(adminRecordFilters.safeParse({ identityId: "550e8400-e29b-41d4-a716-446655440000" }).success).toBe(true);
  expect(adminRecordFilters.safeParse({ identityId: "arbitrary-name" }).success).toBe(false);
});
it("returns the best historical design alongside cumulative totals", async () => {
  const design = { layers:["top","middle","bottom"].map(position=>({position,shape:"circle",points:6,diameterMm:50,actualAreaMm2:1000,holeCount:4,rotationDeg:0,cornerRoundness:0,color:"#123456"})),totalMassG:30,metalDiscDiameterMm:0,centerOfMassOffsetMm:0,momentOfInertiaGmm2:1000,screwRadiusMm:15,screwRotationDeg:0 };
  const row = { identity_id:"550e8400-e29b-41d4-a716-446655440000",display_name:"Student",class_name:null,battle_score:4,challenge_score:1,total_score:5,matches:2,rank:1,total:1,best_design:design,best_match_id:"match-1",best_occurred_at:new Date("2026-09-28T00:00:00Z"),best_score:2.5 };
  let sql = "";
  const source = new PostgresAdminRecordsSource({ unsafe: async (query: string) => { sql = query; return [row]; } } as never);
  const page = await source.queryLeaderboard({page:1,pageSize:10});
  expect(page.rows[0]!.bestDesign).toEqual({design,matchId:"match-1",occurredAt:"2026-09-28T00:00:00.000Z",score:2.5});
  expect(sql).toContain("total_score desc");
  expect(sql).toContain("completed_at desc,match_id,slot");
});
