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
import { AdminAuthService, InMemoryAdminStore } from "../../apps/server/src/auth/admin-auth";
import { InMemoryDeletionStore } from "../../apps/server/src/admin/delete-records";
import type { AdminRecordsSource } from "../../apps/server/src/admin/records-routes";
import type { AnalyticsService } from "../../apps/server/src/analytics/service";
import { inMemoryExportDataSource, type ExportDataset } from "../../apps/server/src/exports/workbook";
import type { AdminAnalyticsSummary, AdminRecordRow } from "../../packages/protocol/src/events";
import { InMemoryAdminCommandStore } from "../../apps/server/src/admin/command-operations";

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
rooms.create({ id: "admin-e2e-owner", displayName: "1A 陳同學" }, "測試房");
rooms.create({ id: "admin-e2e-owner-2", displayName: "1B 李同學" }, "管理操作房");
const designs = new DesignRegistry({ now, ttlMs: 60_000 });
const webOrigin = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? "4173"}`;
const adminOrigin = `http://127.0.0.1:${process.env.E2E_ADMIN_PORT ?? "4175"}`;
const adminStore = new InMemoryAdminStore();
const adminAuth = new AdminAuthService(adminStore, { allowedOrigins: [webOrigin, adminOrigin], secureCookies: false });
const identityId = "550e8400-e29b-41d4-a716-446655440000";
const deletionStore = new InMemoryDeletionStore([{ identityId, className: "1A", occurredAt: new Date("2026-08-29T00:00:00Z"), designs: 2, matches: 3 }]);
const record: AdminRecordRow = { rowId:"m1:player1",matchId:"m1",slot:"player1",occurredAt:"2026-08-29T00:00:00.000Z",identityId,className:"1A",identity:"陳同學",deviceName:"iPad-01",design:{layers:["top","middle","bottom"].map((position,index)=>({position:position as "top"|"middle"|"bottom",shape:"circle",points:3,diameterMm:50-index,actualAreaMm2:1000,holeCount:2,rotationDeg:0,cornerRoundness:0})),totalMassG:25,metalDiscDiameterMm:20,centerOfMassOffsetMm:0,momentOfInertiaGmm2:5000},totalScore:2.5 };
const recordsSource: AdminRecordsSource = { async query(filters) { const rows = deletionStore.remainingIdentities && (!filters.className || filters.className === "1A") ? [record] : []; return { rows, total: rows.length, page: filters.page, pageSize: filters.pageSize }; }, async queryLeaderboard(filters) { const rows = deletionStore.remainingIdentities && (!filters.className || filters.className === "1A") ? [{ identityId, displayName: "陳同學", className: "1A", battleScore: 2, challengeScore: .5, totalScore: 2.5, matches: 1, rank: 1 }] : []; return { rows, total: rows.length, page: filters.page, pageSize: filters.pageSize }; } };
const performance = { dimension:"layerShape",value:{shape:"circle"},launchGrade:"Perfect",opponentStrengthBand:"low",performanceModelVersion:"1",physicsModelVersion:"2",totalGroups:1,sampleSize:12,participantObservations:12,averageScore:2.4,winRate:.6,opponentAverageStrength:50,expectedWinRate:.5,outcomeResidual:.1,gradeOccurrenceCount:12 } as const;
const analytics: AdminAnalyticsSummary = { filters:{from:"2026-08-01",to:"2026-08-29"},filterApplicability:{},usage:[],usagePeriods:{daily:[{date:"2026-08-29",activeDevices:5,designs:3,rooms:2,completedMatches:2,shapes:[]}],weekly:[],monthly:[]},parameterUsage:[{scope:"allEligibleDesigns",dimension:"layerShape",value:{position:"top",shape:"circle"},count:12,proportion:.6,performanceModelVersion:"1",totalGroups:1,truncated:false,population:20}],parameters:[],rankings:{top:[performance],bottom:[],total:1,hasMore:false,snapshotCursor:"cursor",overallLaunchDistribution:{Perfect:1,Great:2,Good:3,Miss:4,totalOccurrences:10}},refreshedAt:"2026-08-29T00:00:00.000Z" };
const analyticsService = { query: async () => analytics, parameterPage: async () => ({ rows: [], total: 0, hasMore: false }) } as unknown as AnalyticsService;
const exportDataset: ExportDataset = { matches:[],rounds:[],designs:[],identities:[],usage:[],parameters:[] };
const adminCommandStore=new InMemoryAdminCommandStore();
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
  allowedOrigins: [webOrigin],
  allowMissingOrigin: true,
  identityResolver: new IdentityResolver(new InMemoryIdentityStore(), { now: () => new Date(now()) }),
  adminAuth,
  analyticsService,
  exportDataSource: inMemoryExportDataSource(exportDataset),
  deletionStore,
  adminRecordsSource: recordsSource,
  adminCommandStore,
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
    adminAudits: adminStore.auditEntries.map(entry => entry.action),
    adminCommands:[...adminCommandStore.operations.values()].map(operation=>({operationId:operation.operationId,status:operation.status,attempts:operation.attempts})),
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
  await adminAuth.bootstrap(process.env.E2E_ADMIN_USERNAME ?? "admin", process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-only-password");
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
