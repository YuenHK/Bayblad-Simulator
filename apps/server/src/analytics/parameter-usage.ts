import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@steam-top/db/schema";
import { analyticsFiltersSchema, hongKongDateBounds, type AnalyticsFilters } from "./usage";

export type ParameterUsageRow = Readonly<{ scope:"allEligibleDesigns"|"completedMatchDesigns";dimension: "layerShape" | "layerSides" | "layerActualArea" | "holes" | "weight" | "layerOrder" | "metalDiscDiameter"; value: Readonly<Record<string, string | number | boolean | null>>; count: number; proportion: number; performanceModelVersion: string;totalGroups:number;truncated:boolean;population:number }>;
type SqlRow = Readonly<{ scope:ParameterUsageRow["scope"];dimension: ParameterUsageRow["dimension"]; value: Record<string, string | number | boolean | null>; count: string | number; total: string | number; performanceModelVersion: string;totalGroups:string|number;truncated:boolean;population:string|number }>;

export function normalizeParameterUsage(rows: readonly SqlRow[]): readonly ParameterUsageRow[] {
  return rows.map((row) => {
    const count = Number(row.count), total = Number(row.total),totalGroups=Number(row.totalGroups),population=Number(row.population);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total) || total < count || total < 1) throw new Error("INVALID_PARAMETER_USAGE");
    if(!Number.isSafeInteger(totalGroups)||totalGroups<1||!Number.isSafeInteger(population)||population!==total||row.truncated!==(totalGroups>20))throw new Error("INVALID_PARAMETER_USAGE_METADATA");
    return Object.freeze({ scope:row.scope,dimension: row.dimension, value: Object.freeze({ ...row.value }), count, proportion: count / total, performanceModelVersion: row.performanceModelVersion,totalGroups,truncated:row.truncated,population });
  });
}

export async function parameterUsage(db: PostgresJsDatabase<typeof schema>, input: AnalyticsFilters,cutoff?:string): Promise<readonly ParameterUsageRow[]> {
  const filters = analyticsFiltersSchema.parse(input); const bounds = hongKongDateBounds(filters.from, filters.to);
  const conditions: SQL[] = [sql`d.created_at >= ${bounds.from}::timestamptz`, sql`d.created_at < ${bounds.toExclusive}::timestamptz`];
  if(cutoff)conditions.push(sql`d.created_at<=${cutoff}::timestamptz`);
  if (filters.performanceModelVersion) conditions.push(sql`d.performance_model_version=${filters.performanceModelVersion}`);
  if (filters.className) conditions.push(sql`s.class_name_snapshot=${filters.className}`);
  if (filters.identityStatus) conditions.push(sql`s.identity_status_snapshot=${filters.identityStatus}`);
  const scope=filters.physicsModelVersion?"completedMatchDesigns":"allEligibleDesigns";
  const matchDesigns=filters.physicsModelVersion?sql`filtered_matches as materialized (
      select player1_design_id,player2_design_id from matches where status='completed' and completed_at>=${bounds.from}::timestamptz and completed_at<${bounds.toExclusive}::timestamptz ${cutoff?sql`and completed_at<=${cutoff}::timestamptz`:sql``} and physics_model_version=${filters.physicsModelVersion}
        ${filters.performanceModelVersion?sql`and performance_model_version=${filters.performanceModelVersion}`:sql``}
    ), eligible_design_ids as materialized (
      select player1_design_id id from filtered_matches union select player2_design_id from filtered_matches
    ),`:sql``;
  const eligibleJoin=filters.physicsModelVersion?sql`join eligible_design_ids e on e.id=d.id`:sql``;
  const rows = await db.execute(sql`
    with ${matchDesigns} filtered_designs as materialized (
      select d.* from designs d ${eligibleJoin} left join design_event_snapshots s on s.design_id=d.id where ${sql.join(conditions, sql` and `)}
    ), layer_orders as (
      select d.id,d.performance_model_version,string_agg(l.shape::text,'>' order by l.layer_order) value
      from filtered_designs d join design_layers l on l.design_id=d.id group by d.id,d.performance_model_version
    ), observations as (
      select 'layerShape'::text dimension,jsonb_build_object('position',l.position::text,'shape',l.shape::text) value,d.performance_model_version from filtered_designs d join design_layers l on l.design_id=d.id
      union all select 'layerSides',jsonb_build_object('position',l.position::text,'label',case l.shape when 'circle' then 'NA' when 'polygon' then 'sides' when 'star' then 'points' else 'lobes' end,'value',case when l.shape='circle' then null else l.points end),d.performance_model_version from filtered_designs d join design_layers l on l.design_id=d.id
      union all select 'layerActualArea',jsonb_build_object('position',l.position::text,'fromMm2',floor(l.actual_area_mm2/250)*250,'toMm2',floor(l.actual_area_mm2/250)*250+250),d.performance_model_version from filtered_designs d join design_layers l on l.design_id=d.id
      union all select 'holes',jsonb_build_object('count',d.screw_count),d.performance_model_version from filtered_designs d
      union all select 'weight',jsonb_build_object('fromG',floor(d.total_mass_g/5)*5,'toG',floor(d.total_mass_g/5)*5+5),d.performance_model_version from filtered_designs d
      union all select 'layerOrder',jsonb_build_object('order',o.value),o.performance_model_version from layer_orders o
      union all select 'metalDiscDiameter',jsonb_build_object('diameterMm',d.metal_disc_diameter_mm,'placement','under_bottom','none',(d.metal_disc_diameter_mm=0)),d.performance_model_version from filtered_designs d
    ), grouped as (
      select dimension,value,performance_model_version,count(*)::bigint count from observations group by dimension,value,performance_model_version
    ), ranked as (
      select *,row_number() over(partition by dimension,performance_model_version order by count desc,value::text) rank,count(*) over(partition by dimension,performance_model_version) total_groups,sum(count) over(partition by dimension,performance_model_version) population from grouped
    ), collapsed as (
      select dimension,performance_model_version,case when rank<=20 then value else jsonb_build_object('category','Other') end value,sum(count)::bigint count,max(total_groups)::bigint total_groups,max(population)::bigint population
      from ranked group by dimension,performance_model_version,case when rank<=20 then value else jsonb_build_object('category','Other') end
    )
    select ${scope}::text scope,dimension,value,count::text,population::text total,performance_model_version "performanceModelVersion",total_groups::text "totalGroups",(total_groups>20) truncated,population::text population
    from collapsed order by performance_model_version,dimension,count desc,value::text
  `);
  return normalizeParameterUsage(rows as unknown as SqlRow[]);
}
