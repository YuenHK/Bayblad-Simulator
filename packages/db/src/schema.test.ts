import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  normalizeRelation,
} from "drizzle-orm/relations";
import { describe, expect, it, vi } from "vitest";

import { battleAuthorityKeyHash } from "./authority";
import {
  createDatabaseClient,
  type SqlClientFactory,
} from "./client";
import { buildMatchWithDetailsQuery } from "./queries";
import * as schema from "./schema";

const tableConfig = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table);

const durableTables = [
  schema.identities,
  schema.identityLinks,
  schema.identitySessions,
  schema.designs,
  schema.designLayers,
  schema.rooms,
  schema.roomParticipants,
  schema.matches,
  schema.rounds,
  schema.adminUsers,
  schema.adminSessions,
  schema.adminAudit,
  schema.deletionAudit,
  schema.deletionOperations,
  schema.deletionLedgerOutbox,
] as const;

describe("persistent PostgreSQL schema", () => {
  it("defines every durable identity, design, room, match and admin table", () => {
    expect(durableTables.map((table) => tableConfig(table).name)).toEqual([
      "identities",
      "identity_links",
      "identity_sessions",
      "designs",
      "design_layers",
      "rooms",
      "room_participants",
      "matches",
      "rounds",
      "admin_users",
      "admin_sessions",
      "admin_audit",
      "deletion_audit",
      "deletion_operations",
      "deletion_ledger_outbox",
    ]);
  });

  it("uses inet only as diagnostic data and never stores a MAC address", () => {
    const diagnosticTables = [
      schema.identitySessions,
      schema.roomParticipants,
      schema.matches,
      schema.adminSessions,
      schema.adminAudit,
    ];

    for (const table of diagnosticTables) {
      const config = tableConfig(table);
      const ipColumns = config.columns.filter((column) =>
        column.name.endsWith("_ip"),
      );
      expect(ipColumns.length).toBeGreaterThan(0);
      expect(ipColumns.every((column) => column.getSQLType() === "inet")).toBe(
        true,
      );
    }

    const allColumnNames = durableTables.flatMap((table) =>
      tableConfig(table).columns.map(({ name }) => name),
    );
    expect(allColumnNames.some((name) => name.includes("mac"))).toBe(false);
    for (const table of diagnosticTables) {
      expect(tableConfig(table).columns.map(({ name }) => name)).not.toContain(
        "diagnostics_expires_at",
      );
    }
  });

  it("bounds student PII fields and does not duplicate canonical designs as JSON", () => {
    for (const [column, sqlType] of [
      [schema.identities.displayName, "varchar(80)"],
      [schema.identities.studentName, "varchar(80)"],
      [schema.identities.className, "varchar(30)"],
      [schema.identities.studentNumber, "varchar(30)"],
      [schema.identities.deviceName, "varchar(128)"],
    ] as const) {
      expect(column.getSQLType()).toBe(sqlType);
    }
    expect(tableConfig(schema.designs).columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["canonical_json", "performance_json"]),
    );
  });

  it("declares database checks and indexes for canonical designs and completed matches", () => {
    expect(tableConfig(schema.designs).columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["battle_eligible", "validation_issues"]),
    );
    expect(
      tableConfig(schema.designLayers).checks.map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining([
        "design_layers_order_range",
        "design_layers_points_range",
        "design_layers_diameter_range",
        "design_layers_roundness_range",
        "design_layers_rotation_range",
        "design_layers_color_format",
      ]),
    );
    expect(tableConfig(schema.designs).checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "designs_version_positive",
        "designs_screw_count_range",
        "designs_screw_radius_range",
        "designs_metal_disc_range",
        "designs_metal_disc_placement",
        "designs_physics_values_positive",
        "designs_performance_range",
        "designs_model_versions_nonblank",
      ]),
    );
    expect(tableConfig(schema.matches).checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "matches_completed_score_shape",
        "matches_battle_points_range",
        "matches_challenge_points_range",
        "matches_round_winners_shape",
        "matches_totals_consistent",
        "matches_distinct_player_identities",
        "matches_model_versions_nonblank",
        "matches_protocol_version_positive",
      ]),
    );
    expect(tableConfig(schema.rounds).checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "rounds_number_range",
        "rounds_attempt_positive",
        "rounds_ticks_nonnegative",
        "rounds_launch_multiplier_range",
        "rounds_authority_key_hash_format",
        "rounds_input_fingerprint_format",
        "rounds_physics_model_version_nonblank",
        "rounds_battle_result_shape",
      ]),
    );

    expect(tableConfig(schema.matches).indexes.map(({ config }) => config.name))
      .toEqual(
        expect.arrayContaining([
          "matches_completed_at_idx",
          "matches_status_completed_at_idx",
          "matches_player1_identity_idx",
          "matches_player2_identity_idx",
          "matches_model_versions_idx",
        ]),
      );
    expect(tableConfig(schema.designLayers).indexes.map(({ config }) => config.name))
      .toEqual(expect.arrayContaining(["design_layers_parameter_analytics_idx"]));
    const roundIndexConfig = tableConfig(schema.rounds).indexes.map(
      ({ config }) => ({ name: config.name, unique: config.unique }),
    );
    expect(roundIndexConfig).toEqual(
      expect.arrayContaining([
        { name: "rounds_authority_key_hash_uidx", unique: true },
        { name: "rounds_match_external_round_id_uidx", unique: true },
        { name: "rounds_input_fingerprint_idx", unique: false },
      ]),
    );
    expect(roundIndexConfig.some(({ name }) => name === "rounds_match_number_idx"))
      .toBe(false);
    expect(tableConfig(schema.roomParticipants).indexes.map(({ config }) => config.name))
      .toContain("room_participants_active_player_seat_uidx");
  });

  it("normalizes every declared relation and compiles the admin inverse graph", () => {
    const relational = extractTablesRelationalConfig(
      schema,
      createTableRelationsHelpers,
    );
    for (const table of Object.values(relational.tables)) {
      for (const relation of Object.values(table.relations)) {
        expect(() =>
          normalizeRelation(
            relational.tables,
            relational.tableNamesMap,
            relation,
          ),
        ).not.toThrow();
      }
    }

    const db = drizzle.mock({ schema });
    const compiled = db.query.adminUsers.findMany({
      with: {
        sessions: { with: { auditEntries: true } },
        auditEntries: { with: { adminSession: true, adminUser: true } },
        deletionEntries: { with: { adminUser: true } },
      },
    }).toSQL();
    expect(compiled.sql).toContain("auditEntries");
    expect(compiled.sql).toContain("deletionEntries");
  });

  it("hashes the exact BattleEngine match/round correlation independently of input", () => {
    const first = battleAuthorityKeyHash("match-1", "round-1");
    const second = battleAuthorityKeyHash("match-1", "round-2");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(
      "f51a2b781772b8c4e9cbc9e5347376230b7bf0a7613c86612f3b28a96b29804c",
    );
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(() => battleAuthorityKeyHash("match 1", "round-1")).toThrow(
      "Invalid correlation key",
    );
  });

  it("compiles one complete match query with rounds, identities and both design snapshots", () => {
    const db = drizzle.mock({ schema });
    const query = buildMatchWithDetailsQuery(
      db,
      "00000000-0000-4000-8000-000000000001",
    );
    const compiled = query.toSQL();

    expect(compiled.params).toContain(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(compiled.sql).toContain('from "matches"');
    for (const relation of [
      "rounds",
      "player1Identity",
      "player2Identity",
      "player1Design",
      "player2Design",
      "layers",
    ]) {
      expect(compiled.sql).toContain(relation);
    }
  });

  it("creates a lazy typed client with configurable SSL and an idempotent close", async () => {
    const end = vi.fn(async () => undefined);
    const fakeSql = Object.assign(vi.fn(), {
      end,
      options: { parsers: {}, serializers: {} },
    });
    const createSqlClient = vi.fn(() => fakeSql);

    const client = createDatabaseClient(
      {
        url: "postgres://app:secret@db.example.test/simulator",
        ssl: "require",
        maxConnections: 7,
        idleTimeoutSeconds: 15,
      },
      { createSqlClient: createSqlClient as unknown as SqlClientFactory },
    );

    expect(createSqlClient).toHaveBeenCalledWith(
      "postgres://app:secret@db.example.test/simulator",
      expect.objectContaining({
        ssl: "require",
        max: 7,
        idle_timeout: 15,
      }),
    );
    expect(client.db).toBeDefined();
    await client.close();
    await client.close();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("requires TLS unless development explicitly opts into an insecure connection", () => {
    const createSqlClient = vi.fn(() => {
      throw new Error("must not connect");
    });
    expect(() => createDatabaseClient(
      { url: "postgresql://localhost/simulator" },
      { createSqlClient: createSqlClient as unknown as SqlClientFactory },
    )).toThrow("TLS is required");
    expect(createSqlClient).not.toHaveBeenCalled();

    for (const ssl of [false, "allow", "prefer", undefined, { rejectUnauthorized: false }] as const) {
      expect(() => createDatabaseClient(
        { url: "postgresql://db.example/simulator", ssl },
        {
          createSqlClient: createSqlClient as unknown as SqlClientFactory,
          runtimeEnvironment: "production",
        },
      )).toThrow("TLS is required");
    }

    for (const ssl of [true, "require", "verify-full", {}] as const) {
      const end = vi.fn(async () => undefined);
      const fakeSql = Object.assign(vi.fn(), {
        end,
        options: { parsers: {}, serializers: {} },
      });
      const secureFactory = vi.fn(() => fakeSql);
      expect(() => createDatabaseClient(
        { url: "postgresql://db.example/simulator", ssl },
        {
          createSqlClient: secureFactory as unknown as SqlClientFactory,
          runtimeEnvironment: "production",
        },
      )).not.toThrow();
    }

    expect(() => createDatabaseClient(
      { url: "postgresql://localhost/simulator", allowInsecure: true },
      {
        createSqlClient: createSqlClient as unknown as SqlClientFactory,
        runtimeEnvironment: "production",
      },
    )).toThrow("Insecure database connections are forbidden in production");
    expect(createSqlClient).not.toHaveBeenCalled();
  });

  it("commits generated SQL containing constraints, FKs, indexes and no credential", () => {
    const migrationDirectory = fileURLToPath(
      new URL("../../../drizzle", import.meta.url),
    );
    const migrationFiles = readdirSync(migrationDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrationFiles).toEqual(["0000_steam_top_pre_first_deploy.sql", "0001_cutover_state_machine.sql"]);
    const sql = migrationFiles
      .map((name) => readFileSync(`${migrationDirectory}/${name}`, "utf8"))
      .join("\n");

    expect(sql).toContain('CREATE TABLE "matches"');
    expect(sql).toContain('CREATE TABLE "rounds"');
    expect(sql).toMatch(/CREATE TABLE "room_projection_jobs"[\s\S]*?"reservation_token" uuid[\s\S]*?room_projection_jobs_reservation/);
    expect(sql.match(/"reservation_token" uuid/g)).toHaveLength(1);
    expect(sql).toContain("matches_completed_score_shape");
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    expect(sql).toContain("rounds_authority_key_matches_correlation");
    expect(sql).toMatch(/battle_result_json"->>'seed'\)::numeric = "rounds"\."seed"::numeric/);
    expect(sql).toMatch(/battle_result_json"->>'ticks'\)::numeric = "rounds"\."ticks"::numeric/);
    expect(sql).toContain("steam_top.deletion_audit_id");
    expect(sql).toContain("txid_current()");
    expect(sql).toContain("deletion_audit_is_immutable");
    expect(sql).not.toContain("steam_top.allow_audited_delete");
    expect(sql).not.toContain("diagnostics_expires_at");
    expect(sql).toContain("completed_matches_are_immutable");
    expect(sql).toContain("completed_rounds_are_immutable");
    expect(sql).toContain("eligible_designs_are_immutable");
    expect(sql).toContain("set_row_updated_at");
    expect(sql).toContain("designs_battle_eligible_three_layers");
    expect(sql).toContain("room_participants_active_player_seat_uidx");
    expect(sql).toContain("identity_sessions_active_expires_at_idx");
    for (const requiredObject of [
      'CREATE TABLE "admin_login_limits"', 'CREATE TABLE "admin_reauth_grants"',
      'admin_login_limits_updated_idx', 'admin_reauth_grants_token_uidx',
      'admin_sessions_active_idx', 'admin_audit_append_only_guard',
      'CREATE TABLE "analytics_daily_summaries"', 'analytics_daily_summaries_refreshed_idx',
      'CREATE TABLE "device_activity_days"', 'CREATE TABLE "design_event_snapshots"',
      'CREATE TABLE "match_participant_snapshots"', 'CREATE TABLE "room_event_snapshots"',
      'analytics_snapshot_append_only_guard',
      'admin_audit_append_only', 'admin_audit_no_truncate',
      'steam_top_assert_battle_eligible_design_layers', 'steam_top_check_round_authority_key',
      'steam_top_current_delete_is_audited', 'steam_top_protect_eligible_design',
      'steam_top_protect_eligible_design_layer', 'steam_top_protect_completed_match',
      'steam_top_protect_authoritative_round', 'steam_top_protect_deletion_audit',
    ]) expect(sql).toContain(requiredObject);
    const adminSessionSql = sql.match(/CREATE TABLE "admin_sessions" \([\s\S]*?\n\);/)?.[0];
    const identitySessionSql = sql.match(/CREATE TABLE "identity_sessions" \([\s\S]*?\n\);/)?.[0];
    expect(adminSessionSql).toContain('"archived_at" timestamp with time zone');
    expect(identitySessionSql).toContain('"archived_at" timestamp with time zone');
    expect(sql).not.toContain("identities_guest_display_name_uidx");
    expect(sql).toContain("ON DELETE set null");
    expect(sql).toContain("ON DELETE cascade");
    expect(sql.toLowerCase()).not.toContain("fwft2026");
    expect(sql.toLowerCase()).not.toMatch(/mac[_ ]?address/);

    const config = readFileSync(
      fileURLToPath(new URL("../../../drizzle.config.ts", import.meta.url)),
      "utf8",
    );
    expect(`${config}\n${sql}`).not.toMatch(
      /postgres(?:ql)?:\/\/[^\s/:]+:[^\s/@]+@/i,
    );
    expect(config).toContain("postgresql://localhost/steam_top_schema_generation");

    const metadataFiles = readdirSync(`${migrationDirectory}/meta`).sort();
    expect(metadataFiles).toEqual(["0000_snapshot.json", "_journal.json"]);
    const journal = JSON.parse(
      readFileSync(`${migrationDirectory}/meta/_journal.json`, "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries).toEqual([
      expect.objectContaining({ tag: "0000_steam_top_pre_first_deploy" }),
      expect.objectContaining({ tag: "0001_cutover_state_machine" }),
    ]);
    const snapshot = JSON.parse(
      readFileSync(`${migrationDirectory}/meta/0000_snapshot.json`, "utf8"),
    ) as { tables: Record<string, { columns: Record<string, unknown> }> };
    expect(snapshot.tables["public.admin_sessions"]?.columns).toHaveProperty("archived_at");
    expect(snapshot.tables["public.identity_sessions"]?.columns).toHaveProperty("archived_at");
    expect(snapshot.tables).toHaveProperty("public.admin_login_limits");
    expect(snapshot.tables).toHaveProperty("public.admin_reauth_grants");
    expect(snapshot.tables).toHaveProperty("public.analytics_daily_summaries");
    expect(snapshot.tables).toHaveProperty("public.device_activity_days");
    expect(snapshot.tables).toHaveProperty("public.design_event_snapshots");
    expect(snapshot.tables).toHaveProperty("public.match_participant_snapshots");
    expect(snapshot.tables).toHaveProperty("public.room_event_snapshots");
    expect(snapshot.tables).toHaveProperty("public.platform_settings");
    expect(snapshot.tables).toHaveProperty("public.admin_command_operations");
    expect(snapshot.tables["public.match_participant_snapshots"]?.columns).toHaveProperty("display_name_snapshot");
    expect(tableConfig(schema.adminAudit).indexes.map(({ config }) => config.name)).toContain("admin_audit_command_correlation_uidx");
  });
});
