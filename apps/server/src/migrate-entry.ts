import { createDatabaseClient } from "@steam-top/db";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { applyMigrations, createPostgresMigrationExecutor } from "./migration-runner";

const requiredFile = (name: string): string => {
  const path = process.env[`${name}_FILE`];
  const direct = process.env[name];
  if (path && direct) throw new Error(`${name}_SOURCE_AMBIGUOUS`);
  const value = path ? readFileSync(path, "utf8").trim() : direct?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

async function main() {
  const url = requiredFile("DATABASE_URL");
  const client = createDatabaseClient({ url, ssl: "require", applicationName: "steam-top-migration", maxConnections: 1 }, { runtimeEnvironment: "production" });
  const executor = createPostgresMigrationExecutor(client);
  try {
    const sources = ["0000_steam_top_pre_first_deploy.sql", "0001_cutover_state_machine.sql", "0002_platform_installation.sql", "0003_postgresql_catalog_array_compatibility.sql"].map((name) => readFileSync(`/app/drizzle/${name}`, "utf8"));
    const outcome = await applyMigrations(executor, sources);
    const markerRows = await client.sql.unsafe("select restore_target_id from restore_control.deployment_environment where singleton=true") as readonly Record<string, unknown>[];
    const marker = String(markerRows[0]?.restore_target_id ?? "");
    if (!/^[0-9a-f-]{36}$/iu.test(marker)) throw new Error("RESTORE_TARGET_ID_MISSING");
    const markerPath = process.env.DEPLOYMENT_MARKER_FILE ?? "/var/lib/steam-top-state/restore-target-id";
    await mkdir("/var/lib/steam-top-state", { recursive: true, mode: 0o700 });
    await writeFile(`${markerPath}.tmp`, `${marker}\n`, { mode: 0o600 });
    await rename(`${markerPath}.tmp`, markerPath);
    process.stdout.write(`${JSON.stringify({ event: "migration.complete", outcome })}\n`);
  } finally { await client.close(); }
}

void main().catch((error: unknown) => {
  const candidate = error as { message?: unknown };
  process.stderr.write(`${JSON.stringify({ level: "fatal", event: "migration.failed", code: typeof candidate.message === "string" ? candidate.message.slice(0, 120) : "MIGRATION_FAILED" })}\n`);
  process.exitCode = 1;
});
