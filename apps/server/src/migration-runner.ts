import { createHash } from "node:crypto";
import type { DatabaseClient } from "@steam-top/db";

export const EXPECTED_MIGRATION_ID = "0000_steam_top_pre_first_deploy";
export const EXPECTED_MIGRATION_SHA256 = "48386c47be2562e241cb520f17cd2cd6d00ca221be6e84860ccebc4ac52c2be8";

type MigrationTransaction = Readonly<{
  prepareLedger(): Promise<void>;
  lock(): Promise<void>;
  queryMigration(id: string): Promise<Readonly<{ id: string; sha256: string }> | null>;
  hasApplicationSchema(): Promise<boolean>;
  execute(statement: string): Promise<void>;
  insertMigration(id: string, sha256: string): Promise<void>;
}>;
export type MigrationExecutor = Readonly<{ transaction<T>(operation: (tx: MigrationTransaction) => Promise<T>): Promise<T> }>;

export function createPostgresMigrationExecutor(client: DatabaseClient): MigrationExecutor {
  return {
    transaction: async <T>(operation: (tx: MigrationTransaction) => Promise<T>) => client.sql.begin(async (sql) => operation({
      lock: async () => { await sql.unsafe("select pg_advisory_xact_lock(1937002750)"); },
      prepareLedger: async () => { await sql.unsafe("create table if not exists public.app_schema_migrations (id text primary key, sha256 char(64) not null check (sha256 ~ '^[a-f0-9]{64}$'), applied_at timestamptz not null default now())"); },
      queryMigration: async (id) => { const rows = await sql.unsafe("select id, sha256 from public.app_schema_migrations where id=$1", [id]) as readonly Record<string, unknown>[]; return rows[0] ? { id: String(rows[0].id), sha256: String(rows[0].sha256) } : null; },
      hasApplicationSchema: async () => { const rows = await sql.unsafe("select to_regclass('public.identities') is not null or to_regclass('public.matches') is not null or to_regnamespace('restore_control') is not null as partial") as readonly Record<string, unknown>[]; return rows[0]?.partial === true; },
      execute: async (statement) => { await sql.unsafe(statement); },
      insertMigration: async (id, sha256) => { await sql.unsafe("insert into public.app_schema_migrations(id,sha256) values ($1,$2)", [id, sha256]); },
    })) as unknown as T,
  };
}

export function verifyMigrationSource(source: string) {
  const sha256 = createHash("sha256").update(source).digest("hex");
  if (sha256 !== EXPECTED_MIGRATION_SHA256) throw new Error("MIGRATION_SOURCE_HASH_MISMATCH");
  return Object.freeze({ id: EXPECTED_MIGRATION_ID, sha256 });
}

export async function applyBaselineMigration(executor: MigrationExecutor, source: string): Promise<"applied" | "already-applied"> {
  const manifest = verifyMigrationSource(source);
  return executor.transaction(async (tx) => {
    await tx.lock();
    await tx.prepareLedger();
    const current = await tx.queryMigration(manifest.id);
    if (current) {
      if (current.sha256 !== manifest.sha256) throw new Error("MIGRATION_HASH_MISMATCH");
      return "already-applied";
    }
    if (await tx.hasApplicationSchema()) throw new Error("MIGRATION_PARTIAL_OR_UNTRACKED_STATE");
    const statements = source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean);
    if (statements.length === 0) throw new Error("MIGRATION_SOURCE_EMPTY");
    for (const statement of statements) await tx.execute(statement);
    await tx.insertMigration(manifest.id, manifest.sha256);
    return "applied";
  });
}
