import type { DatabaseClient } from "@steam-top/db";
import { parameterPerformance } from "./parameters";
import { AnalyticsService, PostgresAnalyticsCache } from "./service";
import { usageAnalytics } from "./usage";

export function createProductionAnalytics(client: DatabaseClient): AnalyticsService {
  return new AnalyticsService(new PostgresAnalyticsCache(client.sql), (filters, period) => usageAnalytics(client.db, filters, period), (filters) => parameterPerformance(client.db, filters));
}
