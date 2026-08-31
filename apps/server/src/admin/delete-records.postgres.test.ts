import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "@steam-top/db";
import { PostgresDeletionStore } from "./delete-records";
import { PostgresExportDataSource } from "../exports/postgres-source";
import { buildWorkbookBuffer } from "../exports/workbook";
import { usageAnalytics } from "../analytics/usage";
import ExcelJS from "exceljs";
import { postgresTestSchemaUrl } from "../postgres-test-url";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schemaName = `deletion_${randomUUID().replaceAll("-", "")}`;
let client: DatabaseClient;
const adminId = "a0000000-0000-4000-8000-000000000001", sessionId = "a0000000-0000-4000-8000-000000000002";

beforeAll(async () => {
  if (!databaseUrl) return;
  const local = /(?:localhost|127\.0\.0\.1)/u.test(databaseUrl);
  client = createDatabaseClient({ url: postgresTestSchemaUrl(databaseUrl, schemaName), ssl: local ? false : "require", allowInsecure: local, maxConnections: 10 });
  await client.sql.unsafe(`create schema ${schemaName}`);
  await client.sql.unsafe(`set search_path to ${schemaName},public`);
  const directory = fileURLToPath(new URL("../../../../drizzle", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) for (const statement of readFileSync(`${directory}/${file}`, "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) if(!statement.includes('"restore_control"'))await client.sql.unsafe(statement);
  await client.sql.unsafe("insert into admin_users(id,username,password_hash) values($1,'delete-admin','hash')", [adminId]);
  await client.sql.unsafe("insert into admin_sessions(id,admin_user_id,token_hash,csrf_token_hash,expires_at) values($1,$2,$3,$4,now()+interval '1 hour')", [sessionId, adminId, "a".repeat(64), "b".repeat(64)]);
}, 30_000);

afterAll(async () => { if (!client) return; await client.sql.unsafe("set search_path to public"); await client.sql.unsafe(`drop schema ${schemaName} cascade`); await client.close(); });

async function recordFixture(suffix: string) {
  const identity1 = `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`, identity2 = `20000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const design1 = `30000000-0000-4000-8000-${suffix.padStart(12, "0")}`, design2 = `40000000-0000-4000-8000-${suffix.padStart(12, "0")}`, match = `50000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  await client.sql.unsafe("insert into identities(id,status,display_name,class_name) values($1,'iclass','Student A','1A'),($2,'iclass','Student B','1B')", [identity1, identity2]);
  const insertDesign = `insert into designs(id,logical_design_id,owner_identity_id,version,schema_version,name,screw_count,screw_radius_mm,screw_rotation_deg,metal_disc_diameter_mm,total_mass_g,polar_moment_gmm2,center_of_mass_x_mm,center_of_mass_y_mm,performance_speed,performance_spin_duration,performance_stability,performance_impact_resistance,performance_model_version,battle_eligible,validation_issues) values($1,$1,$2,1,'1','fixture',4,12,0,0,40,12000,0,0,60,65,70,55,'1.0.0',false,'[]')`;
  await client.sql.unsafe(insertDesign, [design1, identity1]); await client.sql.unsafe(insertDesign, [design2, identity2]);
  await client.sql.unsafe(`insert into matches(id,idempotency_fingerprint,status,player1_identity_id,player2_identity_id,player1_design_id,player2_design_id,performance_model_version,physics_model_version,protocol_version) values($1,$2,'in_progress',$3,$4,$5,$6,'1.0.0','2.0.0',1)`, [match, suffix.padStart(64, "0"), identity1, identity2, design1, design2]);
  return { identity1, identity2, design1, design2, match };
}

async function completeFixture(ids: Awaited<ReturnType<typeof recordFixture>>) {
  const at = new Date("2026-08-15T04:00:00Z");
  await client.sql.unsafe(`update matches set status='completed',player1_battle_points=2,player2_battle_points=0,player1_challenge_points=0,player2_challenge_points=0.5,player1_total=2,player2_total=0.5,winner='player1',round_winners='["player1","player1"]',created_at=$2-interval '1 day',started_at=$2-interval '1 day',completed_at=$2 where id=$1`, [ids.match, at]);
  await client.sql.unsafe("update designs set created_at=$2 where id in($1,$3)",[ids.design1,at,ids.design2]);
  await client.sql.unsafe(`insert into match_participant_snapshots(match_id,slot,identity_id_at_start,canonical_identity_id_at_start,identity_status_snapshot,class_name_snapshot,design_id,captured_at) values($1,'player1',$2,$2,'iclass','1A',$3,$6),($1,'player2',$4,$4,'iclass','1B',$5,$6)`, [ids.match, ids.identity1, ids.design1, ids.identity2, ids.design2, at]);
}

it.skipIf(!databaseUrl)("serializes concurrent execution, keeps one immutable content-free audit, and hides deleted rows", async () => {
  const ids = await recordFixture("1"), storeA = new PostgresDeletionStore(client), storeB = new PostgresDeletionStore(client), now = new Date();
  const identitySession = "70000000-0000-4000-8000-000000000001";
  await client.sql.unsafe("insert into identity_sessions(id,identity_id,token_hash,expires_at) values($1,$2,$3,now()+interval '1 hour')", [identitySession, ids.identity1, "7".repeat(64)]);
  await client.sql.unsafe("insert into webclip_token_nonces(jti_hash,device_id,issued_at,expires_at,used_at,attempt_hash,result_identity_id,result_session_id,result_token_hash,committed_at) values($1,'device-delete',now(),now()+interval '1 hour',now(),$2,$3,$4,$5,now())", ["8".repeat(64), "9".repeat(64), ids.identity1, identitySession, "a".repeat(64)]);
  const preview = await storeA.createPreview({ filter: { scope: "identity", identityId: ids.identity1 }, adminUserId: adminId, adminSessionId: sessionId, now, expiresAt: new Date(now.getTime() + 300_000) });
  expect(preview.counts).toEqual({ identities: 1, designs: 1, matches: 1 });
  const results = await Promise.all([storeA.execute({ previewToken: preview.previewToken, filterHash: preview.filterHash, adminUserId: adminId, adminSessionId: sessionId, now }), storeB.execute({ previewToken: preview.previewToken, filterHash: preview.filterHash, adminUserId: adminId, adminSessionId: sessionId, now })]);
  expect(results.every((result) => result.status === "ok")).toBe(true);
  expect((await client.sql.unsafe("select id from deletion_audit where filter_hash=$1", [preview.filterHash]))).toHaveLength(1);
  expect((await client.sql.unsafe("select id from identities where id=$1", [ids.identity1]))).toHaveLength(0);
  expect((await client.sql.unsafe("select id from matches where id=$1", [ids.match]))).toHaveLength(0);
  expect((await client.sql.unsafe("select id from designs where id=$1", [ids.design2]))).toHaveLength(1);
  expect((await client.sql.unsafe("select jti_hash from webclip_token_nonces where result_identity_id=$1", [ids.identity1]))).toHaveLength(0);
  expect(JSON.stringify(await client.sql.unsafe("select * from deletion_audit where filter_hash=$1", [preview.filterHash]))).not.toContain("Student A");
  const scrubbed=(await client.sql.unsafe("select filters_json from deletion_previews where filter_hash=$1",[preview.filterHash]))[0];expect(scrubbed?.filters_json).toEqual({});
  expect((await client.sql.unsafe("select identity_id from deletion_preview_identities where token_hash=(select token_hash from deletion_previews where filter_hash=$1)",[preview.filterHash]))).toHaveLength(0);
}, 30_000);

it.skipIf(!databaseUrl)("rejects a stale preview without consuming it or deleting anything", async () => {
  const ids = await recordFixture("2"), store = new PostgresDeletionStore(client), now = new Date();
  const preview = await store.createPreview({ filter: { scope: "identity", identityId: ids.identity1 }, adminUserId: adminId, adminSessionId: sessionId, now, expiresAt: new Date(now.getTime() + 300_000) });
  const extra = `60000000-0000-4000-8000-${"2".padStart(12, "0")}`;
  await client.sql.unsafe(`insert into designs(id,logical_design_id,owner_identity_id,version,schema_version,name,screw_count,screw_radius_mm,screw_rotation_deg,metal_disc_diameter_mm,total_mass_g,polar_moment_gmm2,center_of_mass_x_mm,center_of_mass_y_mm,performance_speed,performance_spin_duration,performance_stability,performance_impact_resistance,performance_model_version,battle_eligible,validation_issues) values($1,$1,$2,1,'1','extra',4,12,0,0,40,12000,0,0,60,65,70,55,'1.0.0',false,'[]')`, [extra, ids.identity1]);
  expect(await store.execute({ previewToken: preview.previewToken, filterHash: preview.filterHash, adminUserId: adminId, adminSessionId: sessionId, now })).toEqual({ status: "stale" });
  expect((await client.sql.unsafe("select id from identities where id=$1", [ids.identity1]))).toHaveLength(1);
  expect((await client.sql.unsafe("select consumed_at from deletion_previews where filter_hash=$1", [preview.filterHash]))[0]?.consumed_at).toBeNull();
});

it.skipIf(!databaseUrl)("rejects a same-count member swap against the materialized preview set", async () => {
  const ids = await recordFixture("4"), store = new PostgresDeletionStore(client), now = new Date();
  const preview = await store.createPreview({ filter: { scope: "class", className: "1A" }, adminUserId: adminId, adminSessionId: sessionId, now, expiresAt: new Date(now.getTime() + 300_000) });
  await client.sql.unsafe("update identities set class_name=case id when $1 then '1B' else '1A' end where id in($1,$2)", [ids.identity1, ids.identity2]);
  expect(await store.execute({ previewToken: preview.previewToken, filterHash: preview.filterHash, adminUserId: adminId, adminSessionId: sessionId, now })).toEqual({ status: "stale" });
  expect((await client.sql.unsafe("select id from matches where id=$1", [ids.match]))).toHaveLength(1);
});

it.skipIf(!databaseUrl)("atomically enforces the active preview cap across workers",async()=>{await client.sql.unsafe("delete from deletion_previews");const now=new Date(),stores=Array.from({length:5},()=>new PostgresDeletionStore(client,3));const results=await Promise.allSettled(stores.map(store=>store.createPreview({filter:{scope:"identity",identityId:randomUUID()},adminUserId:adminId,adminSessionId:sessionId,now,expiresAt:new Date(now.getTime()+300_000)})));expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(3);expect(results.filter(result=>result.status==="rejected")).toHaveLength(2);await client.sql.unsafe("delete from deletion_previews");});

it.skipIf(!databaseUrl)("commits the database operation and terminal outbox before publishing C",async()=>{const ids=await recordFixture("9"),events:string[]=[],sourceInstanceId="90000000-0000-4000-8000-000000000009",ledger={recordPending:async()=>{events.push("P");},recordCommitted:async()=>{events.push("C");},recordAborted:async()=>{events.push("A");}};const store=new PostgresDeletionStore(client,10,ledger,sourceInstanceId),now=new Date(),preview=await store.createPreview({filter:{scope:"identity",identityId:ids.identity1},adminUserId:adminId,adminSessionId:sessionId,now,expiresAt:new Date(now.getTime()+300_000)}),result=await store.execute({previewToken:preview.previewToken,filterHash:preview.filterHash,adminUserId:adminId,adminSessionId:sessionId,now});expect(result.status).toBe("ok");expect(events).toEqual(["P","C"]);const operation=(await client.sql.unsafe("select status,source_instance_id,terminal_at from deletion_operations where audit_id=$1",[(result as {auditId:string}).auditId]))[0],outbox=(await client.sql.unsafe("select terminal,completed_at from deletion_ledger_outbox where audit_id=$1",[(result as {auditId:string}).auditId]))[0];expect(operation?.status).toBe("committed");expect(operation?.source_instance_id).toBe(sourceInstanceId);expect(operation?.terminal_at).toBeInstanceOf(Date);expect(outbox?.terminal).toBe("C");expect(outbox?.completed_at).toBeInstanceOf(Date);},30_000);

it.skipIf(!databaseUrl)("rolls back audit, preview consumption and records when any delete fails", async () => {
  const ids = await recordFixture("3"), store = new PostgresDeletionStore(client), now = new Date();
  const preview = await store.createPreview({ filter: { scope: "identity", identityId: ids.identity1 }, adminUserId: adminId, adminSessionId: sessionId, now, expiresAt: new Date(now.getTime() + 300_000) });
  await client.sql.unsafe(`create function fail_identity_delete() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end $$`);
  await client.sql.unsafe(`create trigger fail_identity_delete before delete on identities for each row when (old.id='${ids.identity1}'::uuid) execute function fail_identity_delete()`);
  await expect(store.execute({ previewToken: preview.previewToken, filterHash: preview.filterHash, adminUserId: adminId, adminSessionId: sessionId, now })).rejects.toThrow(/fixture failure/u);
  expect((await client.sql.unsafe("select id from matches where id=$1", [ids.match]))).toHaveLength(1);
  expect((await client.sql.unsafe("select id from deletion_audit where filter_hash=$1", [preview.filterHash]))).toHaveLength(0);
  expect((await client.sql.unsafe("select consumed_at from deletion_previews where filter_hash=$1", [preview.filterHash]))[0]?.consumed_at).toBeNull();
  await client.sql.unsafe("drop trigger fail_identity_delete on identities; drop function fail_identity_delete()");
});

it.skipIf(!databaseUrl).each([
  ["identity", "5"], ["class", "6"], ["date_range", "7"], ["all", "8"],
] as const)("removes %s records from real analytics, export source and generated workbook", async (scope,suffix) => {
  const ids = await recordFixture(suffix); await completeFixture(ids); const filters={from:"2026-08-15",to:"2026-08-15"} as const, source=new PostgresExportDataSource(client);
  const futureMatch=`90000000-0000-4000-8000-${suffix.padStart(12,"0")}`;if(scope==="date_range")await client.sql.unsafe(`insert into matches(id,idempotency_fingerprint,status,player1_identity_id,player2_identity_id,player1_design_id,player2_design_id,performance_model_version,physics_model_version,protocol_version,created_at,started_at) values($1,$2,'in_progress',$3,$4,$5,$6,'1.0.0','2.0.0',1,'2026-08-15T04:00:00Z','2026-08-16T04:00:00Z')`,[futureMatch,`f${suffix}`.padEnd(64,"0"),ids.identity1,ids.identity2,ids.design1,ids.design2]);
  expect(await source.withSnapshot(filters,undefined,async snapshot=>snapshot.metadata.rowCounts?.matches??-1)).toBe(1);
  expect((await usageAnalytics(client.db,filters,"day")).reduce((sum,row)=>sum+row.completedMatches,0)).toBe(1);
  const filter=scope==="identity"?{scope,identityId:ids.identity1}:scope==="class"?{scope,className:"1A"}:scope==="date_range"?{scope,from:"2026-08-15",to:"2026-08-15"}:{scope};
  const store=new PostgresDeletionStore(client),now=new Date(),preview=await store.createPreview({filter,adminUserId:adminId,adminSessionId:sessionId,now,expiresAt:new Date(now.getTime()+300_000)});
  expect((await store.execute({previewToken:preview.previewToken,filterHash:preview.filterHash,adminUserId:adminId,adminSessionId:sessionId,now})).status).toBe("ok");
  expect(await source.withSnapshot(filters,undefined,async snapshot=>snapshot.metadata.rowCounts?.matches??-1)).toBe(0);
  expect((await usageAnalytics(client.db,filters,"day")).reduce((sum,row)=>sum+row.completedMatches,0)).toBe(0);
  if(scope==="date_range"){expect(preview.counts).toEqual({identities:0,designs:0,matches:1});expect((await client.sql.unsafe("select id from identities where id=$1",[ids.identity1]))).toHaveLength(1);expect((await client.sql.unsafe("select id from matches where id=$1",[futureMatch]))).toHaveLength(1);expect((await client.sql.unsafe("select id from designs where id=$1",[ids.design1]))).toHaveLength(1);}
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await buildWorkbookBuffer(source,filters) as never);expect(workbook.getWorksheet("對戰紀錄")!.rowCount).toBe(8);
},30_000);
