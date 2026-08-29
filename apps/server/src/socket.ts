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
  type MatchFinishedEvent,
  type RoundFinishedEvent,
  type ServerEvent,
  type V1CommandEvent,
} from "@steam-top/protocol";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { DesignRegistry } from "./design-registry";
import type { DesignRepository } from "./records/design-repository";
import { completedMatchFingerprint, type CompletedMatchRecord, type MatchRepository } from "./records/match-repository";
import type { RoomParticipantRecord, RoomRecordRepository } from "./records/room-repository";
import { RoomProjectionCoordinator } from "./records/room-projection-coordinator";
import type { RoomProjectionStore } from "./records/room-projection-store";
import { PHYSICS_MODEL_VERSION, sha256Hex, type BattleResult } from "./battle/engine";
import type { BattleEnginePort, ClientKeyResolver } from "./app";
import { TokenBucketLimiter } from "./rate-limit";
import { LaunchCoordinator, type LaunchJudgement } from "./battle/launch";
import { scoreMatch as defaultScoreMatch } from "./battle/scoring";
import type { ScoreMatchInput, MatchScoreResult } from "./battle/scoring";
import { RoomService } from "./rooms/room-service";

type Session = {
  id: string;
  identityId: string;
  token: string;
  displayName: string;
  identitySource: "iclass" | "cookie" | "guest";
  deviceName: string | null;
  ip: string | null;
  userAgent: string | null;
  roomIds: Set<string>;
  ownedRoomIds: Set<string>;
  socketIds: Set<string>;
  events: Map<string, string>;
  commandTail: Promise<void>;
  inflightCommands: Map<string, Readonly<{ fingerprint: string; promise: Promise<void> }>>;
  commandsStopped: boolean;
  disconnectedAt: number | null;
  lastActiveAt: number;
  clockChallenges: Map<string, Readonly<{ serverSentAtMs: number; expiresAtMs: number }>>;
  clockPingIds: Map<string, number>;
  observedRtts: number[];
  pendingDepartures: Map<string, Readonly<{ event: Extract<ServerEvent, { type: "room.departed" }>; expiresAtMs: number }>>;
};

export type FrameScheduler = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<void>;
export type MatchScorer = (input: ScoreMatchInput) => MatchScoreResult;

export type RealtimeDependencies = Readonly<{
  rooms: RoomService;
  designs: DesignRegistry;
  designRepository?: DesignRepository;
  matchRepository?: MatchRepository;
  roomRecordRepository?: RoomRecordRepository;
  roomProjectionStore?: RoomProjectionStore;
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
  diagnosticIpResolver: (request: IncomingMessage) => string | null;
  authenticateIdentity: (request: IncomingMessage, testAuth?: Record<string, unknown>) => Promise<Readonly<{ identityId: string; displayName: string; identitySource?: "iclass" | "cookie" | "guest"; deviceName?: string }> | null>;
  maxRooms: number;
  maxOwnedRoomsPerSession: number;
  maxMatchAttempts: number;
  terminalResultTtlMs: number;
  maxTerminalResults: number;
  lobbyDebounceMs: number;
  persistenceRetryDelaysMs?: readonly number[];
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
  startedAt: Date;
  roundHistory: CompletedMatchRecord["rounds"][number][];
  persistenceAttempts: number;
  officiallyCompleted: boolean;
  spectatorCountAtStart: number;
};

