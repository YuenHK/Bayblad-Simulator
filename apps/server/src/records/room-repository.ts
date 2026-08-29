import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { DatabaseClient } from "@steam-top/db";
import { roomParticipants, rooms } from "@steam-top/db/schema";
import type { RoomProjectionPayload } from "./room-projection-store";

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
  close(roomId: string, at: Date): Promise<void>;
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
    await this.db.insert(roomParticipants).values(participantValues(roomId, participant, at));
  }
  async recordBattleStart(roomId: string, at: Date): Promise<void> {
    await this.db.update(rooms).set({ firstBattleAt: sql`coalesce(${rooms.firstBattleAt}, ${at})` }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)));
  }
  async updatePhase(roomId: string, phase: "waiting" | "launch" | "battle" | "result"): Promise<void> {
    await this.db.update(rooms).set({ status: phase }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)));
  }
  async updateOwner(roomId: string, ownerIdentityId: string | null): Promise<void> {
    await this.db.update(rooms).set({ ownerIdentityId }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)));
  }
  async syncRoles(roomId: string, roles: ReadonlyMap<string, "player1" | "player2" | "spectator">, ownerParticipantId: string | null, ownerIdentityId: string | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Temporarily park active players as spectators so the partial seat index never observes a swap collision.
      await tx.update(roomParticipants).set({ role: "spectator", isOwner: false }).where(and(eq(roomParticipants.roomId, roomId), isNull(roomParticipants.leftAt)));
      for (const [participantPublicId, role] of roles) await tx.update(roomParticipants).set({ role, isOwner: participantPublicId === ownerParticipantId }).where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantPublicId, participantPublicId), isNull(roomParticipants.leftAt)));
      await tx.update(rooms).set({ ownerIdentityId }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)));
    });
  }
  async leave(roomId: string, participantPublicId: string, at: Date): Promise<void> {
    await this.db.update(roomParticipants).set({ leftAt: at }).where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantPublicId, participantPublicId), isNull(roomParticipants.leftAt)));
  }
  async leaveAndSync(roomId: string, participantPublicId: string, at: Date, roles: ReadonlyMap<string, "player1" | "player2" | "spectator">, ownerParticipantId: string | null, ownerIdentityId: string | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(roomParticipants).set({ leftAt: at }).where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantPublicId, participantPublicId), isNull(roomParticipants.leftAt)));
      await tx.update(roomParticipants).set({ role: "spectator", isOwner: false }).where(and(eq(roomParticipants.roomId, roomId), isNull(roomParticipants.leftAt)));
      for (const [publicId, role] of roles) await tx.update(roomParticipants).set({ role, isOwner: publicId === ownerParticipantId }).where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantPublicId, publicId), isNull(roomParticipants.leftAt)));
      await tx.update(rooms).set({ ownerIdentityId }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)));
    });
  }
  async close(roomId: string, at: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(roomParticipants).set({ leftAt: at }).where(and(eq(roomParticipants.roomId, roomId), isNull(roomParticipants.leftAt)));
      await tx.update(rooms).set({ status: "closed", closedAt: at }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)));
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
