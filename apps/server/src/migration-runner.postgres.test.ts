import { createDatabaseClient, type DatabaseClient } from "@steam-top/db";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBaselineMigration, createPostgresMigrationExecutor, EXPECTED_MIGRATION_ID, EXPECTED_MIGRATION_SHA256 } from "./migration-runner";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseName = `migration_${randomUUID().replaceAll("-", "")}`;
let admin: DatabaseClient | undefined;
let worker1: DatabaseClient | undefined;
let worker2: DatabaseClient | undefined;

describe.skipIf(!databaseUrl)("baseline migration PostgreSQL concurrency", () => {
  beforeAll(async () => {
    admin = createDatabaseClient({ url: databaseUrl!, ssl: false, allowInsecure: true, maxConnections: 1 }, { runtimeEnvironment: "test" });
    await admin.sql.unsafe(`create database "${databaseName}"`);
    const target = new URL(databaseUrl!); target.pathname = `/${databaseName}`;
    worker1 = createDatabaseClient({ url: target.toString(), ssl: false, allowInsecure: true, maxConnections: 1 }, { runtimeEnvironment: "test" });
    worker2 = createDatabaseClient({ url: target.toString(), ssl: false, allowInsecure: true, maxConnections: 1 }, { runtimeEnvironment: "test" });
  }, 30_000);

  afterAll(async () => {
    await worker1?.close(); await worker2?.close();
    if (admin) { await admin.sql.unsafe(`drop database if exists "${databaseName}" with (force)`); await admin.close(); }
  }, 30_000);

  it("serializes two first-boot workers before any catalog creation", async () => {
    const source = readFileSync(fileURLToPath(new URL("../../../drizzle/0000_steam_top_pre_first_deploy.sql", import.meta.url)), "utf8");
    const outcomes = await Promise.all([
      applyBaselineMigration(createPostgresMigrationExecutor(worker1!), source),
      applyBaselineMigration(createPostgresMigrationExecutor(worker2!), source),
    ]);
    expect(outcomes.sort()).toEqual(["already-applied", "applied"]);
    const rows = await worker1!.sql.unsafe("select id, sha256, applied_at from public.app_schema_migrations") as readonly Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: EXPECTED_MIGRATION_ID, sha256: EXPECTED_MIGRATION_SHA256 });
    expect(rows[0]?.applied_at).toBeInstanceOf(Date);
  }, 30_000);
});
