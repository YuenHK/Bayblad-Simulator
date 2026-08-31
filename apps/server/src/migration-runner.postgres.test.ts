import { createDatabaseClient, type DatabaseClient } from "@steam-top/db";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBaselineMigration, applyMigrations, createPostgresMigrationExecutor, EXPECTED_MIGRATION_ID, EXPECTED_MIGRATION_SHA256, EXPECTED_MIGRATIONS } from "./migration-runner";

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
    expect(Number.isNaN(Date.parse(String(rows[0]?.applied_at)))).toBe(false);
  }, 30_000);

  it("runs the canonical migration runner before the production installation claim", async () => {
    const sources = ["0000_steam_top_pre_first_deploy.sql", "0001_cutover_state_machine.sql", "0002_platform_installation.sql"].map((name) => readFileSync(fileURLToPath(new URL(`../../../drizzle/${name}`, import.meta.url)), "utf8"));
    await applyMigrations(createPostgresMigrationExecutor(worker1!), sources);
    const ledger = await worker1!.sql.unsafe("select id,sha256 from app_schema_migrations order by id") as readonly Record<string, unknown>[];
    expect(ledger).toEqual(EXPECTED_MIGRATIONS.map(({ id, sha256 }) => ({ id, sha256 })));
    const target = new URL(databaseUrl!); target.pathname = `/${databaseName}`;
    const dir = mkdtempSync(join(tmpdir(), "claim-first-installation-"));
    try {
      const service = join(dir, "pg_service.conf");
      writeFileSync(service, `[claim]\nhost=${target.hostname}\nport=${target.port || "5432"}\ndbname=${databaseName}\nuser=${decodeURIComponent(target.username)}\npassword=${decodeURIComponent(target.password)}\nsslmode=disable\n`);
      chmodSync(service, 0o600);
      execFileSync("bash", [fileURLToPath(new URL("../../../scripts/claim-first-installation.sh", import.meta.url)), "a".repeat(64), "b".repeat(64), "c".repeat(64)], { env: { ...process.env, PGSERVICE: "claim", PGSERVICEFILE: service } });
      const rows = await worker1!.sql.unsafe("select host_id,bootstrap_digest,authorization_nonce,generation::text generation from restore_control.platform_installation") as readonly Record<string, unknown>[];
      expect(rows).toEqual([{ host_id: "a".repeat(64), bootstrap_digest: "b".repeat(64), authorization_nonce: "c".repeat(64), generation: "1" }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
