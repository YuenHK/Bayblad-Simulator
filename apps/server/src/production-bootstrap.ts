import type { DatabaseClient } from "@steam-top/db";
import { buildApp, type BuildAppOptions } from "./app";
import { createProductionRecordRepositories } from "./records/composition";
import { createProductionAnalytics } from "./analytics/composition";
import { createProductionExportDataSource } from "./exports/postgres-source";
import { PostgresDeletionStore } from "./admin/delete-records";
import { FileDeletionLedger } from "./admin/deletion-ledger";
import { PostgresAdminRecordsSource } from "./admin/records-routes";
import { PostgresPlatformSettingsStore } from "./admin/platform-settings";
import { PostgresAdminCommandStore } from "./admin/command-operations";
import { checkDatabaseReadiness, registerHealthRoutes, startFailStopReadinessMonitor, withReadinessDeadline } from "./readiness";

export async function startProductionServer(
  client: DatabaseClient,
  options: Omit<BuildAppOptions, "designRepository" | "matchRepository" | "roomRecordRepository" | "roomProjectionStore" | "resultRepository" | "deletionStore">,
  listen: Readonly<{ host: string; port: number }>,
) {
  const ledgerPath = process.env.DELETION_LEDGER_FILE; if (!ledgerPath) throw new Error("DELETION_LEDGER_FILE is required");const sourceInstanceId=process.env.DELETION_SOURCE_INSTANCE_ID;if(!sourceInstanceId)throw new Error("DELETION_SOURCE_INSTANCE_ID is required");const marker=(await client.sql.unsafe("select restore_target_id from restore_control.deployment_environment where singleton=true")) as readonly Record<string,unknown>[];if(String(marker[0]?.restore_target_id??marker[0]?.restoreTargetId)!==sourceInstanceId)throw new Error("DELETION_SOURCE_INSTANCE_ID mismatch");
  const runReadiness = () => withReadinessDeadline((signal) => checkDatabaseReadiness(client.sql, signal));
  await runReadiness();
  const app = buildApp({ ...options, ...createProductionRecordRepositories(client), analyticsService: options.analyticsService ?? createProductionAnalytics(client), exportDataSource: options.exportDataSource ?? createProductionExportDataSource(client), deletionStore: new PostgresDeletionStore(client, 1_000, new FileDeletionLedger(ledgerPath)), adminRecordsSource: options.adminRecordsSource ?? new PostgresAdminRecordsSource(client.sql), platformSettingsStore: options.platformSettingsStore ?? new PostgresPlatformSettingsStore(client), adminCommandStore: options.adminCommandStore ?? new PostgresAdminCommandStore(client), requireAuthorityLease: true });
  let readinessHealthy = true;
  registerHealthRoutes(app, async () => { if (!readinessHealthy) throw new Error("FAIL_STOP_READINESS_LOST"); return runReadiness(); });
  app.addHook("onRequest", async (request, reply) => { if (!readinessHealthy && !request.url.startsWith("/health/")) return reply.code(503).send({ error: "SERVICE_NOT_READY" }); });
  let cancelReadinessMonitor: (() => void) | undefined;
  app.addHook("onClose", async () => { cancelReadinessMonitor?.(); });
  try { await app.ready(); await app.listen(listen); cancelReadinessMonitor = startFailStopReadinessMonitor({ check: (signal) => checkDatabaseReadiness(client.sql, signal), markUnhealthy: (error) => { readinessHealthy = false; process.exitCode = 1; app.log.error({ event: "readiness.lost", errorName: error instanceof Error ? error.name : "Error" }, "Readiness lost; fail-stop shutdown"); }, stop: async () => { await app.close(); await client.close(); }, reportStopFailure: (closeError) => app.log.error({ event: "readiness.shutdown_failed", errorName: closeError instanceof Error ? closeError.name : "Error" }, "Fail-stop shutdown failed") }); return app; }
  catch (startupError) {
    try { await app.close(); } catch (closeError) { throw new AggregateError([startupError, closeError], "PRODUCTION_STARTUP_FAILED"); }
    throw startupError;
  }
}
