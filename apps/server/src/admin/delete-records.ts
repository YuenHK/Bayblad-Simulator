import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseClient } from "@steam-top/db";
import { withAuditedDeletion } from "@steam-top/db";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { ADMIN_COOKIE_NAME } from "../auth/admin-session";
import { authenticateAdminMutation, type AdminAuthService, type AdminClientResolver } from "../auth/admin-auth";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const [year, month, day] = value.split("-").map(Number), candidate = new Date(Date.UTC(year!, month! - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month! - 1 && candidate.getUTCDate() === day;
}, "INVALID_GREGORIAN_DATE");
export const deletionFilterSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("identity"), identityId: z.uuid() }).strict(),
  z.object({ scope: z.literal("class"), className: z.string().trim().min(1).max(30) }).strict(),
  z.object({ scope: z.literal("date_range"), from: isoDate, to: isoDate }).strict().refine((value) => value.from <= value.to, "INVALID_DATE_RANGE"),
  z.object({ scope: z.literal("all") }).strict(),
]);
export type DeletionFilter = z.infer<typeof deletionFilterSchema>;
export type DeletionCounts = Readonly<{ identities: number; designs: number; matches: number }>;
export type DeletionPreview = Readonly<{ previewToken: string; filterHash: string; expiresAt: Date; counts: DeletionCounts }>;
export type DeletionAuditSummary = Readonly<{ auditId: string; adminUserId: string; scope: DeletionFilter["scope"]; filterHash: string; previewCount: number; deletedIdentityCount: number; deletedDesignCount: number; deletedMatchCount: number }>;

const deleteBodySchema = z.object({
  previewToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  filterHash: z.string().regex(/^[a-f0-9]{64}$/u),
  password: z.string().min(8).max(1024),
  confirmation: z.string().max(32),
}).strict();

