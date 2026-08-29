import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseClient } from "@steam-top/db";
import type { AnalyticsFilters, UsageDay, UsagePeriod } from "./usage";

export const FILTER_APPLICABILITY = Object.freeze({
  activeDevices: Object.freeze({population:"unique anonymous devices with meaningful activity per HK civil bucket",denominator:"none",filters:Object.freeze(["date", "className", "identityStatus"])}),
  designsAndShapes: Object.freeze({population:"eligible immutable design snapshots created in range",denominator:"layers within each shape dimension",filters:Object.freeze(["date", "className", "identityStatus", "performanceModelVersion"])}),
  rooms: Object.freeze({population:"rooms created in range",denominator:"none",filters:Object.freeze(["date", "className", "identityStatus"])}),
  completedMatches: Object.freeze({population:"authoritative completed matches in range",denominator:"none",filters:Object.freeze(["date", "className", "identityStatus", "performanceModelVersion", "physicsModelVersion"])}),
  parameterUsage: Object.freeze({population:"all eligible designs; when physicsModelVersion is set, distinct designs used in matching completed matches",denominator:"observations within dimension and performance model",filters:Object.freeze(["date", "className", "identityStatus", "performanceModelVersion", "physicsModelVersion"])}),
  parameterPerformance: Object.freeze({population:"one observation per match, participant, parameter group and distinct launch grade",denominator:"at least 10 distinct authoritative completed matches",filters:Object.freeze(["date", "className", "identityStatus", "performanceModelVersion", "physicsModelVersion"])}),
});
type JsonRow = Readonly<Record<string, unknown>>;
export type AnalyticsSummary = Readonly<{ filters: AnalyticsFilters; filterApplicability: typeof FILTER_APPLICABILITY; usage: readonly UsageDay[]; usagePeriods: Readonly<{ daily: readonly UsageDay[]; weekly: readonly UsageDay[]; monthly: readonly UsageDay[] }>; parameterUsage: readonly JsonRow[]; parameters: readonly JsonRow[]; rankings:Readonly<{top:readonly JsonRow[];bottom:readonly JsonRow[];total:number;hasMore:boolean;snapshotCursor:string;overallLaunchDistribution:Readonly<Record<string,number>>}>; refreshedAt: string }>;
export interface AnalyticsCache {
  read(hash: string, maxAge: Date): Promise<AnalyticsSummary | null>;
  write(hash: string, summary: AnalyticsSummary): Promise<void>;
  exclusive?<T>(hash: string, operation: () => Promise<T>): Promise<T>;
}

