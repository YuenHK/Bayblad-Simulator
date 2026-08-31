import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseClient } from "@steam-top/db";
import { withAuditedDeletion } from "@steam-top/db";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { authenticateAdminMutation, type AdminAuthService, type AdminClientResolver } from "../auth/admin-auth";
import type { DeletionLedger } from "./deletion-ledger";

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
  confirmed: z.literal(true),
}).strict();

/** Random operation digest: deliberately reveals nothing about low-entropy class/date filters. */
export function deletionFilterHash(filter: DeletionFilter): string { deletionFilterSchema.parse(filter); return randomBytes(32).toString("hex"); }

export interface DeletionStore {
  createPreview(input: Readonly<{ filter: DeletionFilter; adminUserId: string; adminSessionId: string; now: Date; expiresAt: Date }>): Promise<DeletionPreview>;
  inspectPreview(input: Readonly<{ previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }>): Promise<Readonly<{ status: "ok"; scope: DeletionFilter["scope"] }> | Readonly<{ status: "recovered"; auditId: string; counts: DeletionCounts }> | Readonly<{ status: "invalid" | "expired" | "changed" }>>;
  execute(input: Readonly<{ previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }>): Promise<Readonly<{ status: "ok"; auditId: string; counts: DeletionCounts; recovered?: boolean }> | Readonly<{ status: "invalid" | "expired" | "changed" | "stale" }>>;
}

type MemoryRecord = Readonly<{ identityId: string; className: string; occurredAt: Date; designs: number; matches: number }>;
type MemoryPreview = Readonly<{ tokenHash: string; filter?: DeletionFilter; filterHash: string; adminUserId: string; adminSessionId: string; expiresAt: Date; counts: DeletionCounts; outcome?: Readonly<{ auditId: string; counts: DeletionCounts }> }>;

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
  #counts(filter: DeletionFilter): DeletionCounts { const selected = this.#selected(filter); return Object.freeze({ identities: filter.scope==="date_range"?0:selected.length, designs: selected.reduce((sum, row) => sum + row.designs, 0), matches: selected.reduce((sum, row) => sum + row.matches, 0) }); }
  async createPreview(input: { filter: DeletionFilter; adminUserId: string; adminSessionId: string; now: Date; expiresAt: Date }): Promise<DeletionPreview> {
    const previewToken = randomBytes(32).toString("base64url"), tokenHash = createHash("sha256").update(previewToken).digest("hex"), filter = deletionFilterSchema.parse(input.filter), filterHash = deletionFilterHash(filter), counts = this.#counts(filter);
    this.#previews.set(tokenHash, { tokenHash, filter, filterHash, adminUserId: input.adminUserId, adminSessionId: input.adminSessionId, expiresAt: input.expiresAt, counts });
    return Object.freeze({ previewToken, filterHash, expiresAt: input.expiresAt, counts });
  }
  async inspectPreview(input: { previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }) {
    const row = this.#previews.get(createHash("sha256").update(input.previewToken).digest("hex"));
    if (!row || row.adminUserId !== input.adminUserId || row.adminSessionId !== input.adminSessionId) return { status: "invalid" as const };
    if (row.filterHash !== input.filterHash) return { status: "changed" as const };
    if (row.outcome) return { status: "recovered" as const, ...row.outcome };
    if (input.now >= row.expiresAt) return { status: "expired" as const };
    return { status: "ok" as const, scope: row.filter!.scope };
  }
  async execute(input: { previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }): ReturnType<DeletionStore["execute"]> {
    const key = createHash("sha256").update(input.previewToken).digest("hex"), row = this.#previews.get(key), inspected = await this.inspectPreview(input);
    if (inspected.status === "recovered") return { status: "ok", auditId: inspected.auditId, counts: inspected.counts, recovered: true };
    if (inspected.status !== "ok" || !row?.filter) return { status: inspected.status === "ok" ? "invalid" : inspected.status };
    const actual = this.#counts(row.filter);
    if (JSON.stringify(actual) !== JSON.stringify(row.counts)) return { status: "stale" as const };
    const selected = new Set(this.#selected(row.filter).map((record) => record.identityId));
    const auditId = randomUUID();
    const audit = Object.freeze({ auditId, adminUserId: input.adminUserId, scope: row.filter.scope, filterHash: row.filterHash, previewCount: actual.identities + actual.designs + actual.matches, deletedIdentityCount: actual.identities, deletedDesignCount: actual.designs, deletedMatchCount: actual.matches });
    this.#records = row.filter.scope==="date_range"?this.#records.map(record=>selected.has(record.identityId)?{...record,designs:0,matches:0}:record):this.#records.filter((record) => !selected.has(record.identityId));
    this.#previews.set(key, { tokenHash: row.tokenHash, filterHash: row.filterHash, adminUserId: row.adminUserId, adminSessionId: row.adminSessionId, expiresAt: row.expiresAt, counts: row.counts, outcome: { auditId, counts: actual } });
    this.audits.push(audit);
    return { status: "ok" as const, auditId, counts: actual };
  }
}

