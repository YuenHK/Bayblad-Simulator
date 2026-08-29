import type { DatabaseClient } from "@steam-top/db";
import { buildApp, type BuildAppOptions } from "./app";
import { createProductionRecordRepositories } from "./records/composition";

export async function startProductionServer(
  client: DatabaseClient,
  options: Omit<BuildAppOptions, "designRepository" | "matchRepository" | "roomRecordRepository" | "roomProjectionStore" | "resultRepository">,
  listen: Readonly<{ host: string; port: number }>,
) {
  const app = buildApp({ ...options, ...createProductionRecordRepositories(client) });
  await app.ready();
  await app.listen(listen);
  return app;
}
