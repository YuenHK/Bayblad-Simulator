import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import * as schema from "@steam-top/db/schema";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year!, month! - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month! - 1 && candidate.getUTCDate() === day;
}, "invalid Gregorian date");
const identityStatus = z.enum(["iclass", "cookie", "guest"]);

export const analyticsFiltersSchema = z.object({
  from: isoDate,
  to: isoDate,
  className: z.string().trim().min(1).max(30).optional(),
  identityStatus: identityStatus.optional(),
  performanceModelVersion: z.string().trim().min(1).max(64).optional(),
  physicsModelVersion: z.string().trim().min(1).max(64).optional(),
}).strict().superRefine((value, context) => {
  const from = new Date(`${value.from}T00:00:00+08:00`);
  const to = new Date(`${value.to}T00:00:00+08:00`);
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) context.addIssue({ code: "custom", message: "to must not precede from" });
  if (days > 366) context.addIssue({ code: "custom", message: "date range cannot exceed 367 days" });
});

export type AnalyticsFilters = z.infer<typeof analyticsFiltersSchema>;

export function hongKongDateBounds(from: string, to: string) {
  const start = new Date(`${from}T00:00:00+08:00`);
  const end = new Date(`${to}T00:00:00+08:00`);
  end.setUTCDate(end.getUTCDate() + 1);
  return Object.freeze({ from: start.toISOString(), toExclusive: end.toISOString() });
}

type UsageSqlRow = Readonly<{
  localDate: string; activeDevices: string | number; designCount: string | number;
  roomCount: string | number; completedMatchCount: string | number;
  shape: string | null; shapeCount: string | number; totalShapeCount: string | number;
}>;

export type UsageDay = Readonly<{
  date: string; activeDevices: number; designs: number; rooms: number; completedMatches: number;
  shapes: readonly Readonly<{ shape: string; count: number; proportion: number }>[];
}>;
export type UsagePeriod = "day" | "week" | "month";

function localBucket(column: SQL, period: UsagePeriod): SQL {
  if (period === "day") return sql`(${column} at time zone 'Asia/Hong_Kong')::date`;
  return sql`date_trunc(${period}, ${column} at time zone 'Asia/Hong_Kong')::date`;
}

function safeCount(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("INVALID_ANALYTICS_COUNT");
  return result;
}

export function normalizeUsageRows(rows: readonly UsageSqlRow[]): readonly UsageDay[] {
  const days = new Map<string, { date: string; activeDevices: number; designs: number; rooms: number; completedMatches: number; shapes: { shape: string; count: number; proportion: number }[] }>();
  for (const row of rows) {
    const total = safeCount(row.totalShapeCount);
    const current = days.get(row.localDate) ?? { date: row.localDate, activeDevices: safeCount(row.activeDevices), designs: safeCount(row.designCount), rooms: safeCount(row.roomCount), completedMatches: safeCount(row.completedMatchCount), shapes: [] };
    const count = safeCount(row.shapeCount);
    if (row.shape && count > 0) current.shapes.push({ shape: row.shape, count, proportion: total === 0 ? 0 : count / total });
    days.set(row.localDate, current);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => Object.freeze({ ...day, shapes: Object.freeze(day.shapes.sort((a, b) => a.shape.localeCompare(b.shape)).map((shape) => Object.freeze(shape))) }));
}

function activityFilters(filters: AnalyticsFilters) {
  const fragments: SQL[] = [];
  if (filters.className) fragments.push(sql`a.class_name_snapshot=${filters.className}`);
  if (filters.identityStatus) fragments.push(sql`a.identity_status_snapshot=${filters.identityStatus}`);
  return fragments.length ? sql`and ${sql.join(fragments, sql` and `)}` : sql``;
}
function eventSnapshotFilters(filters: AnalyticsFilters, alias: "ds" | "rs" | "ps") {
  const prefix = sql.raw(alias); const fragments: SQL[] = [];
  if (filters.className) fragments.push(sql`${prefix}.class_name_snapshot=${filters.className}`);
  if (filters.identityStatus) fragments.push(sql`${prefix}.identity_status_snapshot=${filters.identityStatus}`);
  return fragments.length ? sql`and ${sql.join(fragments, sql` and `)}` : sql``;
}

