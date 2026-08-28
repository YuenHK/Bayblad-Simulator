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
import type { BattleEnginePort } from "./app";
import { LaunchCoordinator, type LaunchJudgement } from "./battle/launch";
import { scoreMatch as defaultScoreMatch } from "./battle/scoring";
import type { ScoreMatchInput, MatchScoreResult } from "./battle/scoring";
import { RoomService } from "./rooms/room-service";

type Session = {
  id: string;
  token: string;
  displayName: string;
  roomIds: Set<string>;
  socketIds: Set<string>;
  events: Map<string, string>;
  disconnectedAt: number | null;
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
  readonly #sessionsByToken = new Map<string, Session>();
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
    this.#frameScheduler = dependencies.frameScheduler ?? defaultFrameScheduler;
    this.#scoreMatch = dependencies.scoreMatch ?? defaultScoreMatch;
    this.io = new Server(server, { cors: { origin: false } });
    this.io.on("connection", (socket) => this.#connect(socket));
  }

  get activeMatchCount(): number {
    return this.#matches.size;
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
    for (const [roomId, match] of [...this.#matches]) {
      const room = this.#rooms.get(roomId);
      if (!room ||
        room.player1?.participantId !== match.players[0].participantId ||
        room.player2?.participantId !== match.players[1].participantId) {
        this.#cancelMatch(roomId, match);
      }
    }
    let lobbyChanged = false;
    for (const roomId of beforeSweep) {
      if (this.#rooms.hasRoom(roomId)) this.#broadcastRoom(roomId);
      else {
        lobbyChanged = true;
        for (const session of this.#sessionsByToken.values()) session.roomIds.delete(roomId);
      }
    }
    if (beforeSweep.length > 0 || lobbyChanged) this.#broadcastLobby();
    for (const [roomId, match] of [...this.#matches]) {
      if (!this.#rooms.hasRoom(roomId)) this.#cancelMatch(roomId, match);
    }
    for (const [token, session] of this.#sessionsByToken) {
      if (session.socketIds.size === 0 && session.disconnectedAt !== null && nowMs - session.disconnectedAt >= 120_000) {
        this.#sessionsByToken.delete(token);
      }
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
    let sessionStatus: "new" | "resumed" | "replaced" = requestedToken ? "replaced" : "new";
    if (session?.disconnectedAt !== null && session?.disconnectedAt !== undefined && this.#now() - session.disconnectedAt >= 120_000) {
      this.#sessionsByToken.delete(session.token);
      session = undefined;
    }
    if (session) sessionStatus = "resumed";
    if (!session) {
      session = {
        id: this.#createSessionId(),
        token: this.#uniqueToken(),
        displayName: display.data.displayName,
        roomIds: new Set(),
        socketIds: new Set(),
        events: new Map(),
        disconnectedAt: null,
      };
      this.#sessionsByToken.set(session.token, session);
    }
    session.disconnectedAt = null;
    session.socketIds.add(socket.id);
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
          sessionStatus,
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
            this.#emit(socket, this.#rooms.snapshot(roomId, session.id));
            this.#sendCheckpoint(socket, roomId, session.id);
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
      if (session!.socketIds.size > 0) return;
      session!.disconnectedAt = this.#now();
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
      this.#sendCheckpoint(socket, event.roomId, session.id);
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
    const match: MatchState = {
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
    this.#broadcastRoom(roomId);
    this.#broadcastLobby();
    this.#emitToRoom(roomId, battleStarted);
    this.#scheduleRound(roomId, match);
  }

  #scheduleRound(roomId: string, match: MatchState): void {
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
      match.privateResults.set(player.participantId, event);
      this.#emitToSession(player.sessionId, event);
    }
    const spectatorEvent = this.#launch.takeSpectatorResult(roomId, match.currentRoundId);
    if (spectatorEvent) {
      match.spectatorResult = spectatorEvent;
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
        this.#emitToRoom(roomId, event);
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
    if (match.currentRoundId) this.#battleEngine.cleanup(match.matchId, match.currentRoundId);
    this.#matches.delete(roomId);
    this.#sessionIdsByParticipant.delete(roomId);
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
