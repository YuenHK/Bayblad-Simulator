import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@steam-top/db/schema";
import { analyticsFiltersSchema, hongKongDateBounds, type AnalyticsFilters } from "./usage";

export const OPPONENT_STRENGTH_METRIC = Object.freeze({ stability: .4, impactResistance: .3, spinDuration: .2, speed: .1, unit: "performance-index-0-100", version: "1" as const });
export function opponentStrength(value: Readonly<{ stability:number; impactResistance:number; spinDuration:number; speed:number }>):number {
  return value.stability*.4+value.impactResistance*.3+value.spinDuration*.2+value.speed*.1;
}
export const EXPECTED_OUTCOME_METRIC = Object.freeze({ scale:15, unit:"win-probability-residual", version:"1" as const });
export function expectedWinProbability(ownStrength:number,opponentStrengthValue:number):number {
  return 1/(1+Math.exp((opponentStrengthValue-ownStrength)/EXPECTED_OUTCOME_METRIC.scale));
}
export function outcomeResidual(outcome:0|0.5|1,ownStrength:number,opponentStrengthValue:number):number {
  return outcome-expectedWinProbability(ownStrength,opponentStrengthValue);
}

type ParameterSqlRow = Readonly<{ dimension:string; value:Record<string,string|number|boolean|null>; launchGrade:"Perfect"|"Great"|"Good"|"Miss"; opponentStrengthBand:"low"|"medium"|"high"; performanceModelVersion:string; physicsModelVersion:string; sampleSize:string|number; participantObservations:string|number; averageScore:string|number; winRate:string|number; opponentAverageStrength:string|number; expectedWinRate:string|number; outcomeResidual:string|number; totalGroups:string|number }>;

function finite(value: string | number): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error("INVALID_ANALYTICS_NUMBER");
  return result;
}

export function normalizeParameterRows(rows: readonly ParameterSqlRow[]) {
  return rows.filter((row) => finite(row.sampleSize) >= 10).map((row) => Object.freeze({
    dimension:row.dimension,value:Object.freeze({...row.value}),launchGrade:row.launchGrade,opponentStrengthBand:row.opponentStrengthBand,
    performanceModelVersion: row.performanceModelVersion, physicsModelVersion: row.physicsModelVersion,
    totalGroups:finite(row.totalGroups),
    sampleSize: finite(row.sampleSize), participantObservations: finite(row.participantObservations), averageScore: finite(row.averageScore), winRate: finite(row.winRate), opponentAverageStrength: finite(row.opponentAverageStrength),expectedWinRate:finite(row.expectedWinRate),outcomeResidual:finite(row.outcomeResidual),
  }));
}