/** Completed matches are the sole authority for battle counts; dates are Hong Kong civil dates. */
export async function usageAnalytics(db: PostgresJsDatabase<typeof schema>, input: AnalyticsFilters, period: UsagePeriod = "day",cutoff?:string): Promise<readonly UsageDay[]> {
  const filters = analyticsFiltersSchema.parse(input);
  const bounds = hongKongDateBounds(filters.from, filters.to);
  const cutoffSql=cutoff?sql`and first_activity_at <= ${cutoff}::timestamptz`:sql``;const designCutoff=cutoff?sql`and d.created_at <= ${cutoff}::timestamptz`:sql``;const roomCutoff=cutoff?sql`and r.created_at <= ${cutoff}::timestamptz`:sql``;const matchCutoff=cutoff?sql`and m.completed_at <= ${cutoff}::timestamptz`:sql``;
  const designModel = filters.performanceModelVersion ? sql`and d.performance_model_version = ${filters.performanceModelVersion}` : sql``;
  const matchModels = sql`${filters.performanceModelVersion ? sql`and m.performance_model_version = ${filters.performanceModelVersion}` : sql``} ${filters.physicsModelVersion ? sql`and m.physics_model_version = ${filters.physicsModelVersion}` : sql``}`;
  const matchIdentity = filters.className || filters.identityStatus
    ? sql`and exists (select 1 from match_participant_snapshots ps where ps.match_id=m.id ${eventSnapshotFilters(filters, "ps")})`
    : sql``;
  const step = period === "day" ? "1 day" : period === "week" ? "1 week" : "1 month";
  const startBucket = period === "day" ? sql`${filters.from}::date` : sql`date_trunc(${period}, ${filters.from}::date)::date`;
  const endBucket = period === "day" ? sql`${filters.to}::date` : sql`date_trunc(${period}, ${filters.to}::date)::date`;
  const result = await db.execute(sql`
    with days as (
      select generate_series(${startBucket}, ${endBucket}, ${step}::interval)::date as local_date
    ), session_counts as (
      select ${period === "day" ? sql`a.activity_date` : sql`date_trunc(${period},a.activity_date)::date`} local_date,
             count(distinct a.anonymous_device_id)::bigint active_devices
      from device_activity_days a
      where a.activity_date >= ${filters.from}::date and a.activity_date <= ${filters.to}::date ${cutoffSql} ${activityFilters(filters)}
      group by 1
    ), design_counts as (
      select ${localBucket(sql`d.created_at`, period)} local_date, count(*)::bigint design_count
      from designs d left join design_event_snapshots ds on ds.design_id=d.id
      where d.created_at >= ${bounds.from}::timestamptz and d.created_at < ${bounds.toExclusive}::timestamptz
        ${designCutoff} ${eventSnapshotFilters(filters, "ds")} ${designModel}
      group by 1
    ), room_counts as (
      select ${localBucket(sql`r.created_at`, period)} local_date, count(*)::bigint room_count
      from rooms r left join room_event_snapshots rs on rs.room_id=r.id
      where r.created_at >= ${bounds.from}::timestamptz and r.created_at < ${bounds.toExclusive}::timestamptz
        ${roomCutoff} ${eventSnapshotFilters(filters, "rs")}
      group by 1
    ), match_counts as (
      select ${localBucket(sql`m.completed_at`, period)} local_date, count(distinct m.id)::bigint completed_match_count
      from matches m
      where m.status='completed' and m.completed_at >= ${bounds.from}::timestamptz and m.completed_at < ${bounds.toExclusive}::timestamptz
        ${matchCutoff} ${matchModels}
        ${matchIdentity}
      group by 1
    ), shape_counts as (
      select ${localBucket(sql`d.created_at`, period)} local_date, l.shape::text shape, count(*)::bigint shape_count
      from designs d join design_layers l on l.design_id=d.id left join design_event_snapshots ds on ds.design_id=d.id
      where d.created_at >= ${bounds.from}::timestamptz and d.created_at < ${bounds.toExclusive}::timestamptz
        ${designCutoff} ${eventSnapshotFilters(filters, "ds")} ${designModel}
      group by 1,2
    ), shapes as (
      select *, sum(shape_count) over(partition by local_date)::bigint total_shape_count from shape_counts
    )
    select days.local_date::text "localDate", coalesce(sc.active_devices,0)::text "activeDevices",
      coalesce(dc.design_count,0)::text "designCount", coalesce(rc.room_count,0)::text "roomCount",
      coalesce(mc.completed_match_count,0)::text "completedMatchCount", sh.shape,
      coalesce(sh.shape_count,0)::text "shapeCount", coalesce(sh.total_shape_count,0)::text "totalShapeCount"
    from days left join session_counts sc using(local_date) left join design_counts dc using(local_date)
      left join room_counts rc using(local_date) left join match_counts mc using(local_date)
      left join shapes sh using(local_date)
    order by days.local_date, sh.shape
  `);
  return normalizeUsageRows(result as unknown as UsageSqlRow[]);
}