type DbRow = Readonly<Record<string, unknown>>;
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");
const rows = (value: unknown) => value as readonly DbRow[];
const count = (value: unknown) => { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("INVALID_DELETION_COUNT"); return parsed; };
const matchOccurredAt=(alias:string)=>`case when ${alias}.status='completed' then ${alias}.completed_at else coalesce(${alias}.started_at,${alias}.created_at) end`;

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
  or ($1 = 'date_range' and (${matchOccurredAt(alias)} at time zone 'Asia/Hong_Kong')::date between $4::date and $5::date)
)`;
const designPredicate = (alias: string) => `(
  $1 = 'all'
  or ($1 = 'identity' and (${alias}.owner_identity_id = $2::uuid or exists (select 1 from design_event_snapshots ds where ds.design_id = ${alias}.id and (ds.owner_identity_id_at_creation = $2::uuid or ds.canonical_identity_id_at_creation = $2::uuid))))
  or ($1 = 'class' and (exists (select 1 from design_event_snapshots ds where ds.design_id = ${alias}.id and ds.class_name_snapshot = $3) or exists(select 1 from identities oi where oi.id=${alias}.owner_identity_id and oi.class_name=$3)))
  or ($1 = 'date_range' and (${alias}.created_at at time zone 'Asia/Hong_Kong')::date between $4::date and $5::date)
)`;
const identityPredicate = (alias: string) => `(
  $1 = 'all' or ($1 = 'identity' and ${alias}.id = $2::uuid) or ($1 = 'class' and ${alias}.class_name = $3)
)`;
const roomPredicate = (alias: string) => `(
  $1 = 'all' or ($1 = 'identity' and (${alias}.owner_identity_id = $2::uuid or exists(select 1 from room_event_snapshots rs where rs.room_id=${alias}.id and (rs.owner_identity_id_at_creation=$2::uuid or rs.canonical_identity_id_at_creation=$2::uuid))))
  or ($1 = 'class' and (exists(select 1 from room_event_snapshots rs where rs.room_id=${alias}.id and rs.class_name_snapshot=$3) or exists(select 1 from identities oi where oi.id=${alias}.owner_identity_id and oi.class_name=$3)))
  or ($1 = 'date_range' and (${alias}.created_at at time zone 'Asia/Hong_Kong')::date between $4::date and $5::date)
)`;

async function materializeCurrentTargets(transaction: Pick<TransactionSql, "unsafe">, filter: DeletionFilter): Promise<DeletionCounts> {
  const args = filterArguments(filter);
  await transaction.unsafe(`create temporary table deletion_current_identities on commit drop as
    select i.id from identities i where ${identityPredicate("i")}
    or ($1='class' and i.id in (
      select identity_id_at_start from match_participant_snapshots where class_name_snapshot=$3 and identity_id_at_start is not null
      union select canonical_identity_id_at_start from match_participant_snapshots where class_name_snapshot=$3 and canonical_identity_id_at_start is not null
      union select owner_identity_id_at_creation from design_event_snapshots where class_name_snapshot=$3 and owner_identity_id_at_creation is not null
      union select canonical_identity_id_at_creation from design_event_snapshots where class_name_snapshot=$3 and canonical_identity_id_at_creation is not null
    ))`, args);
  await transaction.unsafe("create unique index on deletion_current_identities(id)");
  await transaction.unsafe(`create temporary table deletion_design_candidates on commit drop as select d.id from designs d where ${designPredicate("d")} or d.owner_identity_id in(select id from deletion_current_identities)`, args);
  await transaction.unsafe("create unique index on deletion_design_candidates(id)");
  await transaction.unsafe(`create temporary table deletion_current_matches on commit drop as select m.id from matches m where ${matchPredicate("m")}
    or m.player1_identity_id in(select id from deletion_current_identities) or m.player2_identity_id in(select id from deletion_current_identities)
    or ($1<>'date_range' and (m.player1_design_id in(select id from deletion_design_candidates) or m.player2_design_id in(select id from deletion_design_candidates)))
    or exists(select 1 from match_participant_snapshots ps where ps.match_id=m.id and (ps.identity_id_at_start in(select id from deletion_current_identities) or ps.canonical_identity_id_at_start in(select id from deletion_current_identities)))`, args);
  await transaction.unsafe("create unique index on deletion_current_matches(id)");
  await transaction.unsafe(`create temporary table deletion_current_designs on commit drop as select d.id from designs d join deletion_design_candidates c on c.id=d.id
    where not exists(select 1 from matches m where (m.player1_design_id=d.id or m.player2_design_id=d.id) and m.id not in(select id from deletion_current_matches))`);
  await transaction.unsafe("create unique index on deletion_current_designs(id)");
  const result = rows(await transaction.unsafe(`select (select count(*)::integer from deletion_current_identities) identities,(select count(*)::integer from deletion_current_designs) designs,(select count(*)::integer from deletion_current_matches) matches`));
  const row = result[0]; if (!row) throw new Error("DELETION_COUNT_FAILED");
  return Object.freeze({ identities: count(row.identities), designs: count(row.designs), matches: count(row.matches) });
}

function recoverCounts(row: DbRow): DeletionCounts { return Object.freeze({ identities: count(row.resultIdentities), designs: count(row.resultDesigns), matches: count(row.resultMatches) }); }
const retryableTransaction = (error: unknown) => error !== null && typeof error === "object" && ["40001", "40P01"].includes(String((error as { code?: unknown }).code));

/** PostgreSQL is the authority for previews, one-time consumption and audited all-or-nothing deletion. */
export class PostgresDeletionStore implements DeletionStore {
  constructor(private readonly client: DatabaseClient, private readonly maxActivePreviews = 1_000, private readonly ledger?: DeletionLedger, private readonly sourceInstanceId=process.env.DELETION_SOURCE_INSTANCE_ID) { if (!Number.isSafeInteger(maxActivePreviews) || maxActivePreviews < 1) throw new TypeError("INVALID_PREVIEW_CAP");if(ledger&&!sourceInstanceId)throw new TypeError("DELETION_SOURCE_INSTANCE_ID_REQUIRED"); }
  async createPreview(input: { filter: DeletionFilter; adminUserId: string; adminSessionId: string; now: Date; expiresAt: Date }): Promise<DeletionPreview> {
    const filter = deletionFilterSchema.parse(input.filter), previewToken = randomBytes(32).toString("base64url"), filterHash = deletionFilterHash(filter);
    const hash = tokenDigest(previewToken);
    const counts = await this.client.sql.begin("read write", async (transaction) => {
      await transaction.unsafe("select pg_advisory_xact_lock(hashtext('steam_top_deletion_preview_cap'))");
      await transaction.unsafe(`delete from deletion_previews where token_hash in(select token_hash from deletion_previews where expires_at<=$1 order by expires_at limit 500)`, [input.now]);
      const active = rows(await transaction.unsafe("select count(*)::integer count from deletion_previews where consumed_at is null and expires_at>$1", [input.now]))[0];
      if (count(active?.count) >= this.maxActivePreviews) throw new Error("DELETION_PREVIEW_CAPACITY");
      await transaction.unsafe(`insert into deletion_previews (token_hash,admin_user_id,admin_session_id,scope,filters_json,filter_hash,identity_count,design_count,match_count,created_at,expires_at)
        values ($1,$2,$3,$4,$5::jsonb,$6,0,0,0,$7,$8)`, [hash, input.adminUserId, input.adminSessionId, filter.scope, JSON.stringify(filter), filterHash, input.now, input.expiresAt]);
      const value = await materializeCurrentTargets(transaction, filter);
      await transaction.unsafe("insert into deletion_preview_identities(token_hash,identity_id) select $1,id from deletion_current_identities", [hash]);
      await transaction.unsafe("insert into deletion_preview_designs(token_hash,design_id) select $1,id from deletion_current_designs", [hash]);
      await transaction.unsafe("insert into deletion_preview_matches(token_hash,match_id) select $1,id from deletion_current_matches", [hash]);
      await transaction.unsafe("update deletion_previews set identity_count=$2,design_count=$3,match_count=$4 where token_hash=$1", [hash, value.identities, value.designs, value.matches]);
      return value;
    });
    return Object.freeze({ previewToken, filterHash, expiresAt: input.expiresAt, counts });
  }
  async inspectPreview(input: { previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }) {
    const result = rows(await this.client.sql.unsafe(`select filter_hash "filterHash",scope,expires_at "expiresAt",consumed_at "consumedAt",result_audit_id "resultAuditId",result_identity_count "resultIdentities",result_design_count "resultDesigns",result_match_count "resultMatches" from deletion_previews where token_hash=$1 and admin_user_id=$2 and admin_session_id=$3`, [tokenDigest(input.previewToken), input.adminUserId, input.adminSessionId]));
    const row = result[0]; if (!row) return { status: "invalid" as const };
    if (row.filterHash !== input.filterHash) return { status: "changed" as const };
    if (row.consumedAt instanceof Date && typeof row.resultAuditId === "string") { if(this.ledger)await (this.ledger.recoverCommitted?.({auditId:row.resultAuditId,operationDigest:input.filterHash})??this.ledger.recordCommitted({auditId:row.resultAuditId,operationDigest:input.filterHash})); return { status: "recovered" as const, auditId: row.resultAuditId, counts: recoverCounts(row) }; }
    if (!(row.expiresAt instanceof Date) || input.now >= row.expiresAt) return { status: "expired" as const };
    return { status: "ok" as const, scope: row.scope as DeletionFilter["scope"] };
  }
  async execute(input: { previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }): ReturnType<DeletionStore["execute"]> {
    const auditId = randomUUID();
    if(this.ledger){await this.client.sql.unsafe("insert into deletion_operations(audit_id,source_instance_id,operation_digest,status) values($1,$2,$3,'pending')",[auditId,this.sourceInstanceId!,input.filterHash]);try{await this.ledger.recordPending({auditId,operationDigest:input.filterHash});}catch(error){await this.#abortOperation(auditId,input.filterHash,false);throw error;}}
    for (let attempt = 0; attempt < 3; attempt++) try { const result=await this.executeOnce(input, auditId); if(this.ledger){if(result.status==="ok"&&!result.recovered)await this.#publishTerminal(auditId,input.filterHash,"C");else if(result.status!=="ok"){await this.#abortOperation(auditId,input.filterHash,true);await this.#publishTerminal(auditId,input.filterHash,"A");}} return result; } catch (error) { if (retryableTransaction(error) && attempt < 2) continue; await this.#resolveFailedLedger(auditId,input.filterHash,error); throw error; }
    throw new Error("UNREACHABLE_DELETION_RETRY");
  }
  async #abortOperation(auditId:string,operationDigest:string,withOutbox:boolean){await this.client.sql.begin("isolation level serializable",async transaction=>{const changed=rows(await transaction.unsafe("update deletion_operations set status='aborted',updated_at=now(),terminal_at=now() where audit_id=$1 and operation_digest=$2 and status='pending' returning 1",[auditId,operationDigest])).length>0;if(changed&&withOutbox)await transaction.unsafe("insert into deletion_ledger_outbox(audit_id,operation_digest,terminal) values($1,$2,'A') on conflict(audit_id,terminal) do nothing",[auditId,operationDigest]);});}
  async #publishTerminal(auditId:string,operationDigest:string,terminal:"C"|"A"){if(!this.ledger)return;const input={auditId,operationDigest};if(terminal==="C")await(this.ledger.recoverCommitted?.(input)??this.ledger.recordCommitted(input));else await(this.ledger.recoverAborted?.(input)??this.ledger.recordAborted(input));await this.client.sql.unsafe("update deletion_ledger_outbox set completed_at=coalesce(completed_at,now()) where audit_id=$1 and operation_digest=$2 and terminal=$3",[auditId,operationDigest,terminal]);}
  async #resolveFailedLedger(auditId:string,operationDigest:string,error:unknown){if(!this.ledger)return;try{const operation=rows(await this.client.sql.unsafe("select status from deletion_operations where audit_id=$1 and operation_digest=$2",[auditId,operationDigest]))[0];if(operation?.status==="committed"){await this.#publishTerminal(auditId,operationDigest,"C");return;}if(operation?.status==="aborted"){await this.#publishTerminal(auditId,operationDigest,"A");return;}const code=String((error as {code?:unknown})?.code??"");if(retryableTransaction(error)||/^(?:22|23|40|55)[0-9A-Z]{3}$/u.test(code)){await this.#abortOperation(auditId,operationDigest,true);await this.#publishTerminal(auditId,operationDigest,"A");}/* connection/commit uncertainty deliberately leaves P */}catch{/* unresolved P/outbox is the fail-closed recovery state */}}
  private executeOnce(input: { previewToken: string; filterHash: string; adminUserId: string; adminSessionId: string; now: Date }, auditId: string): ReturnType<DeletionStore["execute"]> {
    return this.client.sql.begin("isolation level serializable", async (transaction) => {
      await transaction.unsafe("set local lock_timeout='5s'");
      await transaction.unsafe("set local statement_timeout='120s'");
      if(this.ledger){const operation=rows(await transaction.unsafe("select status,operation_digest from deletion_operations where audit_id=$1 for update",[auditId]))[0];if(!operation||operation.operation_digest!==input.filterHash||operation.status!=="pending")return{status:"invalid" as const};}
      const hash = tokenDigest(input.previewToken);
      const result = rows(await transaction.unsafe(`select filter_hash "filterHash",scope,filters_json "filters",identity_count identities,design_count designs,match_count matches,expires_at "expiresAt",consumed_at "consumedAt",result_audit_id "resultAuditId",result_identity_count "resultIdentities",result_design_count "resultDesigns",result_match_count "resultMatches" from deletion_previews where token_hash=$1 and admin_user_id=$2 and admin_session_id=$3 for update`, [hash, input.adminUserId, input.adminSessionId]));
      const row = result[0]; if (!row) return { status: "invalid" as const };
      if (row.filterHash !== input.filterHash) return { status: "changed" as const };
      if (row.consumedAt instanceof Date && typeof row.resultAuditId === "string") return { status: "ok" as const, auditId: row.resultAuditId, counts: recoverCounts(row), recovered: true };
      if (!(row.expiresAt instanceof Date) || input.now >= row.expiresAt) return { status: "expired" as const };
      const filter = deletionFilterSchema.parse(row.filters), expected = Object.freeze({ identities: count(row.identities), designs: count(row.designs), matches: count(row.matches) }), actual = await materializeCurrentTargets(transaction, filter);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return { status: "stale" as const };
      const mismatch = rows(await transaction.unsafe(`select exists(
        (select identity_id from deletion_preview_identities where token_hash=$1 except select id from deletion_current_identities) union all (select id from deletion_current_identities except select identity_id from deletion_preview_identities where token_hash=$1)
        union all (select design_id from deletion_preview_designs where token_hash=$1 except select id from deletion_current_designs) union all (select id from deletion_current_designs except select design_id from deletion_preview_designs where token_hash=$1)
        union all (select match_id from deletion_preview_matches where token_hash=$1 except select id from deletion_current_matches) union all (select id from deletion_current_matches except select match_id from deletion_preview_matches where token_hash=$1)) mismatch`, [hash]))[0]?.mismatch;
      if (mismatch !== false) return { status: "stale" as const };
      const args = filterArguments(filter);
      const outcome = await withAuditedDeletion(transaction, { auditId, adminUserId: input.adminUserId, scope: filter.scope, filterHash: input.filterHash, previewCount: expected.identities + expected.designs + expected.matches, deletedIdentityCount: expected.identities, deletedDesignCount: expected.designs, deletedMatchCount: expected.matches }, async () => {
        const deletedMatches = count(rows(await transaction.unsafe(`with deleted as(delete from matches m using deletion_preview_matches p where p.token_hash=$1 and m.id=p.match_id returning m.id) select count(*)::integer count from deleted`, [hash]))[0]?.count);
        const deletedDesigns = count(rows(await transaction.unsafe(`with deleted as(delete from designs d using deletion_preview_designs p where p.token_hash=$1 and d.id=p.design_id returning d.id) select count(*)::integer count from deleted`, [hash]))[0]?.count);
        await transaction.unsafe(`delete from webclip_token_nonces n where n.result_identity_id in(select identity_id from deletion_preview_identities where token_hash=$1) or n.result_session_id in(select s.id from identity_sessions s join deletion_preview_identities p on p.identity_id=s.identity_id where p.token_hash=$1) or n.device_id in(select i.external_device_id from identities i join deletion_preview_identities p on p.identity_id=i.id where p.token_hash=$1 and i.external_device_id is not null)`, [hash]);
        await transaction.unsafe(`delete from identity_sessions s using deletion_preview_identities p where p.token_hash=$1 and s.identity_id=p.identity_id`, [hash]);
        await transaction.unsafe(`delete from room_participants rp where rp.identity_id in(select identity_id from deletion_preview_identities where token_hash=$1) or $2='all' or ($2='class' and exists(select 1 from identities i where i.id=rp.identity_id and i.class_name=$4)) or ($2='date_range' and (rp.joined_at at time zone 'Asia/Hong_Kong')::date between $5::date and $6::date)`, [hash, ...args]);
        await transaction.unsafe(`delete from rooms r where ${roomPredicate("r")}`, args);
        await transaction.unsafe(`delete from device_activity_days a where a.identity_id in(select identity_id from deletion_preview_identities where token_hash=$1) or $2='all' or ($2='class' and a.class_name_snapshot=$4) or ($2='date_range' and a.activity_date between $5::date and $6::date)`, [hash, ...args]);
        const deletedIdentities = count(rows(await transaction.unsafe(`with deleted as(delete from identities i using deletion_preview_identities p where p.token_hash=$1 and i.id=p.identity_id returning i.id) select count(*)::integer count from deleted`, [hash]))[0]?.count);
        await transaction.unsafe("delete from analytics_daily_summaries");
        await transaction.unsafe("delete from deletion_preview_identities where token_hash=$1", [hash]);
        await transaction.unsafe("delete from deletion_preview_designs where token_hash=$1", [hash]);
        await transaction.unsafe("delete from deletion_preview_matches where token_hash=$1", [hash]);
        await transaction.unsafe(`update deletion_previews set consumed_at=$2,filters_json='{}'::jsonb,result_audit_id=$3,result_identity_count=$4,result_design_count=$5,result_match_count=$6 where token_hash=$1`, [hash, input.now, auditId, deletedIdentities, deletedDesigns, deletedMatches]);
        return { deletedIdentityCount: deletedIdentities, deletedDesignCount: deletedDesigns, deletedMatchCount: deletedMatches };
      });
      if(this.ledger){await transaction.unsafe("update deletion_operations set status='committed',updated_at=now(),terminal_at=now() where audit_id=$1 and operation_digest=$2 and status='pending'",[auditId,input.filterHash]);await transaction.unsafe("insert into deletion_ledger_outbox(audit_id,operation_digest,terminal) values($1,$2,'C') on conflict(audit_id,terminal) do nothing",[auditId,input.filterHash]);}
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
    const check = await store.inspectPreview({ previewToken: parsed.data.previewToken, filterHash: parsed.data.filterHash, adminUserId: current.user.id, adminSessionId: current.session.id, now: new Date() });
    if (check.status === "recovered") { reply.header("Cache-Control", "no-store"); return { auditId: check.auditId, counts: check.counts, recovered: true }; }
    if (check.status !== "ok") return reply.code(409).send({ error: `DELETION_PREVIEW_${check.status.toUpperCase()}` });
    try {
      const result = await store.execute({ previewToken: parsed.data.previewToken, filterHash: parsed.data.filterHash, adminUserId: current.user.id, adminSessionId: current.session.id, now: new Date() });
      if (result.status !== "ok") return reply.code(409).send({ error: `DELETION_PREVIEW_${result.status.toUpperCase()}` });
      reply.header("Cache-Control", "no-store");
      return { auditId: result.auditId, counts: result.counts };
    } catch (error) { auth.report("admin.records.delete", error, request.id); return reply.code(503).send({ error: "DELETION_FAILED" }); }
  });
}
