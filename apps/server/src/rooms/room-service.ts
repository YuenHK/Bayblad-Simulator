import {
  PROTOCOL_VERSION,
  correlationIdSchema,
  deriveViewerState,
  lobbyRoomSchema,
  lobbySnapshotEventSchema,
  participantSummarySchema,
  participantIdSchema,
  phaseSchema,
  playerReadyEventSchema,
  roomCreateEventSchema,
  roomDeltaEventSchema,
  roomSnapshotEventSchema,
  type LobbyRoom,
  type LobbySnapshotEvent,
  type ParticipantSummary,
  type Phase,
  type RoomDeltaEvent,
  type RoomSnapshotEvent,
  type RoomStatePatch,
  type ViewerRole,
} from "@steam-top/protocol";

const DISCONNECT_RETENTION_MS = 120_000;
const SCHEMA_EVENT_ID = "00000000-0000-4000-8000-000000000000";
const ROOM_EXPIRED = Symbol("ROOM_EXPIRED");

export type InternalUser = Readonly<{
  id: string;
  displayName: string;
}>;

export type JoinRole = "player" | "spectator";
export type MoveTarget = ViewerRole;

export type RoomServiceDependencies = Readonly<{
  now: () => number;
  createRoomId: () => string;
  createParticipantId: () => string;
  createRoomCode: () => string;
  createServerEventId: () => string;
}>;

export type RoomMembership = Readonly<{
  roomId: string;
  code: string;
  participantId: string;
}>;

export type PublicParticipant = Readonly<{
  participantId: string;
  displayName: string;
}>;

export type PublicPlayerSeat = Readonly<{
  participantId: string;
  displayName: string;
  ready: boolean;
  designId: string | null;
}>;

export type PublicRoom = Readonly<{
  id: string;
  code: string;
  name: string;
  ownerParticipantId: string | null;
  phase: Phase;
  player1: PublicPlayerSeat | null;
  player2: PublicPlayerSeat | null;
  spectators: readonly PublicParticipant[];
  revision: number;
}>;

export type RoomView = PublicRoom;

type Participant = {
  readonly internalUserId: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly joinedAt: number;
  role: ViewerRole;
  ready: boolean;
  designId: string | null;
  connected: boolean;
  disconnectedAt: number | null;
};

type Room = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  ownerInternalUserId: string | null;
  phase: Phase;
  player1: string | null;
  player2: string | null;
  spectators: string[];
  readonly participants: Map<string, Participant>;
  revision: number;
  emptySinceMs: number | null;
  pendingDeltas: RoomDeltaEvent[];
};

export type RoomServiceErrorCode =
  | "ROOM_NOT_FOUND"
  | "NOT_IN_ROOM"
  | "ROOM_FULL"
  | "OWNER_REQUIRED"
  | "PARTICIPANT_NOT_FOUND"
  | "SEAT_OCCUPIED"
  | "SEATS_LOCKED"
  | "PLAYER_REQUIRED"
  | "DESIGN_LOCKED"
  | "PLAYERS_NOT_READY"
  | "PARTICIPANT_DISCONNECTED"
  | "INVALID_PHASE_TRANSITION"
  | "ROOM_ACTIVE"
  | "ROOM_ID_GENERATION_FAILED"
  | "PARTICIPANT_ID_GENERATION_FAILED"
  | "CODE_GENERATION_FAILED";

export class RoomServiceError extends Error {
  readonly code: RoomServiceErrorCode;

  constructor(code: RoomServiceErrorCode) {
    super(code);
    this.name = "RoomServiceError";
    this.code = code;
  }
}

const defaultDependencies: RoomServiceDependencies = {
  now: () => Date.now(),
  createRoomId: () => crypto.randomUUID(),
  createParticipantId: () => crypto.randomUUID().replaceAll("-", "").slice(0, 24),
  createRoomCode: () => crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase(),
  createServerEventId: () => crypto.randomUUID(),
};

export class RoomService {
  readonly #dependencies: RoomServiceDependencies;
  #rooms = new Map<string, Room>();
  #roomIdsByCode = new Map<string, string>();
  #lobbyRevision = 0;

