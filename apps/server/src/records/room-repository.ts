import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DatabaseClient } from "@steam-top/db";
import { roomParticipants, roomProjectionJobs, rooms } from "@steam-top/db/schema";
import type { RoomProjectionPayload } from "./room-projection-store";
import { RoomProjectionConflictError } from "./room-projection-store";

export type RoomParticipantRecord = Readonly<{
  participantPublicId: string; identityId: string | null; displayName: string;
  role: "player1" | "player2" | "spectator"; isOwner: boolean;
  ip: string | null; userAgent: string | null; deviceName: string | null;
}>;
export interface RoomRecordRepository {
  create(input: Readonly<{ id: string; code: string; name: string; ownerIdentityId: string | null; participant: RoomParticipantRecord; at: Date }>): Promise<void>;
  join(roomId: string, participant: RoomParticipantRecord, at: Date): Promise<void>;
  recordBattleStart(roomId: string, at: Date): Promise<void>;
  updatePhase(roomId: string, phase: "waiting" | "launch" | "battle" | "result"): Promise<void>;
  updateOwner(roomId: string, ownerIdentityId: string | null): Promise<void>;
  syncRoles(roomId: string, roles: ReadonlyMap<string, "player1" | "player2" | "spectator">, ownerParticipantId: string | null, ownerIdentityId: string | null): Promise<void>;
  leave(roomId: string, participantPublicId: string, at: Date): Promise<void>;
  leaveAndSync(roomId: string, participantPublicId: string, at: Date, roles: ReadonlyMap<string, "player1" | "player2" | "spectator">, ownerParticipantId: string | null, ownerIdentityId: string | null): Promise<void>;
  close(roomId: string, at: Date, revision?: number): Promise<void>;
  closeWithProjection?(roomId: string, at: Date, revision: number, payload: RoomProjectionPayload, leavingParticipantPublicId?: string): Promise<void>;
  transitionPhaseWithProjection?(roomId: string, revision: number, payload: RoomProjectionPayload, at?: Date): Promise<void>;
  applyProjection?(roomId: string, revision: number, payload: RoomProjectionPayload): Promise<boolean>;
}

type Db = DatabaseClient["db"];
const participantValues = (roomId: string, value: RoomParticipantRecord, joinedAt: Date) => ({
  roomId, identityId: value.identityId, participantPublicId: value.participantPublicId,
  displayNameSnapshot: value.displayName, role: value.role, isOwner: value.isOwner,
  lastIp: value.ip, userAgent: value.userAgent, deviceNameSnapshot: value.deviceName, joinedAt,
});

