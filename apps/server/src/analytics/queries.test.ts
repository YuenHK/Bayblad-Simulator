import { describe, expect, it } from "vitest";
import { analyticsFiltersSchema, hongKongDateBounds, normalizeUsageRows } from "./usage";
import { expectedWinProbability, normalizeOverallLaunchDistribution, normalizeParameterRows, opponentStrength, outcomeResidual, OPPONENT_STRENGTH_METRIC } from "./parameters";
import { AnalyticsService, canonicalFilterHash, signAnalyticsCursor, type AnalyticsCache } from "./service";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { AdminAuthService, InMemoryAdminStore, registerAdminAuthRoutes } from "../auth/admin-auth";
import { registerAnalyticsRoutes } from "./routes";
import { normalizeParameterUsage } from "./parameter-usage";

describe("analytics query contracts", () => {
  it("uses Hong Kong midnight while preserving UTC boundaries", () => {
    expect(hongKongDateBounds("2026-08-31", "2026-09-01")).toEqual({
      from: "2026-08-30T16:00:00.000Z",
      toExclusive: "2026-09-01T16:00:00.000Z",
    });
  });

  it("rejects inverted, overlong and unknown filters", () => {
    expect(() => analyticsFiltersSchema.parse({ from: "2026-09-02", to: "2026-09-01" })).toThrow();
    expect(() => analyticsFiltersSchema.parse({ from: "2020-01-01", to: "2026-09-01" })).toThrow();
    expect(() => analyticsFiltersSchema.parse({ from: "2026-09-01", to: "2026-09-01", secret: true })).toThrow();
    for (const invalid of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10"]) expect(() => analyticsFiltersSchema.parse({ from: invalid, to: "2026-09-01" })).toThrow();
    expect(analyticsFiltersSchema.parse({ from: "2028-02-29", to: "2028-02-29" })).toMatchObject({ from: "2028-02-29" });
  });

  it("normalizes usage counters and shape proportions without leaking identity fields", () => {
    expect(normalizeUsageRows([{ localDate: "2026-08-31", activeDevices: "2", designCount: "3", roomCount: "1", completedMatchCount: "4", shape: "star", shapeCount: "6", totalShapeCount: "9" }])).toEqual([{
      date: "2026-08-31", activeDevices: 2, designs: 3, rooms: 1, completedMatches: 4,
      shapes: [{ shape: "star", count: 6, proportion: 2 / 3 }],
    }]);
  });

  it("drops parameter groups below ten completed matches and maps launch distribution", () => {
    const result = normalizeParameterRows([
      { dimension:"totalMassGBucket",value:{fromG:40,toG:45},launchGrade:"Perfect",opponentStrengthBand:"medium",performanceModelVersion:"perf-1",physicsModelVersion:"physics-1",sampleSize:"10",participantObservations:"12",averageScore:"1.75",winRate:"0.6",opponentAverageStrength:"64",expectedWinRate:"0.45",outcomeResidual:"0.15",gradeOccurrenceCount:"2",totalGroups:"20" },
      { dimension:"holes",value:{count:4},launchGrade:"Good",opponentStrengthBand:"medium",performanceModelVersion:"perf-1",physicsModelVersion:"physics-1",sampleSize:"9",participantObservations:"9",averageScore:"2",winRate:"1",opponentAverageStrength:"60",expectedWinRate:"0.5",outcomeResidual:"0.5",gradeOccurrenceCount:"1",totalGroups:"20" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ dimension:"totalMassGBucket",sampleSize: 10, averageScore: 1.75, winRate: 0.6, launchGrade:"Perfect",opponentStrengthBand:"medium" });
    expect(result[0]?.gradeOccurrenceCount).toBe(2);
    expect(Object.keys(result[0] ?? {})).not.toContain("studentName");
  });
});

it("returns explicit whole-design parameter usage dimensions without PII", () => {
  const rows = normalizeParameterUsage([{scope:"allEligibleDesigns", dimension: "metalDiscDiameter", value: { diameterMm: 0, placement: "under_bottom", none: true }, count: "3", total: "4", performanceModelVersion: "perf-1",totalGroups:"2",truncated:false,population:"4" }]);
  expect(rows).toEqual([{scope:"allEligibleDesigns", dimension: "metalDiscDiameter", value: { diameterMm: 0, placement: "under_bottom", none: true }, count: 3, proportion: .75, performanceModelVersion: "perf-1",totalGroups:2,truncated:false,population:4 }]);
  expect(JSON.stringify(rows)).not.toMatch(/student|className|device/iu);
});
it("defines opponent strength from the authoritative design prediction rather than match score",()=>{
  expect(opponentStrength({stability:80,impactResistance:60,spinDuration:40,speed:20})).toBe(60);
  expect(OPPONENT_STRENGTH_METRIC).toMatchObject({unit:"performance-index-0-100",version:"1"});
});
it("rejects unsafe or internally inconsistent overall launch counts",()=>{
  expect(normalizeOverallLaunchDistribution({perfect:2,great:0,good:1,miss:0,total:3})).toMatchObject({Perfect:2,Good:1,totalOccurrences:3});
  expect(()=>normalizeOverallLaunchDistribution({perfect:2,great:0,good:1,miss:0,total:4})).toThrow("INVALID_LAUNCH_DISTRIBUTION");
  expect(()=>normalizeOverallLaunchDistribution({perfect:-1,great:0,good:1,miss:0,total:0})).toThrow("INVALID_LAUNCH_DISTRIBUTION");
});
it("uses an interpretable expected-outcome residual that rewards equal results against stronger opponents",()=>{
  expect(expectedWinProbability(60,60)).toBe(.5);
  expect(outcomeResidual(.5,60,60)).toBe(0);
  expect(outcomeResidual(1,60,80)).toBeGreaterThan(outcomeResidual(1,60,40));
  expect(outcomeResidual(0,60,80)).toBeGreaterThan(outcomeResidual(0,60,40));
});

describe("analytics summary cache", () => {
  it("uses a stable hash independent of optional property insertion order", () => {
    expect(canonicalFilterHash({ from: "2026-08-01", to: "2026-08-31", className: "1A", identityStatus: "iclass" }))
      .toBe(canonicalFilterHash({ identityStatus: "iclass", className: "1A", to: "2026-08-31", from: "2026-08-01" }));
  });
  it("pages an immutable signed snapshot without skips when source rows mutate",async()=>{
    const cache:AnalyticsCache={read:async()=>null,write:async()=>undefined};
    let source=[0,1,2,3,4];const service=new AnalyticsService(cache,async()=>[],async(_filters,page)=>source.filter(value=>value>=0).slice(page?.offset??0,(page?.offset??0)+(page?.limit??source.length)).map(value=>typeof value==="number"?value:value),async()=>[],()=>new Date("2026-08-01T00:00:00Z"),Buffer.alloc(32,7));
    const first=await service.parameterPage({from:"2026-08-01",to:"2026-08-02"},2);expect(first).toMatchObject({rows:[0,1],hasMore:true});
    source=[...source,5];const second=await service.parameterPage({from:"2026-08-01",to:"2026-08-02"},2,first.nextCursor!);expect(second.rows).toEqual([2,3]);
    await expect(service.parameterPage({from:"2026-08-01",to:"2026-08-03"},2,first.nextCursor!)).rejects.toThrow("INVALID_ANALYTICS_CURSOR");
    await expect(service.parameterPage({from:"2026-08-01",to:"2026-08-02"},101)).rejects.toThrow("INVALID_ANALYTICS_PAGE");
  });
  it("does not let a forced refresh join a less strict in-flight query",async()=>{
    const cache:AnalyticsCache={read:async()=>null,write:async()=>undefined};let runs=0;
    const service=new AnalyticsService(cache,async()=>{runs++;return[];},async()=>[]); const filters={from:"2026-08-01",to:"2026-08-02"} as const;
    await Promise.all([service.query(filters,300_000),service.query(filters,0)]); expect(runs).toBe(6);
  });
  it("loads every summary metric inside one consistency boundary",async()=>{
    const cache:AnalyticsCache={read:async()=>null,write:async()=>undefined};let boundaries=0;
    const service=new AnalyticsService(cache,async()=>[],async()=>[],async()=>[],()=>new Date("2026-08-01T00:00:00Z"),Buffer.alloc(32,8),async(operation)=>{boundaries++;return operation();});
    await service.query({from:"2026-08-01",to:"2026-08-02"});expect(boundaries).toBe(1);
  });
  it("defines high and low rankings primarily by average score",async()=>{
    const cache:AnalyticsCache={read:async()=>null,write:async()=>undefined};const high={averageScore:2,winRate:.5,sampleSize:10,outcomeResidual:-.4,totalGroups:2};const low={averageScore:1,winRate:1,sampleSize:20,outcomeResidual:.9,totalGroups:2};
    const service=new AnalyticsService(cache,async()=>[],async(_filters,page)=>page?.order==="high"?[high,low]:page?.order==="low"?[low,high]:[high,low],async()=>[],undefined,undefined,undefined,async()=>({Perfect:2,Great:0,Good:1,Miss:0,totalOccurrences:3}));
    const filters={from:"2026-08-01",to:"2026-08-02"} as const;const summary=await service.query(filters);expect(summary.rankings.top[0]).toBe(high);expect(summary.rankings.bottom[0]).toBe(low);
    expect(summary.rankings.overallLaunchDistribution).toEqual({Perfect:2,Great:0,Good:1,Miss:0,totalOccurrences:3});
    await expect(service.parameterPage(filters,1,summary.rankings.snapshotCursor)).resolves.toMatchObject({rows:[high]});
  });
  it("rejects an expired signed analytics cursor with an explicit retry code",async()=>{
    const cache:AnalyticsCache={read:async()=>null,write:async()=>undefined};let now=Date.parse("2026-08-01T00:00:00Z");const service=new AnalyticsService(cache,async()=>[],async()=>[1,2],async()=>[],()=>new Date(now),Buffer.alloc(32,4));const filters={from:"2026-08-01",to:"2026-08-02"} as const;
    const first=await service.parameterPage(filters,1);now+=300_001;await expect(service.parameterPage(filters,1,first.nextCursor!)).rejects.toThrow("ANALYTICS_CURSOR_EXPIRED");
  });
  it("re-signs a 4:59-old cached summary cursor for a fresh five-minute response window",async()=>{
    let saved:Awaited<ReturnType<AnalyticsService["query"]>>|null=null,now=Date.parse("2026-08-01T00:00:00Z");const cache:AnalyticsCache={read:async(_hash,maxAge)=>saved&&new Date(saved.refreshedAt)>=maxAge?saved:null,write:async(_hash,value)=>{saved=value;}};const service=new AnalyticsService(cache,async()=>[],async()=>[{totalGroups:1}],async()=>[],()=>new Date(now),Buffer.alloc(32,6));const filters={from:"2026-08-01",to:"2026-08-02"} as const;
    await service.query(filters);now+=299_000;const cached=await service.query(filters);now+=299_000;await expect(service.parameterPage(filters,1,cached.rankings.snapshotCursor)).resolves.toMatchObject({total:1});
  });
  it("never queries or signs beyond the one-million-row accessibility cap",async()=>{
    const secret=Buffer.alloc(32,5),filters={from:"2026-08-01",to:"2026-08-02"} as const,asOf="2026-08-01T00:00:00.000Z",expiresAt="2026-08-01T00:05:00.000Z";let seenLimit=0,calls=0;const cache:AnalyticsCache={read:async()=>null,write:async()=>undefined};const service=new AnalyticsService(cache,async()=>[],async(_filters,page)=>{calls++;seenLimit=page?.limit??0;return Array.from({length:seenLimit},()=>({totalGroups:1_000_100}));},async()=>[],()=>new Date(asOf),secret);
    const near=signAnalyticsCursor(secret,{asOf,expiresAt,offset:999_950,filterHash:canonicalFilterHash(filters)});const page=await service.parameterPage(filters,100,near);expect({seenLimit,rows:page.rows.length,capReached:page.capReached,next:page.nextCursor}).toEqual({seenLimit:50,rows:50,capReached:true,next:null});
    const atCap=signAnalyticsCursor(secret,{asOf,expiresAt,offset:1_000_000,filterHash:canonicalFilterHash(filters)});expect((await service.parameterPage(filters,100,atCap)).rows).toHaveLength(0);expect(calls).toBe(1);
  });

  it("coalesces refreshes and returns a fresh cached summary", async () => {
    let writes = 0;
    const cache: AnalyticsCache = { read: async () => null, write: async () => { writes += 1; } };
    let usageRuns = 0;
    const service = new AnalyticsService(cache, async () => { usageRuns += 1; return []; }, async () => []);
    await Promise.all([service.refreshDefaultWindow(new Date("2026-08-29T02:00:00Z")), service.refreshDefaultWindow(new Date("2026-08-29T02:00:00Z"))]);
    expect({ writes, usageRuns }).toEqual({ writes: 1, usageRuns: 3 });
  });
});

it("exposes analytics only through an authenticated teacher read endpoint", async () => {
  const origin = "https://tops.example.edu.hk"; const store = new InMemoryAdminStore();
  const auth = new AdminAuthService(store, { allowedOrigins: [origin], secureCookies: true, csrfSecret: Buffer.alloc(32, 9) });
  await auth.bootstrap("admin", "test-password-2026");
  const cache: AnalyticsCache = { read: async () => null, write: async () => undefined };
  const analytics = new AnalyticsService(cache, async () => [], async () => []);
  const app = Fastify(); await app.register(fastifyCookie); registerAdminAuthRoutes(app, auth); registerAnalyticsRoutes(app, auth, analytics); await app.ready();
  const query = "/api/admin/analytics?from=2026-08-01&to=2026-08-31";
  expect((await app.inject({ method: "GET", url: query, headers: { host: "tops.example.edu.hk", "sec-fetch-site": "same-origin" } })).statusCode).toBe(401);
  const login = await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin, host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", "content-type": "application/json" }, payload: { username: "admin", password: "test-password-2026" } });
  const cookie = login.cookies[0]!; const adminHeaders = { host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", cookie: `${cookie.name}=${cookie.value}` };
  const response = await app.inject({ method: "GET", url: query, headers: adminHeaders });
  expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store"); expect(response.body).not.toContain("studentName");
  expect((await app.inject({ method: "GET", url: "/api/admin/analytics?from=2026-09-01&to=2026-08-01", headers: adminHeaders })).statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/api/admin/analytics?from=2026-02-30&to=2026-03-01", headers: adminHeaders })).statusCode).toBe(400);
  await app.close();
});
