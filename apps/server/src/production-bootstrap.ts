import type { DatabaseClient } from "@steam-top/db";
import { buildApp, type BuildAppOptions } from "./app";
import { createProductionRecordRepositories } from "./records/composition";
import { createProductionAnalytics } from "./analytics/composition";
import { createProductionExportDataSource } from "./exports/postgres-source";
import { PostgresDeletionStore } from "./admin/delete-records";
import { FileDeletionLedger } from "./admin/deletion-ledger";

export async function startProductionServer(
  client: DatabaseClient,
  options: Omit<BuildAppOptions, "designRepository" | "matchRepository" | "roomRecordRepository" | "roomProjectionStore" | "resultRepository" | "deletionStore">,
  listen: Readonly<{ host: string; port: number }>,
) {
  const ledgerPath = process.env.DELETION_LEDGER_FILE; if (!ledgerPath) throw new Error("DELETION_LEDGER_FILE is required");
  const app = buildApp({ ...options, ...createProductionRecordRepositories(client), analyticsService: options.analyticsService ?? createProductionAnalytics(client), exportDataSource: options.exportDataSource ?? createProductionExportDataSource(client), deletionStore: new PostgresDeletionStore(client, 1_000, new FileDeletionLedger(ledgerPath)), requireAuthorityLease: true });
  try { await app.ready(); await app.listen(listen); return app; }
  catch (startupError) {
    try { await app.close(); } catch (closeError) { throw new AggregateError([startupError, closeError], "PRODUCTION_STARTUP_FAILED"); }
    throw startupError;
  }
}
