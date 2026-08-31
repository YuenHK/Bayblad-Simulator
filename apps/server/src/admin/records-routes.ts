import type { DatabaseClient } from "@steam-top/db";
import {
  adminRecordsPageSchema,
  adminLeaderboardPageSchema,
  type AdminLeaderboardPage,
  type AdminRecordsPage,
} from "@steam-top/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  authenticateAdminRead,
  type AdminAuthService,
} from "../auth/admin-auth";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const [year, month, day] = value.split("-").map(Number), candidate = new Date(Date.UTC(year!, month! - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month! - 1 && candidate.getUTCDate() === day;
}, "INVALID_GREGORIAN_DATE");
export const adminRecordFilters = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    from: date.optional(),
    to: date.optional(),
    className: z.string().trim().max(30).optional(),
    identity: z.string().trim().max(80).optional(),
    device: z.string().trim().max(128).optional(),
    parameter: z.string().trim().max(128).optional(),
  })
  .strict()
  .refine(
    (value) => !value.from || !value.to || value.from <= value.to,
    "INVALID_DATE_RANGE",
  );
export type AdminRecordFilters = z.infer<typeof adminRecordFilters>;
export interface AdminRecordsSource {
  query(filters: AdminRecordFilters): Promise<AdminRecordsPage>;
  queryLeaderboard?(filters: AdminRecordFilters): Promise<AdminLeaderboardPage>;
}
const pattern = (value: string | undefined) =>
  value ? `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : null;
export function adminRecordTimestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) throw new TypeError("INVALID_ADMIN_RECORD_TIMESTAMP");
  return parsed.toISOString();
}
export class PostgresAdminRecordsSource implements AdminRecordsSource {
  constructor(private readonly sql: DatabaseClient["sql"]) {}
  async query(filters: AdminRecordFilters) {
    const query = `with design_projection as materialized(select d.id,jsonb_build_object('layers',jsonb_agg(jsonb_build_object('position',l.position::text,'shape',l.shape::text,'points',l.points,'diameterMm',l.diameter_mm::float8,'actualAreaMm2',l.actual_area_mm2::float8,'holeCount',d.screw_count,'rotationDeg',l.rotation_deg::float8,'cornerRoundness',l.corner_roundness::float8) order by l.layer_order),'totalMassG',d.total_mass_g::float8,'metalDiscDiameterMm',d.metal_disc_diameter_mm::float8,'centerOfMassOffsetMm',sqrt(d.center_of_mass_x_mm*d.center_of_mass_x_mm+d.center_of_mass_y_mm*d.center_of_mass_y_mm)::float8,'momentOfInertiaGmm2',d.polar_moment_gmm2::float8) design from designs d join design_layers l on l.design_id=d.id group by d.id),filtered as materialized(select concat(m.id,':',p.slot::text) "rowId",m.id "matchId",p.slot::text slot,m.completed_at "occurredAt",coalesce(p.canonical_identity_id_at_start,p.identity_id_at_start)::text "identityId",coalesce(p.class_name_snapshot,i.class_name) "className",coalesce(p.display_name_snapshot,i.display_name,'已刪除身份') identity,case when p.slot='player1' then m.player1_device_name else m.player2_device_name end "deviceName",dp.design,coalesce(case when p.slot='player1' then m.player1_total else m.player2_total end,0)::float8 "totalScore" from matches m join match_participant_snapshots p on p.match_id=m.id left join identities i on i.id=coalesce(p.canonical_identity_id_at_start,p.identity_id_at_start) join design_projection dp on dp.id=p.design_id where m.status='completed' and ($1::date is null or (m.completed_at at time zone 'Asia/Hong_Kong')::date >= $1::date) and ($2::date is null or (m.completed_at at time zone 'Asia/Hong_Kong')::date <= $2::date) and ($3::text is null or coalesce(p.class_name_snapshot,i.class_name,'') ilike $3 escape '\\') and ($4::text is null or coalesce(p.display_name_snapshot,i.display_name,'') ilike $4 escape '\\') and ($5::text is null or coalesce(case when p.slot='player1' then m.player1_device_name else m.player2_device_name end,'') ilike $5 escape '\\') and ($6::text is null or dp.design::text ilike $6 escape '\\')),totals as(select count(*)::integer total from filtered),paged as(select * from filtered order by "occurredAt" desc,"matchId",slot limit $7 offset $8) select p.*,t.total from totals t left join paged p on true`;
    const raw = (await this.sql.unsafe(query, [
      filters.from ?? null,
      filters.to ?? null,
      pattern(filters.className),
      pattern(filters.identity),
      pattern(filters.device),
      pattern(filters.parameter),
      filters.pageSize,
      (filters.page - 1) * filters.pageSize,
    ])) as readonly Record<string, unknown>[];
    const total = Number(raw[0]?.total ?? 0),
      rows = raw
        .filter((row) => row.rowId !== null)
        .map(({ total: _, ...row }) => ({
          ...row,
          occurredAt: adminRecordTimestamp(row.occurredAt),
        }));
    return adminRecordsPageSchema.parse({
      rows,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    });
  }
  async queryLeaderboard(filters: AdminRecordFilters) {
    const query = `with design_projection as materialized(select d.id,jsonb_build_object('layers',jsonb_agg(jsonb_build_object('position',l.position::text,'shape',l.shape::text,'points',l.points,'diameterMm',l.diameter_mm::float8,'actualAreaMm2',l.actual_area_mm2::float8) order by l.layer_order),'totalMassG',d.total_mass_g::float8,'metalDiscDiameterMm',d.metal_disc_diameter_mm::float8) design from designs d join design_layers l on l.design_id=d.id group by d.id),participant_scores as materialized(
      select coalesce(p.canonical_identity_id_at_start,p.identity_id_at_start) identity_id,
        coalesce(p.display_name_snapshot,i.display_name,'已刪除身份') display_name,coalesce(p.class_name_snapshot,i.class_name) class_name,
        case when p.slot='player1' then m.player1_battle_points else m.player2_battle_points end::float8 battle_score,
        case when p.slot='player1' then m.player1_challenge_points else m.player2_challenge_points end::float8 challenge_score,
        case when p.slot='player1' then m.player1_total else m.player2_total end::float8 total_score,p.captured_at
      from matches m join match_participant_snapshots p on p.match_id=m.id
      left join identities i on i.id=coalesce(p.canonical_identity_id_at_start,p.identity_id_at_start)
      join design_projection dp on dp.id=p.design_id
      where m.status='completed' and coalesce(p.canonical_identity_id_at_start,p.identity_id_at_start) is not null
        and ($1::date is null or (m.completed_at at time zone 'Asia/Hong_Kong')::date >= $1::date)
        and ($2::date is null or (m.completed_at at time zone 'Asia/Hong_Kong')::date <= $2::date)
        and ($3::text is null or coalesce(p.class_name_snapshot,i.class_name,'') ilike $3 escape '\\')
        and ($4::text is null or coalesce(p.display_name_snapshot,i.display_name,'') ilike $4 escape '\\')
        and ($5::text is null or coalesce(case when p.slot='player1' then m.player1_device_name else m.player2_device_name end,'') ilike $5 escape '\\')
        and ($6::text is null or dp.design::text ilike $6 escape '\\')
    ), latest_label as materialized(select distinct on(identity_id) identity_id,display_name,class_name from participant_scores order by identity_id,captured_at desc,display_name desc),aggregated as materialized(select identity_id,sum(battle_score)::float8 battle_score,sum(challenge_score)::float8 challenge_score,sum(total_score)::float8 total_score,count(*)::integer matches from participant_scores group by identity_id),
    ranked as materialized(select a.*,l.display_name,l.class_name,dense_rank() over(order by a.total_score desc)::integer rank from aggregated a join latest_label l using(identity_id)),
    totals as(select count(*)::integer total from ranked),paged as(select * from ranked order by rank,display_name,identity_id limit $7 offset $8)
    select p.*,t.total from totals t left join paged p on true`;
    const raw = await this.sql.unsafe(query,[filters.from??null,filters.to??null,pattern(filters.className),pattern(filters.identity),pattern(filters.device),pattern(filters.parameter),filters.pageSize,(filters.page-1)*filters.pageSize]) as readonly Record<string,unknown>[];
    return adminLeaderboardPageSchema.parse({ rows: raw.filter(row=>row.identity_id!==null).map(row=>({ identityId:row.identity_id,displayName:row.display_name,className:row.class_name,battleScore:Number(row.battle_score),challengeScore:Number(row.challenge_score),totalScore:Number(row.total_score),matches:Number(row.matches),rank:Number(row.rank) })), total:Number(raw[0]?.total??0),page:filters.page,pageSize:filters.pageSize });
  }
}
export function registerAdminRecordRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  source: AdminRecordsSource,
) {
  app.get("/api/admin/records", async (request, reply) => {
    if (!(await authenticateAdminRead(request, reply, auth))) return;
    const parsed = adminRecordFilters.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "INVALID_RECORD_FILTERS" });
    reply.header("Cache-Control", "private, no-store");
    try {
      return await source.query(parsed.data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        request.log.error({
          event: "admin.records.validation_failed",
          issuePaths: error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "$"}:${issue.code}`),
        }, "Admin records response validation failed");
      }
      auth.report("admin.records.query", error, request.id);
      return reply.code(503).send({ error: "RECORDS_UNAVAILABLE" });
    }
  });
  app.get("/api/admin/leaderboard", async (request, reply) => {
    if (!(await authenticateAdminRead(request, reply, auth))) return;
    const parsed = adminRecordFilters.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_RECORD_FILTERS" });
    if (!source.queryLeaderboard) return reply.code(503).send({ error: "LEADERBOARD_UNAVAILABLE" });
    reply.header("Cache-Control", "private, no-store");
    try { return await source.queryLeaderboard(parsed.data); }
    catch { return reply.code(503).send({ error: "LEADERBOARD_UNAVAILABLE" }); }
  });
}
