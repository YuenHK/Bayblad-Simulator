import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseClient } from "@steam-top/db";
import type { AnalyticsFilters, UsageDay, UsagePeriod } from "./usage";

export type AnalyticsSummary = Readonly<{ filters: AnalyticsFilters; usage: readonly UsageDay[]; usagePeriods: Readonly<{ daily: readonly UsageDay[]; weekly: readonly UsageDay[]; monthly: readonly UsageDay[] }>; parameterUsage: readonly unknown[]; parameters: readonly unknown[]; refreshedAt: string }>;
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
  async read(hash: string, maxAge: Date): Promise<AnalyticsSummary | null> {
    const executor = this.#transaction.getStore() ?? this.sql;
    const rows = await executor<readonly { filters_json: AnalyticsFilters; usage_json: readonly UsageDay[]; usage_periods_json: AnalyticsSummary["usagePeriods"]; parameter_usage_json: readonly unknown[]; parameters_json: readonly unknown[]; refreshed_at: Date }[]>`
      select filters_json,usage_json,usage_periods_json,parameter_usage_json,parameters_json,refreshed_at from analytics_daily_summaries
      where filter_hash=${hash} and refreshed_at >= ${maxAge} order by summary_date desc limit 1`;
    const row = rows[0];
    return row ? Object.freeze({ filters: row.filters_json, usage: row.usage_json, usagePeriods: row.usage_periods_json, parameterUsage: row.parameter_usage_json, parameters: row.parameters_json, refreshedAt: row.refreshed_at.toISOString() }) : null;
  }
  async write(hash: string, summary: AnalyticsSummary): Promise<void> {
    const executor = this.#transaction.getStore() ?? this.sql;
    await executor`insert into analytics_daily_summaries(summary_date,filter_hash,filters_json,usage_json,usage_periods_json,parameter_usage_json,parameters_json,refreshed_at)
      values ((${summary.refreshedAt}::timestamptz at time zone 'Asia/Hong_Kong')::date,${hash},${executor.json(summary.filters)},${executor.json(summary.usage)},${executor.json(summary.usagePeriods)},${executor.json(summary.parameterUsage as readonly never[])},${executor.json(summary.parameters as readonly never[])},${summary.refreshedAt}::timestamptz)
      on conflict(summary_date,filter_hash) do update set filters_json=excluded.filters_json,usage_json=excluded.usage_json,usage_periods_json=excluded.usage_periods_json,parameter_usage_json=excluded.parameter_usage_json,parameters_json=excluded.parameters_json,refreshed_at=excluded.refreshed_at
      where excluded.refreshed_at >= analytics_daily_summaries.refreshed_at`;
    await executor`delete from analytics_daily_summaries where refreshed_at < now() - interval '400 days'`;
    await executor`delete from analytics_daily_summaries where (summary_date,filter_hash) in
      (select summary_date,filter_hash from analytics_daily_summaries order by refreshed_at desc,summary_date desc,filter_hash offset 10000)`;
  }
  async exclusive<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    return this.sql.begin(async (transaction) => { await transaction`select pg_advisory_xact_lock(hashtextextended(${hash}, 1937002026))`; return this.#transaction.run(transaction as unknown as DatabaseClient["sql"], operation); }) as Promise<T>;
  }
}

type UsageQuery = (filters: AnalyticsFilters, period: UsagePeriod) => Promise<readonly UsageDay[]>;
type ParameterQuery = (filters: AnalyticsFilters, page?: Readonly<{ limit?: number; offset?: number }>) => Promise<readonly unknown[]>;

export class AnalyticsService {
  #refresh: Promise<AnalyticsSummary> | null = null;
  readonly #inflight = new Map<string, Promise<AnalyticsSummary>>();
  constructor(private readonly cache: AnalyticsCache, private readonly usageQuery: UsageQuery, private readonly parameterQuery: ParameterQuery, private readonly parameterUsageQuery: ParameterQuery = async () => [], private readonly now = () => new Date()) {}
  async query(filters: AnalyticsFilters, maxAgeMs = 5 * 60_000): Promise<AnalyticsSummary> {
    const hash = canonicalFilterHash(filters);
    const existing = this.#inflight.get(hash); if (existing) return existing;
    const compute = async () => {
      const now = this.now(); const cached = await this.cache.read(hash, new Date(now.getTime() - maxAgeMs)); if (cached) return cached;
      const [daily, weekly, monthly, parameters, parameterUsage] = await Promise.all([this.usageQuery(filters, "day"), this.usageQuery(filters, "week"), this.usageQuery(filters, "month"), this.parameterQuery(filters), this.parameterUsageQuery(filters)]);
      const usagePeriods = Object.freeze({ daily, weekly, monthly });
      const summary = Object.freeze({ filters, usage: daily, usagePeriods, parameters, parameterUsage, refreshedAt: now.toISOString() }); await this.cache.write(hash, summary); return summary;
    };
    const operation = (this.cache.exclusive ? this.cache.exclusive(hash, compute) : compute()).finally(() => { this.#inflight.delete(hash); });
    this.#inflight.set(hash, operation); return operation;
  }
  refreshDefaultWindow(now = this.now()): Promise<AnalyticsSummary> {
    if (this.#refresh) return this.#refresh;
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const fromDate = new Date(`${local}T00:00:00+08:00`); fromDate.setUTCDate(fromDate.getUTCDate() - 30);
    const from = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).format(fromDate);
    this.#refresh = this.query({ from, to: local }, 0).finally(() => { this.#refresh = null; });
    return this.#refresh;
  }
  async parameterPage(filters: AnalyticsFilters, pageSize: number, offset: number) {
    if (!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100||!Number.isSafeInteger(offset)||offset<0||offset>1_000_000) throw new RangeError("INVALID_ANALYTICS_PAGE");
    const rows=await this.parameterQuery(filters,{limit:pageSize+1,offset}); const hasMore=rows.length>pageSize;
    return Object.freeze({ rows:Object.freeze(rows.slice(0,pageSize)), nextOffset:hasMore?offset+pageSize:null });
  }
}
