import Fastify, { type FastifyInstance } from "fastify";
import type { BattleInputs, BattleResult, ResultRepository } from "./battle/engine";
import { BattleEngine } from "./battle/engine";
import { LaunchCoordinator } from "./battle/launch";
import { DesignRegistry, DesignRegistryError } from "./design-registry";
import { RoomService } from "./rooms/room-service";
import { RealtimeGateway } from "./socket";

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
  sweepIntervalMs?: number;
}>;

export type BuiltApp = FastifyInstance & Readonly<{
  realtimeGateway: RealtimeGateway;
  battleEngine: BattleEnginePort;
}>;

export function buildApp(options: BuildAppOptions): BuiltApp {
  const app = Fastify({ logger: false });
  const rooms = options.rooms ?? new RoomService(options.now ? { now: options.now } : {});
  const designs = options.designs ?? new DesignRegistry();
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
        return reply.code(422).send({ error: error.code });
      }
      throw error;
    }
  });

  const intervalMs = options.sweepIntervalMs ?? 1_000;
  const timer = intervalMs > 0 ? setInterval(() => gateway.pump(), intervalMs) : undefined;
  timer?.unref();
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await gateway.close();
  });
  return app as unknown as BuiltApp;
}
