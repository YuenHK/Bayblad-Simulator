import Fastify, { type FastifyInstance } from "fastify";
import type { BattleInputs, BattleResult, ResultRepository } from "./battle/engine";
import { BattleEngine } from "./battle/engine";
import { LaunchCoordinator } from "./battle/launch";
import { DesignRegistry, DesignRegistryError } from "./design-registry";
import { RoomService } from "./rooms/room-service";
import { RealtimeGateway, type FrameScheduler, type MatchScorer } from "./socket";

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
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  maxRooms?: number;
  maxOwnedRoomsPerSession?: number;
  maxDesigns?: number;
  maxDesignsPerSession?: number;
  designTtlMs?: number;
  maxMatchAttempts?: number;
  lobbyDebounceMs?: number;
  logError?: (error: unknown) => void;
  sweepIntervalMs?: number;
}>;

export type BuiltApp = FastifyInstance & Readonly<{
  realtimeGateway: RealtimeGateway;
  battleEngine: BattleEnginePort;
}>;

export function buildApp(options: BuildAppOptions): BuiltApp {
  if (process.env.NODE_ENV === "production" && !options.allowedOrigins?.length) {
    throw new TypeError("Production composition requires allowedOrigins");
  }
  const app = Fastify({
    logger: false,
    forceCloseConnections: true,
    bodyLimit: options.bodyLimit ?? 64 * 1_024,
  });
  const rooms = options.rooms ?? new RoomService(options.now ? { now: options.now } : {});
  const designs = options.designs ?? new DesignRegistry({
    ...(options.now ? { now: options.now } : {}),
    maxGlobal: options.maxDesigns ?? 2_000,
    maxPerOwner: options.maxDesignsPerSession ?? 20,
    ttlMs: options.designTtlMs ?? 24 * 60 * 60_000,
  });
  const battleEngine = options.battleEngine ?? (options.resultRepository
    ? new BattleEngine({ resultRepository: options.resultRepository })
    : undefined);
  if (!battleEngine) throw new TypeError("Production composition requires a durable resultRepository");
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
    maxHttpBufferSize: options.maxHttpBufferSize ?? 64 * 1_024,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
    rateLimitBurst: options.rateLimitBurst ?? 30,
    rateLimitRefillPerSecond: options.rateLimitRefillPerSecond ?? 10,
    maxConnections: options.maxConnections ?? 5_000,
    maxConnectionsPerIp: options.maxConnectionsPerIp ?? 500,
    maxRooms: options.maxRooms ?? 1_000,
    maxOwnedRoomsPerSession: options.maxOwnedRoomsPerSession ?? 3,
    maxMatchAttempts: options.maxMatchAttempts ?? 5,
    lobbyDebounceMs: options.lobbyDebounceMs ?? (process.env.NODE_ENV === "test" ? 0 : 50),
    ...(options.logError ? { logError: options.logError } : {}),
  });
  app.decorate("realtimeGateway", gateway);
  app.decorate("battleEngine", battleEngine);

  app.get("/health", async () => ({ status: "ok" }));
  app.post("/api/designs", async (request, reply) => {
    const authorization = request.headers.authorization;
    const session = gateway.sessionForBearer(authorization);
    if (!session) return reply.code(401).send({ error: "UNAUTHORIZED" });
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

  const intervalMs = options.sweepIntervalMs ?? 1_000;
  const timer = intervalMs > 0 ? setInterval(() => gateway.pump(), intervalMs) : undefined;
  timer?.unref();
  app.addHook("preClose", async () => {
    if (timer) clearInterval(timer);
    await gateway.close();
  });
  return app as unknown as BuiltApp;
}
