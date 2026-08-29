import type { DatabaseClient } from "@steam-top/db";
import * as schema from "@steam-top/db/schema";
import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { parameterPerformance } from "./parameters";
import { AnalyticsService, PostgresAnalyticsCache } from "./service";
import { usageAnalytics } from "./usage";
import { parameterUsage } from "./parameter-usage";

export function createProductionAnalytics(client: DatabaseClient): AnalyticsService {
  const snapshotDb=new AsyncLocalStorage<PostgresJsDatabase<typeof schema>>(); const current=()=>snapshotDb.getStore()??client.db;
  const consistent=<T>(operation:()=>Promise<T>)=>client.sql.begin(async(transaction)=>{
    await transaction`set transaction isolation level repeatable read, read only`;
    return snapshotDb.run(drizzle(transaction as never,{schema}),operation);
  }) as Promise<T>;
  return new AnalyticsService(new PostgresAnalyticsCache(client.sql), (filters, period) => usageAnalytics(current(), filters, period), (filters,page) => parameterPerformance(current(), filters,page), (filters) => parameterUsage(current(), filters),undefined,undefined,consistent);
}