export function deletionFilterHash(filter: DeletionFilter): string {
  const normalized = deletionFilterSchema.parse(filter);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export interface DeletionStore {
  createPreview(input: Readonly<{ filter: DeletionFilter; adminUserId: string; adminSessionId: string; now: Date; expiresAt: Date }>): Promise<DeletionPreview>;
  inspectPreview(input: Readonly<{ previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }>): Promise<Readonly<{ status: "ok"; scope: DeletionFilter["scope"] }> | Readonly<{ status: "invalid" | "expired" | "consumed" | "changed" }>>;
  execute(input: Readonly<{ previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }>): Promise<Readonly<{ status: "ok"; auditId: string; counts: DeletionCounts }> | Readonly<{ status: "invalid" | "expired" | "consumed" | "changed" | "stale" }>>;
}

type MemoryRecord = Readonly<{ identityId: string; className: string; occurredAt: Date; designs: number; matches: number }>;
type MemoryPreview = Readonly<{ tokenHash: string; filter: DeletionFilter; filterHash: string; adminUserId: string; adminSessionId: string; expiresAt: Date; counts: DeletionCounts; consumed: boolean }>;

export class InMemoryDeletionStore implements DeletionStore {
  #records: MemoryRecord[];
  readonly #previews = new Map<string, MemoryPreview>();
  readonly audits: DeletionAuditSummary[] = [];
  constructor(records: readonly MemoryRecord[] = []) { this.#records = [...records]; }
  get remainingIdentities() { return this.#records.length; }
  #selected(filter: DeletionFilter) {
    return this.#records.filter((row) => {
      if (filter.scope === "all") return true;
      if (filter.scope === "identity") return row.identityId === filter.identityId;
      if (filter.scope === "class") return row.className === filter.className;
      const day = row.occurredAt.toISOString().slice(0, 10);
      return day >= filter.from && day <= filter.to;
    });
  }
  #counts(filter: DeletionFilter): DeletionCounts { const selected = this.#selected(filter); return Object.freeze({ identities: selected.length, designs: selected.reduce((sum, row) => sum + row.designs, 0), matches: selected.reduce((sum, row) => sum + row.matches, 0) }); }
  async createPreview(input: { filter: DeletionFilter; adminUserId: string; adminSessionId: string; now: Date; expiresAt: Date }): Promise<DeletionPreview> {
    const previewToken = randomBytes(32).toString("base64url"), tokenHash = createHash("sha256").update(previewToken).digest("hex"), filter = deletionFilterSchema.parse(input.filter), filterHash = deletionFilterHash(filter), counts = this.#counts(filter);
    this.#previews.set(tokenHash, { tokenHash, filter, filterHash, adminUserId: input.adminUserId, adminSessionId: input.adminSessionId, expiresAt: input.expiresAt, counts, consumed: false });
    return Object.freeze({ previewToken, filterHash, expiresAt: input.expiresAt, counts });
  }
  async inspectPreview(input: { previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }) {
    const row = this.#previews.get(createHash("sha256").update(input.previewToken).digest("hex"));
    if (!row || row.adminUserId !== input.adminUserId || row.adminSessionId !== input.adminSessionId) return { status: "invalid" as const };
    if (row.filterHash !== input.filterHash) return { status: "changed" as const };
    if (row.consumed) return { status: "consumed" as const };
    if (input.now >= row.expiresAt) return { status: "expired" as const };
    return { status: "ok" as const, scope: row.filter.scope };
  }
  async execute(input: { previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }): ReturnType<DeletionStore["execute"]> {
    const key = createHash("sha256").update(input.previewToken).digest("hex"), row = this.#previews.get(key), inspected = await this.inspectPreview(input);
    if (inspected.status !== "ok" || !row) return { status: inspected.status === "ok" ? "invalid" : inspected.status };
    const actual = this.#counts(row.filter);
    if (JSON.stringify(actual) !== JSON.stringify(row.counts)) return { status: "stale" as const };
    const selected = new Set(this.#selected(row.filter).map((record) => record.identityId));
    const auditId = randomUUID();
    const audit = Object.freeze({ auditId, adminUserId: input.adminUserId, scope: row.filter.scope, filterHash: row.filterHash, previewCount: actual.identities + actual.designs + actual.matches, deletedIdentityCount: actual.identities, deletedDesignCount: actual.designs, deletedMatchCount: actual.matches });
    this.#records = this.#records.filter((record) => !selected.has(record.identityId));
    this.#previews.set(key, { ...row, consumed: true });
    this.audits.push(audit);
    return { status: "ok" as const, auditId, counts: actual };
  }
}

type DbRow = Readonly<Record<string, unknown>>;
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");
const rows = (value: unknown) => value as readonly DbRow[];
const count = (value: unknown) => { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("INVALID_DELETION_COUNT"); return parsed; };

function filterArguments(filter: DeletionFilter): (string | null)[] {
  return [filter.scope, filter.scope === "identity" ? filter.identityId : null, filter.scope === "class" ? filter.className : null, filter.scope === "date_range" ? filter.from : null, filter.scope === "date_range" ? filter.to : null];
}

const matchPredicate = (alias: string) => `(
  $1 = 'all'
  or ($1 = 'identity' and (${alias}.player1_identity_id = $2::uuid or ${alias}.player2_identity_id = $2::uuid
    or exists (select 1 from match_participant_snapshots ps where ps.match_id = ${alias}.id and (ps.identity_id_at_start = $2::uuid or ps.canonical_identity_id_at_start = $2::uuid))
    or exists (select 1 from designs od where (od.id = ${alias}.player1_design_id or od.id = ${alias}.player2_design_id) and od.owner_identity_id = $2::uuid)))
  or ($1 = 'class' and (exists (select 1 from match_participant_snapshots ps where ps.match_id = ${alias}.id and ps.class_name_snapshot = $3)
    or exists(select 1 from identities pi where (pi.id=${alias}.player1_identity_id or pi.id=${alias}.player2_identity_id) and pi.class_name=$3)
    or exists(select 1 from designs od join identities oi on oi.id=od.owner_identity_id where (od.id=${alias}.player1_design_id or od.id=${alias}.player2_design_id) and oi.class_name=$3)))
  or ($1 = 'date_range' and (coalesce(${alias}.completed_at, ${alias}.started_at) at time zone 'Asia/Hong_Kong')::date between $4::date and $5::date)
)`;
const designPredicate = (alias: string) => `(
  $1 = 'all'
  or ($1 = 'identity' and (${alias}.owner_identity_id = $2::uuid or exists (select 1 from design_event_snapshots ds where ds.design_id = ${alias}.id and (ds.owner_identity_id_at_creation = $2::uuid or ds.canonical_identity_id_at_creation = $2::uuid))))
  or ($1 = 'class' and (exists (select 1 from design_event_snapshots ds where ds.design_id = ${alias}.id and ds.class_name_snapshot = $3) or exists(select 1 from identities oi where oi.id=${alias}.owner_identity_id and oi.class_name=$3)))
  or ($1 = 'date_range' and (${alias}.created_at at time zone 'Asia/Hong_Kong')::date between $4::date and $5::date)
)`;
const identityPredicate = (alias: string) => `(
  $1 = 'all' or ($1 = 'identity' and ${alias}.id = $2::uuid) or ($1 = 'class' and ${alias}.class_name = $3)
  or ($1 = 'date_range' and (${alias}.created_at at time zone 'Asia/Hong_Kong')::date between $4::date and $5::date)
)`;
const roomPredicate = (alias: string) => `(
  $1 = 'all' or ($1 = 'identity' and (${alias}.owner_identity_id = $2::uuid or exists(select 1 from room_event_snapshots rs where rs.room_id=${alias}.id and (rs.owner_identity_id_at_creation=$2::uuid or rs.canonical_identity_id_at_creation=$2::uuid))))
  or ($1 = 'class' and (exists(select 1 from room_event_snapshots rs where rs.room_id=${alias}.id and rs.class_name_snapshot=$3) or exists(select 1 from identities oi where oi.id=${alias}.owner_identity_id and oi.class_name=$3)))
  or ($1 = 'date_range' and (${alias}.created_at at time zone 'Asia/Hong_Kong')::date between $4::date and $5::date)
)`;

async function postgresCounts(transaction: Pick<TransactionSql, "unsafe">, filter: DeletionFilter): Promise<DeletionCounts> {
  const args = filterArguments(filter);
  const result = rows(await transaction.unsafe(`
    with target_matches as (select m.id from matches m where ${matchPredicate("m")}),
    target_designs as (select d.id from designs d where ${designPredicate("d")} and not exists (
      select 1 from matches om where (om.player1_design_id=d.id or om.player2_design_id=d.id) and not ${matchPredicate("om")}
    )), target_identities as (select i.id from identities i where ${identityPredicate("i")})
    select (select count(*)::integer from target_identities) "identities",
      (select count(*)::integer from target_designs) "designs",
      (select count(*)::integer from target_matches) "matches"`, args));
  const row = result[0]; if (!row) throw new Error("DELETION_COUNT_FAILED");
  return Object.freeze({ identities: count(row.identities), designs: count(row.designs), matches: count(row.matches) });
}

/** PostgreSQL is the authority for previews, one-time consumption and audited all-or-nothing deletion. */
export class PostgresDeletionStore implements DeletionStore {
  constructor(private readonly client: DatabaseClient) {}
  async createPreview(input: { filter: DeletionFilter; adminUserId: string; adminSessionId: string; now: Date; expiresAt: Date }): Promise<DeletionPreview> {
    const filter = deletionFilterSchema.parse(input.filter), previewToken = randomBytes(32).toString("base64url"), filterHash = deletionFilterHash(filter);
    const counts = await this.client.sql.begin(async (transaction) => {
      const value = await postgresCounts(transaction, filter);
      await transaction.unsafe(`insert into deletion_previews (token_hash,admin_user_id,admin_session_id,scope,filters_json,filter_hash,identity_count,design_count,match_count,created_at,expires_at)
        values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`, [tokenDigest(previewToken), input.adminUserId, input.adminSessionId, filter.scope, JSON.stringify(filter), filterHash, value.identities, value.designs, value.matches, input.now, input.expiresAt]);
      return value;
    });
    return Object.freeze({ previewToken, filterHash, expiresAt: input.expiresAt, counts });
  }
  async inspectPreview(input: { previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }) {
    const result = rows(await this.client.sql.unsafe(`select filter_hash "filterHash",scope,expires_at "expiresAt",consumed_at "consumedAt" from deletion_previews where token_hash=$1 and admin_user_id=$2 and admin_session_id=$3`, [tokenDigest(input.previewToken), input.adminUserId, input.adminSessionId]));
    const row = result[0]; if (!row) return { status: "invalid" as const };
    if (row.filterHash !== input.filterHash) return { status: "changed" as const };
    if (row.consumedAt instanceof Date) return { status: "consumed" as const };
    if (!(row.expiresAt instanceof Date) || input.now >= row.expiresAt) return { status: "expired" as const };
    return { status: "ok" as const, scope: row.scope as DeletionFilter["scope"] };
  }
  async execute(input: { previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }): ReturnType<DeletionStore["execute"]> {
    return this.client.sql.begin("isolation level serializable", async (transaction) => {
      await transaction.unsafe("set local lock_timeout='5s'");
      await transaction.unsafe("set local statement_timeout='120s'");
      const result = rows(await transaction.unsafe(`select filter_hash "filterHash",scope,filters_json "filters",identity_count "identities",design_count "designs",match_count "matches",expires_at "expiresAt",consumed_at "consumedAt" from deletion_previews where token_hash=$1 and admin_user_id=$2 and admin_session_id=$3 for update`, [tokenDigest(input.previewToken), input.adminUserId, input.adminSessionId]));
      const row = result[0]; if (!row) return { status: "invalid" as const };
      if (row.filterHash !== input.filterHash) return { status: "changed" as const };
      if (row.consumedAt instanceof Date) return { status: "consumed" as const };
      if (!(row.expiresAt instanceof Date) || input.now >= row.expiresAt) return { status: "expired" as const };
      const filter = deletionFilterSchema.parse(row.filters), expected = Object.freeze({ identities: count(row.identities), designs: count(row.designs), matches: count(row.matches) }), actual = await postgresCounts(transaction, filter);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return { status: "stale" as const };
      const args = filterArguments(filter), auditId = randomUUID();
      const outcome = await withAuditedDeletion(transaction, { auditId, adminUserId: input.adminUserId, scope: filter.scope, filterHash: input.filterHash, previewCount: expected.identities + expected.designs + expected.matches, deletedIdentityCount: expected.identities, deletedDesignCount: expected.designs, deletedMatchCount: expected.matches }, async () => {
        const deletedMatches = rows(await transaction.unsafe(`delete from matches m where ${matchPredicate("m")} returning id`, args)).length;
        const deletedDesigns = rows(await transaction.unsafe(`delete from designs d where ${designPredicate("d")} and not exists(select 1 from matches om where om.player1_design_id=d.id or om.player2_design_id=d.id) returning id`, args)).length;
        await transaction.unsafe(`delete from room_participants rp where $1='all' or ($1='identity' and rp.identity_id=$2::uuid) or ($1='class' and exists(select 1 from identities i where i.id=rp.identity_id and i.class_name=$3)) or ($1='date_range' and (rp.joined_at at time zone 'Asia/Hong_Kong')::date between $4::date and $5::date)`, args);
        await transaction.unsafe(`delete from rooms r where ${roomPredicate("r")}`, args);
        await transaction.unsafe(`delete from device_activity_days a where $1='all' or ($1='identity' and a.identity_id=$2::uuid) or ($1='class' and a.class_name_snapshot=$3) or ($1='date_range' and a.activity_date between $4::date and $5::date)`, args);
        const deletedIdentities = rows(await transaction.unsafe(`delete from identities i where ${identityPredicate("i")} returning id`, args)).length;
        await transaction.unsafe("delete from analytics_daily_summaries");
        await transaction.unsafe("update deletion_previews set consumed_at=$2 where token_hash=$1", [tokenDigest(input.previewToken), input.now]);
        return { deletedIdentityCount: deletedIdentities, deletedDesignCount: deletedDesigns, deletedMatchCount: deletedMatches };
      });
      return { status: "ok" as const, auditId: outcome.auditId, counts: Object.freeze({ identities: outcome.counts.deletedIdentityCount, designs: outcome.counts.deletedDesignCount, matches: outcome.counts.deletedMatchCount }) };
    });
  }
}

const defaultResolver: AdminClientResolver = (request) => ({ clientKey: request.socket.remoteAddress ?? "unknown", ...(request.socket.remoteAddress ? { ip: request.socket.remoteAddress } : {}) });
const previewTtlMs = 5 * 60_000;

export function registerDeleteRecordRoutes(app: FastifyInstance, auth: AdminAuthService, store: DeletionStore, clientResolver: AdminClientResolver = defaultResolver): void {
  app.post("/api/admin/records/deletion-preview", async (request, reply) => {
    const current = await authenticateAdminMutation(request, reply, auth, clientResolver); if (!current) return;
    const parsed = deletionFilterSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "INVALID_FILTERS" });
    const now = new Date();
    try {
      const preview = await store.createPreview({ filter: parsed.data, adminUserId: current.user.id, adminSessionId: current.session.id, now, expiresAt: new Date(now.getTime() + previewTtlMs) });
      reply.header("Cache-Control", "no-store");
      return { previewToken: preview.previewToken, filterHash: preview.filterHash, expiresAt: preview.expiresAt.toISOString(), counts: preview.counts };
    } catch (error) { auth.report("admin.records.deletion_preview", error, request.id); return reply.code(503).send({ error: "DELETION_PREVIEW_UNAVAILABLE" }); }
  });
  app.delete("/api/admin/records", async (request, reply) => {
    const current = await authenticateAdminMutation(request, reply, auth, clientResolver); if (!current) return;
    const parsed = deleteBodySchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (parsed.data.confirmation !== "DELETE") return reply.code(403).send({ error: "CONFIRMATION_REQUIRED" });
    const rawSession = request.cookies[ADMIN_COOKIE_NAME]; if (!rawSession) return reply.code(401).send({ error: "UNAUTHORIZED" });
    const check = await store.inspectPreview({ previewToken: parsed.data.previewToken, filterHash: parsed.data.filterHash, adminUserId: current.user.id, adminSessionId: current.session.id, now: new Date() });
    if (check.status !== "ok") return reply.code(409).send({ error: `DELETION_PREVIEW_${check.status.toUpperCase()}` });
    const csrf = request.headers["x-csrf-token"] as string;
    const diagnostic = clientResolver(request.raw);
    const purpose = parsed.data.filterHash;
    let grant: string | null;
    try { grant = await auth.reauthenticate(rawSession, csrf, parsed.data.password, purpose, { ...diagnostic, ...(typeof request.headers["user-agent"] === "string" ? { userAgent: request.headers["user-agent"].slice(0, 512) } : {}) }); }
    catch (error) { auth.report("admin.records.reauthenticate", error, request.id); return reply.code(503).send({ error: "REAUTHENTICATION_UNAVAILABLE" }); }
    if (!grant || !await auth.consumeReauthGrant(rawSession, grant, purpose)) return reply.code(403).send({ error: "REAUTHENTICATION_FAILED" });
    try {
      const result = await store.execute({ previewToken: parsed.data.previewToken, filterHash: parsed.data.filterHash, adminUserId: current.user.id, adminSessionId: current.session.id, now: new Date() });
      if (result.status !== "ok") return reply.code(409).send({ error: `DELETION_PREVIEW_${result.status.toUpperCase()}` });
      reply.header("Cache-Control", "no-store");
      return { auditId: result.auditId, counts: result.counts };
    } catch (error) { auth.report("admin.records.delete", error, request.id); return reply.code(503).send({ error: "DELETION_FAILED" }); }
  });
}
