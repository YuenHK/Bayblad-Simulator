import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type TransactionSql } from "postgres";
import { expect, it } from "vitest";

import { battleAuthorityKeyHash } from "./authority";
import { matchWithDetails } from "./queries";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const rollbackSentinel = new Error("ROLLBACK_POSTGRES_SCHEMA_FIXTURE");

const ids = {
  identity1: "00000000-0000-4000-8000-000000000001",
  identity2: "00000000-0000-4000-8000-000000000002",
  logicalDesign1: "10000000-0000-4000-8000-000000000001",
  logicalDesign2: "10000000-0000-4000-8000-000000000002",
  design1: "20000000-0000-4000-8000-000000000001",
  design2: "20000000-0000-4000-8000-000000000002",
  match: "30000000-0000-4000-8000-000000000001",
  round1: "40000000-0000-4000-8000-000000000001",
  round2: "40000000-0000-4000-8000-000000000002",
} as const;

function migrationStatements(): string[] {
  const directory = fileURLToPath(new URL("../../../drizzle", import.meta.url));
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .flatMap((name) =>
      readFileSync(`${directory}/${name}`, "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean),
    );
}

async function applyMigrations(transaction: TransactionSql): Promise<void> {
  for (const statement of migrationStatements()) {
    await transaction.unsafe(statement);
  }
}

async function inEmptyMigratedDatabase(
  run: (transaction: TransactionSql) => Promise<void>,
): Promise<void> {
  const sql = postgres(testDatabaseUrl!, { max: 1 });
  try {
    await sql.begin(async (transaction) => {
      await applyMigrations(transaction);
      await run(transaction);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function insertDesign(
  transaction: TransactionSql,
  id: string,
  battleEligible: boolean,
): Promise<void> {
  await transaction.unsafe(
    `insert into designs (
      id, logical_design_id, version, schema_version, name,
      screw_count, screw_radius_mm, screw_rotation_deg,
      metal_disc_diameter_mm, total_mass_g, polar_moment_gmm2,
      center_of_mass_x_mm, center_of_mass_y_mm,
      performance_speed, performance_spin_duration, performance_stability,
      performance_impact_resistance, performance_model_version,
      canonical_json, performance_json, battle_eligible, validation_issues
    ) values (
      $1, $1, 1, '1', 'fixture', 4, 12, 0, 0, 40, 12000, 0, 0,
      60, 65, 70, 55, '1.0.0', '{}', '{}', $2, '[]'
    )`,
    [id, battleEligible],
  );
}

async function insertLayer(
  transaction: TransactionSql,
  designId: string,
  layerOrder: number,
): Promise<void> {
  const position = ["top", "middle", "bottom"][layerOrder]!;
  await transaction.unsafe(
    `insert into design_layers (
      design_id, source_layer_id, layer_order, position, shape, points,
      diameter_mm, corner_roundness, rotation_deg, color
    ) values ($1, $2, $3, $4, 'circle', 6, 40, 0.5, 0, '#2563eb')`,
    [designId, `${designId}-${position}`, layerOrder, position],
  );
}

it.skipIf(testDatabaseUrl === undefined)(
  "applies migrations to empty PostgreSQL and reads a completed fixture with all details",
  async () => {
    const sql = postgres(testDatabaseUrl!, { max: 1 });
    try {
      await expect(
        sql.begin(async (transaction) => {
          await applyMigrations(transaction);
          // postgres.js transaction clients intentionally expose a narrower
          // static type, while Drizzle only additionally needs the parent
          // parser/serializer options at runtime.
          const transactionClient = Object.assign(transaction, {
            options: sql.options,
          }) as unknown as typeof sql;
          const db = drizzle(transactionClient, { schema });
          await db.insert(schema.identities).values([
            {
              id: ids.identity1,
              status: "iclass",
              displayName: "1A 陳同學",
              studentName: "陳同學",
              className: "1A",
              studentNumber: "01",
              deviceName: "1A-01 iPad",
            },
            {
              id: ids.identity2,
              status: "guest",
              displayName: "訪客-A1B2",
            },
          ]);

          const canonical = (id: string, name: string) => ({
            id,
            name,
            layers: [],
            screwLayout: { count: 4, radiusMm: 12, rotationDeg: 0 },
            metalDiscDiameterMm: 0,
          });
          const performance = {
            speed: 60,
            spinDuration: 65,
            stability: 70,
            impactResistance: 55,
            modelVersion: "1.0.0",
          };
          await db.insert(schema.designs).values([
            {
              id: ids.design1,
              logicalDesignId: ids.logicalDesign1,
              ownerIdentityId: ids.identity1,
              version: 1,
              schemaVersion: "1",
              name: "藍色陀螺",
              screwCount: 4,
              screwRadiusMm: 12,
              screwRotationDeg: 0,
              metalDiscDiameterMm: 0,
              totalMassG: 40,
              polarMomentGmm2: 12_000,
              centerOfMassXMm: 0,
              centerOfMassYMm: 0,
              performanceSpeed: 60,
              performanceSpinDuration: 65,
              performanceStability: 70,
              performanceImpactResistance: 55,
              performanceModelVersion: "1.0.0",
              canonicalJson: canonical(ids.logicalDesign1, "藍色陀螺"),
              performanceJson: performance,
              battleEligible: true,
              validationIssues: [],
            },
            {
              id: ids.design2,
              logicalDesignId: ids.logicalDesign2,
              ownerIdentityId: ids.identity2,
              version: 1,
              schemaVersion: "1",
              name: "紅色陀螺",
              screwCount: 4,
              screwRadiusMm: 12,
              screwRotationDeg: 0,
              metalDiscDiameterMm: 20,
              totalMassG: 45,
              polarMomentGmm2: 14_000,
              centerOfMassXMm: 0,
              centerOfMassYMm: 0,
              performanceSpeed: 55,
              performanceSpinDuration: 68,
              performanceStability: 72,
              performanceImpactResistance: 58,
              performanceModelVersion: "1.0.0",
              canonicalJson: canonical(ids.logicalDesign2, "紅色陀螺"),
              performanceJson: { ...performance, speed: 55 },
              battleEligible: true,
              validationIssues: [],
            },
          ]);

          const positions = ["top", "middle", "bottom"] as const;
          await db.insert(schema.designLayers).values(
            [ids.design1, ids.design2].flatMap((designId, designIndex) =>
              positions.map((position, layerOrder) => ({
                designId,
                sourceLayerId: `${designIndex}-${position}`,
                layerOrder,
                position,
                shape: layerOrder === 1 ? ("polygon" as const) : ("circle" as const),
                points: 6,
                diameterMm: 40 + layerOrder * 5,
                cornerRoundness: 0.5,
                rotationDeg: 0,
                color: designIndex === 0 ? "#2563eb" : "#dc2626",
              })),
            ),
          );

          await db.insert(schema.matches).values({
            id: ids.match,
            idempotencyFingerprint: "a".repeat(64),
            status: "completed",
            player1IdentityId: ids.identity1,
            player2IdentityId: ids.identity2,
            player1DesignId: ids.design1,
            player2DesignId: ids.design2,
            player1BattlePoints: 2,
            player2BattlePoints: 0,
            player1ChallengePoints: 0.25,
            player2ChallengePoints: 0,
            player1Total: 2.25,
            player2Total: 0,
            winner: "player1",
            roundWinners: ["player1", "player1"],
            performanceModelVersion: "1.0.0",
            physicsModelVersion: "2.0.0",
            protocolVersion: 1,
            spectatorCount: 4,
            completedAt: new Date(),
          });
          const now = new Date();
          await db.insert(schema.rounds).values([
            {
              id: ids.round1,
              matchId: ids.match,
              externalRoundId: "round-1",
              authorityKeyHash: battleAuthorityKeyHash(ids.match, "round-1"),
              roundNumber: 1,
              attempt: 1,
              seed: 101,
              outcome: "player1",
              outcomeReason: "stopped",
              ticks: 600,
              launchGradeA: "Perfect",
              launchGradeB: "Great",
              launchAngularMultiplierA: 1.2,
              launchAngularMultiplierB: 1.1,
              launchLinearMultiplierA: 1.2,
              launchLinearMultiplierB: 1.1,
              physicsModelVersion: "2.0.0",
              inputFingerprint: "b".repeat(64),
              battleResultJson: { outcome: { winner: "player1" } },
              completedAt: now,
            },
            {
              id: ids.round2,
              matchId: ids.match,
              externalRoundId: "round-2",
              authorityKeyHash: battleAuthorityKeyHash(ids.match, "round-2"),
              roundNumber: 2,
              attempt: 1,
              seed: 102,
              outcome: "player1",
              outcomeReason: "out-of-bounds",
              ticks: 720,
              launchGradeA: "Great",
              launchGradeB: "Good",
              launchAngularMultiplierA: 1.1,
              launchAngularMultiplierB: 1,
              launchLinearMultiplierA: 1.1,
              launchLinearMultiplierB: 1,
              physicsModelVersion: "2.0.0",
              inputFingerprint: "b".repeat(64),
              battleResultJson: { outcome: { winner: "player1" } },
              completedAt: now,
            },
          ]);

          const saved = await matchWithDetails(db, ids.match);
          expect(saved).toMatchObject({
            id: ids.match,
            player1Identity: { studentName: "陳同學", className: "1A" },
            player2Identity: { status: "guest" },
            player1Design: { name: "藍色陀螺", layers: expect.arrayContaining([
              expect.objectContaining({ position: "bottom" }),
            ]) },
            player2Design: { name: "紅色陀螺" },
            rounds: [
              expect.objectContaining({ launchGradeA: "Perfect" }),
              expect.objectContaining({
                externalRoundId: "round-2",
                roundNumber: 2,
              }),
            ],
          });
          await transaction.unsafe("set constraints all immediate");
          throw rollbackSentinel;
        }),
      ).rejects.toBe(rollbackSentinel);
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
  30_000,
);

it.skipIf(testDatabaseUrl === undefined)(
  "rejects battle-eligible designs with zero, one or two layers at the deferred boundary",
  async () => {
    for (const layerCount of [0, 1, 2]) {
      await expect(
        inEmptyMigratedDatabase(async (transaction) => {
          const designId = `50000000-0000-4000-8000-00000000000${layerCount}`;
          await insertDesign(transaction, designId, true);
          for (let index = 0; index < layerCount; index += 1) {
            await insertLayer(transaction, designId, index);
          }
          await transaction.unsafe("set constraints all immediate");
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "designs_battle_eligible_three_layers",
      });
    }
  },
  30_000,
);

it.skipIf(testDatabaseUrl === undefined)(
  "allows incomplete drafts but rejects deleting or moving a layer from an eligible design",
  async () => {
    await expect(
      inEmptyMigratedDatabase(async (transaction) => {
        await insertDesign(
          transaction,
          "51000000-0000-4000-8000-000000000000",
          false,
        );
        await transaction.unsafe("set constraints all immediate");
        throw rollbackSentinel;
      }),
    ).rejects.toBe(rollbackSentinel);

    for (const operation of ["delete", "move"] as const) {
      await expect(
        inEmptyMigratedDatabase(async (transaction) => {
          const eligibleId = "52000000-0000-4000-8000-000000000000";
          const draftId = "52000000-0000-4000-8000-000000000001";
          await insertDesign(transaction, eligibleId, true);
          await insertDesign(transaction, draftId, false);
          for (let index = 0; index < 3; index += 1) {
            await insertLayer(transaction, eligibleId, index);
          }
          await transaction.unsafe("set constraints all immediate");
          await transaction.unsafe("set constraints all deferred");
          if (operation === "delete") {
            await transaction.unsafe(
              "delete from design_layers where design_id = $1 and position = 'bottom'",
              [eligibleId],
            );
          } else {
            await transaction.unsafe(
              "update design_layers set design_id = $1 where design_id = $2 and position = 'bottom'",
              [draftId, eligibleId],
            );
          }
          await transaction.unsafe("set constraints all immediate");
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "designs_battle_eligible_three_layers",
      });
    }
  },
  30_000,
);

it.skipIf(testDatabaseUrl === undefined)(
  "allows unlimited active spectators but only one occupant per active player seat",
  async () => {
    const roomId = "60000000-0000-4000-8000-000000000000";
    await expect(
      inEmptyMigratedDatabase(async (transaction) => {
        await transaction.unsafe(
          "insert into rooms (id, code, name) values ($1, 'ROOM01', 'Fixture')",
          [roomId],
        );
        for (const [publicId, role] of [
          ["s1", "spectator"],
          ["s2", "spectator"],
          ["p1", "player1"],
          ["p2", "player2"],
        ] as const) {
          await transaction.unsafe(
            "insert into room_participants (room_id, participant_public_id, display_name_snapshot, role) values ($1, $2, $2, $3)",
            [roomId, publicId, role],
          );
        }
        throw rollbackSentinel;
      }),
    ).rejects.toBe(rollbackSentinel);

    await expect(
      inEmptyMigratedDatabase(async (transaction) => {
        await transaction.unsafe(
          "insert into rooms (id, code, name) values ($1, 'ROOM02', 'Fixture')",
          [roomId],
        );
        await transaction.unsafe(
          "insert into room_participants (room_id, participant_public_id, display_name_snapshot, role) values ($1, 'p1', 'P1', 'player1'), ($1, 'p2', 'P2', 'player1')",
          [roomId],
        );
      }),
    ).rejects.toMatchObject({ code: "23505" });
  },
  30_000,
);

it.skipIf(testDatabaseUrl === undefined)(
  "allows repeated input fingerprints but rejects an authority key reused with different input",
  async () => {
    await expect(
      inEmptyMigratedDatabase(async (transaction) => {
        const designId = "70000000-0000-4000-8000-000000000000";
        const matchId = "71000000-0000-4000-8000-000000000000";
        await insertDesign(transaction, designId, false);
        await transaction.unsafe(
          `insert into matches (
            id, idempotency_fingerprint, player1_design_id, player2_design_id,
            performance_model_version, physics_model_version, protocol_version
          ) values ($1, $2, $3, $3, '1.0.0', '2.0.0', 1)`,
          [matchId, "d".repeat(64), designId],
        );
        const insertRound = async (
          id: string,
          externalRoundId: string,
          authorityHash: string,
          inputHash: string,
          roundNumber: number,
        ) => transaction.unsafe(
          `insert into rounds (
            id, match_id, external_round_id, authority_key_hash,
            round_number, attempt, seed, outcome, outcome_reason, ticks,
            launch_grade_a, launch_grade_b, launch_angular_multiplier_a,
            launch_angular_multiplier_b, launch_linear_multiplier_a,
            launch_linear_multiplier_b, physics_model_version,
            input_fingerprint, battle_result_json, completed_at
          ) values (
            $1, $2, $3, $4, $5, 1, 1, 'player1', 'stopped', 60,
            'Perfect', 'Great', 1.2, 1.1, 1.2, 1.1, '2.0.0', $6, '{}', now()
          )`,
          [id, matchId, externalRoundId, authorityHash, roundNumber, inputHash],
        );
        const repeatedInput = "e".repeat(64);
        await insertRound(
          "72000000-0000-4000-8000-000000000001",
          "round-1",
          battleAuthorityKeyHash(matchId, "round-1"),
          repeatedInput,
          1,
        );
        await insertRound(
          "72000000-0000-4000-8000-000000000002",
          "round-2",
          battleAuthorityKeyHash(matchId, "round-2"),
          repeatedInput,
          2,
        );
        await insertRound(
          "72000000-0000-4000-8000-000000000003",
          "round-3",
          battleAuthorityKeyHash(matchId, "round-1"),
          "f".repeat(64),
          3,
        );
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint_name: "rounds_authority_key_hash_uidx",
    });
  },
  30_000,
);