export class PostgresRoomRecordRepository implements RoomRecordRepository {
  constructor(readonly db: Db) {}
  async create(input: Readonly<{ id: string; code: string; name: string; ownerIdentityId: string | null; participant: RoomParticipantRecord; at: Date }>): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(rooms).values({ id: input.id, code: input.code, name: input.name, ownerIdentityId: input.ownerIdentityId, createdAt: input.at });
      await tx.insert(roomParticipants).values(participantValues(input.id, input.participant, input.at));
    });
  }
  async join(roomId: string, participant: RoomParticipantRecord, at: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [room] = await tx.select({ closedAt: rooms.closedAt }).from(rooms).where(eq(rooms.id, roomId)).for("update").limit(1);
      if (!room || room.closedAt) throw new Error("ROOM_CLOSED");
      await tx.insert(roomParticipants).values(participantValues(roomId, participant, at));
    });
  }
  async recordBattleStart(roomId: string, at: Date): Promise<void> {
    await this.db.update(rooms).set({ firstBattleAt: sql`coalesce(${rooms.firstBattleAt}, ${at})` }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)));
  }
  async updatePhase(roomId: string, phase: "waiting" | "launch" | "battle" | "result"): Promise<void> {
    await this.db.update(rooms).set({ status: phase }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)));
  }
  async updateOwner(roomId: string, ownerIdentityId: string | null): Promise<void> {
    await this.db.transaction(async (tx) => { const [room] = await tx.select({ closedAt: rooms.closedAt }).from(rooms).where(eq(rooms.id, roomId)).for("update").limit(1); if (!room || room.closedAt) throw new Error("ROOM_CLOSED"); await tx.update(rooms).set({ ownerIdentityId }).where(eq(rooms.id, roomId)); });
  }
  async syncRoles(roomId: string, roles: ReadonlyMap<string, "player1" | "player2" | "spectator">, ownerParticipantId: string | null, ownerIdentityId: string | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [room] = await tx.select({ closedAt: rooms.closedAt }).from(rooms).where(eq(rooms.id, roomId)).for("update").limit(1); if (!room || room.closedAt) throw new Error("ROOM_CLOSED");
      // Temporarily park active players as spectators so the partial seat index never observes a swap collision.
      await tx.update(roomParticipants).set({ role: "spectator", isOwner: false }).where(and(eq(roomParticipants.roomId, roomId), isNull(roomParticipants.leftAt)));
      for (const [participantPublicId, role] of roles) await tx.update(roomParticipants).set({ role, isOwner: participantPublicId === ownerParticipantId }).where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantPublicId, participantPublicId), isNull(roomParticipants.leftAt)));
      await tx.update(rooms).set({ ownerIdentityId }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)));
    });
  }
  async leave(roomId: string, participantPublicId: string, at: Date): Promise<void> {
    await this.db.transaction(async (tx) => { await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).for("update").limit(1); await tx.update(roomParticipants).set({ leftAt: at }).where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantPublicId, participantPublicId), isNull(roomParticipants.leftAt))); });
  }
  async leaveAndSync(roomId: string, participantPublicId: string, at: Date, roles: ReadonlyMap<string, "player1" | "player2" | "spectator">, ownerParticipantId: string | null, ownerIdentityId: string | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [room] = await tx.select({ closedAt: rooms.closedAt }).from(rooms).where(eq(rooms.id, roomId)).for("update").limit(1); if (!room || room.closedAt) throw new Error("ROOM_CLOSED");
      await tx.update(roomParticipants).set({ leftAt: at }).where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantPublicId, participantPublicId), isNull(roomParticipants.leftAt)));
      await tx.update(roomParticipants).set({ role: "spectator", isOwner: false }).where(and(eq(roomParticipants.roomId, roomId), isNull(roomParticipants.leftAt)));
      for (const [publicId, role] of roles) await tx.update(roomParticipants).set({ role, isOwner: publicId === ownerParticipantId }).where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantPublicId, publicId), isNull(roomParticipants.leftAt)));
      await tx.update(rooms).set({ ownerIdentityId }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)));
    });
  }
  async close(roomId: string, at: Date, revision?: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for("update").limit(1);
      if (!locked) throw new Error("ROOM_NOT_FOUND");
      if (locked.closedAt) return;
      if (revision !== undefined && locked.appliedProjectionRevision >= revision) throw new Error("ROOM_CLOSE_REVISION_CONFLICT");
      const updated = await tx.update(rooms).set({ status: "closed", closedAt: at, ...(revision === undefined ? {} : { appliedProjectionRevision: revision }) }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt), ...(revision === undefined ? [] : [lt(rooms.appliedProjectionRevision, revision)]))).returning({ id: rooms.id });
      if (updated.length !== 1) throw new Error("ROOM_CLOSE_CAS_MISS");
      await tx.update(roomParticipants).set({ leftAt: at }).where(and(eq(roomParticipants.roomId, roomId), isNull(roomParticipants.leftAt)));
    });
  }
  async closeWithProjection(roomId: string, at: Date, revision: number, payload: RoomProjectionPayload, leavingParticipantPublicId?: string): Promise<void> {
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for("update").limit(1);
      if (!locked) throw new Error("ROOM_NOT_FOUND");
      if (locked.closedAt) return;
      if (locked.appliedProjectionRevision >= revision) throw new Error("ROOM_CLOSE_REVISION_CONFLICT");
      const [job] = await tx.select().from(roomProjectionJobs).where(eq(roomProjectionJobs.roomId, roomId)).for("update").limit(1);
      if (job?.revision === revision && job.payloadHash !== payloadHash) throw new RoomProjectionConflictError();
      if (job && job.revision > revision) throw new Error("ROOM_CLOSE_REVISION_CONFLICT");
      if (!job) await tx.insert(roomProjectionJobs).values({ roomId, revision, payloadHash, payloadJson: payload, nextAttemptAt: at });
      else if (job.revision < revision) await tx.update(roomProjectionJobs).set({ revision, payloadHash, payloadJson: payload, status: "pending", attemptCount: 0, nextAttemptAt: at, leaseToken: null, leaseUntil: null, lastError: null, generation: job.generation + 1, updatedAt: at }).where(and(eq(roomProjectionJobs.roomId, roomId), eq(roomProjectionJobs.revision, job.revision)));
      const updated = await tx.update(rooms).set({ status: "closed", closedAt: at, appliedProjectionRevision: revision }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt), lt(rooms.appliedProjectionRevision, revision))).returning({ id: rooms.id });
      if (updated.length !== 1) throw new Error("ROOM_CLOSE_CAS_MISS");
      if (leavingParticipantPublicId) await tx.update(roomParticipants).set({ leftAt: at }).where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantPublicId, leavingParticipantPublicId), isNull(roomParticipants.leftAt)));
      else await tx.update(roomParticipants).set({ leftAt: at }).where(and(eq(roomParticipants.roomId, roomId), isNull(roomParticipants.leftAt)));
    });
  }
  async transitionPhaseWithProjection(roomId: string, revision: number, payload: RoomProjectionPayload, at = new Date()): Promise<void> {
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await this.db.transaction(async (tx) => {
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for("update").limit(1);
      if (!room || room.closedAt) throw new Error("ROOM_CLOSED");
      if (room.appliedProjectionRevision >= revision) {
        if (room.appliedProjectionRevision === revision && room.status === payload.phase) return;
        throw new Error("ROOM_PHASE_REVISION_CONFLICT");
      }
      const [job] = await tx.select().from(roomProjectionJobs).where(eq(roomProjectionJobs.roomId, roomId)).for("update").limit(1);
      if (job && job.revision >= revision) {
        if (job.revision === revision && job.payloadHash === payloadHash && job.status !== "aborted") return;
        throw new RoomProjectionConflictError();
      }
      if (!job) await tx.insert(roomProjectionJobs).values({ roomId, revision, payloadHash, payloadJson: payload, status: "pending", nextAttemptAt: at });
      else await tx.update(roomProjectionJobs).set({ revision, payloadHash, payloadJson: payload, status: "pending", reservationToken: null, attemptCount: 0, nextAttemptAt: at, leaseToken: null, leaseUntil: null, lastError: null, generation: job.generation + 1, updatedAt: at }).where(and(eq(roomProjectionJobs.roomId, roomId), eq(roomProjectionJobs.generation, job.generation)));
      const updated = await tx.update(rooms).set({ status: payload.phase, appliedProjectionRevision: revision, ...(payload.firstBattleAt ? { firstBattleAt: sql`coalesce(${rooms.firstBattleAt}, ${new Date(payload.firstBattleAt)})` } : {}) }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt), lt(rooms.appliedProjectionRevision, revision))).returning({ id: rooms.id });
      if (updated.length !== 1) throw new Error("ROOM_PHASE_CAS_MISS");
    });
  }
  async applyProjection(roomId: string, revision: number, payload: RoomProjectionPayload): Promise<boolean> {
    const updated = await this.db.update(rooms).set({
      status: payload.phase,
      appliedProjectionRevision: revision,
      ...(payload.firstBattleAt ? { firstBattleAt: sql`coalesce(${rooms.firstBattleAt}, ${new Date(payload.firstBattleAt)})` } : {}),
      ...(payload.closedAt ? { closedAt: sql`coalesce(${rooms.closedAt}, ${new Date(payload.closedAt)})` } : {}),
    }).where(and(eq(rooms.id, roomId), lt(rooms.appliedProjectionRevision, revision))).returning({ id: rooms.id });
    return updated.length === 1;
  }
}