export async function parameterPerformance(db: PostgresJsDatabase<typeof schema>, input: AnalyticsFilters, page: Readonly<{ limit?: number; offset?: number; order?:"stable"|"high"|"low" }> = {}) {
  const filters = analyticsFiltersSchema.parse(input);
  const limit=page.limit ?? 100, offset=page.offset ?? 0;
  if (!Number.isSafeInteger(limit)||limit<1||limit>5_000||!Number.isSafeInteger(offset)||offset<0||offset>1_000_000) throw new RangeError("INVALID_ANALYTICS_PAGE");
  const order=page.order??"stable";
  const tie=sql`performance_model_version,physics_model_version,dimension,value::text,launch_grade,"opponentStrengthBand"`;
  const ordering=order==="high"?sql`"outcomeResidual" desc,"averageScore" desc,"winRate" desc,${tie}`:order==="low"?sql`"outcomeResidual" asc,"averageScore" asc,"winRate" asc,${tie}`:tie;
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
      select m.id match_id,m.player1_identity_id identity_id,m.player1_design_id design_id,m.player2_design_id opponent_design_id,m.player1_total score,case when m.winner='player1' then 1.0 when m.winner is null then .5 else 0.0 end won,'A'::text side,'player1'::player_slot slot,m.performance_model_version,m.physics_model_version
      from filtered_matches m union all
      select m.id,m.player2_identity_id,m.player2_design_id,m.player1_design_id,m.player2_total,case when m.winner='player2' then 1.0 when m.winner is null then .5 else 0.0 end,'B'::text,'player2'::player_slot,m.performance_model_version,m.physics_model_version from filtered_matches m
    ), filtered_participants as materialized (
      select p.* from participants p left join match_participant_snapshots ps on ps.match_id=p.match_id and ps.slot=p.slot ${identityWhere}
    ), relevant_designs as materialized (
      select design_id id from filtered_participants union select opponent_design_id from filtered_participants
    ), launch_grades as materialized (
      select distinct p.match_id,p.identity_id,p.design_id,p.side,case when p.side='A' then r.launch_grade_a else r.launch_grade_b end launch_grade
      from filtered_participants p join rounds r on r.match_id=p.match_id
    ), profiles as materialized (
      select d.id,string_agg(l.shape::text,'>' order by l.layer_order) layer_order,
        jsonb_agg(jsonb_build_object('position',l.position::text,'shape',l.shape::text,'sidesLabel',case l.shape when 'circle' then 'NA' when 'polygon' then 'sides' when 'star' then 'points' else 'lobes' end,'sidesValue',case when l.shape='circle' then null else l.points end,'diameterMm',l.diameter_mm,'actualAreaMm2',l.actual_area_mm2) order by l.layer_order) layer_combination
      from relevant_designs rd join designs d on d.id=rd.id join design_layers l on l.design_id=d.id group by d.id
    ), base as materialized (
      select p.*,lg.launch_grade,d.total_mass_g,d.screw_count,d.metal_disc_diameter_mm,pr.layer_order,pr.layer_combination,
        (d.performance_stability*.4+d.performance_impact_resistance*.3+d.performance_spin_duration*.2+d.performance_speed*.1) own_strength,
        (od.performance_stability*.4+od.performance_impact_resistance*.3+od.performance_spin_duration*.2+od.performance_speed*.1) opponent_strength
      from filtered_participants p join launch_grades lg on lg.match_id=p.match_id and lg.design_id=p.design_id and lg.side=p.side
      join designs d on d.id=p.design_id join designs od on od.id=p.opponent_design_id join profiles pr on pr.id=d.id
    ), observations as (
      select b.*,'totalMassGBucket'::text dimension,jsonb_build_object('fromG',floor(b.total_mass_g/5)*5,'toG',floor(b.total_mass_g/5)*5+5) value from base b
      union all select b.*,'layerOrder',jsonb_build_object('order',b.layer_order) from base b
      union all select b.*,'layerCombination',jsonb_build_object('layers',b.layer_combination) from base b
      union all select b.*,'holes',jsonb_build_object('count',b.screw_count) from base b
      union all select b.*,'metalDiscDiameter',jsonb_build_object('diameterMm',b.metal_disc_diameter_mm,'none',b.metal_disc_diameter_mm=0) from base b
      union all select b.*,'layerShape',jsonb_build_object('position',l.position::text,'shape',l.shape::text) from base b join design_layers l on l.design_id=b.design_id
      union all select b.*,'layerSides',jsonb_build_object('position',l.position::text,'shape',l.shape::text,'label',case l.shape when 'circle' then 'NA' when 'polygon' then 'sides' when 'star' then 'points' else 'lobes' end,'value',case when l.shape='circle' then null else l.points end) from base b join design_layers l on l.design_id=b.design_id
      union all select b.*,'layerActualAreaBucket',jsonb_build_object('position',l.position::text,'fromMm2',floor(l.actual_area_mm2/100)*100,'toMm2',floor(l.actual_area_mm2/100)*100+100) from base b join design_layers l on l.design_id=b.design_id
    )
    select dimension,value,launch_grade::text "launchGrade",case when opponent_strength<40 then 'low' when opponent_strength<70 then 'medium' else 'high' end "opponentStrengthBand",
      performance_model_version "performanceModelVersion",physics_model_version "physicsModelVersion",count(distinct match_id)::text "sampleSize",count(*)::text "participantObservations",
      avg(score)::text "averageScore",avg(won)::text "winRate",avg(opponent_strength)::text "opponentAverageStrength",
      avg(1.0/(1.0+exp((opponent_strength-own_strength)/15.0)))::text "expectedWinRate",
      avg(won-1.0/(1.0+exp((opponent_strength-own_strength)/15.0)))::text "outcomeResidual",count(*) over()::text "totalGroups"
    from observations group by performance_model_version,physics_model_version,dimension,value,launch_grade,case when opponent_strength<40 then 'low' when opponent_strength<70 then 'medium' else 'high' end
    having count(distinct match_id)>=10
    order by ${ordering}
    limit ${limit} offset ${offset}
  `);
  return normalizeParameterRows(result as unknown as ParameterSqlRow[]);
}
