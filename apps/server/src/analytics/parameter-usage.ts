import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@steam-top/db/schema";
import { analyticsFiltersSchema, hongKongDateBounds, type AnalyticsFilters } from "./usage";

export type ParameterUsageRow = Readonly<{ dimension: "layerShape" | "layerSides" | "layerSizeArea" | "holes" | "weight" | "layerOrder" | "metalDiscDiameter"; value: Readonly<Record<string, string | number | boolean>>; count: number; proportion: number; performanceModelVersion: string }>;
type SqlRow = Readonly<{ dimension: ParameterUsageRow["dimension"]; value: Record<string, string | number | boolean>; count: string | number; total: string | number; performanceModelVersion: string }>;

export function normalizeParameterUsage(rows: readonly SqlRow[]): readonly ParameterUsageRow[] {
  return rows.map((row) => {
    const count = Number(row.count), total = Number(row.total);
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total) || total < count || total < 1) throw new Error("INVALID_PARAMETER_USAGE");
    return Object.freeze({ dimension: row.dimension, value: Object.freeze({ ...row.value }), count, proportion: count / total, performanceModelVersion: row.performanceModelVersion });
  });
}

export async function parameterUsage(db: PostgresJsDatabase<typeof schema>, input: AnalyticsFilters): Promise<readonly ParameterUsageRow[]> {
  const filters = analyticsFiltersSchema.parse(input); const bounds = hongKongDateBounds(filters.from, filters.to);
  const conditions: SQL[] = [sql`d.created_at >= ${bounds.from}::timestamptz`, sql`d.created_at < ${bounds.toExclusive}::timestamptz`];
  if (filters.performanceModelVersion) conditions.push(sql`d.performance_model_version=${filters.performanceModelVersion}`);
  if (filters.className) conditions.push(sql`s.class_name_snapshot=${filters.className}`);
  if (filters.identityStatus) conditions.push(sql`s.identity_status_snapshot=${filters.identityStatus}`);
  const rows = await db.execute(sql`
    with filtered_designs as materialized (
      select d.* from designs d left join design_event_snapshots s on s.design_id=d.id where ${sql.join(conditions, sql` and `)}
    ), layer_orders as (
      select d.id,d.performance_model_version,string_agg(l.shape::text,'>' order by l.layer_order) value
      from filtered_designs d join design_layers l on l.design_id=d.id group by d.id,d.performance_model_version
    ), observations as (
      select 'layerShape'::text dimension,jsonb_build_object('position',l.position::text,'shape',l.shape::text) value,d.performance_model_version from filtered_designs d join design_layers l on l.design_id=d.id
      union all select 'layerSides',jsonb_build_object('position',l.position::text,'sides',l.points),d.performance_model_version from filtered_designs d join design_layers l on l.design_id=d.id
      union all select 'layerSizeArea',jsonb_build_object('position',l.position::text,'diameterMm',l.diameter_mm,'envelopeAreaMm2',round(pi()*l.diameter_mm*l.diameter_mm/4,2)),d.performance_model_version from filtered_designs d join design_layers l on l.design_id=d.id
      union all select 'holes',jsonb_build_object('count',d.screw_count),d.performance_model_version from filtered_designs d
      union all select 'weight',jsonb_build_object('totalMassG',round(d.total_mass_g,1)),d.performance_model_version from filtered_designs d
      union all select 'layerOrder',jsonb_build_object('order',o.value),o.performance_model_version from layer_orders o
      union all select 'metalDiscDiameter',jsonb_build_object('diameterMm',d.metal_disc_diameter_mm,'placement','under_bottom','none',(d.metal_disc_diameter_mm=0)),d.performance_model_version from filtered_designs d
    ), grouped as (
      select dimension,value,performance_model_version,count(*)::bigint count from observations group by dimension,value,performance_model_version
    )
    select dimension,value,count::text,sum(count) over(partition by dimension,performance_model_version)::text total,performance_model_version "performanceModelVersion"
    from grouped order by performance_model_version,dimension,value::text
  `);
  return normalizeParameterUsage(rows as unknown as SqlRow[]);
}
