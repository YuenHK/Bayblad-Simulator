import Fastify, { type FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { BattleInputs, BattleResult, ResultRepository } from "./battle/engine";
import { BattleEngine } from "./battle/engine";
import { LaunchCoordinator } from "./battle/launch";
import { DesignRegistry, DesignRegistryError } from "./design-registry";
import { RoomService } from "./rooms/room-service";
import { RealtimeGateway, type FrameScheduler, type MatchScorer } from "./socket";
import { TokenBucketLimiter } from "./rate-limit";

export type ClientKeyResolver = (request: IncomingMessage) => string;

export interface BattleEnginePort {
  readonly simulationCount: number;
  simulateOnceAsync(matchId: string, roundId: string, inputs: BattleInputs, options?: Readonly<{ signal?: AbortSignal }>): Promise<BattleResult>;
  cleanup(matchId: string, roundId: string): boolean;
}

export type BuildAppOptions = Readonly<{
  rooms?: RoomService;
  designs?: DesignRegistry;
  battleEngine?: BattleEnginePort;
  resultRepository?: ResultRepository;
  launch?: LaunchCoordinator;
  now?: () => number;
  seedFactory?: () => number;
  createServerEventId?: () => string;
  createSessionId?: () => string;
  createSessionToken?: () => string;
  frameScheduler?: FrameScheduler;
  scoreMatch?: MatchScorer;
  allowedOrigins?: readonly string[];
  allowMissingOrigin?: boolean;
  bodyLimit?: number;
  maxHttpBufferSize?: number;
  handshakeTimeoutMs?: number;
  rateLimitBurst?: number;
  rateLimitRefillPerSecond?: number;
  pendingRateLimitBurst?: number;
  pendingRateLimitRefillPerSecond?: number;
  rateLimitMaxBuckets?: number;
  rateLimitBucketTtlMs?: number;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  maxRetainedSessions?: number;
  newSessionBurstPerClient?: number;
  newSessionRefillPerSecond?: number;
  newSessionGlobalBurst?: number;
  newSessionGlobalRefillPerSecond?: number;
  maxRooms?: number;
  maxOwnedRoomsPerSession?: number;
  maxDesigns?: number;
  maxDesignsPerSession?: number;
  designTtlMs?: number;
  maxMatchAttempts?: number;
  terminalResultTtlMs?: number;
  maxTerminalResults?: number;
  lobbyDebounceMs?: number;
  designRateBurst?: number;
  designRateRefillPerSecond?: number;
  designClientRateBurst?: number;
  designClientRateRefillPerSecond?: number;
  behindProxy?: boolean;
  clientKeyResolver?: ClientKeyResolver;
  logError?: (error: unknown) => void;
  sweepIntervalMs?: number;
}>;

export type BuiltApp = FastifyInstance & Readonly<{
  realtimeGateway: RealtimeGateway;
  battleEngine: BattleEnginePort;
}>;

function requirePositive(name: string, value: number, integer = true): number {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${name} must be a finite positive${integer ? " integer" : " number"}`);
  }
  return value;
}

function requireNonnegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) throw new TypeError(`${name} must be a finite nonnegative integer`);
  return value;
}

export function buildApp(options: BuildAppOptions): BuiltApp {
  if (process.env.NODE_ENV === "production" && !options.allowedOrigins?.length) {
    throw new TypeError("Production composition requires allowedOrigins");
  }
  if (process.env.NODE_ENV === "production" && options.behindProxy && !options.clientKeyResolver) {
    throw new TypeError("Production behindProxy composition requires clientKeyResolver");
  }
  if (options.clientKeyResolver && !options.behindProxy) {
    throw new TypeError("clientKeyResolver requires behindProxy trusted boundary");
  }
  const config = {
    bodyLimit: requirePositive("bodyLimit", options.bodyLimit ?? 64 * 1_024),
    maxHttpBufferSize: requirePositive("maxHttpBufferSize", options.maxHttpBufferSize ?? 64 * 1_024),
    handshakeTimeoutMs: requirePositive("handshakeTimeoutMs", options.handshakeTimeoutMs ?? 10_000),
    rateLimitBurst: requirePositive("rateLimitBurst", options.rateLimitBurst ?? 30),
    rateLimitRefillPerSecond: requirePositive("rateLimitRefillPerSecond", options.rateLimitRefillPerSecond ?? 10, false),
    pendingRateLimitBurst: requirePositive("pendingRateLimitBurst", options.pendingRateLimitBurst ?? 64),
    pendingRateLimitRefillPerSecond: requirePositive("pendingRateLimitRefillPerSecond", options.pendingRateLimitRefillPerSecond ?? 20, false),
    rateLimitMaxBuckets: requirePositive("rateLimitMaxBuckets", options.rateLimitMaxBuckets ?? 10_000),
    rateLimitBucketTtlMs: requirePositive("rateLimitBucketTtlMs", options.rateLimitBucketTtlMs ?? 120_000),
    maxConnections: requirePositive("maxConnections", options.maxConnections ?? 5_000),
    maxConnectionsPerIp: requirePositive("maxConnectionsPerIp", options.maxConnectionsPerIp ?? 500),
    maxRetainedSessions: requirePositive("maxRetainedSessions", options.maxRetainedSessions ?? 10_000),
    newSessionBurstPerClient: requirePositive("newSessionBurstPerClient", options.newSessionBurstPerClient ?? 600),
    newSessionRefillPerSecond: requirePositive("newSessionRefillPerSecond", options.newSessionRefillPerSecond ?? 10, false),
    newSessionGlobalBurst: requirePositive("newSessionGlobalBurst", options.newSessionGlobalBurst ?? 5_000),
    newSessionGlobalRefillPerSecond: requirePositive("newSessionGlobalRefillPerSecond", options.newSessionGlobalRefillPerSecond ?? 100, false),
    maxRooms: requirePositive("maxRooms", options.maxRooms ?? 1_000),
    maxOwnedRoomsPerSession: requirePositive("maxOwnedRoomsPerSession", options.maxOwnedRoomsPerSession ?? 3),
    maxDesigns: requirePositive("maxDesigns", options.maxDesigns ?? 2_000),
    maxDesignsPerSession: requirePositive("maxDesignsPerSession", options.maxDesignsPerSession ?? 20),
    designTtlMs: requirePositive("designTtlMs", options.designTtlMs ?? 24 * 60 * 60_000),
    maxMatchAttempts: requirePositive("maxMatchAttempts", options.maxMatchAttempts ?? 5),
    terminalResultTtlMs: requirePositive("terminalResultTtlMs", options.terminalResultTtlMs ?? 120_000),
    maxTerminalResults: requirePositive("maxTerminalResults", options.maxTerminalResults ?? 1_000),
    lobbyDebounceMs: requireNonnegative("lobbyDebounceMs", options.lobbyDebounceMs ?? (process.env.NODE_ENV === "test" ? 0 : 50)),
    sweepIntervalMs: requireNonnegative("sweepIntervalMs", options.sweepIntervalMs ?? 1_000),
    designRateBurst: requirePositive("designRateBurst", options.designRateBurst ?? 10),
    designRateRefillPerSecond: requirePositive("designRateRefillPerSecond", options.designRateRefillPerSecond ?? 2, false),
    designClientRateBurst: requirePositive("designClientRateBurst", options.designClientRateBurst ?? 600),
    designClientRateRefillPerSecond: requirePositive("designClientRateRefillPerSecond", options.designClientRateRefillPerSecond ?? 20, false),
  };
  if (config.maxConnectionsPerIp > config.maxConnections) throw new TypeError("maxConnectionsPerIp cannot exceed maxConnections");
  if (config.maxOwnedRoomsPerSession > config.maxRooms) throw new TypeError("maxOwnedRoomsPerSession cannot exceed maxRooms");
  if (config.maxDesignsPerSession > config.maxDesigns) throw new TypeError("maxDesignsPerSession cannot exceed maxDesigns");
  if (config.maxMatchAttempts > 1_000) throw new TypeError("maxMatchAttempts cannot exceed 1000");
  const resolveClientKey: ClientKeyResolver = options.clientKeyResolver ?? ((request) => request.socket.remoteAddress ?? "unknown");
  const safeClientKey = (request: IncomingMessage) => {
    const key = resolveClientKey(request);
    if (typeof key !== "string" || key.length < 1 || key.length > 256) throw new TypeError("clientKeyResolver returned an invalid key");
    return key;
  };
  const app = Fastify({
    logger: false,
    forceCloseConnections: true,
    bodyLimit: config.bodyLimit,
  });
  const rooms = options.rooms ?? new RoomService(options.now ? { now: options.now } : {});
  const designs = options.designs ?? new DesignRegistry({
    ...(options.now ? { now: options.now } : {}),
    maxGlobal: config.maxDesigns,
    maxPerOwner: config.maxDesignsPerSession,
    ttlMs: config.designTtlMs,
  });
  const battleEngine = options.battleEngine ?? (options.resultRepository
    ? new BattleEngine({ resultRepository: options.resultRepository })
    : undefined);
  if (!battleEngine) throw new TypeError("Production composition requires a durable resultRepository");
  const limiterOptions = {
    maxBuckets: config.rateLimitMaxBuckets, ttlMs: config.rateLimitBucketTtlMs,
    ...(options.now ? { now: options.now } : {}),
  };
  const designLimiter = new TokenBucketLimiter({
    burst: config.designRateBurst, refillPerSecond: config.designRateRefillPerSecond, ...limiterOptions,
  });
  const designClientLimiter = new TokenBucketLimiter({
    burst: config.designClientRateBurst, refillPerSecond: config.designClientRateRefillPerSecond, ...limiterOptions,
  });
  const gateway = new RealtimeGateway(app.server, {
    rooms,
    designs,
    battleEngine,
    launch: options.launch ?? new LaunchCoordinator(options.now ? { now: options.now } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.seedFactory ? { seedFactory: options.seedFactory } : {}),
    ...(options.createServerEventId ? { createServerEventId: options.createServerEventId } : {}),
    ...(options.createSessionId ? { createSessionId: options.createSessionId } : {}),
    ...(options.createSessionToken ? { createSessionToken: options.createSessionToken } : {}),
    ...(options.frameScheduler ? { frameScheduler: options.frameScheduler } : {}),
    ...(options.scoreMatch ? { scoreMatch: options.scoreMatch } : {}),
    allowedOrigins: options.allowedOrigins ?? [],
    allowMissingOrigin: options.allowMissingOrigin ?? process.env.NODE_ENV !== "production",
    maxHttpBufferSize: config.maxHttpBufferSize,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    rateLimitBurst: config.rateLimitBurst,
    rateLimitRefillPerSecond: config.rateLimitRefillPerSecond,
    pendingRateLimitBurst: config.pendingRateLimitBurst,
    pendingRateLimitRefillPerSecond: config.pendingRateLimitRefillPerSecond,
    rateLimitMaxBuckets: config.rateLimitMaxBuckets,
    rateLimitBucketTtlMs: config.rateLimitBucketTtlMs,
    maxConnections: config.maxConnections,
    maxConnectionsPerIp: config.maxConnectionsPerIp,
    maxRetainedSessions: config.maxRetainedSessions,
    newSessionBurstPerClient: config.newSessionBurstPerClient,
    newSessionRefillPerSecond: config.newSessionRefillPerSecond,
    newSessionGlobalBurst: config.newSessionGlobalBurst,
    newSessionGlobalRefillPerSecond: config.newSessionGlobalRefillPerSecond,
    clientKeyResolver: safeClientKey,
    maxRooms: config.maxRooms,
    maxOwnedRoomsPerSession: config.maxOwnedRoomsPerSession,
    maxMatchAttempts: config.maxMatchAttempts,
    terminalResultTtlMs: config.terminalResultTtlMs,
    maxTerminalResults: config.maxTerminalResults,
    lobbyDebounceMs: config.lobbyDebounceMs,
    maintenance: () => { designLimiter.pruneExpired(); designClientLimiter.pruneExpired(); },
    ...(options.logError ? { logError: options.logError } : {}),
  });
  app.decorate("realtimeGateway", gateway);
  app.decorate("battleEngine", battleEngine);

  app.get("/health", async () => ({ status: "ok" }));
  app.post("/api/designs", { onRequest: async (request, reply) => {
    const authorization = request.headers.authorization;
    const session = gateway.sessionForBearer(authorization);
    if (!session) return reply.code(401).send({ error: "UNAUTHORIZED" });
    let clientKey: string;
    try { clientKey = safeClientKey(request.raw); } catch { return reply.code(400).send({ error: "INVALID_CLIENT_KEY" }); }
    if (!designLimiter.consume(session.id) || !designClientLimiter.consume(clientKey)) {
      return reply.code(429).send({ error: "RATE_LIMITED" });
    }
    try { designs.assertCanRegister(session.id); } catch (error) {
      if (error instanceof DesignRegistryError) return reply.code(429).send({ error: error.code });
      throw error;
    }
  } }, async (request, reply) => {
    const session = gateway.sessionForBearer(request.headers.authorization)!;
    try {
      const stored = designs.register(session.id, request.body);
      return reply.code(201).send({
        designId: stored.designId,
        massG: stored.massG,
        performance: stored.performance,
      });
    } catch (error) {
      if (error instanceof DesignRegistryError) {
        return reply.code(error.code === "DESIGN_QUOTA_EXCEEDED" ? 429 : 422).send({ error: error.code });
      }
      throw error;
    }
  });

  const intervalMs = config.sweepIntervalMs;
  const timer = intervalMs > 0 ? setInterval(() => gateway.pump(), intervalMs) : undefined;
  timer?.unref();
  app.addHook("preClose", async () => {
    if (timer) clearInterval(timer);
    await gateway.close();
  });
  return app as unknown as BuiltApp;
}
