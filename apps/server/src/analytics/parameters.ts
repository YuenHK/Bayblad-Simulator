import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@steam-top/db/schema";
import { analyticsFiltersSchema, hongKongDateBounds, type AnalyticsFilters } from "./usage";

export const OPPONENT_STRENGTH_METRIC = Object.freeze({ stability: .4, impactResistance: .3, spinDuration: .2, speed: .1, unit: "performance-index-0-100", version: "1" as const });
export function opponentStrength(value: Readonly<{ stability:number; impactResistance:number; spinDuration:number; speed:number }>):number {
  return value.stability*.4+value.impactResistance*.3+value.spinDuration*.2+value.speed*.1;
}

type ParameterSqlRow = Readonly<Record<"position" | "shape", string> & {
  points: number; diameterMm: string | number; cornerRoundness: string | number; screwCount: number; metalDiscDiameterMm: string | number;
  performanceModelVersion: string; physicsModelVersion: string; sampleSize: string | number; participantObservations: string | number; averageScore: string | number; winRate: string | number; opponentAverageStrength: string | number;
  perfectCount: string | number; greatCount: string | number; goodCount: string | number; missCount: string | number;
}>;

function finite(value: string | number): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error("INVALID_ANALYTICS_NUMBER");
  return result;
}

export function normalizeParameterRows(rows: readonly ParameterSqlRow[]) {
  return rows.filter((row) => finite(row.sampleSize) >= 10).map((row) => Object.freeze({
    parameters: Object.freeze({ position: row.position, shape: row.shape, points: row.points, diameterMm: finite(row.diameterMm), cornerRoundness: finite(row.cornerRoundness), screwCount: row.screwCount, metalDiscDiameterMm: finite(row.metalDiscDiameterMm) }),
    performanceModelVersion: row.performanceModelVersion, physicsModelVersion: row.physicsModelVersion,
    sampleSize: finite(row.sampleSize), participantObservations: finite(row.participantObservations), averageScore: finite(row.averageScore), winRate: finite(row.winRate), opponentAverageStrength: finite(row.opponentAverageStrength),
    launchGrades: Object.freeze({ Perfect: finite(row.perfectCount), Great: finite(row.greatCount), Good: finite(row.goodCount), Miss: finite(row.missCount) }),
  }));
}

export async function parameterPerformance(db: PostgresJsDatabase<typeof schema>, input: AnalyticsFilters, page: Readonly<{ limit?: number; offset?: number }> = {}) {
  const filters = analyticsFiltersSchema.parse(input);
  const limit=page.limit ?? 100, offset=page.offset ?? 0;
  if (!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0||offset>1_000_000) throw new RangeError("INVALID_ANALYTICS_PAGE");
  const bounds = hongKongDateBounds(filters.from, filters.to);
  const matchConditions: SQL[] = [sql`status='completed'`, sql`completed_at >= ${bounds.from}::timestamptz`, sql`completed_at < ${bounds.toExclusive}::timestamptz`];
  if (filters.performanceModelVersion) matchConditions.push(sql`performance_model_version=${filters.performanceModelVersion}`);
  if (filters.physicsModelVersion) matchConditions.push(sql`physics_model_version=${filters.physicsModelVersion}`);
  const identityConditions: SQL[] = [];
  if (filters.className) identityConditions.push(sql`ps.class_name_snapshot=${filters.className}`);
  if (filters.identityStatus) identityConditions.push(sql`ps.identity_status_snapshot=${filters.identityStatus}`);
  const identityWhere = identityConditions.length ? sql`where ${sql.join(identityConditions, sql` and `)}` : sql``;
  const result = await db.execute(sql`
    with filtered_matches as materialized (
      select * from matches where ${sql.join(matchConditions, sql` and `)}
    ), participants as materialized (
      select m.id match_id,m.player1_identity_id identity_id,m.player1_design_id design_id,m.player2_design_id opponent_design_id,m.player1_total score,(m.winner='player1')::int won,'A'::text side,'player1'::player_slot slot,m.performance_model_version,m.physics_model_version
      from filtered_matches m union all
      select m.id,m.player2_identity_id,m.player2_design_id,m.player1_design_id,m.player2_total,(m.winner='player2')::int,'B'::text,'player2'::player_slot,m.performance_model_version,m.physics_model_version from filtered_matches m
    ), filtered_participants as materialized (
      select p.* from participants p left join match_participant_snapshots ps on ps.match_id=p.match_id and ps.slot=p.slot ${identityWhere}
    ), launch as (
      select r.match_id, p.side,
        count(*) filter(where (case when p.side='A' then r.launch_grade_a else r.launch_grade_b end)='Perfect')::bigint perfect_count,
        count(*) filter(where (case when p.side='A' then r.launch_grade_a else r.launch_grade_b end)='Great')::bigint great_count,
        count(*) filter(where (case when p.side='A' then r.launch_grade_a else r.launch_grade_b end)='Good')::bigint good_count,
        count(*) filter(where (case when p.side='A' then r.launch_grade_a else r.launch_grade_b end)='Miss')::bigint miss_count
      from rounds r join (select distinct match_id from filtered_participants) fm on fm.match_id=r.match_id
        cross join (values ('A'::text),('B'::text)) p(side) group by r.match_id,p.side
    )
    select l.position::text position,l.shape::text shape,l.points,l.diameter_mm::text "diameterMm",l.corner_roundness::text "cornerRoundness",
      d.screw_count "screwCount",d.metal_disc_diameter_mm::text "metalDiscDiameterMm",p.performance_model_version "performanceModelVersion",p.physics_model_version "physicsModelVersion",
      count(distinct p.match_id)::text "sampleSize",count(*)::text "participantObservations",
      avg(p.score)::text "averageScore",avg(p.won)::text "winRate",
      avg(od.performance_stability * .4 + od.performance_impact_resistance * .3 + od.performance_spin_duration * .2 + od.performance_speed * .1)::text "opponentAverageStrength",
      sum(la.perfect_count)::text "perfectCount",sum(la.great_count)::text "greatCount",sum(la.good_count)::text "goodCount",sum(la.miss_count)::text "missCount"
    from filtered_participants p join designs d on d.id=p.design_id join designs od on od.id=p.opponent_design_id
      join design_layers l on l.design_id=d.id join launch la on la.match_id=p.match_id and la.side=p.side
    group by p.performance_model_version,p.physics_model_version,l.position,l.shape,l.points,l.diameter_mm,l.corner_roundness,d.screw_count,d.metal_disc_diameter_mm
    having count(distinct p.match_id) >= 10
    order by p.performance_model_version,p.physics_model_version,l.position,l.shape,l.points,l.diameter_mm,l.corner_roundness,d.screw_count,d.metal_disc_diameter_mm
    limit ${limit} offset ${offset}
  `);
  return normalizeParameterRows(result as unknown as ParameterSqlRow[]);
}
