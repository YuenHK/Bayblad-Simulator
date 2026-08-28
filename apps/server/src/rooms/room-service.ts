import {
  PROTOCOL_VERSION,
  deriveViewerState,
  lobbySnapshotEventSchema,
  participantSummarySchema,
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
  | "INVALID_PHASE_TRANSITION"
  | "ROOM_ACTIVE"
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
  createRoomCode: () => Math.random().toString(36).slice(2, 8).toUpperCase(),
  createServerEventId: () => crypto.randomUUID(),
};

export class RoomService {
  readonly #dependencies: RoomServiceDependencies;
  readonly #rooms = new Map<string, Room>();
  readonly #roomIdsByCode = new Map<string, string>();
  #lobbyRevision = 0;

  constructor(dependencies: Partial<RoomServiceDependencies> = {}) {
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  create(user: InternalUser, roomName: string): RoomMembership {
    const name = roomCreateEventSchema.parse({
      type: "room.create",
      name: roomName,
      protocolVersion: PROTOCOL_VERSION,
      eventId: SCHEMA_EVENT_ID,
    }).name;
    const participant = this.#newParticipant(user, "player1");
    const id = this.#dependencies.createRoomId();
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

  join(roomId: string, user: InternalUser, role: JoinRole): RoomMembership {
    const room = this.#room(roomId);
    let existing = room.participants.get(user.id);
    const now = this.#dependencies.now();
    if (
      existing &&
      !existing.connected &&
      existing.disconnectedAt !== null &&
      now - existing.disconnectedAt >= DISCONNECT_RETENTION_MS
    ) {
      this.#removeParticipant(room, existing);
      this.#markEmpty(room);
      if (
        room.emptySinceMs !== null &&
        now - room.emptySinceMs >= DISCONNECT_RETENTION_MS
      ) {
        this.#deleteRoom(room);
        throw new RoomServiceError("ROOM_NOT_FOUND");
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

    const participant = this.#newParticipant(user, assignedRole);
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

  move(
    roomId: string,
    actorInternalUserId: string,
    target: MoveTarget,
    subjectParticipantId?: string,
  ): void {
    const room = this.#room(roomId);
    if (room.phase === "launch" || room.phase === "battle") {
      throw new RoomServiceError("SEATS_LOCKED");
    }
    const actor = this.#participant(room, actorInternalUserId);
    const subject = subjectParticipantId
      ? this.#participantByPublicId(room, subjectParticipantId)
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

  ready(roomId: string, internalUserId: string, designId: string): void {
    const room = this.#room(roomId);
    const participant = this.#participant(room, internalUserId);
    if (participant.role === "spectator") throw new RoomServiceError("PLAYER_REQUIRED");
    const normalizedDesignId = playerReadyEventSchema.parse({
      type: "player.ready",
      roomId,
      designId,
      protocolVersion: PROTOCOL_VERSION,
      eventId: SCHEMA_EVENT_ID,
    }).designId;
    participant.ready = true;
    participant.designId = normalizedDesignId;
    this.#emitDelta(room, { [participant.role]: this.#seat(participant) }, [], []);
  }

  resetReady(roomId: string, actorInternalUserId: string, subjectParticipantId?: string): void {
    const room = this.#room(roomId);
    const actor = this.#participant(room, actorInternalUserId);
    const subject = subjectParticipantId
      ? this.#participantByPublicId(room, subjectParticipantId)
      : actor;
    if (subject !== actor && room.ownerInternalUserId !== actorInternalUserId) {
      throw new RoomServiceError("OWNER_REQUIRED");
    }
    if (subject.role === "spectator") throw new RoomServiceError("PLAYER_REQUIRED");
    subject.ready = false;
    subject.designId = null;
    this.#emitDelta(room, { [subject.role]: this.#seat(subject) }, [], []);
  }

  setPhase(roomId: string, phase: Phase): void {
    const room = this.#room(roomId);
    const nextPhase = phaseSchema.parse(phase);
    const allowed: Readonly<Record<Phase, Phase>> = {
      waiting: "launch",
      launch: "battle",
      battle: "result",
      result: "waiting",
    };
    if (allowed[room.phase] !== nextPhase) {
      throw new RoomServiceError("INVALID_PHASE_TRANSITION");
    }
    room.phase = nextPhase;
    const patch: RoomStatePatch = { phase: nextPhase };
    if (nextPhase === "waiting") {
      for (const role of ["player1", "player2"] as const) {
        const internalUserId = room[role];
        if (internalUserId === null) continue;
        const participant = room.participants.get(internalUserId)!;
        participant.ready = false;
        participant.designId = null;
        patch[role] = this.#seat(participant);
      }
    }
    this.#emitDelta(room, patch, [], []);
  }

  disconnect(roomId: string, internalUserId: string): void {
    const room = this.#room(roomId);
    const participant = this.#participant(room, internalUserId);
    if (!participant.connected) return;
    participant.connected = false;
    participant.disconnectedAt = this.#dependencies.now();
    if (![...room.participants.values()].some((candidate) => candidate.connected)) {
      room.emptySinceMs = this.#dependencies.now();
    }
  }

  leave(roomId: string, internalUserId: string): void {
    const room = this.#room(roomId);
    const participant = this.#participant(room, internalUserId);
    this.#removeParticipant(room, participant);
    this.#transferOwnerIfMissing(room);
    this.#markEmpty(room);
  }

  close(roomId: string, actorInternalUserId: string): void {
    const room = this.#room(roomId);
    this.#participant(room, actorInternalUserId);
    if (room.ownerInternalUserId !== actorInternalUserId) {
      throw new RoomServiceError("OWNER_REQUIRED");
    }
    if (room.phase === "launch" || room.phase === "battle") {
      throw new RoomServiceError("ROOM_ACTIVE");
    }
    this.#deleteRoom(room);
  }

  sweep(): void {
    const now = this.#dependencies.now();
    for (const room of [...this.#rooms.values()]) {
      for (const participant of [...room.participants.values()]) {
        if (
          !participant.connected &&
          participant.disconnectedAt !== null &&
          now - participant.disconnectedAt >= DISCONNECT_RETENTION_MS
        ) {
          this.#removeParticipant(room, participant);
        }
      }
      if (!this.#rooms.has(room.id)) continue;
      this.#transferOwnerIfMissing(room);
      this.#markEmpty(room);
      if (
        room.emptySinceMs !== null &&
        now - room.emptySinceMs >= DISCONNECT_RETENTION_MS
      ) {
        this.#deleteRoom(room);
      }
    }
  }

  snapshot(roomId: string, viewerInternalUserId: string): RoomSnapshotEvent {
    const room = this.#room(roomId);
    const viewerParticipant = room.participants.get(viewerInternalUserId);
    if (!viewerParticipant) throw new RoomServiceError("NOT_IN_ROOM");
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

  drainDeltas(roomId: string): RoomDeltaEvent[] {
    const room = this.#room(roomId);
    const deltas = structuredClone(room.pendingDeltas);
    room.pendingDeltas = [];
    return deltas;
  }

  hasRoom(roomId: string): boolean {
    return this.#rooms.has(roomId);
  }

  #newParticipant(user: InternalUser, role: ViewerRole): Participant {
    const summary = participantSummarySchema.parse({
      participantId: this.#dependencies.createParticipantId(),
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

  #uniqueCode(): string {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const code = this.#dependencies.createRoomCode();
      if (!this.#roomIdsByCode.has(code)) return code;
    }
    throw new RoomServiceError("CODE_GENERATION_FAILED");
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

  #markEmpty(room: Room): void {
    const hasConnectedParticipant = [...room.participants.values()].some(
      (participant) => participant.connected,
    );
    if (hasConnectedParticipant) room.emptySinceMs = null;
    else if (room.emptySinceMs === null) room.emptySinceMs = this.#dependencies.now();
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
