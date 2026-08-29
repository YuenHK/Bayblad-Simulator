import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "@steam-top/db";
import { parameterPerformance } from "./parameters";
import { parameterUsage } from "./parameter-usage";
import { usageAnalytics } from "./usage";
import { AnalyticsService, canonicalFilterHash, FILTER_APPLICABILITY, PostgresAnalyticsCache } from "./service";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schemaName = `analytics_${randomUUID().replaceAll("-", "")}`;
let client: DatabaseClient;
let firstIdentityId: string;

beforeAll(async () => {
  if (!databaseUrl) return;
  client = createDatabaseClient({ url: databaseUrl, ssl: false, allowInsecure: true, maxConnections: 4 });
  await client.sql.unsafe(`create schema ${schemaName}`); await client.sql.unsafe(`set search_path to ${schemaName},public`);
  const directory = fileURLToPath(new URL("../../../../drizzle", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) for (const statement of readFileSync(`${directory}/${file}`, "utf8").split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await client.sql.unsafe(statement);
  const first = randomUUID(), second = randomUUID(), star = randomUUID(), circle = randomUUID(), firstDevice=randomUUID(), secondDevice=randomUUID();
  firstIdentityId=first;
  await client.sql`insert into identities(id,status,display_name,class_name,anonymous_device_id) values (${first},'iclass','1A-01','1A',${firstDevice}),(${second},'guest','訪客-ABCD',null,${secondDevice})`;
  await client.sql`insert into identity_sessions(identity_id,token_hash,created_at,last_seen_at,expires_at) values
    (${first},${"a".repeat(64)},'2026-07-31T15:00:00Z','2026-07-31T16:30:00Z','2027-01-01T00:00:00Z'),
    (${first},${"b".repeat(64)},'2026-07-31T15:00:00Z','2026-07-31T16:45:00Z','2027-01-01T00:00:00Z'),
    (${second},${"c".repeat(64)},'2026-08-31T15:00:00Z','2026-08-31T16:15:00Z','2027-01-01T00:00:00Z')`;
  await client.sql`insert into device_activity_days(activity_date,anonymous_device_id,identity_id,identity_status_snapshot,class_name_snapshot,first_activity_at,last_activity_at) values
    ('2026-08-01',${firstDevice},${first},'iclass','1A','2026-07-31T16:30:00Z','2026-07-31T16:45:00Z'),
    ('2026-09-01',${secondDevice},${second},'guest',null,'2026-08-31T16:15:00Z','2026-08-31T16:15:00Z')`;
  const addDesign = async (id: string, owner: string, shape: string, at: string) => {
    await client.sql.unsafe(`insert into designs(id,logical_design_id,owner_identity_id,version,schema_version,name,screw_count,screw_radius_mm,screw_rotation_deg,metal_disc_diameter_mm,total_mass_g,polar_moment_gmm2,center_of_mass_x_mm,center_of_mass_y_mm,performance_speed,performance_spin_duration,performance_stability,performance_impact_resistance,performance_model_version,battle_eligible,validation_issues,created_at) values ($1,$1,$2,1,'1','fixture',6,12,0,30,40,12000,0,0,60,60,60,60,'perf-1',false,'[]',$3)`, [id, owner, at]);
    for (let order=0; order<3; order++) await client.sql.unsafe(`insert into design_layers(design_id,source_layer_id,layer_order,position,shape,points,diameter_mm,actual_area_mm2,corner_roundness,rotation_deg,color) values ($1,$2,$3,$4,$5,8,70,$6,0.2,0,'#123456')`, [id, `${id}-${order}`, order, ["top","middle","bottom"][order]!, shape,shape==="circle"?3848.451:2450]);
    await client.sql`update designs set battle_eligible=true where id=${id}`;
    await client.sql`insert into design_event_snapshots(design_id,owner_identity_id_at_creation,canonical_identity_id_at_creation,identity_status_snapshot,class_name_snapshot,captured_at) select d.id,d.owner_identity_id,d.owner_identity_id,i.status,i.class_name,d.created_at from designs d left join identities i on i.id=d.owner_identity_id where d.id=${id}`;
  };
  await addDesign(star, first, "star", "2026-07-31T16:10:00Z"); await addDesign(circle, second, "star", "2026-08-31T16:10:00Z");
  const roomJuly = randomUUID(), roomAugust = randomUUID();
  await client.sql`insert into rooms(id,code,name,owner_identity_id,status,created_at) values (${roomJuly},'A100','July',${first},'waiting','2026-07-31T16:05:00Z'),(${roomAugust},'A101','August',${second},'waiting','2026-08-31T16:05:00Z')`;
  await client.sql`insert into room_event_snapshots(room_id,owner_identity_id_at_creation,canonical_identity_id_at_creation,identity_status_snapshot,class_name_snapshot,captured_at) select r.id,r.owner_identity_id,r.owner_identity_id,i.status,i.class_name,r.created_at from rooms r left join identities i on i.id=r.owner_identity_id where r.id in (${roomJuly},${roomAugust})`;
  for (let index=0; index<10; index++) {
    const match = randomUUID(); const completed = index < 5 ? `2026-08-0${index + 1}T04:00:00Z` : `2026-09-0${index - 4}T04:00:00Z`;
    await client.sql`insert into matches(id,room_id,idempotency_fingerprint,status,player1_identity_id,player2_identity_id,player1_design_id,player2_design_id,performance_model_version,physics_model_version,protocol_version,started_at) values (${match},${roomJuly},${index.toString(16).padStart(64,"0")},'in_progress',${first},${second},${star},${circle},'perf-1','physics-1',1,${completed}::timestamptz - interval '1 minute')`;
    await client.sql`insert into match_participant_snapshots(match_id,slot,identity_id_at_start,canonical_identity_id_at_start,identity_status_snapshot,class_name_snapshot,design_id,captured_at) values (${match},'player1',${first},${first},'iclass','1A',${star},${completed}::timestamptz-interval '1 minute'),(${match},'player2',${second},${second},'guest',null,${circle},${completed}::timestamptz-interval '1 minute')`;
    for (let round=1; round<=2; round++) await client.sql`insert into rounds(id,match_id,external_round_id,authority_key_hash,round_number,attempt,seed,outcome,outcome_reason,ticks,launch_grade_a,launch_grade_b,launch_angular_multiplier_a,launch_angular_multiplier_b,launch_linear_multiplier_a,launch_linear_multiplier_b,physics_model_version,input_fingerprint,battle_result_json,started_at,completed_at) values (${randomUUID()},${match},${`m${index}r${round}`},${(index * 2 + round).toString(16).padStart(64,"1")},${round},1,1,'player1','stopped',60,'Perfect','Good',1,1,1,1,'physics-1',${(index * 2 + round).toString(16).padStart(64,"2")},'{"modelVersion":"physics-1","seed":1,"ticks":60,"frames":[],"outcome":{"winner":"player1","reason":"stopped"},"finalStats":{}}',${completed}::timestamptz - interval '30 seconds',${completed})`;
    await client.sql`update matches set status='completed',player1_battle_points=2,player2_battle_points=0,player1_challenge_points=0,player2_challenge_points=0,player1_total=2,player2_total=0,winner='player1',round_winners='["player1","player1"]',completed_at=${completed} where id=${match}`;
  }
}, 30_000);

it.skipIf(!databaseUrl)("counts Hong Kong days, distinct devices and completed authority only", async () => {
  const rows = await usageAnalytics(client.db, { from: "2026-08-01", to: "2026-09-01" });
  expect(rows.find((row) => row.date === "2026-08-01")).toMatchObject({ activeDevices: 1, designs: 1, rooms: 1 });
  expect(rows.find((row) => row.date === "2026-09-01")).toMatchObject({ activeDevices: 1, designs: 1, rooms: 1 });
  expect(rows.reduce((sum,row) => sum + row.completedMatches, 0)).toBe(6);
  const weekly = await usageAnalytics(client.db, { from: "2026-08-01", to: "2026-09-01" }, "week");
  expect(weekly.reduce((sum,row) => sum + row.completedMatches, 0)).toBe(6);
  expect(weekly.reduce((sum,row) => sum + row.activeDevices, 0)).toBe(2);
}, 30_000);

it.skipIf(!databaseUrl)("returns only parameter groups backed by at least ten completed matches", async () => {
  const rows = await parameterPerformance(client.db, { from: "2026-08-01", to: "2026-09-30", performanceModelVersion: "perf-1", physicsModelVersion: "physics-1" });
  expect(rows.length).toBeGreaterThanOrEqual(20);
  expect(rows.every((row) => row.sampleSize === 10)).toBe(true);
  expect(rows.some(row=>row.dimension==="totalMassGBucket")).toBe(true); expect(rows.some(row=>row.dimension==="layerOrder")).toBe(true); expect(rows.some(row=>row.dimension==="layerCombination")).toBe(true);
  expect(rows.find((row) => row.dimension === "totalMassGBucket"&&row.launchGrade==="Perfect")).toMatchObject({ averageScore: 2, winRate: 1, opponentAverageStrength: 60,participantObservations:20 });
}, 30_000);

it.skipIf(!databaseUrl)("filters by immutable event-time class snapshots",async()=>{
  await client.sql`update identities set class_name='2B' where id=${firstIdentityId}`;
  const rows=await parameterPerformance(client.db,{from:"2026-08-01",to:"2026-09-30",className:"1A"});
  expect(rows.length).toBeGreaterThanOrEqual(10); expect(rows.every(row=>row.averageScore===2)).toBe(true);
  expect(await parameterPerformance(client.db,{from:"2026-08-01",to:"2026-09-30",className:"2B"})).toHaveLength(0);
},30_000);

it.skipIf(!databaseUrl)("applies physics filters only through eligible completed-match designs",async()=>{
  const eligible=await parameterUsage(client.db,{from:"2026-08-01",to:"2026-09-30",physicsModelVersion:"physics-1"});
  expect(eligible.length).toBeGreaterThan(0); expect(eligible.every(row=>row.scope==="completedMatchDesigns")).toBe(true);
  expect(await parameterUsage(client.db,{from:"2026-08-01",to:"2026-09-30",physicsModelVersion:"physics-missing"})).toHaveLength(0);
},30_000);

it.skipIf(!databaseUrl)("keeps the completed-match analytics plan indexable at scale",async()=>{
  await client.sql`set local enable_seqscan=off`;
  const plan=await client.sql.unsafe(`explain (costs off) select id from matches where status='completed' and completed_at >= '2026-08-01T00:00:00Z' and completed_at < '2026-10-01T00:00:00Z'`);
  expect(JSON.stringify(plan)).toMatch(/matches_(?:status_completed|completed_at)_idx/u);
},30_000);

it.skipIf(!databaseUrl)("persists and reuses a bounded materialized summary", async () => {
  const cache = new PostgresAnalyticsCache(client.sql); let executions = 0;
  const service = new AnalyticsService(cache, async (filters, period) => { executions++; return usageAnalytics(client.db, filters, period); }, async (filters) => parameterPerformance(client.db, filters), async () => [], () => new Date("2026-09-30T16:00:00Z"));
  const filters = { from: "2026-08-01", to: "2026-09-30" } as const;
  await service.query(filters); await service.query(filters);
  expect(executions).toBe(3);
}, 30_000);

it.skipIf(!databaseUrl)("coordinates the same cache hash across service instances", async () => {
  let executions=0; const make=()=>new AnalyticsService(new PostgresAnalyticsCache(client.sql),async()=>{ executions++; return []; },async()=>[],async()=>[],()=>new Date("2026-10-01T16:00:00Z"));
  await Promise.all([make().query({ from:"2026-08-01",to:"2026-08-02" }),make().query({ from:"2026-08-01",to:"2026-08-02" })]);
  expect(executions).toBe(3);
},30_000);

it.skipIf(!databaseUrl)("fences a stale cache writer",async()=>{
  const cache=new PostgresAnalyticsCache(client.sql),filters={from:"2026-07-01",to:"2026-07-02"} as const,hash=canonicalFilterHash(filters);
  const common={filters,filterApplicability:FILTER_APPLICABILITY,usage:[],usagePeriods:{daily:[],weekly:[],monthly:[]},parameterUsage:[],parameters:[],rankings:{top:[],bottom:[],total:0,hasMore:false,snapshotCursor:"test"}};
  await cache.write(hash,{...common,refreshedAt:"2026-10-02T00:00:00.000Z"});
  await cache.write(hash,{...common,refreshedAt:"2026-10-01T00:00:00.000Z"});
  expect((await cache.read(hash,new Date("2020-01-01")))?.refreshedAt).toBe("2026-10-02T00:00:00.000Z");
},30_000);

afterAll(async () => { if (!client) return; await client.sql.unsafe("set search_path to public"); await client.sql.unsafe(`drop schema ${schemaName} cascade`); await client.close(); });
