import { createHash } from "node:crypto";

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

export function verifyMigrationSource(source: string) {
  const sha256 = createHash("sha256").update(source).digest("hex");
  if (sha256 !== EXPECTED_MIGRATION_SHA256) throw new Error("MIGRATION_SOURCE_HASH_MISMATCH");
  return Object.freeze({ id: EXPECTED_MIGRATION_ID, sha256 });
}

export async function applyBaselineMigration(executor: MigrationExecutor, source: string): Promise<"applied" | "already-applied"> {
  const manifest = verifyMigrationSource(source);
  return executor.transaction(async (tx) => {
    await tx.prepareLedger();
    await tx.lock();
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
