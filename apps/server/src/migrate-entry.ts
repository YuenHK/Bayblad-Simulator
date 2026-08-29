import { createDatabaseClient } from "@steam-top/db";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { applyBaselineMigration, type MigrationExecutor } from "./migration-runner";

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
  const executor: MigrationExecutor = {
    transaction: (operation) => client.sql.begin(async (sql) => operation({
      prepareLedger: async () => { await sql.unsafe("create table if not exists public.app_schema_migrations (id text primary key, sha256 char(64) not null check (sha256 ~ '^[a-f0-9]{64}$'), applied_at timestamptz not null default now())"); },
      lock: async () => { await sql.unsafe("select pg_advisory_xact_lock(1937002750)"); },
      queryMigration: async (id) => { const rows = await sql.unsafe("select id, sha256 from public.app_schema_migrations where id=$1", [id]) as readonly Record<string, unknown>[]; return rows[0] ? { id: String(rows[0].id), sha256: String(rows[0].sha256) } : null; },
      hasApplicationSchema: async () => { const rows = await sql.unsafe("select to_regclass('public.identities') is not null or to_regclass('public.matches') is not null or to_regnamespace('restore_control') is not null as partial") as readonly Record<string, unknown>[]; return rows[0]?.partial === true; },
      execute: async (statement) => { await sql.unsafe(statement); },
      insertMigration: async (id, sha256) => { await sql.unsafe("insert into public.app_schema_migrations(id,sha256) values ($1,$2)", [id, sha256]); },
    })) as Promise<unknown> as ReturnType<typeof operation>,
  };
  try {
    const source = readFileSync("/app/drizzle/0000_steam_top_pre_first_deploy.sql", "utf8");
    const outcome = await applyBaselineMigration(executor, source);
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