  constructor(dependencies: Partial<RoomServiceDependencies> = {}) {
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  create(user: InternalUser, roomName: string): RoomMembership {
    return this.#transaction(null, () => this.#create(user, roomName));
  }

  join(roomId: string, user: InternalUser, role: JoinRole): RoomMembership {
    const result = this.#transaction(roomId, () => this.#join(roomId, user, role));
    if (result === ROOM_EXPIRED) throw new RoomServiceError("ROOM_NOT_FOUND");
    return result;
  }

  move(
    roomId: string,
    actorInternalUserId: string,
    target: MoveTarget,
    subjectParticipantId?: string,
  ): void {
    this.#transaction(roomId, () =>
      this.#move(roomId, actorInternalUserId, target, subjectParticipantId),
    );
  }

  ready(roomId: string, internalUserId: string, designId: string): void {
    this.#transaction(roomId, () => this.#ready(roomId, internalUserId, designId));
  }

  resetReady(roomId: string, actorInternalUserId: string, subjectParticipantId?: string): void {
    this.#transaction(roomId, () =>
      this.#resetReady(roomId, actorInternalUserId, subjectParticipantId),
    );
  }

  setPhase(roomId: string, phase: Phase): void {
    this.#transaction(roomId, () => this.#setPhase(roomId, phase));
  }

  nextRound(roomId: string): void {
    this.#transaction(roomId, () => this.#transitionResult(roomId, "launch"));
  }

  retryRound(roomId: string): void {
    this.#transaction(roomId, () => this.#retryRound(roomId));
  }

  finishMatch(roomId: string): void {
    this.#transaction(roomId, () => this.#transitionResult(roomId, "waiting"));
  }

  cancelMatch(roomId: string): void {
    this.#transaction(roomId, () => this.#cancelMatch(roomId));
  }

  disconnect(roomId: string, internalUserId: string): void {
    this.#transaction(roomId, () => this.#disconnect(roomId, internalUserId));
  }

  leave(roomId: string, internalUserId: string): void {
    this.#transaction(roomId, () => this.#leave(roomId, internalUserId));
  }

  close(roomId: string, actorInternalUserId: string): void {
    this.#transaction(roomId, () => this.#close(roomId, actorInternalUserId));
  }

  sweep(): void {
    for (const roomId of [...this.#rooms.keys()]) {
      this.#transaction(roomId, () => this.#sweepRoom(roomId));
    }
  }

  #create(user: InternalUser, roomName: string): RoomMembership {
    const name = roomCreateEventSchema.parse({
      type: "room.create",
      name: roomName,
      protocolVersion: PROTOCOL_VERSION,
      eventId: SCHEMA_EVENT_ID,
    }).name;
    const participant = this.#newParticipant(user, "player1");
    const id = this.#uniqueRoomId();
    const code = this.#uniqueCode();
    const room: Room = {
      id,
      code,
      name,
      ownerInternalUserId: user.id,
      phase: "waiting",
      player1: user.id,
      player2: null,
      spectators: [],
      participants: new Map([[user.id, participant]]),
      revision: 1,
      emptySinceMs: null,
      pendingDeltas: [],
    };
    this.#rooms.set(id, room);
    this.#roomIdsByCode.set(code, id);
    this.#lobbyRevision += 1;
    return Object.freeze({ roomId: id, code, participantId: participant.participantId });
  }

  #join(
    roomId: string,
    user: InternalUser,
    role: JoinRole,
  ): RoomMembership | typeof ROOM_EXPIRED {
    const room = this.#room(roomId);
    const now = this.#dependencies.now();
    if (
      room.emptySinceMs !== null &&
      now - room.emptySinceMs >= DISCONNECT_RETENTION_MS
    ) {
      this.#deleteRoom(room);
      return ROOM_EXPIRED;
    }
    let existing = room.participants.get(user.id);
    if (
      existing &&
      !existing.connected &&
      existing.disconnectedAt !== null &&
      now - existing.disconnectedAt >= DISCONNECT_RETENTION_MS &&
      !(
        room.phase !== "waiting" &&
        existing.role !== "spectator"
      )
    ) {
      this.#removeParticipant(room, existing);
      this.#markEmpty(room, now);
      if (
        room.emptySinceMs !== null &&
        now - room.emptySinceMs >= DISCONNECT_RETENTION_MS
      ) {
        this.#deleteRoom(room);
        return ROOM_EXPIRED;
      }
      existing = undefined;
    }
    if (existing) {
      if (!existing.connected) {
        existing.connected = true;
        existing.disconnectedAt = null;
        room.emptySinceMs = null;
        if (room.ownerInternalUserId === null) {
          room.ownerInternalUserId = existing.internalUserId;
          this.#emitDelta(room, { ownerParticipantId: existing.participantId }, [], []);
        }
      }
      return Object.freeze({ roomId, code: room.code, participantId: existing.participantId });
    }

    if (role === "player" && room.phase !== "waiting") {
      throw new RoomServiceError("SEATS_LOCKED");
    }

    let assignedRole: ViewerRole;
    if (role === "spectator") {
      assignedRole = "spectator";
    } else if (room.player1 === null) {
      assignedRole = "player1";
    } else if (room.player2 === null) {
      assignedRole = "player2";
    } else {
      throw new RoomServiceError("ROOM_FULL");
    }

    const participant = this.#newParticipant(user, assignedRole, room);
    room.participants.set(user.id, participant);
    this.#addToLocation(room, participant);
    room.emptySinceMs = null;

    const patch: RoomStatePatch =
      assignedRole === "spectator"
        ? { spectatorCount: room.spectators.length }
        : { [assignedRole]: this.#seat(participant) };
    if (room.ownerInternalUserId === null) {
      room.ownerInternalUserId = participant.internalUserId;
      patch.ownerParticipantId = participant.participantId;
    }
    this.#emitDelta(room, patch, assignedRole === "spectator" ? [this.#summary(participant)] : [], []);
    return Object.freeze({ roomId, code: room.code, participantId: participant.participantId });
  }

  #move(
    roomId: string,
    actorInternalUserId: string,
    target: MoveTarget,
    subjectParticipantId?: string,
  ): void {
    const room = this.#room(roomId);
    const actor = this.#connectedParticipant(room, actorInternalUserId);
    if (room.phase !== "waiting") {
      throw new RoomServiceError("SEATS_LOCKED");
    }
    const subject = subjectParticipantId
      ? this.#connectedParticipantByPublicId(room, subjectParticipantId)
      : actor;
    if (subject !== actor && room.ownerInternalUserId !== actorInternalUserId) {
      throw new RoomServiceError("OWNER_REQUIRED");
    }
    if (subject.role === target) return;
    if (target !== "spectator" && this.#internalIdAt(room, target) !== null) {
      throw new RoomServiceError("SEAT_OCCUPIED");
    }

    const previousRole = subject.role;
    this.#removeFromLocation(room, subject);
    subject.role = target;
    subject.ready = false;
    subject.designId = null;
    this.#addToLocation(room, subject);

    const patch: RoomStatePatch = {};
    if (previousRole !== "spectator") patch[previousRole] = null;
    if (target !== "spectator") patch[target] = this.#seat(subject);
    if (previousRole === "spectator" || target === "spectator") {
      patch.spectatorCount = room.spectators.length;
    }
    this.#emitDelta(
      room,
      patch,
      target === "spectator" ? [this.#summary(subject)] : [],
      previousRole === "spectator" ? [subject.participantId] : [],
    );
  }

  #ready(roomId: string, internalUserId: string, designId: string): void {
    const room = this.#room(roomId);
    const participant = this.#connectedParticipant(room, internalUserId);
    if (room.phase !== "waiting") throw new RoomServiceError("DESIGN_LOCKED");
    if (participant.role === "spectator") throw new RoomServiceError("PLAYER_REQUIRED");
    const normalizedDesignId = playerReadyEventSchema.parse({
      type: "player.ready",
      roomId,
      designId,
      protocolVersion: PROTOCOL_VERSION,
      eventId: SCHEMA_EVENT_ID,
    }).designId;
    if (participant.ready) {
      if (participant.designId === normalizedDesignId) return;
      throw new RoomServiceError("DESIGN_LOCKED");
    }
    participant.ready = true;
    participant.designId = normalizedDesignId;
    this.#emitDelta(room, { [participant.role]: this.#seat(participant) }, [], []);
  }

  #resetReady(roomId: string, actorInternalUserId: string, subjectParticipantId?: string): void {
    const room = this.#room(roomId);
    const actor = this.#connectedParticipant(room, actorInternalUserId);
    if (room.phase !== "waiting") throw new RoomServiceError("DESIGN_LOCKED");
    const subject = subjectParticipantId
      ? this.#connectedParticipantByPublicId(room, subjectParticipantId)
      : actor;
    if (subject !== actor && room.ownerInternalUserId !== actorInternalUserId) {
      throw new RoomServiceError("OWNER_REQUIRED");
    }
    if (subject.role === "spectator") throw new RoomServiceError("PLAYER_REQUIRED");
    if (!subject.ready && subject.designId === null) return;
    subject.ready = false;
    subject.designId = null;
    this.#emitDelta(room, { [subject.role]: this.#seat(subject) }, [], []);
  }

  #setPhase(roomId: string, phase: Phase): void {
    const room = this.#room(roomId);
    const nextPhase = phaseSchema.parse(phase);
    const allowed: Readonly<Partial<Record<Phase, Phase>>> = {
      waiting: "launch",
      launch: "battle",
      battle: "result",
    };
    if (allowed[room.phase] !== nextPhase) {
      throw new RoomServiceError("INVALID_PHASE_TRANSITION");
    }
    if (room.phase === "waiting" && nextPhase === "launch") {
      const players = [room.player1, room.player2].map((internalUserId) =>
        internalUserId === null ? undefined : room.participants.get(internalUserId),
      );
      if (
        players.some(
          (participant) =>
            !participant ||
            !participant.connected ||
            !participant.ready ||
            participant.designId === null,
        )
      ) {
        throw new RoomServiceError("PLAYERS_NOT_READY");
      }
    }
    room.phase = nextPhase;
    const patch: RoomStatePatch = { phase: nextPhase };
    this.#emitDelta(room, patch, [], []);
  }

  #transitionResult(roomId: string, nextPhase: "launch" | "waiting"): void {
    const room = this.#room(roomId);
    if (room.phase !== "result") throw new RoomServiceError("INVALID_PHASE_TRANSITION");
    room.phase = nextPhase;
    const patch: RoomStatePatch = { phase: nextPhase };
    if (nextPhase === "waiting") this.#clearReady(room, patch);
    this.#emitDelta(room, patch, [], []);
  }

  #retryRound(roomId: string): void {
    const room = this.#room(roomId);
    if (room.phase !== "battle" && room.phase !== "result") {
      throw new RoomServiceError("INVALID_PHASE_TRANSITION");
    }
    room.phase = "launch";
    this.#emitDelta(room, { phase: "launch" }, [], []);
  }

  #cancelMatch(roomId: string): void {
    const room = this.#room(roomId);
    const patch: RoomStatePatch = {};
    if (room.phase !== "waiting") {
      room.phase = "waiting";
      patch.phase = "waiting";
    }
    this.#clearReady(room, patch);
    if (Object.keys(patch).length === 0) throw new RoomServiceError("INVALID_PHASE_TRANSITION");
    this.#emitDelta(room, patch, [], []);
  }

  #clearReady(room: Room, patch: RoomStatePatch): void {
    for (const role of ["player1", "player2"] as const) {
      const internalUserId = room[role];
      if (internalUserId === null) continue;
      const participant = room.participants.get(internalUserId)!;
      participant.ready = false;
      participant.designId = null;
      patch[role] = this.#seat(participant);
    }
  }

  #disconnect(roomId: string, internalUserId: string): void {
    const room = this.#room(roomId);
    const participant = this.#participant(room, internalUserId);
    if (!participant.connected) return;
    const now = this.#dependencies.now();
    this.#markDisconnected(room, participant, now);
  }

  #leave(roomId: string, internalUserId: string): void {
    const room = this.#room(roomId);
    const participant = this.#participant(room, internalUserId);
    if (
      room.phase !== "waiting" &&
      participant.role !== "spectator"
    ) {
      if (!participant.connected) return;
      this.#markDisconnected(room, participant, this.#dependencies.now());
      return;
    }
    if (!participant.connected) throw new RoomServiceError("PARTICIPANT_DISCONNECTED");
    this.#removeParticipant(room, participant);
    this.#transferOwnerIfMissing(room);
    this.#markEmpty(room, this.#dependencies.now());
  }

  #close(roomId: string, actorInternalUserId: string): void {
    const room = this.#room(roomId);
    this.#connectedParticipant(room, actorInternalUserId);
    if (room.ownerInternalUserId !== actorInternalUserId) {
      throw new RoomServiceError("OWNER_REQUIRED");
    }
    if (room.phase !== "waiting") {
      throw new RoomServiceError("ROOM_ACTIVE");
    }
    this.#deleteRoom(room);
  }

  #sweepRoom(roomId: string): void {
    const room = this.#room(roomId);
    const now = this.#dependencies.now();
    const hasConnectedParticipant = [...room.participants.values()].some(
      (participant) => participant.connected,
    );
    if (
      !hasConnectedParticipant &&
      room.emptySinceMs !== null &&
      now - room.emptySinceMs >= DISCONNECT_RETENTION_MS
    ) {
      this.#deleteRoom(room);
      return;
    }

    const seatsAreRetained = room.phase !== "waiting";
    for (const participant of [...room.participants.values()]) {
      const expired =
        !participant.connected &&
        participant.disconnectedAt !== null &&
        now - participant.disconnectedAt >= DISCONNECT_RETENTION_MS;
      if (!expired) continue;
      if (seatsAreRetained && participant.role !== "spectator") {
        if (room.ownerInternalUserId === participant.internalUserId) {
          const nextOwner = this.#ownerCandidate(room);
          if (nextOwner) {
            room.ownerInternalUserId = nextOwner.internalUserId;
            this.#emitDelta(room, { ownerParticipantId: nextOwner.participantId }, [], []);
          }
        }
        continue;
      }
      this.#removeParticipant(room, participant);
    }
    if (!this.#rooms.has(room.id)) return;
    this.#transferOwnerIfMissing(room);
    this.#markEmpty(room, now);
    if (
      room.emptySinceMs !== null &&
      now - room.emptySinceMs >= DISCONNECT_RETENTION_MS
    ) {
      this.#deleteRoom(room);
    }
  }

  snapshot(roomId: string, viewerInternalUserId: string): RoomSnapshotEvent {
    const room = this.#room(roomId);
    const viewerParticipant = this.#connectedParticipant(room, viewerInternalUserId);
    const owner = room.ownerInternalUserId
      ? room.participants.get(room.ownerInternalUserId)
      : undefined;
    if (!owner) throw new Error("A non-empty room must have an owner");
    const state = {
      ownerParticipantId: owner.participantId,
      player1: this.#publicSeat(room, "player1"),
      player2: this.#publicSeat(room, "player2"),
      spectators: room.spectators.map((id) => this.#summary(room.participants.get(id)!)),
    };
    return roomSnapshotEventSchema.parse({
      type: "room.snapshot",
      roomId: room.id,
      code: room.code,
      name: room.name,
      phase: room.phase,
      revision: room.revision,
      ...state,
      viewer: deriveViewerState(state, viewerParticipant.participantId),
      protocolVersion: PROTOCOL_VERSION,
      serverEventId: this.#dependencies.createServerEventId(),
    });
  }

  lobbySnapshot(): LobbySnapshotEvent {
    const rooms: LobbyRoom[] = [...this.#rooms.values()].map((room) => ({
      id: room.id,
      code: room.code,
      name: room.name,
      phase: room.phase,
      player1: { displayName: this.#publicSeat(room, "player1")?.displayName ?? null },
      player2: { displayName: this.#publicSeat(room, "player2")?.displayName ?? null },
      spectatorCount: room.spectators.length,
    }));
    return lobbySnapshotEventSchema.parse({
      type: "lobby.snapshot",
      revision: this.#lobbyRevision,
      rooms,
      protocolVersion: PROTOCOL_VERSION,
      serverEventId: this.#dependencies.createServerEventId(),
    });
  }

  get(roomId: string): RoomView | undefined {
    const room = this.#rooms.get(roomId);
    if (!room) return undefined;
    const owner = room.ownerInternalUserId
      ? room.participants.get(room.ownerInternalUserId)
      : undefined;
    return {
      id: room.id,
      code: room.code,
      name: room.name,
      ownerParticipantId: owner?.participantId ?? null,
      phase: room.phase,
      player1: this.#publicSeat(room, "player1"),
      player2: this.#publicSeat(room, "player2"),
      spectators: room.spectators.map((id) => this.#summary(room.participants.get(id)!)),
      revision: room.revision,
    };
  }

  drainDeltas(roomId: string): RoomDeltaEvent[] {
    const room = this.#room(roomId);
    const deltas = structuredClone(room.pendingDeltas);
    room.pendingDeltas = [];
    return deltas;
  }

  hasRoom(roomId: string): boolean {
    return this.#rooms.has(roomId);
  }

  #newParticipant(user: InternalUser, role: ViewerRole, room?: Room): Participant {
    const participantId = this.#uniqueParticipantId(room);
    const summary = participantSummarySchema.parse({
      participantId,
      displayName: user.displayName,
    });
    return {
      internalUserId: user.id,
      participantId: summary.participantId,
      displayName: summary.displayName,
      joinedAt: this.#dependencies.now(),
      role,
      ready: false,
      designId: null,
      connected: true,
      disconnectedAt: null,
    };
  }

  #uniqueParticipantId(room?: Room): string {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const participantId = participantIdSchema.parse(
        this.#dependencies.createParticipantId(),
      );
      if (
        !room ||
        ![...room.participants.values()].some(
          (participant) => participant.participantId === participantId,
        )
      ) {
        return participantId;
      }
    }
    throw new RoomServiceError("PARTICIPANT_ID_GENERATION_FAILED");
  }

  #uniqueCode(): string {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const code = lobbyRoomSchema.parse({
        id: "room-code-validation",
        code: this.#dependencies.createRoomCode(),
        name: "Room",
        phase: "waiting",
        player1: { displayName: null },
        player2: { displayName: null },
        spectatorCount: 0,
      }).code;
      if (!this.#roomIdsByCode.has(code)) return code;
    }
    throw new RoomServiceError("CODE_GENERATION_FAILED");
  }

  #uniqueRoomId(): string {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const roomId = correlationIdSchema.parse(this.#dependencies.createRoomId());
      if (!this.#rooms.has(roomId)) return roomId;
    }
    throw new RoomServiceError("ROOM_ID_GENERATION_FAILED");
  }

  #room(roomId: string): Room {
    const room = this.#rooms.get(roomId);
    if (!room) throw new RoomServiceError("ROOM_NOT_FOUND");
    return room;
  }

  #participant(room: Room, internalUserId: string): Participant {
    const participant = room.participants.get(internalUserId);
    if (!participant) throw new RoomServiceError("NOT_IN_ROOM");
    return participant;
  }

  #participantByPublicId(room: Room, participantId: string): Participant {
    const participant = [...room.participants.values()].find(
      (candidate) => candidate.participantId === participantId,
    );
    if (!participant) throw new RoomServiceError("PARTICIPANT_NOT_FOUND");
    return participant;
  }

  #connectedParticipant(room: Room, internalUserId: string): Participant {
    const participant = this.#participant(room, internalUserId);
    if (!participant.connected) throw new RoomServiceError("PARTICIPANT_DISCONNECTED");
    return participant;
  }

  #connectedParticipantByPublicId(room: Room, participantId: string): Participant {
    const participant = this.#participantByPublicId(room, participantId);
    if (!participant.connected) throw new RoomServiceError("PARTICIPANT_DISCONNECTED");
    return participant;
  }

  #internalIdAt(room: Room, role: Exclude<ViewerRole, "spectator">): string | null {
    return room[role];
  }

  #removeFromLocation(room: Room, participant: Participant): void {
    if (participant.role === "spectator") {
      room.spectators = room.spectators.filter((id) => id !== participant.internalUserId);
    } else {
      room[participant.role] = null;
    }
  }

  #addToLocation(room: Room, participant: Participant): void {
    if (participant.role === "spectator") {
      room.spectators.push(participant.internalUserId);
    } else room[participant.role] = participant.internalUserId;
  }

  #removeParticipant(room: Room, participant: Participant): void {
    const previousRole = participant.role;
    this.#removeFromLocation(room, participant);
    room.participants.delete(participant.internalUserId);
    if (room.ownerInternalUserId === participant.internalUserId) room.ownerInternalUserId = null;
    const patch: RoomStatePatch =
      previousRole === "spectator"
        ? { spectatorCount: room.spectators.length }
        : { [previousRole]: null };
    if (room.ownerInternalUserId === null) {
      const nextOwner = this.#ownerCandidate(room);
      if (nextOwner) {
        room.ownerInternalUserId = nextOwner.internalUserId;
        patch.ownerParticipantId = nextOwner.participantId;
      }
    }
    this.#emitDelta(
      room,
      patch,
      [],
      previousRole === "spectator" ? [participant.participantId] : [],
    );
  }

  #transferOwnerIfMissing(room: Room): void {
    if (room.ownerInternalUserId !== null) return;
    const candidate = this.#ownerCandidate(room);
    if (!candidate) return;
    room.ownerInternalUserId = candidate.internalUserId;
    this.#emitDelta(room, { ownerParticipantId: candidate.participantId }, [], []);
  }

  #ownerCandidate(room: Room): Participant | undefined {
    return [...room.participants.values()]
      .filter((participant) => participant.connected)
      .sort(
        (left, right) =>
          left.joinedAt - right.joinedAt ||
          left.participantId.localeCompare(right.participantId),
      )[0];
  }

  #markDisconnected(room: Room, participant: Participant, now: number): void {
    participant.connected = false;
    participant.disconnectedAt = now;
    this.#markEmpty(room, now);
  }

  #markEmpty(room: Room, now = this.#dependencies.now()): void {
    const hasConnectedParticipant = [...room.participants.values()].some(
      (participant) => participant.connected,
    );
    if (hasConnectedParticipant) room.emptySinceMs = null;
    else if (room.emptySinceMs === null) room.emptySinceMs = now;
  }

  #deleteRoom(room: Room): void {
    this.#rooms.delete(room.id);
    this.#roomIdsByCode.delete(room.code);
    this.#lobbyRevision += 1;
  }

  #publicSeat(room: Room, role: Exclude<ViewerRole, "spectator">) {
    const internalUserId = room[role];
    return internalUserId === null ? null : this.#seat(room.participants.get(internalUserId)!);
  }

  #seat(participant: Participant) {
    return {
      participantId: participant.participantId,
      displayName: participant.displayName,
      ready: participant.ready,
      designId: participant.designId,
    };
  }

  #summary(participant: Participant): ParticipantSummary {
    return {
      participantId: participant.participantId,
      displayName: participant.displayName,
    };
  }

  #transaction<T>(roomId: string | null, mutation: () => T): T {
    const allRoomsBackup = roomId === null ? new Map(this.#rooms) : undefined;
    const hadRoom = roomId !== null && this.#rooms.has(roomId);
    const roomBackup =
      roomId !== null && hadRoom ? this.#copyRoom(this.#rooms.get(roomId)!) : undefined;
    const roomIdsByCodeBackup = new Map(this.#roomIdsByCode);
    const lobbyRevisionBackup = this.#lobbyRevision;
    try {
      return mutation();
    } catch (error) {
      if (roomId === null) {
        this.#rooms = allRoomsBackup!;
      } else if (hadRoom) {
        this.#rooms.set(roomId, roomBackup!);
      } else {
        this.#rooms.delete(roomId);
      }
      this.#roomIdsByCode = roomIdsByCodeBackup;
      this.#lobbyRevision = lobbyRevisionBackup;
      throw error;
    }
  }

  #copyRoom(room: Room): Room {
    return {
      ...room,
      spectators: [...room.spectators],
      participants: new Map(
        [...room.participants].map(([internalUserId, participant]) => [
          internalUserId,
          { ...participant },
        ]),
      ),
      pendingDeltas: [...room.pendingDeltas],
    };
  }

  #emitDelta(
    room: Room,
    patch: RoomStatePatch,
    joined: ParticipantSummary[],
    leftParticipantIds: string[],
  ): void {
    const baseRevision = room.revision;
    room.revision += 1;
    this.#lobbyRevision += 1;
    room.pendingDeltas.push(
      roomDeltaEventSchema.parse({
        type: "room.delta",
        roomId: room.id,
        baseRevision,
        revision: room.revision,
        patch,
        joined,
        leftParticipantIds,
        protocolVersion: PROTOCOL_VERSION,
        serverEventId: this.#dependencies.createServerEventId(),
      }),
    );
  }
}
