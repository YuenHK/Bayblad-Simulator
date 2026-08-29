import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "@steam-top/db";
import { roomProjectionJobs } from "@steam-top/db/schema";
import { z } from "zod";

export type RoomProjectionPayload = Readonly<{
  phase: "waiting" | "launch" | "battle" | "result" | "closed";
  firstBattleAt: string | null;
  closedAt: string | null;
}>;

export type RoomProjectionInput = Readonly<{
  roomId: string;
  revision: number;
  payload: RoomProjectionPayload;
}>;

export type ClaimedRoomProjection = RoomProjectionInput & Readonly<{
  attempt: number;
  generation: number;
  leaseToken: string;
}>;
export type PreparedRoomProjection = RoomProjectionInput & Readonly<{ reservationToken: string }>;

export interface RoomProjectionStore {
  enqueue(input: RoomProjectionInput): Promise<"created" | "updated" | "stale">;
  prepare(input: RoomProjectionInput): Promise<PreparedRoomProjection>;
  commitPrepared(prepared: PreparedRoomProjection): Promise<boolean>;
  abortPrepared(prepared: PreparedRoomProjection): Promise<boolean>;
  claimDue(limit: number, now?: Date): Promise<readonly ClaimedRoomProjection[]>;
  complete(claim: ClaimedRoomProjection): Promise<boolean>;
  fail(claim: ClaimedRoomProjection, errorCode: string, now?: Date): Promise<boolean>;
  pruneDead?(now?: Date, limit?: number): Promise<number>;
  readonly size?: number;
}
export class RoomProjectionConflictError extends Error { constructor() { super("ROOM_PROJECTION_CONFLICT"); this.name = "RoomProjectionConflictError"; } }

type MemoryEntry = RoomProjectionInput & {
  status: "prepared" | "pending" | "leased" | "dead" | "aborted";
  reservationToken: string | null;
  attempt: number;
  generation: number;
  leaseToken: string | null;
  leaseUntil: Date | null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastError: string | null;
};

export class MemoryRoomProjectionStore implements RoomProjectionStore {
  readonly #entries = new Map<string, MemoryEntry>();
  readonly #maxEntries: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #now: () => Date;

  constructor(options: Readonly<{ maxEntries?: number; leaseMs?: number; maxAttempts?: number; now?: () => Date }> = {}) {
    this.#maxEntries = options.maxEntries ?? 2_000;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#maxAttempts = options.maxAttempts ?? 10;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) throw new RangeError("invalid room projection capacity");
  }

