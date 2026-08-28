import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";

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
      ]),
    );
    expect(tableConfig(schema.matches).checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "matches_completed_score_shape",
        "matches_challenge_points_range",
        "matches_totals_consistent",
        "matches_distinct_player_identities",
      ]),
    );
    expect(tableConfig(schema.rounds).checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "rounds_number_range",
        "rounds_attempt_positive",
        "rounds_ticks_nonnegative",
        "rounds_launch_multiplier_range",
        "rounds_result_fingerprint_format",
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

  it("commits generated SQL containing constraints, FKs, indexes and no credential", () => {
    const migrationDirectory = fileURLToPath(
      new URL("../../../drizzle", import.meta.url),
    );
    const migrationFiles = readdirSync(migrationDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrationFiles.length).toBeGreaterThan(0);
    const sql = migrationFiles
      .map((name) => readFileSync(`${migrationDirectory}/${name}`, "utf8"))
      .join("\n");

    expect(sql).toContain('CREATE TABLE "matches"');
    expect(sql).toContain('CREATE TABLE "rounds"');
    expect(sql).toContain("matches_completed_score_shape");
    expect(sql).toContain("ON DELETE set null");
    expect(sql).toContain("ON DELETE cascade");
    expect(sql.toLowerCase()).not.toContain("fwft2026");
    expect(sql.toLowerCase()).not.toMatch(/mac[_ ]?address/);
  });
});
