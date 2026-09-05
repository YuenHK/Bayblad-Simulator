import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DatabaseClient } from "@steam-top/db";
import { identities, roomEventSnapshots, roomParticipants, roomProjectionJobs, rooms } from "@steam-top/db/schema";
import type { RoomProjectionPayload, TransactionalRoomProjectionStore } from "./room-projection-store";
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
  reconcileOrphanedActiveRooms?(at?: Date): Promise<number>;
  acquireStartupLease?(): Promise<void>;
  releaseStartupLease?(): Promise<void>;
  verifyStartupLease?(): Promise<void>;
  applyProjection?(roomId: string, revision: number, payload: RoomProjectionPayload): Promise<boolean>;
}

type Db = DatabaseClient["db"];
export function coalesceTimestamp(column: typeof rooms.firstBattleAt | typeof rooms.closedAt, value: Date) {
  return sql`coalesce(${column}, ${sql.param(value, column)})`;
}
const participantValues = (roomId: string, value: RoomParticipantRecord, joinedAt: Date) => ({
  roomId, identityId: value.identityId, participantPublicId: value.participantPublicId,
  displayNameSnapshot: value.displayName, role: value.role, isOwner: value.isOwner,
  lastIp: value.ip, userAgent: value.userAgent, deviceNameSnapshot: value.deviceName, joinedAt,
});

