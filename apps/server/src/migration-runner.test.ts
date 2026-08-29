import { describe, expect, it, vi } from "vitest";
import { applyBaselineMigration, EXPECTED_MIGRATION_ID, EXPECTED_MIGRATION_SHA256, verifyMigrationSource } from "./migration-runner";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../../../drizzle/0000_steam_top_pre_first_deploy.sql", import.meta.url)), "utf8");

function executor(input: { ledger?: { id: string; sha256: string }; partial?: boolean; failApply?: boolean } = {}) {
  const executed: string[] = [];
  const insert = vi.fn(async () => undefined);
  return {
    executed,
    insert,
    value: {
      transaction: async <T>(operation: (tx: never) => Promise<T>) => operation({
        prepareLedger: async () => { executed.push("prepare-ledger"); },
        lock: async () => { executed.push("advisory-lock"); },
        queryMigration: async () => input.ledger ?? null,
        hasApplicationSchema: async () => input.partial ?? false,
        execute: async (sql: string) => { executed.push(sql); if (input.failApply && sql.includes("CREATE SCHEMA")) throw new Error("apply failed"); },
        insertMigration: insert,
      } as never),
    },
  };
}

describe("single baseline migration", () => {
  it("pins the committed source to the exact expected SHA-256", () => {
    expect(verifyMigrationSource(source)).toEqual({ id: EXPECTED_MIGRATION_ID, sha256: EXPECTED_MIGRATION_SHA256 });
  });

  it("applies a fresh baseline atomically and records its hash", async () => {
    const target = executor();
    await expect(applyBaselineMigration(target.value, source)).resolves.toBe("applied");
    expect(target.executed.slice(0, 2)).toEqual(["advisory-lock", "prepare-ledger"]);
    expect(target.executed.some((statement) => statement.includes("CREATE SCHEMA"))).toBe(true);
    expect(target.insert).toHaveBeenCalledWith(EXPECTED_MIGRATION_ID, EXPECTED_MIGRATION_SHA256);
  });

  it("is idempotent only when the ledger hash is exact", async () => {
    const exact = executor({ ledger: { id: EXPECTED_MIGRATION_ID, sha256: EXPECTED_MIGRATION_SHA256 } });
    await expect(applyBaselineMigration(exact.value, source)).resolves.toBe("already-applied");
    expect(exact.executed).toEqual(["advisory-lock", "prepare-ledger"]);
    await expect(applyBaselineMigration(executor({ ledger: { id: EXPECTED_MIGRATION_ID, sha256: "0".repeat(64) } }).value, source)).rejects.toThrow("MIGRATION_HASH_MISMATCH");
  });

  it("fails closed for an untracked partial schema and rolls back failed application", async () => {
    await expect(applyBaselineMigration(executor({ partial: true }).value, source)).rejects.toThrow("MIGRATION_PARTIAL_OR_UNTRACKED_STATE");
    const failed = executor({ failApply: true });
    await expect(applyBaselineMigration(failed.value, source)).rejects.toThrow("apply failed");
    expect(failed.insert).not.toHaveBeenCalled();
  });
});
