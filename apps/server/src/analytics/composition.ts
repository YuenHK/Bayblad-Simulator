import type { DatabaseClient } from "@steam-top/db";
import * as schema from "@steam-top/db/schema";
import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { overallLaunchDistribution, parameterPerformance } from "./parameters";
import { AnalyticsService, PostgresAnalyticsCache } from "./service";
import { usageAnalytics } from "./usage";
import { parameterUsage } from "./parameter-usage";

export function createProductionAnalytics(client: DatabaseClient): AnalyticsService {
  const configuredSecret=process.env.ANALYTICS_CURSOR_SECRET;const cursorSecret=configuredSecret?Buffer.from(configuredSecret,"base64url"):undefined;
  if(process.env.NODE_ENV==="production"&&(!cursorSecret||cursorSecret.length<32))throw new TypeError("ANALYTICS_CURSOR_SECRET must contain at least 32 bytes");
  const cache=new PostgresAnalyticsCache(client.sql);const snapshotDb=new AsyncLocalStorage<PostgresJsDatabase<typeof schema>>(); const current=()=>snapshotDb.getStore()??client.db;
  const consistent=<T>(operation:()=>Promise<T>)=>snapshotDb.run(drizzle(cache.currentExecutor() as never,{schema}),operation);
  return new AnalyticsService(cache, (filters, period,cutoff) => usageAnalytics(current(), filters, period,cutoff), (filters,page) => parameterPerformance(current(), filters,page), (filters,page) => parameterUsage(current(), filters,page?.asOf),undefined,cursorSecret,consistent,(filters,cutoff)=>overallLaunchDistribution(current(),filters,cutoff));
}
