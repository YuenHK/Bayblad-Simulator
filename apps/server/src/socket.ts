import {
  PROTOCOL_VERSION,
  clientEventSchema,
  participantSummarySchema,
  protocolHelloEventSchema,
  type BattleFrameEvent,
  type BattleStartedEvent,
  type LaunchResultPrivateEvent,
  type LaunchResultSpectatorEvent,
  type LaunchScheduleEvent,
  type RoundFinishedEvent,
  type ServerEvent,
  type V1CommandEvent,
} from "@steam-top/protocol";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { DesignRegistry } from "./design-registry";
import type { BattleEnginePort, ClientKeyResolver } from "./app";
import { TokenBucketLimiter } from "./rate-limit";
import { LaunchCoordinator, type LaunchJudgement } from "./battle/launch";
import { scoreMatch as defaultScoreMatch } from "./battle/scoring";
import type { ScoreMatchInput, MatchScoreResult } from "./battle/scoring";
import { RoomService } from "./rooms/room-service";

type Session = {
  id: string;
  token: string;
  displayName: string;
  roomIds: Set<string>;
  ownedRoomIds: Set<string>;
  socketIds: Set<string>;
  events: Map<string, string>;
  disconnectedAt: number | null;
  lastActiveAt: number;
};

export type FrameScheduler = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<void>;
export type MatchScorer = (input: ScoreMatchInput) => MatchScoreResult;

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
  frameScheduler?: FrameScheduler;
  scoreMatch?: MatchScorer;
  allowedOrigins: readonly string[];
  allowMissingOrigin: boolean;
  maxHttpBufferSize: number;
  handshakeTimeoutMs: number;
  rateLimitBurst: number;
  rateLimitRefillPerSecond: number;
  pendingRateLimitBurst: number;
  pendingRateLimitRefillPerSecond: number;
  rateLimitMaxBuckets: number;
  rateLimitBucketTtlMs: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
  maxRetainedSessions: number;
  newSessionBurstPerClient: number;
  newSessionRefillPerSecond: number;
  newSessionGlobalBurst: number;
  newSessionGlobalRefillPerSecond: number;
  clientKeyResolver: ClientKeyResolver;
  maxRooms: number;
  maxOwnedRoomsPerSession: number;
  maxMatchAttempts: number;
  lobbyDebounceMs: number;
  maintenance?: () => void;
  logError?: (error: unknown) => void;
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
  schedule: LaunchScheduleEvent | null;
  privateResults: Map<string, LaunchResultPrivateEvent>;
  spectatorResult: LaunchResultSpectatorEvent | null;
  battleStarted: BattleStartedEvent;
  latestFrame: BattleFrameEvent | null;
  latestRoundFinished: RoundFinishedEvent | null;
  simulating: boolean;
  controller: AbortController | null;
};

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const defaultFrameScheduler: FrameScheduler = (delayMs, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      const error = new Error("Frame playback aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const timer = setTimeout(done, Math.max(0, delayMs));
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const error = new Error("Frame playback aborted");
      error.name = "AbortError";
      reject(error);
    };
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });

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
  readonly #frameScheduler: FrameScheduler;
  readonly #scoreMatch: MatchScorer;
  readonly #handshakeTimeoutMs: number;
  readonly #pendingLimiter: TokenBucketLimiter;
  readonly #sessionCommandLimiter: TokenBucketLimiter;
  readonly #maxConnections: number;
  readonly #maxConnectionsPerIp: number;
  readonly #maxRetainedSessions: number;
  readonly #clientKeyResolver: ClientKeyResolver;
  readonly #newSessionByClientLimiter: TokenBucketLimiter;
  readonly #newSessionGlobalLimiter: TokenBucketLimiter;
  readonly #maxRooms: number;
  readonly #maxOwnedRoomsPerSession: number;
  readonly #maxMatchAttempts: number;
  readonly #lobbyDebounceMs: number;
  readonly #logError: (error: unknown) => void;
  readonly #maintenance: () => void;
  readonly #sessionsByToken = new Map<string, Session>();
  readonly #sessionsById = new Map<string, Session>();
  readonly #sessionIdsByParticipant = new Map<string, Map<string, string>>();
  readonly #matches = new Map<string, MatchState>();
  readonly #connectionsByIp = new Map<string, number>();
  #lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  #lobbyPending = false;
  #frameBroadcastOperations = 0;

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
    this.#frameScheduler = dependencies.frameScheduler ?? defaultFrameScheduler;
    this.#scoreMatch = dependencies.scoreMatch ?? defaultScoreMatch;
    this.#handshakeTimeoutMs = dependencies.handshakeTimeoutMs;
    const limiterOptions = {
      maxBuckets: dependencies.rateLimitMaxBuckets,
      ttlMs: dependencies.rateLimitBucketTtlMs,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    };
    this.#pendingLimiter = new TokenBucketLimiter({
      burst: dependencies.pendingRateLimitBurst,
      refillPerSecond: dependencies.pendingRateLimitRefillPerSecond,
      ...limiterOptions,
    });
    this.#sessionCommandLimiter = new TokenBucketLimiter({
      burst: dependencies.rateLimitBurst,
      refillPerSecond: dependencies.rateLimitRefillPerSecond,
      ...limiterOptions,
    });
    this.#maxConnections = dependencies.maxConnections;
    this.#maxConnectionsPerIp = dependencies.maxConnectionsPerIp;
    this.#maxRetainedSessions = dependencies.maxRetainedSessions;
    this.#clientKeyResolver = dependencies.clientKeyResolver;
    this.#newSessionByClientLimiter = new TokenBucketLimiter({
      burst: dependencies.newSessionBurstPerClient,
      refillPerSecond: dependencies.newSessionRefillPerSecond,
      ...limiterOptions,
    });
    this.#newSessionGlobalLimiter = new TokenBucketLimiter({
      burst: dependencies.newSessionGlobalBurst,
      refillPerSecond: dependencies.newSessionGlobalRefillPerSecond,
      ...limiterOptions,
    });
    this.#maxRooms = dependencies.maxRooms;
    this.#maxOwnedRoomsPerSession = dependencies.maxOwnedRoomsPerSession;
    this.#maxMatchAttempts = dependencies.maxMatchAttempts;
    this.#lobbyDebounceMs = dependencies.lobbyDebounceMs;
    this.#logError = dependencies.logError ?? (() => undefined);
    this.#maintenance = dependencies.maintenance ?? (() => undefined);
    const origins = new Set(dependencies.allowedOrigins);
    const originAllowed = (origin: string | undefined) =>
      origin === undefined ? dependencies.allowMissingOrigin : origins.has(origin);
    this.io = new Server(server, {
      maxHttpBufferSize: dependencies.maxHttpBufferSize,
      cors: {
        origin: (origin, callback) => callback(null, originAllowed(origin)),
        credentials: true,
      },
      allowRequest: (request, callback) => callback(null, originAllowed(request.headers.origin)),
    });
    this.io.on("connection", (socket) => this.#connect(socket));
  }

  get activeMatchCount(): number {
    return this.#matches.size;
  }

  get debugCounts(): Readonly<{
    sessions: number;
    bindings: number;
    matches: number;
    frameBroadcastOperations: number;
    connections: number;
    newSessionClientBuckets: number;
    pendingBuckets: number;
    sessionCommandBuckets: number;
  }> {
    return {
      sessions: this.#sessionsById.size,
      bindings: [...this.#sessionIdsByParticipant.values()].reduce((sum, map) => sum + map.size, 0),
      matches: this.#matches.size,
      frameBroadcastOperations: this.#frameBroadcastOperations,
      connections: [...this.#connectionsByIp.values()].reduce((sum, count) => sum + count, 0),
      newSessionClientBuckets: this.#newSessionByClientLimiter.size,
      pendingBuckets: this.#pendingLimiter.size,
      sessionCommandBuckets: this.#sessionCommandLimiter.size,
    };
  }

  flushLobby(): void {
    if (this.#lobbyTimer) clearTimeout(this.#lobbyTimer);
    this.#lobbyTimer = null;
    if (!this.#lobbyPending) return;
    this.#lobbyPending = false;
    this.io.to("protocol:v1").emit("server.event", this.#rooms.lobbySnapshot());
  }

  sessionForBearer(value: string | undefined): Readonly<{ id: string; displayName: string }> | undefined {
    if (!value?.startsWith("Bearer ")) return undefined;
    const session = this.#sessionsByToken.get(value.slice(7));
    return session ? { id: session.id, displayName: session.displayName } : undefined;
  }

  async close(): Promise<void> {
    if (this.#lobbyTimer) clearTimeout(this.#lobbyTimer);
    this.#lobbyTimer = null;
    for (const [roomId, match] of this.#matches) this.#cancelMatch(roomId, match);
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
    this.#pendingLimiter.clear();
    this.#sessionCommandLimiter.clear();
    this.#newSessionByClientLimiter.clear();
    this.#newSessionGlobalLimiter.clear();
  }

  pump(nowMs = this.#now()): void {
    this.#launch.finalizeExpired(nowMs);
    this.#pendingLimiter.pruneExpired();
    this.#sessionCommandLimiter.pruneExpired();
    this.#newSessionByClientLimiter.pruneExpired();
    this.#newSessionGlobalLimiter.pruneExpired();
    this.#maintenance();
    for (const [roomId, match] of [...this.#matches]) {
      if (!this.#rooms.hasRoom(roomId)) {
        this.#cancelMatch(roomId, match);
        continue;
      }
      this.#flushLaunch(roomId, match);
    }
    const beforeSweep = new Map(this.#rooms.lobbySnapshot().rooms.map(({ id }) => [id, this.#rooms.get(id)!.revision]));
    this.#rooms.sweep();
    for (const [roomId, match] of [...this.#matches]) {
      const room = this.#rooms.get(roomId);
      if (!room ||
        room.player1?.participantId !== match.players[0].participantId ||
        room.player2?.participantId !== match.players[1].participantId) {
        this.#cancelMatch(roomId, match);
      }
    }
    const afterSweep = new Map(this.#rooms.lobbySnapshot().rooms.map(({ id }) => [id, this.#rooms.get(id)!.revision]));
    let lobbyChanged = beforeSweep.size !== afterSweep.size;
    for (const [roomId, revision] of beforeSweep) {
      const nextRevision = afterSweep.get(roomId);
      if (nextRevision === undefined) {
        lobbyChanged = true;
        this.#cleanupRoom(roomId);
      } else if (nextRevision !== revision) {
        lobbyChanged = true;
        this.#syncBindings(roomId);
        this.#syncTransportRoles(roomId);
        this.#broadcastRoom(roomId);
      }
    }
    if (lobbyChanged) this.#broadcastLobby();
    for (const [roomId, match] of [...this.#matches]) {
      if (!this.#rooms.hasRoom(roomId)) this.#cancelMatch(roomId, match);
    }
    for (const session of [...this.#sessionsById.values()]) {
      if (session.socketIds.size === 0 && session.disconnectedAt !== null && nowMs - session.disconnectedAt >= 120_000) {
        this.#expireSession(session);
      }
    }
  }

  #connect(socket: Socket): void {
    let clientKey: string;
    try { clientKey = this.#clientKeyResolver(socket.request); } catch { socket.disconnect(true); return; }
    const clientCount = this.#connectionsByIp.get(clientKey) ?? 0;
    if (this.io.engine.clientsCount > this.#maxConnections || clientCount >= this.#maxConnectionsPerIp) {
      socket.disconnect(true);
      return;
    }
    this.#connectionsByIp.set(clientKey, clientCount + 1);
    const auth = socket.handshake.auth as Record<string, unknown>;
    const display = participantSummarySchema.safeParse({
      participantId: "identity-check",
      displayName: auth.displayName,
    });
    if (!display.success) {
      if (clientCount === 0) this.#connectionsByIp.delete(clientKey);
      else this.#connectionsByIp.set(clientKey, clientCount);
      socket.disconnect(true);
      return;
    }
    const requestedToken = typeof auth.sessionToken === "string" ? auth.sessionToken : undefined;
    const pendingKey = `${clientKey}:${socket.id}`;
    let session: Session | null = null;
    let welcomed = false;
    let closingProtocol = false;
    const handshakeTimer = setTimeout(() => socket.disconnect(true), this.#handshakeTimeoutMs);
    handshakeTimer.unref();
    socket.on("client.event", (raw: unknown) => {
      if (closingProtocol) return;
      if (!this.#pendingLimiter.consume(pendingKey)) {
        closingProtocol = true;
        this.#error(socket, "RATE_LIMITED", "Too many socket events");
        setTimeout(() => socket.disconnect(true), 0);
        return;
      }
      const hello = protocolHelloEventSchema.safeParse(raw);
      if (hello.success) {
        if (welcomed) {
          closingProtocol = true;
          this.#error(socket, "INVALID_EVENT", "Protocol hello has already completed");
          setTimeout(() => socket.disconnect(true), 0);
          return;
        }
        if (!hello.data.supportedVersions.includes(PROTOCOL_VERSION)) {
          closingProtocol = true;
          this.#emit(socket, {
            type: "protocol.unsupported",
            serverEventId: this.#createServerEventId(),
            supportedVersions: [PROTOCOL_VERSION],
            causedByEventId: hello.data.eventId,
            reason: "No mutually supported protocol version",
          });
          setTimeout(() => socket.disconnect(true), 0);
          return;
        }
        clearTimeout(handshakeTimer);
        let established: Readonly<{ session: Session; status: "new" | "resumed" | "replaced" }>;
        try {
          established = this.#establishSession(display.data.displayName, requestedToken, clientKey);
        } catch (error) {
          const code = this.#safeErrorCode(error);
          this.#error(socket, code, code);
          setTimeout(() => socket.disconnect(true), 0);
          return;
        }
        session = established.session;
        session.disconnectedAt = null;
        session.lastActiveAt = this.#now();
        session.socketIds.add(socket.id);
        socket.join(`session:${session.id}`);
        socket.join("protocol:v1");
        welcomed = true;
        this.#emit(socket, {
          type: "protocol.welcome",
          selectedVersion: PROTOCOL_VERSION,
          sessionToken: session.token,
          sessionStatus: established.status,
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
            const membership = this.#rooms.join(roomId, this.#user(session), "spectator");
            this.#bindParticipant(roomId, membership.participantId, session.id);
            this.#joinTransportRoom(socket, session, roomId);
            this.#emit(socket, this.#rooms.snapshot(roomId, session.id));
            this.#sendCheckpoint(socket, roomId, session.id);
          } catch { /* retention may have expired between checks */ }
        }
        return;
      }
      if (!welcomed) {
        closingProtocol = true;
        this.#error(socket, "INVALID_EVENT", "Protocol hello is required");
        setTimeout(() => socket.disconnect(true), 0);
        return;
      }
      const now = this.#now();
      if (!this.#sessionCommandLimiter.consume(session!.id)) {
        this.#error(socket, "RATE_LIMITED", "Too many commands");
        return;
      }
      session!.lastActiveAt = now;
      const parsed = clientEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.type === "protocol.hello") {
        this.#error(socket, "INVALID_EVENT", "Malformed protocol event");
        return;
      }
      void this.#command(socket, session!, parsed.data).catch((error: unknown) => {
        this.#logError(error);
        const code = this.#safeErrorCode(error);
        this.#error(socket, code, code === "COMMAND_FAILED" ? "Command could not be completed" : code, parsed.data.eventId);
      });
    });
    socket.on("disconnect", () => {
      clearTimeout(handshakeTimer);
      this.#pendingLimiter.delete(pendingKey);
      const remaining = Math.max(0, (this.#connectionsByIp.get(clientKey) ?? 1) - 1);
      if (remaining === 0) this.#connectionsByIp.delete(clientKey);
      else this.#connectionsByIp.set(clientKey, remaining);
      if (!session) return;
      session.socketIds.delete(socket.id);
      if (session.socketIds.size > 0) return;
      session.disconnectedAt = this.#now();
      session.lastActiveAt = session.disconnectedAt;
      for (const roomId of session.roomIds) {
        try { this.#rooms.disconnect(roomId, session.id); } catch { /* already closed */ }
      }
    });
  }

  #establishSession(
    displayName: string,
    requestedToken: string | undefined,
    clientKey: string,
  ): Readonly<{ session: Session; status: "new" | "resumed" | "replaced" }> {
    let session = requestedToken ? this.#sessionsByToken.get(requestedToken) : undefined;
    let status: "new" | "resumed" | "replaced" = requestedToken ? "replaced" : "new";
    if (session?.disconnectedAt !== null && session?.disconnectedAt !== undefined && this.#now() - session.disconnectedAt >= 120_000) {
      this.#expireSession(session);
      session = undefined;
    }
    if (session) return { session, status: "resumed" };
    this.#pruneSessionsForCapacity();
    if (this.#sessionsById.size >= this.#maxRetainedSessions) {
      throw Object.assign(new Error("SESSION_CAPACITY"), { code: "SESSION_CAPACITY" });
    }
    if (!this.#newSessionGlobalLimiter.consume("global") || !this.#newSessionByClientLimiter.consume(clientKey)) {
      throw Object.assign(new Error("SESSION_RATE_LIMITED"), { code: "SESSION_RATE_LIMITED" });
    }
    const now = this.#now();
    session = {
      id: this.#uniqueSessionId(),
      token: this.#uniqueToken(),
      displayName,
      roomIds: new Set(),
      ownedRoomIds: new Set(),
      socketIds: new Set(),
      events: new Map(),
      disconnectedAt: null,
      lastActiveAt: now,
    };
    this.#sessionsByToken.set(session.token, session);
    this.#sessionsById.set(session.id, session);
    return { session, status };
  }

  #pruneSessionsForCapacity(): void {
    if (this.#sessionsById.size < this.#maxRetainedSessions) return;
    const candidates = [...this.#sessionsById.values()]
      .filter(({ roomIds, socketIds }) => roomIds.size === 0 && socketIds.size === 0)
      .sort((left, right) => left.lastActiveAt - right.lastActiveAt);
    while (this.#sessionsById.size >= this.#maxRetainedSessions && candidates.length > 0) {
      this.#expireSession(candidates.shift()!);
    }
  }

  #expireSession(session: Session): void {
    this.#sessionsByToken.delete(session.token);
    this.#sessionsById.delete(session.id);
    this.#sessionCommandLimiter.delete(session.id);
    this.#designs.cleanupOwner(session.id);
    for (const [roomId, bindings] of this.#sessionIdsByParticipant) {
      for (const [participantId, sessionId] of bindings) {
        if (sessionId === session.id) bindings.delete(participantId);
      }
      if (bindings.size === 0 && !this.#matches.has(roomId)) this.#sessionIdsByParticipant.delete(roomId);
    }
  }

  #joinTransportRoom(socket: Socket, session: Session, roomId: string): void {
    socket.join(`room:${roomId}`);
    socket.leave(`room:${roomId}:player1`);
    socket.leave(`room:${roomId}:player2`);
    socket.leave(`room:${roomId}:spectator`);
    try {
      const role = this.#rooms.snapshot(roomId, session.id).viewer.role;
      socket.join(`room:${roomId}:${role}`);
    } catch { /* membership may have been swept */ }
  }

  #safeErrorCode(error: unknown): string {
    const candidate = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "COMMAND_FAILED";
    const allowed = new Set([
      "ROOM_NOT_FOUND", "NOT_IN_ROOM", "ROOM_FULL", "OWNER_REQUIRED",
      "PARTICIPANT_NOT_FOUND", "SEAT_OCCUPIED", "SEATS_LOCKED", "PLAYER_REQUIRED",
      "DESIGN_LOCKED", "PLAYERS_NOT_READY", "PARTICIPANT_DISCONNECTED",
      "INVALID_PHASE_TRANSITION", "ROOM_ACTIVE", "DESIGN_INVALID", "DESIGN_NOT_FOUND",
      "DESIGN_NOT_OWNED", "DESIGN_QUOTA_EXCEEDED", "RATE_LIMITED", "NO_ACTIVE_LAUNCH",
      "EVENT_ID_CONFLICT", "INVALID_TAP", "SCHEDULE_MISMATCH", "UNKNOWN_PARTICIPANT",
      "OUTSIDE_ACCEPTANCE_WINDOW", "ALREADY_SUBMITTED", "ROUND_CLOSED",
      "ROOM_QUOTA_EXCEEDED", "SERVER_CAPACITY",
      "SESSION_CAPACITY", "SESSION_RATE_LIMITED",
    ]);
    return allowed.has(candidate) ? candidate : "COMMAND_FAILED";
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
      if (session.ownedRoomIds.size >= this.#maxOwnedRoomsPerSession) {
        throw Object.assign(new Error("ROOM_QUOTA_EXCEEDED"), { code: "ROOM_QUOTA_EXCEEDED" });
      }
      if (this.#rooms.lobbySnapshot().rooms.length >= this.#maxRooms) {
        throw Object.assign(new Error("SERVER_CAPACITY"), { code: "SERVER_CAPACITY" });
      }
      const membership = this.#rooms.create(this.#user(session), event.name);
      session.roomIds.add(membership.roomId);
      session.ownedRoomIds.add(membership.roomId);
      this.#bindParticipant(membership.roomId, membership.participantId, session.id);
      this.#joinTransportRoom(socket, session, membership.roomId);
      this.#emit(socket, this.#rooms.snapshot(membership.roomId, session.id));
      this.#broadcastLobby();
    } else if (event.type === "room.join") {
      const membership = this.#rooms.join(event.roomId, this.#user(session), event.role);
      session.roomIds.add(event.roomId);
      this.#bindParticipant(event.roomId, membership.participantId, session.id);
      this.#joinTransportRoom(socket, session, event.roomId);
      this.#broadcastRoom(event.roomId);
      this.#emit(socket, this.#rooms.snapshot(event.roomId, session.id));
      this.#sendCheckpoint(socket, event.roomId, session.id);
      this.#broadcastLobby();
    } else if (event.type === "room.move") {
      this.#rooms.move(event.roomId, session.id, event.target, event.subjectParticipantId);
      this.#syncTransportRoles(event.roomId);
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
      this.#cleanupRoom(event.roomId);
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
    for (const delta of deltas) this.io.to(`room:${roomId}`).emit("server.event", delta);
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
    this.#designs.pin(session1, room.player1.designId);
    try {
      this.#designs.pin(session2, room.player2.designId);
    } catch (error) {
      this.#designs.unpin(session1, room.player1.designId);
      throw error;
    }
    let match: MatchState | undefined;
    try {
      const matchId = crypto.randomUUID();
      const battleStarted: BattleStartedEvent = {
      type: "battle.started",
      roomId,
      matchId,
      player1: {
        participantId: room.player1.participantId,
        designId: room.player1.designId,
        design: this.#designs.publicBattleDesign(session1, room.player1.designId),
      },
      player2: {
        participantId: room.player2.participantId,
        designId: room.player2.designId,
        design: this.#designs.publicBattleDesign(session2, room.player2.designId),
      },
      protocolVersion: PROTOCOL_VERSION,
      serverEventId: this.#createServerEventId(),
      };
      match = {
      generation: 1,
      matchId,
      attempt: 0,
      currentRoundId: "",
      roundWinners: [],
      players: [
        { participantId: room.player1.participantId, sessionId: session1, designId: room.player1.designId },
        { participantId: room.player2.participantId, sessionId: session2, designId: room.player2.designId },
      ],
      launches: new Map(),
      schedule: null,
      privateResults: new Map(),
      spectatorResult: null,
      battleStarted,
      latestFrame: null,
      latestRoundFinished: null,
      simulating: false,
      controller: null,
      };
      this.#matches.set(roomId, match);
      this.#rooms.setPhase(roomId, "launch");
      const initialSchedule = this.#scheduleRound(roomId, match, false);
      this.#broadcastRoom(roomId);
      this.#broadcastLobby();
      this.#emitToRoom(roomId, battleStarted);
      if (initialSchedule) this.#emitToRoom(roomId, initialSchedule);
    } catch (error) {
      if (match) this.#cancelMatch(roomId, match);
      else {
        this.#designs.unpin(session1, room.player1.designId);
        this.#designs.unpin(session2, room.player2.designId);
      }
      try { this.#rooms.cancelMatch(roomId); } catch (rollbackError) { this.#logError(rollbackError); }
      this.#broadcastRoom(roomId);
      this.#broadcastLobby();
      throw error;
    }
  }

  #scheduleRound(roomId: string, match: MatchState, emit = true): LaunchScheduleEvent | null {
    if (match.attempt >= this.#maxMatchAttempts) {
      this.#cancelForAttemptLimit(roomId, match);
      return null;
    }
    match.attempt += 1;
    match.currentRoundId = `round-${match.attempt}-${crypto.randomUUID()}`;
    match.launches.clear();
    match.privateResults.clear();
    match.spectatorResult = null;
    match.latestFrame = null;
    match.latestRoundFinished = null;
    match.simulating = false;
    const room = this.#rooms.get(roomId)!;
    const schedule = this.#launch.schedule({
      roomId, matchId: match.matchId, roundId: match.currentRoundId,
      players: [
        { participantId: match.players[0].participantId, displayName: room.player1!.displayName },
        { participantId: match.players[1].participantId, displayName: room.player2!.displayName },
      ],
    });
    match.schedule = schedule;
    if (emit) this.#emitToRoom(roomId, schedule);
    return schedule;
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
      match.privateResults.set(player.participantId, event);
      this.#emitToSession(player.sessionId, event);
    }
    const spectatorEvent = this.#launch.takeSpectatorResult(roomId, match.currentRoundId);
    if (spectatorEvent) {
      match.spectatorResult = spectatorEvent;
      this.io.to(`room:${roomId}:spectator`).emit("server.event", spectatorEvent);
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
      if (result.frames.length === 0) throw new Error("Battle result contained no frames");
      let previousTick = 0;
      for (const [sequence, frame] of result.frames.entries()) {
        const delayMs = Math.max(0, frame.tick - previousTick) * (1_000 / 60);
        previousTick = frame.tick;
        if (delayMs > 0) await this.#frameScheduler(delayMs, controller.signal);
        if (this.#matches.get(roomId) !== match || match.generation !== generation || match.currentRoundId !== roundId) return;
        const event: BattleFrameEvent = {
          type: "battle.frame", roomId, matchId: match.matchId, roundId,
          sequence, ...frame, protocolVersion: PROTOCOL_VERSION,
          serverEventId: this.#createServerEventId(),
        };
        match.latestFrame = event;
        this.#emitToRoom(roomId, event, sequence === result.frames.length - 1);
      }
      const candidateWinners = [...match.roundWinners];
      if (result.outcome.winner !== "draw") candidateWinners.push(result.outcome.winner);
      const p1Wins = candidateWinners.filter((winner) => winner === "player1").length;
      const p2Wins = candidateWinners.length - p1Wins;
      const completedScore = p1Wins === 2 || p2Wins === 2
        ? this.#scoreMatch({
            player1MassG: design1.massG,
            player2MassG: design2.massG,
            roundWinners: candidateWinners,
          })
        : null;
      const roundFinished: RoundFinishedEvent = {
        type: "round.finished", roomId, matchId: match.matchId, roundId,
        winner: result.outcome.winner, protocolVersion: PROTOCOL_VERSION,
        serverEventId: this.#createServerEventId(),
      };
      match.latestRoundFinished = roundFinished;
      this.#emitToRoom(roomId, roundFinished);
      this.#rooms.setPhase(roomId, "result");
      this.#broadcastRoom(roomId);
      this.#broadcastLobby();
      match.roundWinners.splice(0, match.roundWinners.length, ...candidateWinners);
      if (completedScore) {
        this.#emitToRoom(roomId, {
          type: "match.finished", roomId, matchId: match.matchId,
          player1: completedScore.player1, player2: completedScore.player2,
          roundWinners: [...match.roundWinners], protocolVersion: PROTOCOL_VERSION,
          serverEventId: this.#createServerEventId(),
        });
        this.#rooms.finishMatch(roomId);
        this.#broadcastRoom(roomId);
        this.#broadcastLobby();
        this.#launch.cleanupRound(roomId, roundId);
        this.#battleEngine.cleanup(match.matchId, roundId);
        this.#unpinMatchDesigns(match);
        this.#matches.delete(roomId);
        return;
      }
      this.#rooms.nextRound(roomId);
      this.#broadcastRoom(roomId);
      this.#broadcastLobby();
      this.#launch.cleanupRound(roomId, roundId);
      this.#battleEngine.cleanup(match.matchId, roundId);
      this.#scheduleRound(roomId, match);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        for (const player of match.players) this.#emitErrorToSession(player.sessionId, "BATTLE_FAILED");
        if (this.#matches.get(roomId) === match && match.generation === generation) {
          match.generation += 1;
          try { this.#launch.cleanupRound(roomId, roundId); } catch { /* already reclaimed */ }
          this.#battleEngine.cleanup(match.matchId, roundId);
          match.launches.clear();
          match.privateResults.clear();
          match.spectatorResult = null;
          match.latestFrame = null;
          match.latestRoundFinished = null;
          this.#rooms.retryRound(roomId);
          this.#broadcastRoom(roomId);
          this.#broadcastLobby();
          this.#scheduleRound(roomId, match);
        }
      }
    } finally {
      if (match.controller === controller) match.controller = null;
    }
  }

  #cancelMatch(roomId: string, match: MatchState): void {
    match.generation += 1;
    match.controller?.abort();
    if (match.currentRoundId) {
      try { this.#launch.cancelRound(roomId, match.currentRoundId); } catch { /* already reclaimed */ }
      this.#battleEngine.cleanup(match.matchId, match.currentRoundId);
    }
    this.#unpinMatchDesigns(match);
    this.#matches.delete(roomId);
  }

  #cancelForAttemptLimit(roomId: string, match: MatchState): void {
    this.#emitToRoom(roomId, {
      type: "match.cancelled", roomId, matchId: match.matchId, reason: "attempt-limit",
      protocolVersion: PROTOCOL_VERSION, serverEventId: this.#createServerEventId(),
    });
    try { this.#rooms.cancelMatch(roomId); } catch { /* room was concurrently removed */ }
    this.#cancelMatch(roomId, match);
    this.#broadcastRoom(roomId);
    this.#broadcastLobby();
  }

  #unpinMatchDesigns(match: MatchState): void {
    for (const player of match.players) this.#designs.unpin(player.sessionId, player.designId);
  }

  #bindParticipant(roomId: string, participantId: string, sessionId: string): void {
    let bindings = this.#sessionIdsByParticipant.get(roomId);
    if (!bindings) this.#sessionIdsByParticipant.set(roomId, bindings = new Map());
    const room = this.#rooms.get(roomId);
    const activeParticipantIds = new Set([
      ...(room?.player1 ? [room.player1.participantId] : []),
      ...(room?.player2 ? [room.player2.participantId] : []),
      ...(room?.spectators.map(({ participantId: id }) => id) ?? []),
    ]);
    for (const existingId of bindings.keys()) {
      if (!activeParticipantIds.has(existingId)) bindings.delete(existingId);
    }
    for (const [existingId, existingSessionId] of bindings) {
      if (existingSessionId === sessionId && existingId !== participantId) bindings.delete(existingId);
    }
    bindings.set(participantId, sessionId);
  }

  #syncBindings(roomId: string): void {
    const bindings = this.#sessionIdsByParticipant.get(roomId);
    const room = this.#rooms.get(roomId);
    if (!bindings || !room) return;
    const active = new Set([
      ...(room.player1 ? [room.player1.participantId] : []),
      ...(room.player2 ? [room.player2.participantId] : []),
      ...room.spectators.map(({ participantId }) => participantId),
    ]);
    for (const participantId of bindings.keys()) if (!active.has(participantId)) bindings.delete(participantId);
  }

  #syncTransportRoles(roomId: string): void {
    const bindings = this.#sessionIdsByParticipant.get(roomId);
    if (!bindings) return;
    for (const sessionId of new Set(bindings.values())) {
      const session = this.#sessionsById.get(sessionId);
      if (!session) continue;
      for (const socketId of session.socketIds) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) this.#joinTransportRoom(socket, session, roomId);
      }
    }
  }

  #cleanupRoom(roomId: string): void {
    const match = this.#matches.get(roomId);
    if (match) this.#cancelMatch(roomId, match);
    this.#sessionIdsByParticipant.delete(roomId);
    for (const session of this.#sessionsById.values()) {
      session.roomIds.delete(roomId);
      session.ownedRoomIds.delete(roomId);
    }
    this.io.in(`room:${roomId}`).socketsLeave([
      `room:${roomId}`, `room:${roomId}:player1`, `room:${roomId}:player2`, `room:${roomId}:spectator`,
    ]);
  }

  #participantForSession(roomId: string, sessionId: string): string {
    const entry = [...(this.#sessionIdsByParticipant.get(roomId) ?? [])].find(([, value]) => value === sessionId);
    if (!entry) throw Object.assign(new Error("NOT_IN_ROOM"), { code: "NOT_IN_ROOM" });
    return entry[0];
  }

  #sendCheckpoint(socket: Socket, roomId: string, sessionId: string): void {
    const match = this.#matches.get(roomId);
    if (!match) return;
    this.#emit(socket, match.battleStarted);
    const currentPhase = this.#rooms.get(roomId)?.phase;
    if (currentPhase && currentPhase !== "waiting") {
      this.#emit(socket, {
        type: "battle.checkpoint",
        roomId,
        matchId: match.matchId,
        roundId: match.currentRoundId,
        attempt: match.attempt,
        phase: currentPhase,
        roundWinners: [...match.roundWinners],
        protocolVersion: PROTOCOL_VERSION,
        serverEventId: this.#createServerEventId(),
      });
    }
    if (match.schedule) this.#emit(socket, match.schedule);
    const participantId = this.#participantForSession(roomId, sessionId);
    const room = this.#rooms.get(roomId);
    const isSpectator = room?.spectators.some((candidate) => candidate.participantId === participantId) ?? false;
    if (isSpectator) {
      if (match.spectatorResult) this.#emit(socket, match.spectatorResult);
    } else {
      const privateResult = match.privateResults.get(participantId);
      if (privateResult) this.#emit(socket, privateResult);
    }
    if (match.latestFrame) this.#emit(socket, match.latestFrame);
    if (match.latestRoundFinished) this.#emit(socket, match.latestRoundFinished);
  }

  #emitToRoom(roomId: string, event: Record<string, unknown>, reliable = false): void {
    const channel = this.io.to(`room:${roomId}`);
    if (event.type === "battle.frame") {
      this.#frameBroadcastOperations += 1;
      if (reliable) channel.emit("server.event", event);
      else channel.volatile.emit("server.event", event);
    } else channel.emit("server.event", event);
  }

  #emitToSession(sessionId: string, event: Record<string, unknown>): void {
    if (this.#sessionsById.has(sessionId)) this.io.to(`session:${sessionId}`).emit("server.event", event);
  }

  #emitErrorToSession(sessionId: string, code: string): void {
    const session = this.#sessionsById.get(sessionId);
    if (!session) return;
    for (const socketId of session.socketIds) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) this.#error(socket, code, code);
    }
  }

  #broadcastLobby(): void {
    this.#lobbyPending = true;
    if (this.#lobbyTimer) return;
    this.#lobbyTimer = setTimeout(() => this.flushLobby(), this.#lobbyDebounceMs);
    this.#lobbyTimer.unref();
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

  #uniqueSessionId(): string {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const id = this.#createSessionId();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id) && !this.#sessionsById.has(id)) return id;
    }
    throw new Error("SESSION_ID_GENERATION_FAILED");
  }
}
