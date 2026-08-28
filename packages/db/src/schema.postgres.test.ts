import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { expect, it } from "vitest";

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

it.skipIf(testDatabaseUrl === undefined)(
  "applies migrations to empty PostgreSQL and reads a completed fixture with all details",
  async () => {
    const sql = postgres(testDatabaseUrl!, { max: 1 });
    try {
      await expect(
        sql.begin(async (transaction) => {
          for (const statement of migrationStatements()) {
            await transaction.unsafe(statement);
          }
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
              resultFingerprint: "b".repeat(64),
              battleResultJson: { outcome: { winner: "player1" } },
              completedAt: now,
            },
            {
              id: ids.round2,
              matchId: ids.match,
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
              resultFingerprint: "c".repeat(64),
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
              expect.objectContaining({ roundNumber: 2 }),
            ],
          });
          throw rollbackSentinel;
        }),
      ).rejects.toBe(rollbackSentinel);
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
  30_000,
);
