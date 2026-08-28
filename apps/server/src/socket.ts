import {
  PROTOCOL_VERSION,
  clientEventSchema,
  participantSummarySchema,
  protocolHelloEventSchema,
  type ServerEvent,
  type V1CommandEvent,
} from "@steam-top/protocol";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { DesignRegistry } from "./design-registry";
import type { BattleEnginePort } from "./app";
import { LaunchCoordinator, type LaunchJudgement } from "./battle/launch";
import { scoreMatch } from "./battle/scoring";
import { RoomService } from "./rooms/room-service";

type Session = {
  id: string;
  token: string;
  displayName: string;
  roomIds: Set<string>;
  socketIds: Set<string>;
  events: Map<string, string>;
};

export type RealtimeDependencies = Readonly<{
  rooms: RoomService;
  designs: DesignRegistry;
  battleEngine: BattleEnginePort;
  launch: LaunchCoordinator;
  now?: () => number;
  seedFactory?: () => number;
  createServerEventId?: () => string;
  createSessionId?: () => string;
  createSessionToken?: () => string;
}>; 

type MatchState = {
  generation: number;
  matchId: string;
  attempt: number;
  currentRoundId: string;
  roundWinners: Array<"player1" | "player2">;
  players: readonly [
    { participantId: string; sessionId: string; designId: string },
    { participantId: string; sessionId: string; designId: string },
  ];
  launches: Map<string, LaunchJudgement>;
  simulating: boolean;
  controller: AbortController | null;
};

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class RealtimeGateway {
  readonly io: Server;
  readonly #rooms: RoomService;
  readonly #designs: DesignRegistry;
  readonly #battleEngine: BattleEnginePort;
  readonly #launch: LaunchCoordinator;
  readonly #now: () => number;
  readonly #seedFactory: () => number;
  readonly #createServerEventId: () => string;
  readonly #createSessionId: () => string;
  readonly #createSessionToken: () => string;
  readonly #sessionsByToken = new Map<string, Session>();
  readonly #sessionBySocketId = new Map<string, Session>();
  readonly #sessionIdsByParticipant = new Map<string, Map<string, string>>();
  readonly #matches = new Map<string, MatchState>();

  constructor(server: HttpServer, dependencies: RealtimeDependencies) {
    this.#rooms = dependencies.rooms;
    this.#designs = dependencies.designs;
    this.#battleEngine = dependencies.battleEngine;
    this.#launch = dependencies.launch;
    this.#now = dependencies.now ?? Date.now;
    this.#seedFactory = dependencies.seedFactory ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]!);
    this.#createServerEventId = dependencies.createServerEventId ?? (() => crypto.randomUUID());
    this.#createSessionId = dependencies.createSessionId ?? (() => crypto.randomUUID());
    this.#createSessionToken = dependencies.createSessionToken ?? randomToken;
    this.io = new Server(server, { cors: { origin: false } });
    this.io.on("connection", (socket) => this.#connect(socket));
  }

  sessionForBearer(value: string | undefined): Readonly<{ id: string; displayName: string }> | undefined {
    if (!value?.startsWith("Bearer ")) return undefined;
    const session = this.#sessionsByToken.get(value.slice(7));
    return session ? { id: session.id, displayName: session.displayName } : undefined;
  }

  async close(): Promise<void> {
    for (const [roomId, match] of this.#matches) this.#cancelMatch(roomId, match);
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
  }

  pump(nowMs = this.#now()): void {
    this.#launch.finalizeExpired(nowMs);
    for (const [roomId, match] of [...this.#matches]) {
      if (!this.#rooms.hasRoom(roomId)) {
        this.#cancelMatch(roomId, match);
        continue;
      }
      this.#flushLaunch(roomId, match);
    }
    const beforeSweep = [...new Set([...this.#sessionsByToken.values()].flatMap((session) => [...session.roomIds]))];
    this.#rooms.sweep();
    let lobbyChanged = false;
    for (const roomId of beforeSweep) {
      if (this.#rooms.hasRoom(roomId)) this.#broadcastRoom(roomId);
      else {
        lobbyChanged = true;
        for (const session of this.#sessionsByToken.values()) session.roomIds.delete(roomId);
      }
    }
    if (lobbyChanged) this.#broadcastLobby();
    for (const [roomId, match] of [...this.#matches]) {
      if (!this.#rooms.hasRoom(roomId)) this.#cancelMatch(roomId, match);
    }
  }

  #connect(socket: Socket): void {
    const auth = socket.handshake.auth as Record<string, unknown>;
    const display = participantSummarySchema.safeParse({
      participantId: "identity-check",
      displayName: auth.displayName,
    });
    if (!display.success) {
      socket.disconnect(true);
      return;
    }
    const requestedToken = typeof auth.sessionToken === "string" ? auth.sessionToken : undefined;
    let session = requestedToken ? this.#sessionsByToken.get(requestedToken) : undefined;
    if (!session) {
      session = {
        id: this.#createSessionId(),
        token: this.#uniqueToken(),
        displayName: display.data.displayName,
        roomIds: new Set(),
        socketIds: new Set(),
        events: new Map(),
      };
      this.#sessionsByToken.set(session.token, session);
    }
    session.socketIds.add(socket.id);
    this.#sessionBySocketId.set(socket.id, session);
    let welcomed = false;
    socket.on("client.event", (raw: unknown) => {
      const hello = protocolHelloEventSchema.safeParse(raw);
      if (hello.success) {
        if (!hello.data.supportedVersions.includes(PROTOCOL_VERSION)) {
          this.#emit(socket, {
            type: "protocol.unsupported",
            serverEventId: this.#createServerEventId(),
            supportedVersions: [PROTOCOL_VERSION],
            causedByEventId: hello.data.eventId,
            reason: "No mutually supported protocol version",
          });
          return;
        }
        welcomed = true;
        this.#emit(socket, {
          type: "protocol.welcome",
          selectedVersion: PROTOCOL_VERSION,
          sessionToken: session.token,
          protocolVersion: PROTOCOL_VERSION,
          serverEventId: this.#createServerEventId(),
        });
        this.#emit(socket, this.#rooms.lobbySnapshot());
        for (const roomId of [...session.roomIds]) {
          if (!this.#rooms.hasRoom(roomId)) {
            session.roomIds.delete(roomId);
            continue;
          }
          try {
            this.#rooms.join(roomId, this.#user(session), "spectator");
            this.#emit(socket, this.#rooms.snapshot(roomId, session.id));
          } catch { /* retention may have expired between checks */ }
        }
        return;
      }
      if (!welcomed) {
        this.#error(socket, "INVALID_EVENT", "Protocol hello is required");
        return;
      }
      const parsed = clientEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.type === "protocol.hello") {
        this.#error(socket, "INVALID_EVENT", "Malformed protocol event");
        return;
      }
      void this.#command(socket, session, parsed.data).catch((error: unknown) => {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : "COMMAND_FAILED";
        this.#error(socket, code, code, parsed.data.eventId);
      });
    });
    socket.on("disconnect", () => {
      session!.socketIds.delete(socket.id);
      this.#sessionBySocketId.delete(socket.id);
      if (session!.socketIds.size > 0) return;
      for (const roomId of session!.roomIds) {
        try { this.#rooms.disconnect(roomId, session!.id); } catch { /* already closed */ }
      }
    });
  }

  async #command(socket: Socket, session: Session, event: V1CommandEvent): Promise<void> {
    const fingerprint = JSON.stringify(event);
    const previous = session.events.get(event.eventId);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw Object.assign(new Error("EVENT_ID_CONFLICT"), { code: "EVENT_ID_CONFLICT" });
      this.#ack(socket, event.eventId, "replayed");
      return;
    }
    if (event.type === "room.create") {
      const membership = this.#rooms.create(this.#user(session), event.name);
      session.roomIds.add(membership.roomId);
      this.#bindParticipant(membership.roomId, membership.participantId, session.id);
      this.#emit(socket, this.#rooms.snapshot(membership.roomId, session.id));
      this.#broadcastLobby();
    } else if (event.type === "room.join") {
      const membership = this.#rooms.join(event.roomId, this.#user(session), event.role);
      session.roomIds.add(event.roomId);
      this.#bindParticipant(event.roomId, membership.participantId, session.id);
      this.#broadcastRoom(event.roomId);
      this.#emit(socket, this.#rooms.snapshot(event.roomId, session.id));
      this.#broadcastLobby();
    } else if (event.type === "room.move") {
      this.#rooms.move(event.roomId, session.id, event.target, event.subjectParticipantId);
      this.#broadcastRoom(event.roomId);
      this.#broadcastLobby();
    } else if (event.type === "player.ready") {
      this.#designs.requireOwned(session.id, event.designId);
      this.#rooms.ready(event.roomId, session.id, event.designId);
      this.#broadcastRoom(event.roomId);
      this.#broadcastLobby();
      this.#startMatchIfReady(event.roomId);
    } else if (event.type === "room.close") {
      this.#rooms.close(event.roomId, session.id);
      const match = this.#matches.get(event.roomId);
      if (match) this.#cancelMatch(event.roomId, match);
      for (const candidate of this.#sessionsByToken.values()) candidate.roomIds.delete(event.roomId);
      this.#broadcastLobby();
    } else if (event.type === "launch.tap") {
      const match = this.#matches.get(event.roomId);
      if (!match || match.currentRoundId !== event.roundId) {
        throw Object.assign(new Error("NO_ACTIVE_LAUNCH"), { code: "NO_ACTIVE_LAUNCH" });
      }
      const participantId = this.#participantForSession(event.roomId, session.id);
      this.#launch.submit(participantId, event, this.#now());
      this.#flushLaunch(event.roomId, match);
    }
    session.events.set(event.eventId, fingerprint);
    if (session.events.size > 512) session.events.delete(session.events.keys().next().value!);
    this.#ack(socket, event.eventId, "applied");
  }

  #broadcastRoom(roomId: string): void {
    if (!this.#rooms.hasRoom(roomId)) return;
    const deltas = this.#rooms.drainDeltas(roomId);
    for (const session of this.#sessionsByToken.values()) {
      if (!session.roomIds.has(roomId)) continue;
      for (const socketId of session.socketIds) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (!socket) continue;
        for (const delta of deltas) this.#emit(socket, delta);
      }
    }
  }

  #startMatchIfReady(roomId: string): void {
    if (this.#matches.has(roomId)) return;
    const room = this.#rooms.get(roomId);
    if (!room?.player1?.ready || !room.player2?.ready || !room.player1.designId || !room.player2.designId) return;
    const bindings = this.#sessionIdsByParticipant.get(roomId);
    const session1 = bindings?.get(room.player1.participantId);
    const session2 = bindings?.get(room.player2.participantId);
    if (!session1 || !session2) throw new Error("Missing authoritative participant binding");
    this.#designs.requireOwned(session1, room.player1.designId);
    this.#designs.requireOwned(session2, room.player2.designId);
    const match: MatchState = {
      generation: 1,
      matchId: crypto.randomUUID(),
      attempt: 0,
      currentRoundId: "",
      roundWinners: [],
      players: [
        { participantId: room.player1.participantId, sessionId: session1, designId: room.player1.designId },
        { participantId: room.player2.participantId, sessionId: session2, designId: room.player2.designId },
      ],
      launches: new Map(), simulating: false, controller: null,
    };
    this.#matches.set(roomId, match);
    this.#rooms.setPhase(roomId, "launch");
    this.#broadcastRoom(roomId);
    this.#broadcastLobby();
    this.#scheduleRound(roomId, match);
  }

  #scheduleRound(roomId: string, match: MatchState): void {
    match.attempt += 1;
    match.currentRoundId = `round-${match.attempt}-${crypto.randomUUID()}`;
    match.launches.clear();
    match.simulating = false;
    const room = this.#rooms.get(roomId)!;
    const schedule = this.#launch.schedule({
      roomId, matchId: match.matchId, roundId: match.currentRoundId,
      players: [
        { participantId: match.players[0].participantId, displayName: room.player1!.displayName },
        { participantId: match.players[1].participantId, displayName: room.player2!.displayName },
      ],
    });
    this.#emitToRoom(roomId, schedule);
  }

  #flushLaunch(roomId: string, match: MatchState): void {
    for (const player of match.players) {
      const event = this.#launch.takePrivateResult(roomId, match.currentRoundId, player.participantId);
      if (!event) continue;
      match.launches.set(player.participantId, {
        grade: event.grade,
        angularMultiplier: event.angularMultiplier,
        impulseMultiplier: event.impulseMultiplier,
      });
      this.#emitToSession(player.sessionId, event);
    }
    const spectatorEvent = this.#launch.takeSpectatorResult(roomId, match.currentRoundId);
    if (spectatorEvent) {
      const room = this.#rooms.get(roomId);
      const spectatorIds = new Set(room?.spectators.map(({ participantId }) => participantId));
      const bindings = this.#sessionIdsByParticipant.get(roomId);
      for (const participantId of spectatorIds) {
        const sessionId = bindings?.get(participantId);
        if (sessionId) this.#emitToSession(sessionId, spectatorEvent);
      }
    }
    if (match.launches.size === 2 && !match.simulating) void this.#simulate(roomId, match);
  }

  async #simulate(roomId: string, match: MatchState): Promise<void> {
    match.simulating = true;
    const generation = match.generation;
    const roundId = match.currentRoundId;
    const controller = new AbortController();
    match.controller = controller;
    try {
      this.#rooms.setPhase(roomId, "battle");
      this.#broadcastRoom(roomId);
      this.#broadcastLobby();
      const design1 = this.#designs.requireOwned(match.players[0].sessionId, match.players[0].designId);
      const design2 = this.#designs.requireOwned(match.players[1].sessionId, match.players[1].designId);
      const result = await this.#battleEngine.simulateOnceAsync(match.matchId, roundId, {
        player1: design1.design, player2: design2.design,
        launchA: match.launches.get(match.players[0].participantId)!,
        launchB: match.launches.get(match.players[1].participantId)!,
        seed: this.#seedFactory(),
      }, { signal: controller.signal });
      if (this.#matches.get(roomId) !== match || match.generation !== generation || match.currentRoundId !== roundId) return;
      result.frames.forEach((frame, sequence) => this.#emitToRoom(roomId, {
        type: "battle.frame", roomId, matchId: match.matchId, roundId,
        sequence, ...frame, protocolVersion: PROTOCOL_VERSION, serverEventId: this.#createServerEventId(),
      }));
      this.#emitToRoom(roomId, {
        type: "round.finished", roomId, matchId: match.matchId, roundId,
        winner: result.outcome.winner, protocolVersion: PROTOCOL_VERSION,
        serverEventId: this.#createServerEventId(),
      });
      this.#rooms.setPhase(roomId, "result");
      this.#broadcastRoom(roomId);
      this.#broadcastLobby();
      if (result.outcome.winner !== "draw") match.roundWinners.push(result.outcome.winner);
      const p1Wins = match.roundWinners.filter((winner) => winner === "player1").length;
      const p2Wins = match.roundWinners.length - p1Wins;
      if (p1Wins === 2 || p2Wins === 2) {
        const score = scoreMatch({
          player1MassG: design1.massG, player2MassG: design2.massG,
          roundWinners: match.roundWinners,
        });
        this.#emitToRoom(roomId, {
          type: "match.finished", roomId, matchId: match.matchId,
          player1: score.player1, player2: score.player2,
          roundWinners: [...match.roundWinners], protocolVersion: PROTOCOL_VERSION,
          serverEventId: this.#createServerEventId(),
        });
        this.#rooms.setPhase(roomId, "waiting");
        this.#broadcastRoom(roomId);
        this.#broadcastLobby();
        this.#launch.cleanupRound(roomId, roundId);
        this.#battleEngine.cleanup(match.matchId, roundId);
        this.#matches.delete(roomId);
        return;
      }
      this.#rooms.setPhase(roomId, "waiting");
      this.#rooms.ready(roomId, match.players[0].sessionId, match.players[0].designId);
      this.#rooms.ready(roomId, match.players[1].sessionId, match.players[1].designId);
      this.#rooms.setPhase(roomId, "launch");
      this.#broadcastRoom(roomId);
      this.#broadcastLobby();
      this.#launch.cleanupRound(roomId, roundId);
      this.#battleEngine.cleanup(match.matchId, roundId);
      this.#scheduleRound(roomId, match);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        for (const player of match.players) this.#emitErrorToSession(player.sessionId, "BATTLE_FAILED");
      }
    } finally {
      if (match.controller === controller) match.controller = null;
    }
  }

  #cancelMatch(roomId: string, match: MatchState): void {
    match.generation += 1;
    match.controller?.abort();
    if (match.currentRoundId) this.#battleEngine.cleanup(match.matchId, match.currentRoundId);
    this.#matches.delete(roomId);
    this.#sessionIdsByParticipant.delete(roomId);
  }

  #bindParticipant(roomId: string, participantId: string, sessionId: string): void {
    let bindings = this.#sessionIdsByParticipant.get(roomId);
    if (!bindings) this.#sessionIdsByParticipant.set(roomId, bindings = new Map());
    bindings.set(participantId, sessionId);
  }

  #participantForSession(roomId: string, sessionId: string): string {
    const entry = [...(this.#sessionIdsByParticipant.get(roomId) ?? [])].find(([, value]) => value === sessionId);
    if (!entry) throw Object.assign(new Error("NOT_IN_ROOM"), { code: "NOT_IN_ROOM" });
    return entry[0];
  }

  #emitToRoom(roomId: string, event: Record<string, unknown>): void {
    for (const session of this.#sessionsByToken.values()) {
      if (session.roomIds.has(roomId)) this.#emitToSession(session.id, event);
    }
  }

  #emitToSession(sessionId: string, event: Record<string, unknown>): void {
    const session = [...this.#sessionsByToken.values()].find(({ id }) => id === sessionId);
    if (!session) return;
    for (const socketId of session.socketIds) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) this.#emit(socket, event);
    }
  }

  #emitErrorToSession(sessionId: string, code: string): void {
    const session = [...this.#sessionsByToken.values()].find(({ id }) => id === sessionId);
    if (!session) return;
    for (const socketId of session.socketIds) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) this.#error(socket, code, code);
    }
  }

  #broadcastLobby(): void {
    const snapshot = this.#rooms.lobbySnapshot();
    for (const socket of this.io.sockets.sockets.values()) this.#emit(socket, snapshot);
  }

  #user(session: Session) { return { id: session.id, displayName: session.displayName }; }

  #ack(socket: Socket, causedByEventId: string, status: "applied" | "replayed"): void {
    this.#emit(socket, {
      type: "command.ack", causedByEventId, status,
      protocolVersion: PROTOCOL_VERSION, serverEventId: this.#createServerEventId(),
    });
  }

  #error(socket: Socket, code: string, message: string, causedByEventId?: string): void {
    this.#emit(socket, {
      type: "error", code: code.slice(0, 64), message: message.slice(0, 500),
      ...(causedByEventId ? { causedByEventId } : {}),
      protocolVersion: PROTOCOL_VERSION, serverEventId: this.#createServerEventId(),
    });
  }

  #emit(socket: Socket, event: Omit<ServerEvent, "protocolVersion"> | ServerEvent | Record<string, unknown>): void {
    socket.emit(
      "server.event",
      event.type === "protocol.unsupported"
        ? event
        : { protocolVersion: PROTOCOL_VERSION, ...event },
    );
  }

  #uniqueToken(): string {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const token = this.#createSessionToken();
      if (token.length >= 32 && token.length <= 256 && !this.#sessionsByToken.has(token)) return token;
    }
    throw new Error("SESSION_TOKEN_GENERATION_FAILED");
  }
}
