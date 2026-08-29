import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@steam-top/db/schema";
import { analyticsFiltersSchema, hongKongDateBounds, type AnalyticsFilters } from "./usage";

type ParameterSqlRow = Readonly<Record<"position" | "shape", string> & {
  points: number; diameterMm: string | number; cornerRoundness: string | number; screwCount: number; metalDiscDiameterMm: string | number;
  sampleSize: string | number; averageScore: string | number; winRate: string | number; opponentAverageStrength: string | number;
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
    sampleSize: finite(row.sampleSize), averageScore: finite(row.averageScore), winRate: finite(row.winRate), opponentAverageStrength: finite(row.opponentAverageStrength),
    launchGrades: Object.freeze({ Perfect: finite(row.perfectCount), Great: finite(row.greatCount), Good: finite(row.goodCount), Miss: finite(row.missCount) }),
  }));
}

export async function parameterPerformance(db: PostgresJsDatabase<typeof schema>, input: AnalyticsFilters) {
  const filters = analyticsFiltersSchema.parse(input);
  const bounds = hongKongDateBounds(filters.from, filters.to);
  const conditions: SQL[] = [sql`m.status='completed'`, sql`m.completed_at >= ${bounds.from}::timestamptz`, sql`m.completed_at < ${bounds.toExclusive}::timestamptz`];
  if (filters.performanceModelVersion) conditions.push(sql`m.performance_model_version=${filters.performanceModelVersion}`);
  if (filters.physicsModelVersion) conditions.push(sql`m.physics_model_version=${filters.physicsModelVersion}`);
  if (filters.className) conditions.push(sql`i.class_name=${filters.className}`);
  if (filters.identityStatus) conditions.push(sql`i.status=${filters.identityStatus}`);
  const result = await db.execute(sql`
    with participants as (
      select m.id match_id,m.player1_identity_id identity_id,m.player1_design_id design_id,m.player1_total score,m.player2_total opponent_score,(m.winner='player1')::int won,'A'::text side
      from matches m union all
      select m.id,m.player2_identity_id,m.player2_design_id,m.player2_total,m.player1_total,(m.winner='player2')::int,'B'::text from matches m
    ), launch as (
      select r.match_id, p.side,
        count(*) filter(where (case when p.side='A' then r.launch_grade_a else r.launch_grade_b end)='Perfect')::bigint perfect_count,
        count(*) filter(where (case when p.side='A' then r.launch_grade_a else r.launch_grade_b end)='Great')::bigint great_count,
        count(*) filter(where (case when p.side='A' then r.launch_grade_a else r.launch_grade_b end)='Good')::bigint good_count,
        count(*) filter(where (case when p.side='A' then r.launch_grade_a else r.launch_grade_b end)='Miss')::bigint miss_count
      from rounds r cross join (values ('A'::text),('B'::text)) p(side) group by r.match_id,p.side
    )
    select l.position::text position,l.shape::text shape,l.points,l.diameter_mm::text "diameterMm",l.corner_roundness::text "cornerRoundness",
      d.screw_count "screwCount",d.metal_disc_diameter_mm::text "metalDiscDiameterMm",count(*)::text "sampleSize",
      avg(p.score)::text "averageScore",avg(p.won)::text "winRate",avg(p.opponent_score)::text "opponentAverageStrength",
      sum(la.perfect_count)::text "perfectCount",sum(la.great_count)::text "greatCount",sum(la.good_count)::text "goodCount",sum(la.miss_count)::text "missCount"
    from participants p join matches m on m.id=p.match_id left join identities i on i.id=p.identity_id join designs d on d.id=p.design_id
      join design_layers l on l.design_id=d.id join launch la on la.match_id=p.match_id and la.side=p.side
    where ${sql.join(conditions, sql` and `)}
    group by l.position,l.shape,l.points,l.diameter_mm,l.corner_roundness,d.screw_count,d.metal_disc_diameter_mm
    having count(*) >= 10
    order by avg(p.score) desc,count(*) desc,l.position,l.shape
    limit 500
  `);
  return normalizeParameterRows(result as unknown as ParameterSqlRow[]);
}