type MemoryRoomRecord = { status: "waiting" | "launch" | "battle" | "result" | "closed"; revision: number; lastTransitionHash: string | null; closedAt: Date | null; firstBattleAt: Date | null; participants: Map<string, { record: RoomParticipantRecord; leftAt: Date | null }> };
export class MemoryRoomRecordRepository implements RoomRecordRepository {
  readonly #rooms = new Map<string, MemoryRoomRecord>();
  constructor(readonly projections: TransactionalRoomProjectionStore, readonly options: Readonly<{ beforeAuthorityCommit?: () => void }> = {}) {}
  async create(input: Parameters<RoomRecordRepository["create"]>[0]) { this.#rooms.set(input.id, { status: "waiting", revision: -1, lastTransitionHash: null, closedAt: null, firstBattleAt: null, participants: new Map([[input.participant.participantPublicId, { record: input.participant, leftAt: null }]]) }); }
  async join(roomId: string, participant: RoomParticipantRecord) { const room = this.#active(roomId); room.participants.set(participant.participantPublicId, { record: participant, leftAt: null }); }
  async recordBattleStart(roomId: string, at: Date) { const room = this.#active(roomId); room.firstBattleAt ??= at; }
  async updatePhase(roomId: string, phase: "waiting" | "launch" | "battle" | "result") { this.#active(roomId).status = phase; }
  async updateOwner() {} async syncRoles() {}
  async leave(roomId: string, participantPublicId: string, at: Date) { const participant = this.#rooms.get(roomId)?.participants.get(participantPublicId); if (participant) participant.leftAt ??= at; }
  async leaveAndSync(roomId: string, participantPublicId: string, at: Date) { await this.leave(roomId, participantPublicId, at); }
  async close(roomId: string, at: Date, revision?: number) { const room = this.#rooms.get(roomId); if (!room || room.closedAt) return; room.status = "closed"; room.closedAt = at; if (revision !== undefined) room.revision = revision; for (const participant of room.participants.values()) participant.leftAt ??= at; }
  async closeWithProjection(roomId: string, at: Date, revision: number, payload: RoomProjectionPayload) { const room = this.#rooms.get(roomId); const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex"); if (!room) throw new Error("ROOM_CLOSED"); if (room.closedAt) { if (room.revision === revision && room.lastTransitionHash === hash) return; throw new Error("ROOM_CLOSE_REVISION_CONFLICT"); } if (revision <= room.revision) throw new Error("ROOM_CLOSE_REVISION_CONFLICT"); await this.projections.transaction(async () => { await this.projections.enqueue({ roomId, revision, payload }); this.options.beforeAuthorityCommit?.(); room.lastTransitionHash = hash; await this.close(roomId, at, revision); }); }
  async transitionPhaseWithProjection(roomId: string, revision: number, payload: RoomProjectionPayload) { const room = this.#active(roomId); const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex"); if (revision <= room.revision) { if (revision === room.revision && room.status === payload.phase && room.lastTransitionHash === hash) return; throw new Error("ROOM_PHASE_REVISION_CONFLICT"); } await this.projections.transaction(async () => { await this.projections.enqueue({ roomId, revision, payload }); this.options.beforeAuthorityCommit?.(); room.status = payload.phase; room.revision = revision; room.lastTransitionHash = hash; if (payload.firstBattleAt) room.firstBattleAt ??= new Date(payload.firstBattleAt); }); }
  async reconcileOrphanedActiveRooms(at = new Date()) { let count = 0; for (const [roomId, room] of this.#rooms) if (!room.closedAt) { const revision = room.revision + 1; const payload: RoomProjectionPayload = { phase: "closed", firstBattleAt: room.firstBattleAt?.toISOString() ?? null, closedAt: at.toISOString() }; await this.closeWithProjection(roomId, at, revision, payload); count++; } return count; }
  async applyProjection(roomId: string, revision: number, payload: RoomProjectionPayload) { const room = this.#rooms.get(roomId); if (!room || revision <= room.revision) return false; room.revision = revision; room.status = payload.phase; if (payload.closedAt) room.closedAt = new Date(payload.closedAt); return true; }
  snapshot(roomId: string) { return this.#rooms.get(roomId); }
  #active(roomId: string) { const room = this.#rooms.get(roomId); if (!room || room.closedAt) throw new Error("ROOM_CLOSED"); return room; }
}

export class PostgresRoomRecordRepository implements RoomRecordRepository {
  #reserved: Awaited<ReturnType<DatabaseClient["sql"]["reserve"]>> | undefined;
  #leaseBackendPid: number | undefined;
  constructor(readonly db: Db, readonly sql?: DatabaseClient["sql"], private readonly authorityLockObjectId = 1) {
    if (!Number.isSafeInteger(authorityLockObjectId) || authorityLockObjectId < 1 || authorityLockObjectId > 2_147_483_647) throw new TypeError("INVALID_ROOM_AUTHORITY_LOCK_OBJECT_ID");
  }
  get startupLeaseBackendPidForTesting(): number | undefined { return this.#leaseBackendPid; }
  async acquireStartupLease(): Promise<void> {
    if (this.#reserved) return;
    if (!this.sql) throw new Error("ROOM_SINGLE_INSTANCE_LOCK_UNAVAILABLE");
    const reserved = await this.sql.reserve();
    try {
      const rows = await reserved<{ acquired: boolean; backendPid: number }[]>`select pg_try_advisory_lock(1937006964, ${this.authorityLockObjectId}) as acquired, pg_backend_pid() as "backendPid"`;
      let lease = rows[0];
      if (!lease?.acquired) {
        const takeover = await reserved<{ terminated: boolean }[]>`
          select pg_terminate_backend(pid) as terminated from pg_locks
          where locktype = 'advisory' and classid = 1937006964 and objid = ${this.authorityLockObjectId}
            and granted and pid <> pg_backend_pid()
        `;
        if (!takeover.some(({ terminated }) => terminated)) throw new Error("ROOM_SINGLE_INSTANCE_LOCK_HELD");
        const [replacement] = await reserved<{ backendPid: number }[]>`select pg_advisory_lock(1937006964, ${this.authorityLockObjectId}), pg_backend_pid() as "backendPid"`;
        lease = { acquired: true, backendPid: replacement!.backendPid };
      }
      if (!lease?.acquired) throw new Error("ROOM_SINGLE_INSTANCE_LOCK_HELD");
      this.#reserved = reserved; this.#leaseBackendPid = lease.backendPid;
    } catch (error) { reserved.release(); throw error; }
  }
  async releaseStartupLease(): Promise<void> {
    const reserved = this.#reserved; this.#reserved = undefined; this.#leaseBackendPid = undefined;
    if (!reserved) return;
    try { await reserved`select pg_advisory_unlock(1937006964, ${this.authorityLockObjectId})`; } finally { reserved.release(); }
  }
  async verifyStartupLease(): Promise<void> {
    const reserved = this.#reserved;
    const expectedBackendPid = this.#leaseBackendPid;
    if (!reserved || expectedBackendPid === undefined) throw new Error("ROOM_SINGLE_INSTANCE_LOCK_LOST");
    const verification = reserved<{ backendPid: number; held: boolean }[]>`
      select pg_backend_pid() as "backendPid", exists(
        select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
          and classid = 1937006964 and objid = ${this.authorityLockObjectId} and granted
      ) as held`;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let connectionResponded = false;
    try {
      const rows = await Promise.race([
        verification,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("ROOM_SINGLE_INSTANCE_LOCK_LOST")), 2_000); }),
      ]);
      connectionResponded = true;
      if (rows[0]?.backendPid !== expectedBackendPid || !rows[0]?.held) throw new Error("ROOM_SINGLE_INSTANCE_LOCK_LOST");
    } catch {
      // A dead lease must never be queried again during shutdown. Do not call
      // release() on a connection-error path: postgres.js already recycles the
      // failed socket, while releasing its reserved handle can race a queued
      // socket write. A later acquire uses a fresh reservation.
      if (this.#reserved === reserved) {
        this.#reserved = undefined;
        this.#leaseBackendPid = undefined;
        if (connectionResponded) reserved.release();
      }
      throw new Error("ROOM_SINGLE_INSTANCE_LOCK_LOST");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  async create(input: Readonly<{ id: string; code: string; name: string; ownerIdentityId: string | null; participant: RoomParticipantRecord; at: Date }>): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(rooms).values({ id: input.id, code: input.code, name: input.name, ownerIdentityId: input.ownerIdentityId, createdAt: input.at });
      const [owner] = input.ownerIdentityId ? await tx.select().from(identities).where(eq(identities.id, input.ownerIdentityId)).limit(1) : [];
      const canonical = input.ownerIdentityId ? await tx.execute<{ id: string }>(sql`with recursive chain as (select id,merged_into_identity_id,0 depth from identities where id=${input.ownerIdentityId} union all select i.id,i.merged_into_identity_id,c.depth+1 from identities i join chain c on i.id=c.merged_into_identity_id where c.depth<16) select id from chain order by depth desc limit 1`) : [];
      await tx.insert(roomEventSnapshots).values({ roomId: input.id, ownerIdentityIdAtCreation: input.ownerIdentityId, canonicalIdentityIdAtCreation: canonical[0]?.id ?? input.ownerIdentityId, identityStatusSnapshot: owner?.status ?? null, classNameSnapshot: owner?.className ?? null, capturedAt: input.at });
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
    await this.db.update(rooms).set({ firstBattleAt: coalesceTimestamp(rooms.firstBattleAt, at) }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt)));
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
      if (locked.closedAt) {
        if (locked.appliedProjectionRevision === revision && locked.lastTransitionHash === payloadHash) return;
        throw new Error("ROOM_CLOSE_REVISION_CONFLICT");
      }
      if (locked.appliedProjectionRevision >= revision) throw new Error("ROOM_CLOSE_REVISION_CONFLICT");
      const [job] = await tx.select().from(roomProjectionJobs).where(eq(roomProjectionJobs.roomId, roomId)).for("update").limit(1);
      if (job?.revision === revision && job.payloadHash !== payloadHash) throw new RoomProjectionConflictError();
      if (job && job.revision > revision) throw new Error("ROOM_CLOSE_REVISION_CONFLICT");
      if (!job) await tx.insert(roomProjectionJobs).values({ roomId, revision, payloadHash, payloadJson: payload, nextAttemptAt: at });
      else if (job.revision < revision) await tx.update(roomProjectionJobs).set({ revision, payloadHash, payloadJson: payload, status: "pending", attemptCount: 0, nextAttemptAt: at, leaseToken: null, leaseUntil: null, lastError: null, generation: job.generation + 1, updatedAt: at }).where(and(eq(roomProjectionJobs.roomId, roomId), eq(roomProjectionJobs.revision, job.revision)));
      const updated = await tx.update(rooms).set({ status: "closed", closedAt: at, appliedProjectionRevision: revision, lastTransitionHash: payloadHash }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt), lt(rooms.appliedProjectionRevision, revision))).returning({ id: rooms.id });
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
      const [job] = await tx.select().from(roomProjectionJobs).where(eq(roomProjectionJobs.roomId, roomId)).for("update").limit(1);
      if (room.appliedProjectionRevision >= revision) {
        if (room.appliedProjectionRevision === revision && room.status === payload.phase && room.lastTransitionHash === payloadHash) return;
        throw new Error("ROOM_PHASE_REVISION_CONFLICT");
      }
      if (job && job.revision >= revision) {
        if (job.revision === revision && job.payloadHash === payloadHash && job.status !== "aborted") return;
        throw new RoomProjectionConflictError();
      }
      if (!job) await tx.insert(roomProjectionJobs).values({ roomId, revision, payloadHash, payloadJson: payload, status: "pending", nextAttemptAt: at });
      else await tx.update(roomProjectionJobs).set({ revision, payloadHash, payloadJson: payload, status: "pending", reservationToken: null, attemptCount: 0, nextAttemptAt: at, leaseToken: null, leaseUntil: null, lastError: null, generation: job.generation + 1, updatedAt: at }).where(and(eq(roomProjectionJobs.roomId, roomId), eq(roomProjectionJobs.generation, job.generation)));
      const updated = await tx.update(rooms).set({ status: payload.phase, appliedProjectionRevision: revision, lastTransitionHash: payloadHash, ...(payload.firstBattleAt ? { firstBattleAt: coalesceTimestamp(rooms.firstBattleAt, new Date(payload.firstBattleAt)) } : {}) }).where(and(eq(rooms.id, roomId), isNull(rooms.closedAt), lt(rooms.appliedProjectionRevision, revision))).returning({ id: rooms.id });
      if (updated.length !== 1) throw new Error("ROOM_PHASE_CAS_MISS");
    });
  }
  async reconcileOrphanedActiveRooms(at = new Date()): Promise<number> {
    return this.db.transaction(async (tx) => {
      const active = await tx.select().from(rooms).where(isNull(rooms.closedAt)).for("update");
      for (const room of active) {
        const [job] = await tx.select().from(roomProjectionJobs).where(eq(roomProjectionJobs.roomId, room.id)).for("update").limit(1);
        const revision = Math.max(room.appliedProjectionRevision, job?.revision ?? -1) + 1;
        const payload: RoomProjectionPayload = { phase: "closed", firstBattleAt: room.firstBattleAt?.toISOString() ?? null, closedAt: at.toISOString() };
        const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        if (!job) await tx.insert(roomProjectionJobs).values({ roomId: room.id, revision, payloadHash, payloadJson: payload, status: "pending", nextAttemptAt: at });
        else await tx.update(roomProjectionJobs).set({ revision, payloadHash, payloadJson: payload, status: "pending", reservationToken: null, attemptCount: 0, nextAttemptAt: at, leaseToken: null, leaseUntil: null, lastError: null, generation: job.generation + 1, updatedAt: at }).where(and(eq(roomProjectionJobs.roomId, room.id), eq(roomProjectionJobs.generation, job.generation)));
        await tx.update(roomParticipants).set({ leftAt: at }).where(and(eq(roomParticipants.roomId, room.id), isNull(roomParticipants.leftAt)));
        await tx.update(rooms).set({ status: "closed", closedAt: at, appliedProjectionRevision: revision, lastTransitionHash: payloadHash }).where(and(eq(rooms.id, room.id), isNull(rooms.closedAt)));
      }
      return active.length;
    });
  }
  async applyProjection(roomId: string, revision: number, payload: RoomProjectionPayload): Promise<boolean> {
    const updated = await this.db.update(rooms).set({
      status: payload.phase,
      appliedProjectionRevision: revision,
      ...(payload.firstBattleAt ? { firstBattleAt: coalesceTimestamp(rooms.firstBattleAt, new Date(payload.firstBattleAt)) } : {}),
      ...(payload.closedAt ? { closedAt: coalesceTimestamp(rooms.closedAt, new Date(payload.closedAt)) } : {}),
    }).where(and(eq(rooms.id, roomId), lt(rooms.appliedProjectionRevision, revision))).returning({ id: rooms.id });
    return updated.length === 1;
  }
}
