import { buildApp, type BattleEnginePort } from "../../apps/server/src/app";
import type { BattleInputs, BattleResult } from "../../apps/server/src/battle/engine";

if (process.env.NODE_ENV !== "test") throw new Error("The realtime test server is test-only");

const port = Number(process.env.TEST_REALTIME_PORT ?? 4174);
const secret = process.env.TEST_CONTROL_SECRET ?? "steam-top-e2e-only";
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

const engine = new DeterministicBattleEngine();
const app = buildApp({
  battleEngine: engine,
  now,
  seedFactory: () => 42,
  frameScheduler: async (_delayMs, signal) => {
    if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    });
  },
  allowedOrigins: ["http://127.0.0.1:4173"],
  allowMissingOrigin: true,
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
  return {
    simulationCount: engine.simulationCount,
    ...app.realtimeGateway.debugCounts,
    heapUsed: process.memoryUsage().heapUsed,
    activeHandles: (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles().length,
  };
});

async function main(): Promise<void> {
  await app.listen({ host: "127.0.0.1", port });
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

void main();
