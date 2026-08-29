import { buildApp, type BattleEnginePort } from "../../apps/server/src/app";
import {
  BattleEngine,
  InMemoryCompletedRoundStore,
  PHYSICS_MODEL_VERSION,
  type BattleInputs,
  type BattleResult,
} from "../../apps/server/src/battle/engine";
import { DesignRegistry } from "../../apps/server/src/design-registry";
import { RoomService } from "../../apps/server/src/rooms/room-service";
import { IdentityResolver, InMemoryIdentityStore } from "../../apps/server/src/identity/resolver";

if (process.env.NODE_ENV !== "test") throw new Error("The realtime test server is test-only");

const port = Number(process.env.TEST_REALTIME_PORT ?? 4174);
const secret = process.env.TEST_CONTROL_SECRET ?? "steam-top-e2e-only";
const engineKind = process.env.BATTLE_ENGINE === "real" ? "real" : "deterministic";
let clockOffsetMs = 0;
const now = () => Date.now() + clockOffsetMs;

class DeterministicBattleEngine implements BattleEnginePort {
  simulationCount = 0;
  async simulateOnceAsync(_matchId: string, roundId: string, inputs: BattleInputs): Promise<BattleResult> {
    this.simulationCount += 1;
    const isThreeRoundFixture = inputs.player1.layers[0].diameterMm === 41;
    const winner = isThreeRoundFixture && roundId.startsWith("round-2-") ? "player2" : "player1";
    return {
      modelVersion: "2.0.0",
      seed: inputs.seed,
      ticks: 3,
      frames: [
        { tick: 1, player1: { x: -28, y: 0, angle: 0.1, angularSpeed: 30 }, player2: { x: 28, y: 0, angle: -0.1, angularSpeed: 27 } },
        { tick: 2, player1: { x: -8, y: 0, angle: 0.5, angularSpeed: 28 }, player2: { x: 8, y: 0, angle: -0.4, angularSpeed: 22 } },
        { tick: 3, player1: { x: winner === "player1" ? 4 : -75, y: 1, angle: 0.9, angularSpeed: winner === "player1" ? 25 : 0 }, player2: { x: winner === "player2" ? -4 : 75, y: 0, angle: -0.7, angularSpeed: winner === "player2" ? 25 : 0 } },
      ],
      outcome: { winner, reason: "out-of-bounds" },
      finalStats: {
        player1: { angularSpeed: 25, speedMps: 0.1, energyJ: 1, stoppedTicks: 0, impactRetentionProduct: 1 },
        player2: { angularSpeed: 0, speedMps: 0, energyJ: 0, stoppedTicks: 1, impactRetentionProduct: 0.8 },
        topTopContactCount: 1, topTopBeginContactEpisodes: 1, topTopImpactApplications: 1,
      },
    };
  }
  cleanup(): boolean { return true; }
}

type ObservedRound = Readonly<{ matchId: string; roundId: string; modelVersion: string; winner: string; frameCount: number; finalTick: number }>;
class ObservedEngine implements BattleEnginePort {
  readonly rounds: ObservedRound[] = [];
  constructor(readonly delegate: BattleEnginePort) {}
  get simulationCount(): number { return this.delegate.simulationCount; }
  async simulateOnceAsync(matchId: string, roundId: string, inputs: BattleInputs, options?: Readonly<{ signal?: AbortSignal }>): Promise<BattleResult> {
    const result = await this.delegate.simulateOnceAsync(matchId, roundId, inputs, options);
    this.rounds.push({ matchId, roundId, modelVersion: result.modelVersion, winner: result.outcome.winner, frameCount: result.frames.length, finalTick: result.frames.at(-1)?.tick ?? 0 });
    return result;
  }
  cleanup(matchId: string, roundId: string): boolean { return this.delegate.cleanup(matchId, roundId); }
}

const resultStore = new InMemoryCompletedRoundStore({ maxResults: 32, maxRecords: 64 });
const formalEngine = engineKind === "real" ? new BattleEngine({ resultRepository: resultStore, now, chunkTicks: 120, yieldBudgetMs: 8 }) : null;
const engine = new ObservedEngine(formalEngine ?? new DeterministicBattleEngine());
const rooms = new RoomService({ now });
const designs = new DesignRegistry({ now, ttlMs: 60_000 });
const app = buildApp({
  battleEngine: engine,
  rooms,
  designs,
  now,
  seedFactory: () => 42,
  frameScheduler: async (_delayMs, signal) => {
    if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(Object.assign(new Error("aborted"), { name: "AbortError" }));
      const timer = setTimeout(() => finish(), 200);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  },
  allowedOrigins: ["http://127.0.0.1:4173"],
  allowMissingOrigin: true,
  identityResolver: new IdentityResolver(new InMemoryIdentityStore(), { now: () => new Date(now()) }),
  sweepIntervalMs: 25,
});

function authorize(value: string | string[] | undefined): boolean {
  return value === secret;
}

app.post("/__test/advance", async (request, reply) => {
  if (!authorize(request.headers["x-test-secret"])) return reply.code(404).send();
  const body = request.body as { ms?: unknown };
  if (!Number.isSafeInteger(body?.ms) || Number(body.ms) < 0) return reply.code(400).send({ error: "invalid ms" });
  clockOffsetMs += Number(body.ms);
  const nowMs = now();
  app.realtimeGateway.pump(nowMs);
  return { nowMs };
});

app.get("/__test/stats", async (request, reply) => {
  if (!authorize(request.headers["x-test-secret"])) return reply.code(404).send();
  app.realtimeGateway.flushLobby();
  const query = request.query as { gc?: string };
  const heapSamples: number[] = [];
  if (query.gc === "1" && globalThis.gc) {
    for (let index = 0; index < 3; index += 1) {
      globalThis.gc();
      heapSamples.push(process.memoryUsage().heapUsed);
    }
  } else heapSamples.push(process.memoryUsage().heapUsed);
  const sortedHeap = [...heapSamples].sort((left, right) => left - right);
  return {
    nowMs: now(),
    engineKind,
    physicsModelVersion: PHYSICS_MODEL_VERSION,
    simulationCount: engine.simulationCount,
    observedRounds: engine.rounds,
    rooms: rooms.lobbySnapshot().rooms.length,
    designs: designs.debugCounts(),
    repository: { records: resultStore.recordCount, fullResults: resultStore.fullResultCount },
    engine: formalEngine ? { cache: formalEngine.cacheSize, running: formalEngine.runningCount, queued: formalEngine.queuedCount } : { cache: 0, running: 0, queued: 0 },
    ...app.realtimeGateway.debugCounts,
    timers: app.realtimeGateway.activeMatchCount,
    heapUsed: sortedHeap[Math.floor(sortedHeap.length / 2)],
    heapSamples,
    activeHandles: (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles().length,
  };
});

app.post("/__test/shutdown", async (request, reply) => {
  if (!authorize(request.headers["x-test-secret"])) return reply.code(404).send();
  setImmediate(() => void shutdown());
  return { shuttingDown: true };
});

async function main(): Promise<void> {
  await app.listen({ host: "127.0.0.1", port });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  console.info(JSON.stringify({ type: "ready", url: `http://127.0.0.1:${address.port}`, engineKind }));
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
void main();