type TerminalMatchState = Readonly<{
  roomId: string;
  matchId: string;
  memberships: readonly Readonly<{ participantId: string; sessionId: string }>[];
  battleStarted: BattleStartedEvent;
  checkpoint: Extract<ServerEvent, { type: "battle.checkpoint" }>;
  latestFrame: BattleFrameEvent;
  matchFinished: MatchFinishedEvent;
  expiresAtMs: number;
}>;

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const CLOCK_CHALLENGE_TTL_MS = 10_000;
const DEPARTURE_TTL_MS = 120_000;
const MAX_PENDING_OUTCOMES = 64;
const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

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
  readonly #designRepository: DesignRepository | undefined;
  readonly #matchRepository: MatchRepository | undefined;
  readonly #roomRecordRepository: RoomRecordRepository | undefined;
  readonly #roomProjections: RoomProjectionCoordinator;
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
  readonly #diagnosticIpResolver: (request: IncomingMessage) => string | null;
  readonly #authenticateIdentity: RealtimeDependencies["authenticateIdentity"];
  readonly #newSessionByClientLimiter: TokenBucketLimiter;
  readonly #newSessionGlobalLimiter: TokenBucketLimiter;
  readonly #maxRooms: number;
  readonly #maxOwnedRoomsPerSession: number;
  readonly #maxMatchAttempts: number;
  readonly #terminalResultTtlMs: number;
  readonly #maxTerminalResults: number;
  readonly #lobbyDebounceMs: number;
  readonly #logError: (error: unknown) => void;
  readonly #maintenance: () => void;
  readonly #persistenceRetryDelaysMs: readonly number[];
  readonly #sessionsByToken = new Map<string, Session>();
  readonly #sessionsById = new Map<string, Session>();
  readonly #sessionIdsByParticipant = new Map<string, Map<string, string>>();
  readonly #matches = new Map<string, MatchState>();
  readonly #terminalMatches = new Map<string, TerminalMatchState>();
  readonly #connectionsByIp = new Map<string, number>();
  #lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  #lobbyPending = false;
  #frameBroadcastOperations = 0;

  constructor(server: HttpServer, dependencies: RealtimeDependencies) {
    this.#rooms = dependencies.rooms;
    this.#designs = dependencies.designs;
    this.#designRepository = dependencies.designRepository;
    this.#matchRepository = dependencies.matchRepository;
    this.#roomRecordRepository = dependencies.roomRecordRepository;
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
    this.#diagnosticIpResolver = dependencies.diagnosticIpResolver;
    this.#authenticateIdentity = dependencies.authenticateIdentity;
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
    this.#terminalResultTtlMs = dependencies.terminalResultTtlMs;
    this.#maxTerminalResults = dependencies.maxTerminalResults;
    this.#lobbyDebounceMs = dependencies.lobbyDebounceMs;
    this.#logError = dependencies.logError ?? (() => undefined);
    this.#roomProjections = dependencies.roomProjectionStore && dependencies.roomRecordRepository
      ? new RoomProjectionCoordinator({
          report: this.#logError,
          store: dependencies.roomProjectionStore,
          apply: async (job) => {
            if (dependencies.roomRecordRepository!.applyProjection) await dependencies.roomRecordRepository!.applyProjection(job.roomId, job.revision, job.payload);
            else {
              if (job.payload.firstBattleAt) await dependencies.roomRecordRepository!.recordBattleStart(job.roomId, new Date(job.payload.firstBattleAt));
              if (job.payload.phase === "closed") await dependencies.roomRecordRepository!.close(job.roomId, new Date(job.payload.closedAt!));
              else await dependencies.roomRecordRepository!.updatePhase(job.roomId, job.payload.phase);
            }
          },
        })
      : new RoomProjectionCoordinator({ report: this.#logError });
    this.#maintenance = dependencies.maintenance ?? (() => undefined);
    this.#persistenceRetryDelaysMs = dependencies.persistenceRetryDelaysMs ?? [0, 100, 500];
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
    this.io.use(async (socket, next) => {
      try {
        const auth = socket.handshake.auth as Record<string, unknown>;
        const identity = await this.#authenticateIdentity(socket.request, auth);
        if (!identity) { const error = new Error("IDENTITY_REQUIRED") as Error & { data?: unknown }; error.data = { code: "IDENTITY_REQUIRED" }; next(error); return; }
        socket.data.identity = identity;
        next();
      } catch {
        const error = new Error("IDENTITY_REQUIRED") as Error & { data?: unknown }; error.data = { code: "IDENTITY_REQUIRED" }; next(error);
      }
    });
    this.io.on("connection", (socket) => { void this.#connect(socket); });
  }

  get activeMatchCount(): number {
    return this.#matches.size;
  }

  get debugCounts(): Readonly<{
    sessions: number;
    bindings: number;
    matches: number;
    terminalMatches: number;
    pendingDepartures: number;
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
      terminalMatches: this.#terminalMatches.size,
      pendingDepartures: [...this.#sessionsById.values()].reduce((sum, session) => sum + session.pendingDepartures.size, 0),
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

  sessionForBearer(value: string | undefined): Readonly<{ id: string; identityId: string; displayName: string }> | undefined {
    if (!value?.startsWith("Bearer ")) return undefined;
    const session = this.#sessionsByToken.get(value.slice(7));
    return session ? { id: session.id, identityId: session.identityId, displayName: session.displayName } : undefined;
  }

  async close(): Promise<void> {
    if (this.#lobbyTimer) clearTimeout(this.#lobbyTimer);
    this.#lobbyTimer = null;
    for (const session of this.#sessionsById.values()) session.commandsStopped = true;
    await Promise.allSettled([...this.#sessionsById.values()].map((session) => session.commandTail));
    for (const [roomId, match] of this.#matches) this.#cancelMatch(roomId, match);
    this.#terminalMatches.clear();
    await this.#roomProjections.close();
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
    this.#pendingLimiter.clear();
    this.#sessionCommandLimiter.clear();
    this.#newSessionByClientLimiter.clear();
    this.#newSessionGlobalLimiter.clear();
  }

  pump(nowMs = this.#now()): void {
    this.#pruneTerminalMatches(nowMs);
    this.#launch.finalizeExpired(nowMs);
    this.#pendingLimiter.pruneExpired();
    this.#sessionCommandLimiter.pruneExpired();
    this.#newSessionByClientLimiter.pruneExpired();
    this.#newSessionGlobalLimiter.pruneExpired();
    this.#maintenance();
    void this.#roomProjections.pump(new Date(nowMs)).catch(this.#logError);
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
        this.#projectRoomClosure(roomId, revision + 1, nowMs);
        this.#departWholeRoom(roomId, "expired");
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
      this.#pruneSessionOutcomes(session, nowMs);
      if (session.socketIds.size === 0 && session.disconnectedAt !== null && nowMs - session.disconnectedAt >= 120_000) {
        this.#expireSession(session);
      }
    }
  }

  async #connect(socket: Socket): Promise<void> {
    let clientKey: string;
    try { clientKey = this.#clientKeyResolver(socket.request); } catch { socket.disconnect(true); return; }
    const clientCount = this.#connectionsByIp.get(clientKey) ?? 0;
    if (this.io.engine.clientsCount > this.#maxConnections || clientCount >= this.#maxConnectionsPerIp) {
      socket.disconnect(true);
      return;
    }
    this.#connectionsByIp.set(clientKey, clientCount + 1);
    const auth = socket.handshake.auth as Record<string, unknown>;
    const requestedToken = typeof auth.sessionToken === "string" ? auth.sessionToken : undefined;
    let authenticated = socket.data.identity as Readonly<{ identityId: string; displayName: string; identitySource?: "iclass" | "cookie" | "guest"; deviceName?: string }>;
    const requestedSession = requestedToken ? this.#sessionsByToken.get(requestedToken) : undefined;
    if (authenticated?.identityId.startsWith("test:") && requestedSession) authenticated = { identityId: requestedSession.identityId, displayName: requestedSession.displayName, identitySource: requestedSession.identitySource, ...(requestedSession.deviceName ? { deviceName: requestedSession.deviceName } : {}) };
    const display = participantSummarySchema.safeParse({ participantId: "identity-check", displayName: authenticated?.displayName });
    if (!display.success) {
      if (clientCount === 0) this.#connectionsByIp.delete(clientKey);
      else this.#connectionsByIp.set(clientKey, clientCount);
      socket.disconnect(true);
      return;
    }
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
          established = this.#establishSession(authenticated, display.data.displayName, requestedToken, clientKey, this.#diagnosticIpResolver(socket.request), socket.request.headers["user-agent"] ?? null);
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
        this.#pruneSessionOutcomes(session, this.#now());
        for (const { event } of session.pendingDepartures.values()) this.#emit(socket, event);
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
      void this.#enqueueCommand(socket, session!, parsed.data, now).catch((error: unknown) => {
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
    identity: Readonly<{ identityId: string; identitySource?: "iclass" | "cookie" | "guest"; deviceName?: string }>,
    displayName: string,
    requestedToken: string | undefined,
    clientKey: string,
    ip: string | null,
    userAgent: string | null,
  ): Readonly<{ session: Session; status: "new" | "resumed" | "replaced" }> {
    const identityId = identity.identityId;
    let session = requestedToken ? this.#sessionsByToken.get(requestedToken) : undefined;
    if (!requestedToken) session = [...this.#sessionsById.values()].find((candidate) => candidate.identityId === identityId && (candidate.disconnectedAt === null || this.#now() - candidate.disconnectedAt < 120_000));
    let status: "new" | "resumed" | "replaced" = requestedToken ? "replaced" : "new";
    if (session?.disconnectedAt !== null && session?.disconnectedAt !== undefined && this.#now() - session.disconnectedAt >= 120_000) {
      this.#expireSession(session);
      session = undefined;
    }
    if (session?.identityId !== identityId) session = undefined;
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
      identityId,
      token: this.#uniqueToken(),
      displayName,
      identitySource: identity.identitySource ?? "guest",
      deviceName: identity.deviceName ?? null,
      ip,
      userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
      roomIds: new Set(),
      ownedRoomIds: new Set(),
      socketIds: new Set(),
      events: new Map(),
      commandTail: Promise.resolve(),
      inflightCommands: new Map(),
      commandsStopped: false,
      disconnectedAt: null,
      lastActiveAt: now,
      clockChallenges: new Map(),
      clockPingIds: new Map(),
      observedRtts: [],
      pendingDepartures: new Map(),
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
      "SESSION_CAPACITY", "SESSION_RATE_LIMITED", "INVALID_CLOCK_SAMPLE", "ALREADY_IN_ROOM",
      "CLOCK_PING_REPLAY", "CLOCK_CHALLENGE_INVALID",
    ]);
    return allowed.has(candidate) ? candidate : "COMMAND_FAILED";
  }

  async #enqueueCommand(socket: Socket, session: Session, event: V1CommandEvent, receivedAtMs: number): Promise<void> {
    const fingerprint = JSON.stringify(event);
    const previous = session.events.get(event.eventId);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw Object.assign(new Error("EVENT_ID_CONFLICT"), { code: "EVENT_ID_CONFLICT" });
      this.#ack(socket, event.eventId, event.type, "replayed");
      return;
    }
    const inflight = session.inflightCommands.get(event.eventId);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint) throw Object.assign(new Error("EVENT_ID_CONFLICT"), { code: "EVENT_ID_CONFLICT" });
      await inflight.promise;
      this.#ack(socket, event.eventId, event.type, "replayed");
      return;
    }
    if (session.commandsStopped) throw Object.assign(new Error("COMMAND_FAILED"), { code: "COMMAND_FAILED" });
    const execution = session.commandTail.then(async () => {
      if (session.commandsStopped) throw Object.assign(new Error("COMMAND_FAILED"), { code: "COMMAND_FAILED" });
      await this.#applyCommand(socket, session, event, receivedAtMs);
      session.events.set(event.eventId, fingerprint);
      if (session.events.size > 512) session.events.delete(session.events.keys().next().value!);
    });
    session.inflightCommands.set(event.eventId, { fingerprint, promise: execution });
    session.commandTail = execution.then(() => undefined, () => undefined);
    try {
      await execution;
      this.#ack(socket, event.eventId, event.type, "applied");
    } finally {
      if (session.inflightCommands.get(event.eventId)?.promise === execution) session.inflightCommands.delete(event.eventId);
    }
  }

  async #applyCommand(socket: Socket, session: Session, event: V1CommandEvent, receivedAtMs: number): Promise<void> {
    if (event.type === "room.create") {
      if (session.roomIds.size > 0) throw Object.assign(new Error("ALREADY_IN_ROOM"), { code: "ALREADY_IN_ROOM" });
      if (session.ownedRoomIds.size >= this.#maxOwnedRoomsPerSession) {
        throw Object.assign(new Error("ROOM_QUOTA_EXCEEDED"), { code: "ROOM_QUOTA_EXCEEDED" });
      }
      if (this.#rooms.lobbySnapshot().rooms.length >= this.#maxRooms) {
        throw Object.assign(new Error("SERVER_CAPACITY"), { code: "SERVER_CAPACITY" });
      }
      const membership = this.#rooms.create(this.#user(session), event.name);
      if (this.#roomRecordRepository) {
        const view = this.#rooms.get(membership.roomId)!;
        try {
          await this.#roomRecordRepository.create({
            id: membership.roomId, code: membership.code, name: view.name,
            ownerIdentityId: this.#uuidOrNull(session.identityId),
            participant: this.#participantRecord(session, membership.participantId, "player1", true),
            at: new Date(this.#now()),
          });
        } catch (error) {
          try { this.#rooms.close(membership.roomId, session.id); } catch { /* best-effort in-memory rollback */ }
          throw error;
        }
      }
      session.roomIds.add(membership.roomId);
      session.ownedRoomIds.add(membership.roomId);
      this.#bindParticipant(membership.roomId, membership.participantId, session.id);
      this.#joinTransportRoom(socket, session, membership.roomId);
      this.#emit(socket, this.#rooms.snapshot(membership.roomId, session.id));
      this.#broadcastLobby();
    } else if (event.type === "room.join") {
      if (session.roomIds.size > 0) throw Object.assign(new Error("ALREADY_IN_ROOM"), { code: "ALREADY_IN_ROOM" });
      const roomId = this.#rooms.resolveRoomReference(event.roomId);
      if (!roomId) throw Object.assign(new Error("ROOM_NOT_FOUND"), { code: "ROOM_NOT_FOUND" });
      const membership = this.#rooms.join(roomId, this.#user(session), event.role);
      if (this.#roomRecordRepository) {
        const view = this.#rooms.get(roomId)!;
        const role = view.player1?.participantId === membership.participantId ? "player1" : view.player2?.participantId === membership.participantId ? "player2" : "spectator";
        try {
          await this.#roomRecordRepository.join(roomId, this.#participantRecord(session, membership.participantId, role, view.ownerParticipantId === membership.participantId), new Date(this.#now()));
        } catch (error) {
          try { this.#rooms.leave(roomId, session.id); } catch { /* best-effort in-memory rollback */ }
          throw error;
        }
      }
      session.roomIds.add(roomId);
      this.#bindParticipant(roomId, membership.participantId, session.id);
      this.#joinTransportRoom(socket, session, roomId);
      this.#broadcastRoom(roomId);
      this.#emit(socket, this.#rooms.snapshot(roomId, session.id));
      this.#sendCheckpoint(socket, roomId, session.id);
      this.#broadcastLobby();
    } else if (event.type === "room.move") {
      const checkpoint = this.#rooms.checkpoint(event.roomId);
      this.#rooms.move(event.roomId, session.id, event.target, event.subjectParticipantId);
      try { if (this.#roomRecordRepository) await this.#persistRoomRoles(event.roomId); }
      catch (error) { this.#rooms.restore(checkpoint); this.#broadcastRoom(event.roomId); this.#broadcastLobby(); throw error; }
      this.#syncTransportRoles(event.roomId);
      this.#broadcastRoom(event.roomId);
      this.#broadcastLobby();
    } else if (event.type === "player.ready") {
      try {
        this.#designs.requireOwned(session.id, event.designId);
      } catch (error) {
        if (!this.#designRepository) throw error;
        const persisted = await this.#designRepository.getOwned(session.identityId, event.designId);
        if (!persisted) throw error;
        this.#designs.hydrate(session.id, persisted);
      }
      this.#rooms.ready(event.roomId, session.id, event.designId);
      this.#broadcastRoom(event.roomId);
      this.#broadcastLobby();
      await this.#startMatchIfReady(event.roomId);
    } else if (event.type === "room.close") {
      const closingRevision = (this.#rooms.get(event.roomId)?.revision ?? 0) + 1;
      const checkpoint = this.#rooms.checkpoint(event.roomId);
      this.#rooms.close(event.roomId, session.id);
      try { if (this.#roomRecordRepository) await this.#roomRecordRepository.close(event.roomId, new Date(this.#now())); }
      catch (error) { this.#rooms.restore(checkpoint); this.#broadcastRoom(event.roomId); this.#broadcastLobby(); throw error; }
      this.#projectRoomClosure(event.roomId, closingRevision, this.#now());
      const match = this.#matches.get(event.roomId);
      if (match) this.#cancelMatch(event.roomId, match);
      this.#departWholeRoom(event.roomId, "closed");
      this.#cleanupRoom(event.roomId);
      this.#broadcastLobby();
    } else if (event.type === "room.leave") {
      const closingRevision = (this.#rooms.get(event.roomId)?.revision ?? 0) + 1;
      const beforeLeave = this.#rooms.snapshot(event.roomId, session.id);
      if (beforeLeave.phase !== "waiting" && beforeLeave.viewer.role !== "spectator") {
        throw Object.assign(new Error("ROOM_ACTIVE"), { code: "ROOM_ACTIVE" });
      }
      const participantId = this.#participantForSession(event.roomId, session.id);
      const checkpoint = this.#rooms.checkpoint(event.roomId);
      this.#rooms.leave(event.roomId, session.id);
      try {
        if (this.#roomRecordRepository) {
          if (this.#rooms.hasRoom(event.roomId)) {
            const projection = this.#roomRoleProjection(event.roomId);
            await this.#roomRecordRepository.leaveAndSync(event.roomId, participantId, new Date(this.#now()), projection.roles, projection.ownerParticipantId, projection.ownerIdentityId);
          } else await this.#roomRecordRepository.leave(event.roomId, participantId, new Date(this.#now()));
        }
      } catch (error) { this.#rooms.restore(checkpoint); this.#broadcastRoom(event.roomId); this.#broadcastLobby(); throw error; }
      const departure = {
        type: "room.departed", roomId: event.roomId, reason: "left",
        departureId: this.#createServerEventId(),
        protocolVersion: PROTOCOL_VERSION, serverEventId: this.#createServerEventId(),
      } as const;
      this.#queueDeparture(session, departure);
      this.#emitToSession(session.id, departure);
      this.#sessionIdsByParticipant.get(event.roomId)?.delete(participantId);
      session.roomIds.delete(event.roomId);
      session.ownedRoomIds.delete(event.roomId);
      this.io.in(`session:${session.id}`).socketsLeave([
        `room:${event.roomId}`, `room:${event.roomId}:player1`,
        `room:${event.roomId}:player2`, `room:${event.roomId}:spectator`,
      ]);
      if (this.#rooms.hasRoom(event.roomId)) {
        const room = this.#rooms.get(event.roomId)!;
        const nextOwnerSessionId = room.ownerParticipantId
          ? this.#sessionIdsByParticipant.get(event.roomId)?.get(room.ownerParticipantId)
          : undefined;
        if (nextOwnerSessionId) this.#sessionsById.get(nextOwnerSessionId)?.ownedRoomIds.add(event.roomId);
        this.#broadcastRoom(event.roomId);
      } else { this.#projectRoomClosure(event.roomId, closingRevision, this.#now()); this.#cleanupRoom(event.roomId); }
      this.#broadcastLobby();
    } else if (event.type === "clock.ping") {
      this.#pruneSessionOutcomes(session, receivedAtMs);
      if (session.clockPingIds.has(event.pingId)) throw Object.assign(new Error("CLOCK_PING_REPLAY"), { code: "CLOCK_PING_REPLAY" });
      const serverSentAtMs = Math.max(receivedAtMs, this.#now());
      session.clockPingIds.set(event.pingId, serverSentAtMs + CLOCK_CHALLENGE_TTL_MS);
      session.clockChallenges.set(event.pingId, { serverSentAtMs, expiresAtMs: serverSentAtMs + CLOCK_CHALLENGE_TTL_MS });
      this.#emit(socket, {
        type: "clock.pong", pingId: event.pingId, clientSentAtMs: event.clientSentAtMs,
        serverReceiveTimeMs: receivedAtMs, serverSendTimeMs: serverSentAtMs,
        protocolVersion: PROTOCOL_VERSION, serverEventId: this.#createServerEventId(),
      });
    } else if (event.type === "clock.ack") {
      this.#pruneSessionOutcomes(session, receivedAtMs);
      const challenge = session.clockChallenges.get(event.pingId);
      if (!challenge) {
        if (!session.clockPingIds.has(event.pingId)) throw Object.assign(new Error("CLOCK_CHALLENGE_INVALID"), { code: "CLOCK_CHALLENGE_INVALID" });
      } else {
        session.clockChallenges.delete(event.pingId);
        const rttMs = receivedAtMs - challenge.serverSentAtMs;
        if (rttMs >= 0 && rttMs <= 2_000) {
          session.observedRtts.push(rttMs);
          if (session.observedRtts.length > 9) session.observedRtts.shift();
        }
      }
    } else if (event.type === "room.departed.ack") {
      session.pendingDepartures.delete(event.departureId);
    } else if (event.type === "launch.tap") {
      const match = this.#matches.get(event.roomId);
      if (!match || match.currentRoundId !== event.roundId) {
        throw Object.assign(new Error("NO_ACTIVE_LAUNCH"), { code: "NO_ACTIVE_LAUNCH" });
      }
      const participantId = this.#participantForSession(event.roomId, session.id);
      this.#launch.submit(participantId, event, receivedAtMs, median(session.observedRtts));
      this.#flushLaunch(event.roomId, match);
    }
  }

  #broadcastRoom(roomId: string): void {
    if (!this.#rooms.hasRoom(roomId)) return;
    const deltas = this.#rooms.drainDeltas(roomId);
    for (const delta of deltas) this.io.to(`room:${roomId}`).emit("server.event", delta);
  }

  async #startMatchIfReady(roomId: string): Promise<void> {
    if (this.#matches.has(roomId)) return;
    const room = this.#rooms.get(roomId);
    if (!room?.player1?.ready || !room.player2?.ready || !room.player1.designId || !room.player2.designId) return;
    const bindings = this.#sessionIdsByParticipant.get(roomId);
    const session1 = bindings?.get(room.player1.participantId);
    const session2 = bindings?.get(room.player2.participantId);
    if (!session1 || !session2) throw new Error("Missing authoritative participant binding");
    this.#terminalMatches.delete(roomId);
    const persistedDesign1 = this.#designs.requireOwned(session1, room.player1.designId);
    const persistedDesign2 = this.#designs.requireOwned(session2, room.player2.designId);
    if (persistedDesign1.performance.modelVersion !== persistedDesign2.performance.modelVersion) throw new Error("PERFORMANCE_MODEL_MISMATCH");
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
      startedAt: new Date(this.#now()),
      roundHistory: [],
      persistenceAttempts: 0,
      officiallyCompleted: false,
      spectatorCountAtStart: room.spectators.length,
      };
      if (this.#matchRepository) {
        const identity1 = this.#sessionsById.get(session1)!;
        const identity2 = this.#sessionsById.get(session2)!;
        await this.#matchRepository.beginMatch({
          id: matchId, roomId: this.#roomRecordRepository ? this.#uuidOrNull(roomId) : null,
          player1IdentityId: this.#uuidOrNull(identity1.identityId), player2IdentityId: this.#uuidOrNull(identity2.identityId),
          player1DesignId: room.player1.designId, player2DesignId: room.player2.designId,
          performanceModelVersion: persistedDesign1.performance.modelVersion,
          physicsModelVersion: PHYSICS_MODEL_VERSION, protocolVersion: PROTOCOL_VERSION,
          spectatorCount: match.spectatorCountAtStart, startedAt: match.startedAt,
        });
      }
      this.#matches.set(roomId, match);
      this.#rooms.setPhase(roomId, "launch");
      this.#projectRoomPhase(roomId, "launch");
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
      this.#projectRoomPhase(roomId, "waiting");
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
      this.#projectRoomPhase(roomId, "battle");
      this.#rooms.setPhase(roomId, "battle");
      this.#broadcastRoom(roomId);
      this.#broadcastLobby();
      const design1 = this.#designs.requireOwned(match.players[0].sessionId, match.players[0].designId);
      const design2 = this.#designs.requireOwned(match.players[1].sessionId, match.players[1].designId);
      const seed = this.#seedFactory();
      const roundStartedAt = new Date(this.#now());
      const battleInputs = {
        player1: design1.design, player2: design2.design,
        launchA: match.launches.get(match.players[0].participantId)!,
        launchB: match.launches.get(match.players[1].participantId)!,
        seed,
      };
      const result = await this.#battleEngine.simulateOnceAsync(match.matchId, roundId, battleInputs, { signal: controller.signal });
      if (this.#matches.get(roomId) !== match || match.generation !== generation || match.currentRoundId !== roundId) return;
      if (result.frames.length === 0) throw new Error("Battle result contained no frames");
      const persistedAttempt: CompletedMatchRecord["rounds"][number] = {
        id: crypto.randomUUID(), externalRoundId: roundId,
        roundNumber: Math.min(3, match.roundWinners.length + 1),
        attempt: match.roundHistory.filter((attempt) => attempt.roundNumber === Math.min(3, match.roundWinners.length + 1)).length + 1,
        inputFingerprint: sha256Hex(JSON.stringify(battleInputs)),
        launchA: { ...battleInputs.launchA, ...(this.#launch.launchDiagnostic(roomId, roundId, match.players[0].participantId) ?? { tapReceivedAtMs: null, tapOffsetMs: null }) },
        launchB: { ...battleInputs.launchB, ...(this.#launch.launchDiagnostic(roomId, roundId, match.players[1].participantId) ?? { tapReceivedAtMs: null, tapOffsetMs: null }) },
        startedAt: roundStartedAt, completedAt: new Date(this.#now()),
        battleResult: { ...structuredClone(result), frames: [...result.frames], finalStats: { ...result.finalStats } },
      };
      if (this.#matchRepository) await this.#persistRoundAttempt(roomId, match, persistedAttempt);
      match.roundHistory.push(persistedAttempt);
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
        this.#emitToRoom(roomId, event, sequence === 0 || sequence === result.frames.length - 1);
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
      this.#projectRoomPhase(roomId, "result");
      this.#rooms.setPhase(roomId, "result");
      this.#broadcastRoom(roomId);
      this.#broadcastLobby();
      match.roundWinners.splice(0, match.roundWinners.length, ...candidateWinners);
      if (completedScore) {
        const matchFinished: MatchFinishedEvent = {
          type: "match.finished", roomId, matchId: match.matchId,
          player1: completedScore.player1, player2: completedScore.player2,
          roundWinners: [...match.roundWinners], protocolVersion: PROTOCOL_VERSION,
          serverEventId: this.#createServerEventId(),
        };
        if (this.#matchRepository) {
          await this.#persistCompletedMatch(roomId, match, completedScore, design1.performance.modelVersion, result);
          if (this.#matches.get(roomId) !== match || match.generation !== generation) return;
        }
        match.officiallyCompleted = true;
        try {
          this.#emitToRoom(roomId, matchFinished);
          this.#storeTerminalMatch(roomId, match, matchFinished);
          this.#rooms.finishMatch(roomId);
          this.#broadcastRoom(roomId);
          this.#broadcastLobby();
          this.#projectRoomPhase(roomId, "waiting");
        } finally {
          try { this.#launch.cleanupRound(roomId, roundId); } catch { /* already reclaimed */ }
          this.#battleEngine.cleanup(match.matchId, roundId);
          this.#unpinMatchDesigns(match);
          if (this.#matches.get(roomId) === match) this.#matches.delete(roomId);
        }
        return;
      }
      this.#projectRoomPhase(roomId, "launch");
      this.#rooms.nextRound(roomId);
      this.#broadcastRoom(roomId);
      this.#broadcastLobby();
      this.#launch.cleanupRound(roomId, roundId);
      this.#battleEngine.cleanup(match.matchId, roundId);
      this.#scheduleRound(roomId, match);
    } catch (error) {
      if (!match.officiallyCompleted && !(error instanceof Error && (error.name === "AbortError" || error.name === "MatchPersistenceTerminalError" || error.name === "RoundPersistenceTerminalError"))) {
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

  async #persistCompletedMatch(
    roomId: string,
    match: MatchState,
    score: MatchScoreResult,
    performanceModelVersion: string,
    finalResult: BattleResult,
  ): Promise<void> {
    const room = this.#rooms.get(roomId);
    const session1 = this.#sessionsById.get(match.players[0].sessionId);
    const session2 = this.#sessionsById.get(match.players[1].sessionId);
    if (!room || !session1 || !session2 || !this.#matchRepository) throw new Error("MATCH_CONTEXT_MISSING");
    const completedAt = new Date(this.#now());
    const base = {
      id: match.matchId,
      roomId: this.#roomRecordRepository ? this.#uuidOrNull(roomId) : null,
      player1: {
        identityId: this.#uuidOrNull(session1.identityId), identitySource: session1.identitySource,
        deviceName: session1.deviceName, ip: session1.ip, userAgent: session1.userAgent,
        designId: match.players[0].designId, massG: this.#designs.requireOwned(session1.id, match.players[0].designId).massG, score: score.player1,
      },
      player2: {
        identityId: this.#uuidOrNull(session2.identityId), identitySource: session2.identitySource,
        deviceName: session2.deviceName, ip: session2.ip, userAgent: session2.userAgent,
        designId: match.players[1].designId, massG: this.#designs.requireOwned(session2.id, match.players[1].designId).massG, score: score.player2,
      },
      roundWinners: [...match.roundWinners], rounds: structuredClone(match.roundHistory),
      performanceModelVersion, physicsModelVersion: finalResult.modelVersion,
      protocolVersion: PROTOCOL_VERSION, spectatorCount: match.spectatorCountAtStart,
      startedAt: match.startedAt, completedAt,
    };
    const record: CompletedMatchRecord = {
      ...base,
      idempotencyFingerprint: completedMatchFingerprint(base),
    };
    let lastError: unknown;
    let queued = false;
    for (const [index, delay] of this.#persistenceRetryDelaysMs.entries()) {
      match.persistenceAttempts += 1;
      this.#emitToRoom(roomId, {
        type: "match.persistence", roomId, matchId: match.matchId,
        status: index === 0 ? "saving" : "retrying", attempt: match.persistenceAttempts,
        protocolVersion: PROTOCOL_VERSION, serverEventId: this.#createServerEventId(),
      });
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      try {
        if (!queued) { await this.#matchRepository.queueCompletion(record); queued = true; }
        await this.#matchRepository.retryFailedMatch(record.id);
        return;
      } catch (error) {
        lastError = error;
        this.#logError(error);
      }
    }
    try { await this.#matchRepository.markPersistenceFailure?.(match.matchId, "MATCH_SAVE_FAILED"); } catch (error) { this.#logError(error); }
    this.#emitToRoom(roomId, {
      type: "match.persistence_failed", roomId, matchId: match.matchId,
      failureCode: "MATCH_SAVE_FAILED", retryable: queued,
      protocolVersion: PROTOCOL_VERSION, serverEventId: this.#createServerEventId(),
    });
    try { this.#rooms.cancelMatch(roomId); } catch { /* room may already be gone */ }
    this.#projectRoomPhase(roomId, "waiting");
    try { this.#launch.cleanupRound(roomId, match.currentRoundId); } catch { /* already reclaimed */ }
    this.#battleEngine.cleanup(match.matchId, match.currentRoundId);
    this.#unpinMatchDesigns(match);
    this.#matches.delete(roomId);
    this.#broadcastRoom(roomId);
    this.#broadcastLobby();
    const terminal = new Error(lastError instanceof Error ? "MATCH_SAVE_FAILED" : "MATCH_SAVE_FAILED");
    terminal.name = "MatchPersistenceTerminalError";
    throw terminal;
  }

  async #persistRoundAttempt(roomId: string, match: MatchState, attempt: CompletedMatchRecord["rounds"][number]): Promise<void> {
    let lastError: unknown;
    for (const delay of this.#persistenceRetryDelaysMs) {
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      try { await this.#matchRepository!.saveRoundAttempt(match.matchId, attempt); return; }
      catch (error) { lastError = error; this.#logError(error); }
    }
    try { await this.#matchRepository!.markPersistenceFailure?.(match.matchId, "ROUND_SAVE_FAILED"); } catch (error) { this.#logError(error); }
    this.#emitToRoom(roomId, { type: "match.persistence_failed", roomId, matchId: match.matchId, failureCode: "ROUND_SAVE_FAILED", retryable: false, protocolVersion: PROTOCOL_VERSION, serverEventId: this.#createServerEventId() });
    try { this.#rooms.cancelMatch(roomId); } catch { /* room may have closed */ }
    this.#projectRoomPhase(roomId, "waiting");
    this.#cancelMatch(roomId, match);
    this.#broadcastRoom(roomId); this.#broadcastLobby();
    const terminal = new Error(lastError instanceof Error ? "ROUND_SAVE_FAILED" : "ROUND_SAVE_FAILED"); terminal.name = "RoundPersistenceTerminalError"; throw terminal;
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
    this.#terminalMatches.delete(roomId);
    this.#sessionIdsByParticipant.delete(roomId);
    for (const session of this.#sessionsById.values()) {
      session.roomIds.delete(roomId);
      session.ownedRoomIds.delete(roomId);
    }
    this.io.in(`room:${roomId}`).socketsLeave([
      `room:${roomId}`, `room:${roomId}:player1`, `room:${roomId}:player2`, `room:${roomId}:spectator`,
    ]);
  }

  #departWholeRoom(roomId: string, reason: "closed" | "expired" | "removed"): void {
    const event = {
      type: "room.departed", departureId: this.#createServerEventId(), roomId, reason,
      protocolVersion: PROTOCOL_VERSION, serverEventId: this.#createServerEventId(),
    } as const;
    for (const session of this.#sessionsById.values()) {
      if (session.roomIds.has(roomId)) this.#queueDeparture(session, event);
    }
    this.#emitToRoom(roomId, event);
  }

  #queueDeparture(session: Session, event: Extract<ServerEvent, { type: "room.departed" }>): void {
    this.#pruneSessionOutcomes(session, this.#now());
    while (session.pendingDepartures.size >= MAX_PENDING_OUTCOMES) session.pendingDepartures.delete(session.pendingDepartures.keys().next().value!);
    session.pendingDepartures.set(event.departureId, { event: structuredClone(event), expiresAtMs: this.#now() + DEPARTURE_TTL_MS });
  }

  #pruneSessionOutcomes(session: Session, nowMs: number): void {
    for (const [pingId, expiresAtMs] of session.clockPingIds) if (expiresAtMs <= nowMs) session.clockPingIds.delete(pingId);
    for (const [pingId, challenge] of session.clockChallenges) if (challenge.expiresAtMs <= nowMs) session.clockChallenges.delete(pingId);
    for (const [departureId, pending] of session.pendingDepartures) if (pending.expiresAtMs <= nowMs) session.pendingDepartures.delete(departureId);
  }

  #participantForSession(roomId: string, sessionId: string): string {
    const entry = [...(this.#sessionIdsByParticipant.get(roomId) ?? [])].find(([, value]) => value === sessionId);
    if (!entry) throw Object.assign(new Error("NOT_IN_ROOM"), { code: "NOT_IN_ROOM" });
    return entry[0];
  }

  #sendCheckpoint(socket: Socket, roomId: string, sessionId: string): void {
    const match = this.#matches.get(roomId);
    if (!match) {
      const terminal = this.#terminalMatches.get(roomId);
      const participantId = [...(this.#sessionIdsByParticipant.get(roomId) ?? [])].find(([, boundSessionId]) => boundSessionId === sessionId)?.[0];
      if (!terminal || terminal.expiresAtMs <= this.#now() || !participantId ||
        !terminal.memberships.some((membership) => membership.sessionId === sessionId && membership.participantId === participantId)) return;
      this.#emit(socket, terminal.battleStarted);
      this.#emit(socket, terminal.checkpoint);
      this.#emit(socket, terminal.latestFrame);
      this.#emit(socket, terminal.matchFinished);
      return;
    }
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

  #storeTerminalMatch(roomId: string, match: MatchState, matchFinished: MatchFinishedEvent): void {
    if (!match.latestFrame) return;
    const nowMs = this.#now();
    this.#pruneTerminalMatches(nowMs);
    this.#terminalMatches.delete(roomId);
    while (this.#terminalMatches.size >= this.#maxTerminalResults) {
      const oldest = [...this.#terminalMatches.entries()]
        .sort(([, left], [, right]) => left.expiresAtMs - right.expiresAtMs)[0];
      if (!oldest) break;
      this.#terminalMatches.delete(oldest[0]);
    }
    this.#terminalMatches.set(roomId, {
      roomId,
      matchId: match.matchId,
      memberships: [...(this.#sessionIdsByParticipant.get(roomId) ?? [])].map(([participantId, sessionId]) => ({ participantId, sessionId })),
      battleStarted: structuredClone(match.battleStarted),
      checkpoint: {
        type: "battle.checkpoint", roomId, matchId: match.matchId,
        roundId: match.currentRoundId, attempt: match.attempt, phase: "result",
        roundWinners: [...match.roundWinners], protocolVersion: PROTOCOL_VERSION,
        serverEventId: this.#createServerEventId(),
      },
      latestFrame: structuredClone(match.latestFrame),
      matchFinished: structuredClone(matchFinished),
      expiresAtMs: nowMs + this.#terminalResultTtlMs,
    });
  }

  #pruneTerminalMatches(nowMs: number): void {
    for (const [roomId, terminal] of this.#terminalMatches) {
      if (terminal.expiresAtMs <= nowMs) this.#terminalMatches.delete(roomId);
    }
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

  #uuidOrNull(value: string): string | null {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) ? value : null;
  }

  #participantRecord(session: Session, participantPublicId: string, role: "player1" | "player2" | "spectator", isOwner: boolean): RoomParticipantRecord {
    return {
      participantPublicId, identityId: this.#uuidOrNull(session.identityId), displayName: session.displayName,
      role, isOwner, ip: session.ip, userAgent: session.userAgent, deviceName: session.deviceName,
    };
  }

  async #persistRoomRoles(roomId: string): Promise<void> {
    if (!this.#roomRecordRepository) return;
    const projection = this.#roomRoleProjection(roomId);
    await this.#roomRecordRepository.syncRoles(roomId, projection.roles, projection.ownerParticipantId, projection.ownerIdentityId);
  }

  #roomRoleProjection(roomId: string) {
    const room = this.#rooms.get(roomId);
    if (!room) throw new Error("ROOM_NOT_FOUND");
    const roles = new Map<string, "player1" | "player2" | "spectator">();
    if (room.player1) roles.set(room.player1.participantId, "player1");
    if (room.player2) roles.set(room.player2.participantId, "player2");
    for (const spectator of room.spectators) roles.set(spectator.participantId, "spectator");
    const ownerSessionId = room.ownerParticipantId
      ? this.#sessionIdsByParticipant.get(roomId)?.get(room.ownerParticipantId)
      : undefined;
    const ownerIdentityId = ownerSessionId
      ? this.#uuidOrNull(this.#sessionsById.get(ownerSessionId)?.identityId ?? "")
      : null;
    return { roles, ownerParticipantId: room.ownerParticipantId, ownerIdentityId };
  }

  #projectRoomPhase(roomId: string, phase: "waiting" | "launch" | "battle" | "result"): void {
    if (!this.#roomRecordRepository) return;
    const revision = this.#rooms.get(roomId)?.revision ?? Number.MAX_SAFE_INTEGER;
    if (this.#roomProjections.usesDurableStore) {
      void this.#roomProjections.enqueueProjection({
        roomId, revision,
        payload: { phase, firstBattleAt: this.#matches.get(roomId)?.startedAt.toISOString() ?? null, closedAt: null },
      }).catch(this.#logError);
    } else this.#roomProjections.enqueue(`${roomId}:phase`, revision, () => this.#roomRecordRepository!.updatePhase(roomId, phase));
  }

  #projectRoomClosure(roomId: string, revision: number, closedAtMs: number): void {
    if (!this.#roomRecordRepository) return;
    const closedAt = new Date(closedAtMs);
    if (this.#roomProjections.usesDurableStore) {
      void this.#roomProjections.enqueueProjection({ roomId, revision, payload: { phase: "closed", firstBattleAt: null, closedAt: closedAt.toISOString() } }).catch(this.#logError);
    } else this.#roomProjections.enqueue(`${roomId}:phase`, revision, () => this.#roomRecordRepository!.close(roomId, closedAt));
  }

  #user(session: Session) { return { id: session.id, displayName: session.displayName }; }

  #ack(socket: Socket, causedByEventId: string, commandType: V1CommandEvent["type"], status: "applied" | "replayed"): void {
    this.#emit(socket, {
      type: "command.ack", causedByEventId, commandType, status,
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