  async enqueue(input: RoomProjectionInput): Promise<"created" | "updated" | "stale"> {
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new RangeError("invalid room projection revision");
    const current = this.#entries.get(input.roomId);
    if (current && current.revision === input.revision) {
      if (JSON.stringify(current.payload) !== JSON.stringify(input.payload)) throw new RoomProjectionConflictError();
      return "stale";
    }
    if (current && current.revision > input.revision) return "stale";
    if (!current && this.#entries.size >= this.#maxEntries) throw new Error("ROOM_PROJECTION_CAPACITY");
    const now = this.#now();
    this.#entries.set(input.roomId, {
      ...structuredClone(input), status: "pending", reservationToken: null, attempt: 0,
      generation: (current?.generation ?? 0) + 1, leaseToken: null,
      leaseUntil: null, nextAttemptAt: now, createdAt: current?.createdAt ?? now, updatedAt: now,
      lastError: null,
    });
    return current ? "updated" : "created";
  }
  async prepare(input: RoomProjectionInput): Promise<PreparedRoomProjection> {
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new RangeError("invalid room projection revision");
    const current = this.#entries.get(input.roomId);
    if (current && current.revision > input.revision) throw new RoomProjectionConflictError();
    if (current && current.revision === input.revision && current.status !== "aborted") {
      if (JSON.stringify(current.payload) !== JSON.stringify(input.payload)) throw new RoomProjectionConflictError();
      if (current.status === "prepared" && current.reservationToken) return { ...structuredClone(input), reservationToken: current.reservationToken };
      throw new RoomProjectionConflictError();
    }
    if (!current && this.#entries.size >= this.#maxEntries) throw new Error("ROOM_PROJECTION_CAPACITY");
    const now = this.#now(); const reservationToken = randomUUID();
    this.#entries.set(input.roomId, { ...structuredClone(input), status: "prepared", reservationToken, attempt: 0, generation: (current?.generation ?? 0) + 1, leaseToken: null, leaseUntil: null, nextAttemptAt: now, createdAt: current?.createdAt ?? now, updatedAt: now, lastError: null });
    return { ...structuredClone(input), reservationToken };
  }
  async commitPrepared(prepared: PreparedRoomProjection): Promise<boolean> { const entry = this.#entries.get(prepared.roomId); if (!entry || entry.status !== "prepared" || entry.revision !== prepared.revision || entry.reservationToken !== prepared.reservationToken || JSON.stringify(entry.payload) !== JSON.stringify(prepared.payload)) return false; entry.status = "pending"; entry.reservationToken = null; entry.updatedAt = this.#now(); return true; }
  async abortPrepared(prepared: PreparedRoomProjection): Promise<boolean> { const entry = this.#entries.get(prepared.roomId); if (!entry || entry.status !== "prepared" || entry.revision !== prepared.revision || entry.reservationToken !== prepared.reservationToken || JSON.stringify(entry.payload) !== JSON.stringify(prepared.payload)) return false; entry.status = "aborted"; entry.reservationToken = null; entry.updatedAt = this.#now(); return true; }

  async claimDue(limit: number, now = this.#now()): Promise<readonly ClaimedRoomProjection[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("invalid room projection claim limit");
    const due = [...this.#entries.values()]
      .filter((entry) => ["pending", "leased"].includes(entry.status) && entry.nextAttemptAt <= now && (entry.status !== "leased" || !entry.leaseUntil || entry.leaseUntil <= now))
      .sort((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime() || left.createdAt.getTime() - right.createdAt.getTime() || left.roomId.localeCompare(right.roomId))
      .slice(0, limit);
    return due.map((entry) => {
      entry.status = "leased";
      entry.generation += 1;
      entry.leaseToken = randomUUID();
      entry.leaseUntil = new Date(now.getTime() + this.#leaseMs);
      return structuredClone({ roomId: entry.roomId, revision: entry.revision, payload: entry.payload, attempt: entry.attempt, generation: entry.generation, leaseToken: entry.leaseToken });
    });
  }

  async complete(claim: ClaimedRoomProjection): Promise<boolean> {
    const entry = this.#entries.get(claim.roomId);
    if (!entry || entry.revision !== claim.revision || entry.generation !== claim.generation || entry.leaseToken !== claim.leaseToken) return false;
    this.#entries.delete(claim.roomId);
    return true;
  }

  async fail(claim: ClaimedRoomProjection, errorCode: string, now = this.#now()): Promise<boolean> {
    const entry = this.#entries.get(claim.roomId);
    if (!entry || entry.revision !== claim.revision || entry.generation !== claim.generation || entry.leaseToken !== claim.leaseToken) return false;
    entry.attempt += 1;
    entry.status = entry.attempt >= this.#maxAttempts ? "dead" : "pending";
    entry.lastError = /^[A-Z0-9_]{1,128}$/.test(errorCode) ? errorCode : "ROOM_PROJECTION_FAILED";
    entry.nextAttemptAt = new Date(entry.status === "dead" ? 8_640_000_000_000_000 : now.getTime() + Math.min(300_000, 1_000 * 2 ** Math.max(0, entry.attempt - 1)));
    entry.leaseToken = null;
    entry.leaseUntil = null;
    entry.updatedAt = now;
    return true;
  }

  async pruneDead(now = this.#now(), limit = 1_000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new RangeError("invalid prune limit");
    let removed = 0; const cutoff = now.getTime() - 30 * 86_400_000;
    for (const [id, entry] of this.#entries) if (removed < limit && entry.status === "dead" && entry.updatedAt.getTime() < cutoff) { this.#entries.delete(id); removed++; }
    return removed;
  }

  get size(): number { return this.#entries.size; }
}

const payloadSchema = z.object({
  phase: z.enum(["waiting", "launch", "battle", "result", "closed"]),
  firstBattleAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
}).strict();
type Db = DatabaseClient["db"];

export class PostgresRoomProjectionStore implements RoomProjectionStore {
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  constructor(readonly db: Db, options: Readonly<{ leaseMs?: number; maxAttempts?: number }> = {}) {
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#maxAttempts = options.maxAttempts ?? 10;
  }

  async enqueue(input: RoomProjectionInput): Promise<"created" | "updated" | "stale"> {
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new RangeError("invalid room projection revision");
    const payload = payloadSchema.parse(input.payload);
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    try { return await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(roomProjectionJobs).where(eq(roomProjectionJobs.roomId, input.roomId)).for("update").limit(1);
      if (existing && existing.revision === input.revision) {
        if (existing.payloadHash !== payloadHash) throw new RoomProjectionConflictError();
        return "stale" as const;
      }
      if (existing && existing.revision > input.revision) return "stale" as const;
      const now = new Date();
      if (!existing) {
        await tx.insert(roomProjectionJobs).values({ roomId: input.roomId, revision: input.revision, payloadHash, payloadJson: payload, nextAttemptAt: now });
        return "created" as const;
      }
      await tx.update(roomProjectionJobs).set({
        revision: input.revision, payloadHash, payloadJson: payload,
        status: "pending", attemptCount: 0, nextAttemptAt: now,
        reservationToken: null, leaseToken: null, leaseUntil: null, lastError: null,
        generation: existing.generation + 1, updatedAt: now,
      }).where(and(eq(roomProjectionJobs.roomId, input.roomId), eq(roomProjectionJobs.revision, existing.revision)));
      return "updated" as const;
    }); } catch (error) {
      if ((error as { code?: string }).code === "23505") return this.enqueue(input);
      throw error;
    }
  }

  async prepare(input: RoomProjectionInput): Promise<PreparedRoomProjection> {
    const payload = payloadSchema.parse(input.payload); const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(roomProjectionJobs).where(eq(roomProjectionJobs.roomId, input.roomId)).for("update").limit(1);
      if (existing && existing.revision > input.revision) throw new RoomProjectionConflictError();
      if (existing?.revision === input.revision && existing.status !== "aborted") {
        if (existing.payloadHash !== payloadHash) throw new RoomProjectionConflictError();
        if (existing.status === "prepared" && existing.reservationToken) return { ...input, reservationToken: existing.reservationToken };
        throw new RoomProjectionConflictError();
      }
      const reservationToken = randomUUID(); const now = new Date();
      if (!existing) await tx.insert(roomProjectionJobs).values({ roomId: input.roomId, revision: input.revision, payloadHash, payloadJson: payload, status: "prepared", reservationToken, nextAttemptAt: now });
      else await tx.update(roomProjectionJobs).set({ revision: input.revision, payloadHash, payloadJson: payload, status: "prepared", reservationToken, attemptCount: 0, leaseToken: null, leaseUntil: null, lastError: null, generation: existing.generation + 1, updatedAt: now }).where(and(eq(roomProjectionJobs.roomId, input.roomId), eq(roomProjectionJobs.generation, existing.generation)));
      return { ...input, reservationToken };
    });
  }
  async commitPrepared(prepared: PreparedRoomProjection): Promise<boolean> { const payloadHash = createHash("sha256").update(JSON.stringify(prepared.payload)).digest("hex"); const rows = await this.db.update(roomProjectionJobs).set({ status: "pending", reservationToken: null, nextAttemptAt: new Date(), updatedAt: new Date() }).where(and(eq(roomProjectionJobs.roomId, prepared.roomId), eq(roomProjectionJobs.revision, prepared.revision), eq(roomProjectionJobs.payloadHash, payloadHash), eq(roomProjectionJobs.status, "prepared"), eq(roomProjectionJobs.reservationToken, prepared.reservationToken))).returning({ id: roomProjectionJobs.roomId }); return rows.length === 1; }
  async abortPrepared(prepared: PreparedRoomProjection): Promise<boolean> { const payloadHash = createHash("sha256").update(JSON.stringify(prepared.payload)).digest("hex"); const rows = await this.db.update(roomProjectionJobs).set({ status: "aborted", reservationToken: null, updatedAt: new Date() }).where(and(eq(roomProjectionJobs.roomId, prepared.roomId), eq(roomProjectionJobs.revision, prepared.revision), eq(roomProjectionJobs.payloadHash, payloadHash), eq(roomProjectionJobs.status, "prepared"), eq(roomProjectionJobs.reservationToken, prepared.reservationToken))).returning({ id: roomProjectionJobs.roomId }); return rows.length === 1; }

  async claimDue(limit: number, now = new Date()): Promise<readonly ClaimedRoomProjection[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("invalid room projection claim limit");
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(roomProjectionJobs)
        .where(and(
          inArray(roomProjectionJobs.status, ["pending", "leased"]),
          lte(roomProjectionJobs.nextAttemptAt, now),
          or(eq(roomProjectionJobs.status, "pending"), lte(roomProjectionJobs.leaseUntil, now)),
        ))
        .orderBy(asc(roomProjectionJobs.nextAttemptAt), asc(roomProjectionJobs.createdAt), asc(roomProjectionJobs.roomId))
        .limit(limit).for("update", { skipLocked: true });
      const claims: ClaimedRoomProjection[] = [];
      for (const row of rows) {
        const payload = payloadSchema.parse(row.payloadJson);
        if (createHash("sha256").update(JSON.stringify(payload)).digest("hex") !== row.payloadHash) throw new Error("ROOM_PROJECTION_PAYLOAD_CORRUPT");
        const leaseToken = randomUUID();
        const generation = row.generation + 1;
        await tx.update(roomProjectionJobs).set({ status: "leased", leaseToken, generation, leaseUntil: new Date(now.getTime() + this.#leaseMs), updatedAt: now }).where(and(eq(roomProjectionJobs.roomId, row.roomId), eq(roomProjectionJobs.generation, row.generation)));
        claims.push({ roomId: row.roomId, revision: row.revision, payload, attempt: row.attemptCount, generation, leaseToken });
      }
      return claims;
    });
  }

  async complete(claim: ClaimedRoomProjection): Promise<boolean> {
    const deleted = await this.db.delete(roomProjectionJobs).where(and(
      eq(roomProjectionJobs.roomId, claim.roomId), eq(roomProjectionJobs.revision, claim.revision),
      eq(roomProjectionJobs.generation, claim.generation), eq(roomProjectionJobs.leaseToken, claim.leaseToken),
    )).returning({ roomId: roomProjectionJobs.roomId });
    return deleted.length === 1;
  }

  async fail(claim: ClaimedRoomProjection, errorCode: string, now = new Date()): Promise<boolean> {
    const attempt = claim.attempt + 1;
    const dead = attempt >= this.#maxAttempts;
    const updated = await this.db.update(roomProjectionJobs).set({
      status: dead ? "dead" : "pending", attemptCount: attempt,
      nextAttemptAt: new Date(dead ? 8_640_000_000_000_000 : now.getTime() + Math.min(300_000, 1_000 * 2 ** Math.max(0, attempt - 1))),
      leaseToken: null, leaseUntil: null,
      lastError: /^[A-Z0-9_]{1,128}$/.test(errorCode) ? errorCode : "ROOM_PROJECTION_FAILED",
      updatedAt: now,
    }).where(and(
      eq(roomProjectionJobs.roomId, claim.roomId), eq(roomProjectionJobs.revision, claim.revision),
      eq(roomProjectionJobs.generation, claim.generation), eq(roomProjectionJobs.leaseToken, claim.leaseToken),
    )).returning({ roomId: roomProjectionJobs.roomId });
    return updated.length === 1;
  }
  async pruneDead(now = new Date(), limit = 1_000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new RangeError("invalid prune limit");
    const rows = await this.db.execute(sql`with expired as (select room_id from room_projection_jobs where status='dead' and updated_at < ${new Date(now.getTime() - 30 * 86_400_000)} order by updated_at limit ${limit} for update skip locked) delete from room_projection_jobs j using expired where j.room_id=expired.room_id and j.status='dead' returning j.room_id`);
    return rows.length;
  }
}