export function canonicalFilterHash(filters: AnalyticsFilters): string {
  const canonical = { from: filters.from, to: filters.to, className: filters.className ?? null, identityStatus: filters.identityStatus ?? null, performanceModelVersion: filters.performanceModelVersion ?? null, physicsModelVersion: filters.physicsModelVersion ?? null };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export class PostgresAnalyticsCache implements AnalyticsCache {
  readonly #transaction = new AsyncLocalStorage<DatabaseClient["sql"]>();
  constructor(private readonly sql: DatabaseClient["sql"]) {}
  currentExecutor():DatabaseClient["sql"] { return this.#transaction.getStore()??this.sql; }
  async read(hash: string, maxAge: Date): Promise<AnalyticsSummary | null> {
    const executor = this.#transaction.getStore() ?? this.sql;
    const rows = await executor<readonly { filters_json: AnalyticsFilters; usage_json: readonly UsageDay[]; usage_periods_json: AnalyticsSummary["usagePeriods"]; parameter_usage_json: readonly unknown[]; parameters_json: readonly unknown[]; rankings_json:AnalyticsSummary["rankings"]; refreshed_at: Date }[]>`
      select filters_json,usage_json,usage_periods_json,parameter_usage_json,parameters_json,rankings_json,refreshed_at from analytics_daily_summaries
      where filter_hash=${hash} and refreshed_at >= ${maxAge} order by summary_date desc limit 1`;
    const row = rows[0];
    return row ? Object.freeze({ filters: row.filters_json, filterApplicability: FILTER_APPLICABILITY, usage: row.usage_json, usagePeriods: row.usage_periods_json, parameterUsage: row.parameter_usage_json as readonly JsonRow[], parameters: row.parameters_json as readonly JsonRow[],rankings:row.rankings_json, refreshedAt: row.refreshed_at.toISOString() }) : null;
  }
  async write(hash: string, summary: AnalyticsSummary): Promise<void> {
    const executor = this.#transaction.getStore() ?? this.sql;
    await executor`insert into analytics_daily_summaries(summary_date,filter_hash,filters_json,usage_json,usage_periods_json,parameter_usage_json,parameters_json,rankings_json,refreshed_at)
      values ((${summary.refreshedAt}::timestamptz at time zone 'Asia/Hong_Kong')::date,${hash},${executor.json(summary.filters)},${executor.json(summary.usage)},${executor.json(summary.usagePeriods)},${executor.json(summary.parameterUsage as readonly never[])},${executor.json(summary.parameters as readonly never[])},${executor.json(summary.rankings as never)},${summary.refreshedAt}::timestamptz)
      on conflict(summary_date,filter_hash) do update set filters_json=excluded.filters_json,usage_json=excluded.usage_json,usage_periods_json=excluded.usage_periods_json,parameter_usage_json=excluded.parameter_usage_json,parameters_json=excluded.parameters_json,rankings_json=excluded.rankings_json,refreshed_at=excluded.refreshed_at
      where excluded.refreshed_at >= analytics_daily_summaries.refreshed_at`;
    await executor`delete from analytics_daily_summaries where refreshed_at < now() - interval '400 days'`;
    await executor`delete from analytics_daily_summaries where (summary_date,filter_hash) in
      (select summary_date,filter_hash from analytics_daily_summaries order by refreshed_at desc,summary_date desc,filter_hash offset 10000)`;
  }
  async exclusive<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    return this.sql.begin(async (transaction) => { await transaction`set transaction isolation level repeatable read`;await transaction`select pg_advisory_xact_lock(hashtextextended(${hash}, 1937002026))`; return this.#transaction.run(transaction as unknown as DatabaseClient["sql"], operation); }) as Promise<T>;
  }
}

type UsageQuery = (filters: AnalyticsFilters, period: UsagePeriod,cutoff?:string) => Promise<readonly UsageDay[]>;
type ParameterQuery = (filters: AnalyticsFilters, page?: Readonly<{ limit?: number; offset?: number;order?:"stable"|"high"|"low";asOf?:string }>) => Promise<readonly unknown[]>;
type LaunchQuery=(filters:AnalyticsFilters,cutoff?:string)=>Promise<Readonly<Record<string,number>>>;

export class AnalyticsService {
  #refresh: Promise<AnalyticsSummary> | null = null;
  readonly #inflight = new Map<string, Promise<AnalyticsSummary>>();
  readonly #cursorSecret:Buffer;
  constructor(private readonly cache: AnalyticsCache, private readonly usageQuery: UsageQuery, private readonly parameterQuery: ParameterQuery, private readonly parameterUsageQuery: ParameterQuery = async () => [], private readonly now = () => new Date(),cursorSecret:Buffer=randomBytes(32),private readonly consistent=<T>(operation:()=>Promise<T>)=>operation(),private readonly launchQuery:LaunchQuery=async()=>Object.freeze({Perfect:0,Great:0,Good:0,Miss:0,totalOccurrences:0})) { if(cursorSecret.length<32)throw new TypeError("analytics cursor secret too short");this.#cursorSecret=cursorSecret; }
  async query(filters: AnalyticsFilters, maxAgeMs = 5 * 60_000): Promise<AnalyticsSummary> {
    const hash = canonicalFilterHash(filters);
    const inflightKey=`${hash}:${maxAgeMs}`; const existing = this.#inflight.get(inflightKey); if (existing) return existing;
    const compute = async () => {
      const now = this.now(); const cached = await this.cache.read(hash, new Date(now.getTime() - maxAgeMs)); if (cached) return this.#present(cached,now);
      const cutoff=now.toISOString();const [daily, weekly, monthly, parameterRows, parameterUsage,topRows,bottomRows,overallLaunchDistribution] = await this.consistent(()=>Promise.all([this.usageQuery(filters, "day",cutoff), this.usageQuery(filters, "week",cutoff), this.usageQuery(filters, "month",cutoff), this.parameterQuery(filters,{limit:100,order:"stable",asOf:cutoff}), this.parameterUsageQuery(filters,{asOf:cutoff}),this.parameterQuery(filters,{limit:10,order:"high",asOf:cutoff}),this.parameterQuery(filters,{limit:10,order:"low",asOf:cutoff}),this.launchQuery(filters,cutoff)]));
      const usagePeriods = Object.freeze({ daily, weekly, monthly });
      const parameters=parameterRows as readonly JsonRow[]; const top=topRows as readonly JsonRow[],bottom=bottomRows as readonly JsonRow[];const total=Number((top[0] as {totalGroups?:unknown}|undefined)?.totalGroups??parameters.length);
      const rankings=Object.freeze({top,bottom,total,hasMore:total>parameters.length,snapshotCursor:"",overallLaunchDistribution});
      const summary = Object.freeze({ filters, filterApplicability: FILTER_APPLICABILITY, usage: daily, usagePeriods, parameters, parameterUsage:parameterUsage as readonly JsonRow[],rankings:rankings as AnalyticsSummary["rankings"], refreshedAt: now.toISOString() });
      if(Buffer.byteLength(JSON.stringify(summary),"utf8")>2_000_000)throw new Error("ANALYTICS_PAYLOAD_LIMIT");await this.cache.write(hash, summary); return this.#present(summary,now);
    };
    const operation = (this.cache.exclusive ? this.cache.exclusive(hash, compute) : compute()).finally(() => { this.#inflight.delete(inflightKey); });
    this.#inflight.set(inflightKey, operation); return operation;
  }
  refreshDefaultWindow(now = this.now()): Promise<AnalyticsSummary> {
    if (this.#refresh) return this.#refresh;
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const fromDate = new Date(`${local}T00:00:00+08:00`); fromDate.setUTCDate(fromDate.getUTCDate() - 30);
    const from = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).format(fromDate);
    this.#refresh = this.query({ from, to: local }, 0).finally(() => { this.#refresh = null; });
    return this.#refresh;
  }
  #signCursor(payload:string){const body=Buffer.from(payload).toString("base64url");return `${body}.${createHmac("sha256",this.#cursorSecret).update(body).digest("base64url")}`;}
  #present(summary:AnalyticsSummary,responseNow:Date):AnalyticsSummary {const filterHash=canonicalFilterHash(summary.filters),asOf=summary.refreshedAt,expiresAt=new Date(responseNow.getTime()+300_000).toISOString();return Object.freeze({...summary,rankings:Object.freeze({...summary.rankings,snapshotCursor:this.#signCursor(JSON.stringify({asOf,expiresAt,offset:0,filterHash}))})});}
  #readCursor(cursor:string){try{if(cursor.length<20||cursor.length>1024)throw new Error();const [body,signature,...rest]=cursor.split(".");if(!body||!signature||rest.length||body.length>768||signature.length>128)throw new Error();const expected=createHmac("sha256",this.#cursorSecret).update(body).digest();const actual=Buffer.from(signature,"base64url");if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();const value=JSON.parse(Buffer.from(body,"base64url").toString("utf8")) as {asOf:string;expiresAt:string;offset:number;filterHash:string};if(!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>1_000_000||typeof value.asOf!=="string"||typeof value.expiresAt!=="string"||typeof value.filterHash!=="string"||Object.keys(value).length!==4)throw new Error();for(const raw of [value.asOf,value.expiresAt]){const date=new Date(raw);if(!Number.isFinite(date.getTime())||date.toISOString()!==raw)throw new Error();}if(this.now().getTime()>new Date(value.expiresAt).getTime())throw new RangeError("ANALYTICS_CURSOR_EXPIRED");return value;}catch(error){if(error instanceof RangeError&&error.message==="ANALYTICS_CURSOR_EXPIRED")throw error;throw new RangeError("INVALID_ANALYTICS_CURSOR");}}
  async parameterPage(filters: AnalyticsFilters, pageSize: number, cursor?: string) {
    if (!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100) throw new RangeError("INVALID_ANALYTICS_PAGE");
    const filterHash=canonicalFilterHash(filters);let offset=0,asOf=this.now().toISOString(),expiresAt=new Date(this.now().getTime()+300_000).toISOString();
    if(cursor){const decoded=this.#readCursor(cursor);if(decoded.filterHash!==filterHash)throw new RangeError("INVALID_ANALYTICS_CURSOR");offset=decoded.offset;asOf=decoded.asOf;expiresAt=decoded.expiresAt;}
    const queried=await this.parameterQuery(filters,{limit:pageSize+1,offset,order:"stable",asOf});const rows=queried.slice(0,pageSize),nextOffset=offset+rows.length,total=Number((queried[0] as {totalGroups?:unknown}|undefined)?.totalGroups??offset+rows.length),capReached=nextOffset>=1_000_000&&total>nextOffset,hasMore=queried.length>pageSize&&!capReached;
    const payload={asOf,expiresAt,offset:nextOffset,filterHash};
    return Object.freeze({rows:Object.freeze(rows),nextCursor:hasMore?this.#signCursor(JSON.stringify(payload)):null,total,hasMore,capReached,truncated:capReached,accessibleLimit:1_000_000,paginationConsistency:"insert-consistent-asOf; deletion-sensitive",snapshotCursor:this.#signCursor(JSON.stringify({asOf,expiresAt,offset:0,filterHash}))});
  }
}
