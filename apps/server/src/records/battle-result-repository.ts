import { and, eq, isNull, lt, or } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "@steam-top/db";
import { battleResults } from "@steam-top/db/schema";
import { z } from "zod";
import type { ResultRepository, StoredBattleResult } from "../battle/engine";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const battleResultSchema = z.object({
  modelVersion: z.literal("2.0.0"),
  seed: z.number().int().safe(),
  ticks: z.number().int().min(0).max(5_400),
  frames: z.array(z.object({
    tick: z.number().int().min(0).max(5_400),
    player1: z.object({ x: z.number().finite(), y: z.number().finite(), angle: z.number().finite(), angularSpeed: z.number().finite() }).strict(),
    player2: z.object({ x: z.number().finite(), y: z.number().finite(), angle: z.number().finite(), angularSpeed: z.number().finite() }).strict(),
  }).strict()).max(1_352),
  outcome: z.object({ winner: z.enum(["player1", "player2", "draw"]), reason: z.enum(["stopped", "out-of-bounds", "timeout", "simultaneous"]) }).strict(),
  finalStats: z.object({
    player1: z.object({ angularSpeed: z.number().finite(), speedMps: z.number().finite(), energyJ: z.number().finite(), stoppedTicks: z.number().int().nonnegative(), impactRetentionProduct: z.number().finite() }).strict(),
    player2: z.object({ angularSpeed: z.number().finite(), speedMps: z.number().finite(), energyJ: z.number().finite(), stoppedTicks: z.number().int().nonnegative(), impactRetentionProduct: z.number().finite() }).strict(),
    topTopContactCount: z.number().int().nonnegative(),
    topTopBeginContactEpisodes: z.number().int().nonnegative(),
    topTopImpactApplications: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((value, context) => {
  let previous = -1;
  for (const frame of value.frames) {
    if (frame.tick <= previous || frame.tick > value.ticks) context.addIssue({ code: "custom", message: "battle frame ticks must be strictly increasing and within result ticks" });
    previous = frame.tick;
  }
});

const storedSchema = z.object({ fingerprint: hash, result: battleResultSchema }).strict();
const parseStored = (fingerprint: string, result: unknown): StoredBattleResult => ({ fingerprint: hash.parse(fingerprint), result: battleResultSchema.parse(result) });
const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");

export class BattleResultConflictError extends Error {
  constructor() { super("BATTLE_RESULT_CONFLICT"); this.name = "BattleResultConflictError"; }
}

type Db = DatabaseClient["db"];

/** PostgreSQL result authority with an expiring cross-process simulation lease. */
export class PostgresBattleResultRepository implements ResultRepository {
  readonly #claimTokens = new Map<string, string>();
  readonly #leaseMs: number;
  readonly #pollMs: number;
  readonly #maxWaitMs: number;
  constructor(readonly db: Db, options: Readonly<{ leaseMs?: number; pollMs?: number; maxWaitMs?: number }> = {}) {
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#pollMs = options.pollMs ?? 25;
    this.#maxWaitMs = options.maxWaitMs ?? 35_000;
  }
  get leaseRenewIntervalMs(): number { return Math.max(1, Math.floor(this.#leaseMs / 3)); }

  async renewLease(correlationKey: string, fingerprint: string): Promise<boolean> {
    const authorityKeyHash = keyHash(correlationKey); const claimToken = this.#claimTokens.get(authorityKeyHash);
    if (!claimToken) return false;
    const renewed = await this.db.update(battleResults).set({ leaseExpiresAt: new Date(Date.now() + this.#leaseMs) }).where(and(
      eq(battleResults.authorityKeyHash, authorityKeyHash), eq(battleResults.correlationKey, correlationKey), eq(battleResults.inputFingerprint, fingerprint),
      eq(battleResults.claimOwner, claimToken), isNull(battleResults.resultJson),
    )).returning({ authorityKeyHash: battleResults.authorityKeyHash });
    return renewed.length === 1;
  }

  async get(correlationKey: string): Promise<StoredBattleResult | undefined> {
    const [row] = await this.db.select().from(battleResults).where(eq(battleResults.authorityKeyHash, keyHash(correlationKey))).limit(1);
    if (!row?.resultJson) return undefined;
    return parseStored(row.inputFingerprint, row.resultJson);
  }

  async claim(correlationKey: string, fingerprint: string): Promise<"acquired" | StoredBattleResult> {
    hash.parse(fingerprint);
    const authorityKeyHash = keyHash(correlationKey);
    const claimToken = randomUUID();
    const deadline = Date.now() + this.#maxWaitMs;
    while (true) {
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + this.#leaseMs);
      const outcome = await this.db.transaction(async (tx) => {
        await tx.insert(battleResults).values({ authorityKeyHash, correlationKey, inputFingerprint: fingerprint, claimOwner: claimToken, leaseExpiresAt, createdAt: now }).onConflictDoNothing();
        const [row] = await tx.select().from(battleResults).where(eq(battleResults.authorityKeyHash, authorityKeyHash)).for("update").limit(1);
        if (!row) throw new Error("BATTLE_CLAIM_MISSING");
        if (row.inputFingerprint !== fingerprint || row.correlationKey !== correlationKey) throw new BattleResultConflictError();
        if (row.resultJson) return parseStored(row.inputFingerprint, row.resultJson);
        if (row.claimOwner === claimToken) return "acquired" as const;
        if (row.leaseExpiresAt && row.leaseExpiresAt <= now) {
          await tx.update(battleResults).set({ claimOwner: claimToken, leaseExpiresAt })
            .where(and(eq(battleResults.authorityKeyHash, authorityKeyHash), isNull(battleResults.resultJson), or(isNull(battleResults.leaseExpiresAt), lt(battleResults.leaseExpiresAt, now))));
          return "acquired" as const;
        }
        return "busy" as const;
      });
      if (outcome !== "busy") { if (outcome === "acquired") this.#claimTokens.set(authorityKeyHash, claimToken); return outcome; }
      if (Date.now() >= deadline) throw new Error("BATTLE_RESULT_LEASE_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, this.#pollMs));
    }
  }

  async saveIfAbsent(correlationKey: string, value: StoredBattleResult): Promise<StoredBattleResult> {
    if (!value.result) throw new TypeError("A durable battle result is required");
    const parsed = storedSchema.parse({ fingerprint: value.fingerprint, result: value.result });
    const encoded = JSON.stringify(parsed.result);
    const resultBytes = Buffer.byteLength(encoded);
    if (resultBytes > 2 * 1_024 * 1_024) throw new RangeError("Battle result exceeds 2 MiB");
    const authorityKeyHash = keyHash(correlationKey);
    const claimToken = this.#claimTokens.get(authorityKeyHash);
    if (!claimToken) throw new BattleResultConflictError();
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(battleResults).where(eq(battleResults.authorityKeyHash, authorityKeyHash)).for("update").limit(1);
      if (!row || row.correlationKey !== correlationKey || row.inputFingerprint !== parsed.fingerprint) throw new BattleResultConflictError();
      if (row.resultJson) return parseStored(row.inputFingerprint, row.resultJson);
      if (row.claimOwner !== claimToken) throw new BattleResultConflictError();
      const [saved] = await tx.update(battleResults).set({ resultJson: parsed.result, resultBytes, completedAt: new Date(), claimOwner: null, leaseExpiresAt: null })
        .where(and(eq(battleResults.authorityKeyHash, authorityKeyHash), eq(battleResults.claimOwner, claimToken), isNull(battleResults.resultJson))).returning();
      if (!saved) throw new BattleResultConflictError();
      this.#claimTokens.delete(authorityKeyHash);
      return parseStored(saved.inputFingerprint, saved.resultJson);
    });
  }

  async release(correlationKey: string, fingerprint: string): Promise<void> {
    const authorityKeyHash = keyHash(correlationKey); const claimToken = this.#claimTokens.get(authorityKeyHash);
    if (!claimToken) return;
    await this.db.delete(battleResults).where(and(
      eq(battleResults.authorityKeyHash, authorityKeyHash),
      eq(battleResults.inputFingerprint, fingerprint),
      eq(battleResults.claimOwner, claimToken),
      isNull(battleResults.resultJson),
    ));
    this.#claimTokens.delete(authorityKeyHash);
  }
}
