import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { designUploadResponseSchema } from "@steam-top/domain";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { randomBytes } from "node:crypto";
import type { BattleInputs, BattleResult, ResultRepository } from "./battle/engine";
import { BattleEngine } from "./battle/engine";
import { LaunchCoordinator } from "./battle/launch";
import { DesignRegistry, DesignRegistryError } from "./design-registry";
import { RoomService } from "./rooms/room-service";
import { RealtimeGateway, type FrameScheduler, type MatchScorer } from "./socket";
import { TokenBucketLimiter } from "./rate-limit";
import { COOKIE_NAME } from "./identity/cookie";
import { createValidatedLiveIdentityProvider, IdentityAdmissionError, IdentityCapacityError, IdentityResolver, IdentityStoreUnavailableError } from "./identity/resolver";
import { PostgresIdentityStore } from "./identity/postgres-store";
import type { IClassAdapter } from "./identity/iclass-adapter";
import type { WebClipTokenService } from "./identity/webclip-token";
import { authenticateAdminMutation, durableAudit, type AdminAuthService, registerAdminAuthRoutes } from "./auth/admin-auth";
import { PostgresAdminStore } from "./auth/postgres-admin-store";
import { DesignPersistenceError, PostgresDesignRepository, type DesignRepository } from "./records/design-repository";
import { PostgresMatchRepository, type MatchRepository } from "./records/match-repository";
import { PostgresBattleResultRepository } from "./records/battle-result-repository";
import { PostgresRoomRecordRepository, type RoomRecordRepository } from "./records/room-repository";
import { PostgresRoomProjectionStore, type RoomProjectionStore } from "./records/room-projection-store";
import type { AnalyticsService } from "./analytics/service";
import { registerAnalyticsRoutes } from "./analytics/routes";
import { registerExportRoutes, type ExportDataSource } from "./exports/workbook";
import { registerDeleteRecordRoutes, type DeletionStore } from "./admin/delete-records";

export type ClientKeyResolver = (request: IncomingMessage) => string;

export interface BattleEnginePort {
  readonly simulationCount: number;
  simulateOnceAsync(matchId: string, roundId: string, inputs: BattleInputs, options?: Readonly<{ signal?: AbortSignal }>): Promise<BattleResult>;
  cleanup(matchId: string, roundId: string): boolean;
  shutdown?(): Promise<void>;
}

export type BuildAppOptions = Readonly<{
  rooms?: RoomService;
  designs?: DesignRegistry;
  designRepository?: DesignRepository;
  matchRepository?: MatchRepository;
  roomRecordRepository?: RoomRecordRepository;
  roomProjectionStore?: RoomProjectionStore;
  requireAuthorityLease?: boolean;
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
  identityResolver?: IdentityResolver;
  identityIpResolver?: ClientKeyResolver;
  identityCreationBurst?: number;
  identityCreationRefillPerSecond?: number;
  identityGlobalCreationBurst?: number;
  identityGlobalCreationRefillPerSecond?: number;
  iClassAdapter?: IClassAdapter;
  webClipTokens?: WebClipTokenService;
  iClassStatus?: "api" | "csv" | "api-csv-fallback" | "disabled";
  testIdentityResolver?: (request: IncomingMessage, testAuth?: Record<string, unknown>) => Promise<Readonly<{ identityId: string; displayName: string }> | null>;
  testRecordIdentityActivity?: (request:IncomingMessage)=>Promise<void>;
  adminAuth?: AdminAuthService;
  adminClientKeyResolver?: ClientKeyResolver;
  adminClientAddressResolver?: ClientKeyResolver;
  adminMaintenanceIntervalMs?: number;
  persistenceRetryDelaysMs?: readonly number[];
  analyticsService?: AnalyticsService;
  exportDataSource?: ExportDataSource;
  deletionStore?: DeletionStore;
  analyticsRefreshIntervalMs?: number;
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
  if (options.requireAuthorityLease && (!options.roomRecordRepository?.acquireStartupLease || !options.roomRecordRepository.verifyStartupLease || !options.roomRecordRepository.releaseStartupLease)) throw new TypeError("Authority lease lifecycle is required");
  if (process.env.NODE_ENV === "production" && options.testIdentityResolver) throw new TypeError("testIdentityResolver is forbidden in production");
  if (process.env.NODE_ENV === "production" && options.testRecordIdentityActivity) throw new TypeError("testRecordIdentityActivity is forbidden in production");
  if (process.env.NODE_ENV === "production" && !options.allowedOrigins?.length) {
    throw new TypeError("Production composition requires allowedOrigins");
  }
  if (process.env.NODE_ENV === "production" && options.behindProxy && !options.clientKeyResolver) {
    throw new TypeError("Production behindProxy composition requires clientKeyResolver");
  }
  if (process.env.NODE_ENV === "production" && options.behindProxy && !options.identityIpResolver) throw new TypeError("Production behindProxy composition requires identityIpResolver");
  if (options.identityIpResolver && !options.behindProxy) throw new TypeError("identityIpResolver requires behindProxy trusted boundary");
  if ((options.adminClientKeyResolver || options.adminClientAddressResolver) && !options.behindProxy) throw new TypeError("admin client resolvers require behindProxy trusted boundary");
  if (process.env.NODE_ENV === "production" && options.behindProxy && (!options.adminClientKeyResolver || !options.adminClientAddressResolver)) throw new TypeError("Production behindProxy composition requires admin client resolvers");
  if (options.clientKeyResolver && !options.behindProxy) {
    throw new TypeError("clientKeyResolver requires behindProxy trusted boundary");
  }
  if (process.env.NODE_ENV === "production" && (!options.identityResolver || !options.identityResolver.isBackedBy(PostgresIdentityStore))) {
    throw new TypeError("Production composition requires a persistent identityResolver");
  }
  if (process.env.NODE_ENV === "production" && !options.iClassStatus) throw new TypeError("Production composition requires explicit iClassStatus");
  if (options.iClassStatus === "disabled" && (options.iClassAdapter || options.webClipTokens)) throw new TypeError("Disabled iClass composition cannot include adapters");
  if (options.iClassStatus && options.iClassStatus !== "disabled" && (!options.iClassAdapter || !options.webClipTokens)) throw new TypeError("Enabled iClass composition requires adapter and tokens");
  if (process.env.NODE_ENV === "production" && (!options.adminAuth || !(options.adminAuth.store instanceof PostgresAdminStore))) throw new TypeError("Production composition requires persistent admin authentication");
  if (process.env.NODE_ENV === "production" && !(options.designRepository instanceof PostgresDesignRepository)) throw new TypeError("Production composition requires a persistent designRepository");
  if (process.env.NODE_ENV === "production" && !(options.matchRepository instanceof PostgresMatchRepository)) throw new TypeError("Production composition requires a persistent matchRepository");
  if (process.env.NODE_ENV === "production" && !(options.resultRepository instanceof PostgresBattleResultRepository)) throw new TypeError("Production composition requires a persistent resultRepository");
  if (process.env.NODE_ENV === "production" && !(options.roomRecordRepository instanceof PostgresRoomRecordRepository)) throw new TypeError("Production composition requires a persistent roomRecordRepository");
  if (process.env.NODE_ENV === "production" && !(options.roomProjectionStore instanceof PostgresRoomProjectionStore)) throw new TypeError("Production composition requires a persistent roomProjectionStore");
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
    identityCreationBurst: requirePositive("identityCreationBurst", options.identityCreationBurst ?? 600),
    identityCreationRefillPerSecond: requirePositive("identityCreationRefillPerSecond", options.identityCreationRefillPerSecond ?? 0.01, false),
    identityGlobalCreationBurst: requirePositive("identityGlobalCreationBurst", options.identityGlobalCreationBurst ?? 5_000),
    identityGlobalCreationRefillPerSecond: requirePositive("identityGlobalCreationRefillPerSecond", options.identityGlobalCreationRefillPerSecond ?? 0.1, false),
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
  const diagnosticIp = (request: IncomingMessage): string | null => {
    const candidate = options.identityIpResolver?.(request) ?? request.socket.remoteAddress;
    if (!candidate) return null;
    let normalized = candidate.trim();
    if (normalized.startsWith("::ffff:") && isIP(normalized.slice(7)) === 4) normalized = normalized.slice(7);
    return isIP(normalized) ? normalized : null;
  };
  const app = Fastify({
    logger: process.env.NODE_ENV === "production",
    forceCloseConnections: true,
    bodyLimit: config.bodyLimit,
  });
  const reportBackgroundError = options.logError ?? ((error: unknown) => {
    const candidate = error as { name?: unknown; code?: unknown };
    app.log.error({ event: "background.operation_failed", errorName: typeof candidate?.name === "string" ? candidate.name.slice(0, 80) : "Error", errorCode: typeof candidate?.code === "string" ? candidate.code.slice(0, 80) : "UNCLASSIFIED" }, "Background operation failed");
  });
  void app.register(fastifyCookie);
  const adminResolver = (request: IncomingMessage) => ({ clientKey: options.adminClientKeyResolver?.(request) ?? request.socket.remoteAddress ?? "unknown", ...(options.adminClientAddressResolver ? { ip: options.adminClientAddressResolver(request) } : (request.socket.remoteAddress ? { ip: request.socket.remoteAddress } : {})) });
  if (options.adminAuth) registerAdminAuthRoutes(app, options.adminAuth, adminResolver);
  if (options.adminAuth && options.analyticsService) registerAnalyticsRoutes(app, options.adminAuth, options.analyticsService);
  if (options.adminAuth && options.exportDataSource) registerExportRoutes(app, options.adminAuth, options.exportDataSource);
  if (options.adminAuth && options.deletionStore) registerDeleteRecordRoutes(app, options.adminAuth, options.deletionStore, adminResolver);
  if (options.adminAuth && options.matchRepository) app.post("/api/admin/records/matches/:id/retry", async (request, reply) => {
    const current = await authenticateAdminMutation(request, reply, options.adminAuth!, adminResolver); if (!current) return;
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/iu.test(id)) return reply.code(400).send({ error: "INVALID_MATCH_ID" });
    try {
      await options.matchRepository!.retryFailedMatch(id, { manual: true });
      try { await durableAudit(options.adminAuth!.store, { adminUserId: current.user.id, adminSessionId: current.session.id, action: "match.persistence.retry", outcome: "success", details: { matchId: id } }); }
      catch (auditError) { options.adminAuth!.report("match.persistence.retry.audit_pending", auditError, request.id); }
      return reply.code(204).send();
    } catch (error) {
      options.adminAuth!.report("match.persistence.retry", error, request.id);
      try {
        await durableAudit(options.adminAuth!.store, { adminUserId: current.user.id, adminSessionId: current.session.id, action: "match.persistence.retry", outcome: "failure", details: { matchId: id, code: "MATCH_RETRY_FAILED" } });
      } catch (auditError) { options.adminAuth!.report("match.persistence.retry.audit", auditError, request.id); }
      return reply.code(409).send({ error: "MATCH_RETRY_FAILED" });
    }
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
  const identityCreationLimiter = new TokenBucketLimiter({ burst: config.identityCreationBurst, refillPerSecond: config.identityCreationRefillPerSecond, ...limiterOptions });
  const identityGlobalCreationLimiter = new TokenBucketLimiter({ burst: config.identityGlobalCreationBurst, refillPerSecond: config.identityGlobalCreationRefillPerSecond, ...limiterOptions, maxBuckets: 1 });
  const cookieFromRequest = (request: IncomingMessage): string | undefined => {
    const raw = request.headers.cookie;
    if (!raw) return undefined;
    for (const item of raw.split(";")) {
      const separator = item.indexOf("=");
      if (separator < 0 || item.slice(0, separator).trim() !== COOKIE_NAME) continue;
      try { return decodeURIComponent(item.slice(separator + 1).trim()); } catch { return undefined; }
    }
    return undefined;
  };
  const authenticateIdentity = options.identityResolver
      ? async (request: IncomingMessage) => {
        const cookie=cookieFromRequest(request); const identity = await options.identityResolver!.authenticate(cookie);
        if(identity) await options.identityResolver!.recordActivity(cookie);
        return identity ? { identityId: identity.id, displayName: identity.displayName, identitySource: identity.status, ...(identity.deviceName ? { deviceName: identity.deviceName } : {}) } : null;
      }
    : options.testIdentityResolver ?? (process.env.NODE_ENV === "test"
      ? async (_request: IncomingMessage, auth?: Record<string, unknown>) => {
          const displayName = typeof auth?.displayName === "string" ? auth.displayName : "";
          return displayName ? { identityId: `test:${displayName}`, displayName, identitySource: "guest" as const } : null;
        }
      : async () => null);
  const retryWorkers = new Map<string, Promise<void>>();
  let retryClaimPump: Promise<void> | undefined;
  let retryPumpClosing = false;
  const pumpRetryJobs = () => {
    if (!options.matchRepository || retryPumpClosing || retryClaimPump) return;
    const now = new Date();
    const pump = Promise.resolve(options.matchRepository.pruneRetention?.(now, 1_000)).then(() => options.matchRepository!.claimDueJobs(now, 25)).then((jobs) => {
      for (const job of jobs) {
        if (retryWorkers.has(job.matchId)) continue;
        const operation = options.matchRepository!.retryFailedMatch(job.matchId, { claimToken: job.claimToken, generation: job.generation }).then(() => undefined).catch(reportBackgroundError).finally(() => retryWorkers.delete(job.matchId));
        retryWorkers.set(job.matchId, operation);
      }
    }).catch(reportBackgroundError).finally(() => { if (retryClaimPump === pump) retryClaimPump = undefined; });
    retryClaimPump = pump;
  };
  const gateway = new RealtimeGateway(app.server, {
    rooms,
    designs,
    ...(options.designRepository ? { designRepository: options.designRepository } : {}),
    ...(options.matchRepository ? { matchRepository: options.matchRepository } : {}),
    ...(options.roomRecordRepository ? { roomRecordRepository: options.roomRecordRepository } : {}),
    ...(options.roomProjectionStore ? { roomProjectionStore: options.roomProjectionStore } : {}),
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
    diagnosticIpResolver: diagnosticIp,
    authenticateIdentity: options.testIdentityResolver ?? authenticateIdentity,
    ...(options.testRecordIdentityActivity?{recordIdentityActivity:options.testRecordIdentityActivity}:options.identityResolver?{recordIdentityActivity:async(request:IncomingMessage)=>{await options.identityResolver!.recordActivity(cookieFromRequest(request));}}:{}),
    maxRooms: config.maxRooms,
    maxOwnedRoomsPerSession: config.maxOwnedRoomsPerSession,
    maxMatchAttempts: config.maxMatchAttempts,
    terminalResultTtlMs: config.terminalResultTtlMs,
    maxTerminalResults: config.maxTerminalResults,
    lobbyDebounceMs: config.lobbyDebounceMs,
    ...(options.persistenceRetryDelaysMs ? { persistenceRetryDelaysMs: options.persistenceRetryDelaysMs } : {}),
    maintenance: () => { designLimiter.pruneExpired(); designClientLimiter.pruneExpired(); identityCreationLimiter.pruneExpired(); identityGlobalCreationLimiter.pruneExpired(); pumpRetryJobs(); },
    logError: reportBackgroundError,
  });
  app.decorate("realtimeGateway", gateway);
  app.decorate("battleEngine", battleEngine);

  let authorityHealthy = true;
  app.addHook("onRequest", async (request, reply) => { if (!authorityHealthy && request.url !== "/health") return reply.code(503).send({ error: "ROOM_AUTHORITY_UNHEALTHY" }); });
  app.get("/health", async (_request, reply) => { if (!authorityHealthy) reply.code(503); return { status: authorityHealthy ? "ok" : "unhealthy", identity: { iclass: options.iClassStatus ?? (options.iClassAdapter ? "api" : "disabled") } }; });
  if (options.identityResolver) {
    const identityResolver = options.identityResolver;
    const allowedIdentityOrigins = new Set(options.allowedOrigins ?? []);
    const allowIdentityRequest = (headers: Record<string, unknown>) => {
      if (headers["sec-fetch-site"] === "cross-site") return false;
      const origin = headers.origin;
      return typeof origin !== "string" || allowedIdentityOrigins.has(origin);
    };
    const identityIp = (request: IncomingMessage): string | undefined => {
      const candidate = options.identityIpResolver?.(request) ?? request.socket.remoteAddress;
      if (!candidate) return undefined;
      let normalized = candidate.trim();
      if (normalized.startsWith("::ffff:") && isIP(normalized.slice(7)) === 4) normalized = normalized.slice(7);
      return isIP(normalized) ? normalized : undefined;
    };
    const resolveIdentityRequest = async (request: { raw: IncomingMessage; cookies: Record<string, string | undefined>; headers: Record<string, string | string[] | undefined> }, live?: Parameters<IdentityResolver["resolve"]>[1]) => {
      const clientKey = safeClientKey(request.raw);
      const ip = identityIp(request.raw);
      return identityResolver.resolve({
        ...(request.cookies[COOKIE_NAME] ? { cookieToken: request.cookies[COOKIE_NAME] } : {}),
        ...(ip ? { ip } : {}),
        ...(typeof request.headers["user-agent"] === "string" ? { userAgent: request.headers["user-agent"] } : {}),
        admitCreation: () => identityCreationLimiter.consume(clientKey) && identityGlobalCreationLimiter.consume("global"),
      }, live);
    };
    const setIdentityCookie = (reply: FastifyReply, resolved: Awaited<ReturnType<typeof resolveIdentityRequest>>) => reply.setCookie(COOKIE_NAME, resolved.cookieToken, {
      path: "/", httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict",
      maxAge: Math.max(0, Math.floor((resolved.expiresAt.getTime() - resolved.issuedAt.getTime()) / 1_000)), expires: resolved.expiresAt,
    });
    app.get("/api/identity", async (request, reply) => {
      if (!allowIdentityRequest(request.headers)) return reply.code(403).send({ error: "IDENTITY_ORIGIN_REJECTED" });
      if (request.headers["content-length"] && request.headers["content-length"] !== "0") return reply.code(413).send({ error: "IDENTITY_BODY_FORBIDDEN" });
      let resolved;
      try {
        resolved = await resolveIdentityRequest(request);
      } catch (error) {
        if (error instanceof IdentityAdmissionError) return reply.code(429).send({ error: error.message });
        if (error instanceof IdentityCapacityError || error instanceof IdentityStoreUnavailableError) return reply.code(503).send({ error: error.message });
        throw error;
      }
      setIdentityCookie(reply, resolved);
      return { id: resolved.identity.id, status: resolved.identity.status, displayName: resolved.identity.displayName };
    });
    app.get("/start", async (request, reply) => {
      reply.header("Referrer-Policy", "no-referrer").header("Cache-Control", "no-store");
      const token = (request.query as { t?: unknown }).t;
      if (!allowIdentityRequest(request.headers) || (request.headers["content-length"] && request.headers["content-length"] !== "0")) return reply.redirect("/", 303);
      try {
        if (!options.webClipTokens || !options.iClassAdapter || typeof token !== "string") throw new Error("INVALID_DEVICE_TOKEN");
        const verified = await options.webClipTokens.inspect(token);
        const attemptName = "steam_top_webclip_attempt";
        const attempt = request.cookies[attemptName];
        if (!attempt) {
          const created = randomBytes(32).toString("base64url");
          reply.setCookie(attemptName, created, { path: "/start", httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: Math.max(1, Math.floor((verified.expiresAt.getTime() - Date.now()) / 1_000)), expires: verified.expiresAt });
          return reply.redirect(`/start?t=${encodeURIComponent(token)}`, 303);
        }
        const handle = options.webClipTokens.prepareExchange(verified, attempt);
        const preflight = await options.webClipTokens.preflightVerified(handle);
        if (preflight.status === "replay" || preflight.status === "missing") { reply.header("X-Identity-Bootstrap", "replay"); return reply.redirect("/", 303); }
        if (preflight.status === "recovered") {
          const recovered = await identityResolver.recoverLiveExchange(handle.cookieToken);
          if (!recovered || recovered.identity.id !== preflight.result.identityId || recovered.sessionId !== preflight.result.sessionId) throw new Error("WEBCLIP_RECOVERY_FAILED");
          setIdentityCookie(reply, recovered); reply.clearCookie(attemptName, { path: "/start", httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" }); return reply.redirect("/", 303);
        }
        let device;
        try { device = await options.iClassAdapter.resolveDevice(verified.deviceId); }
        catch { throw new Error("ICLASS_LOOKUP_RETRYABLE"); }
        if (!device) throw new Error("ICLASS_DEVICE_NOT_FOUND");
        const live = await createValidatedLiveIdentityProvider({ resolve: async () => ({ externalId: device.externalDeviceId, displayName: device.studentName, studentName: device.studentName, className: device.className, studentNumber: device.studentNumber, deviceName: device.deviceName }) }).resolve();
        if (!live) throw new Error("ICLASS_DEVICE_NOT_FOUND");
        let created: Awaited<ReturnType<IdentityResolver["resolveLiveWithToken"]>> | undefined;
        const requestIp = identityIp(request.raw);
        const exchanged = await options.webClipTokens.exchange(handle, async (transaction) => {
          created = await identityResolver.resolveLiveWithToken({ ...(request.cookies[COOKIE_NAME] ? { cookieToken: request.cookies[COOKIE_NAME] } : {}), ...(requestIp ? { ip: requestIp } : {}), ...(typeof request.headers["user-agent"] === "string" ? { userAgent: request.headers["user-agent"] } : {}) }, live, handle.cookieToken, transaction);
          return { identityId: created.identity.id, sessionId: created.sessionId, tokenHash: handle.tokenHash, committedAt: created.issuedAt };
        });
        if (exchanged.status !== "committed" && exchanged.status !== "recovered") { reply.header("X-Identity-Bootstrap", "replay"); return reply.redirect("/", 303); }
        const resolved = created ?? await identityResolver.recoverLiveExchange(handle.cookieToken);
        if (!resolved) throw new Error("WEBCLIP_RECOVERY_FAILED");
        setIdentityCookie(reply, resolved);
        reply.clearCookie(attemptName, { path: "/start", httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" });
        return reply.redirect("/", 303);
      } catch (error) {
        reply.header("X-Identity-Bootstrap", error instanceof Error && error.message === "ICLASS_LOOKUP_RETRYABLE" ? "retry" : "invalid");
        return reply.redirect("/", 303);
      }
    });
    app.post("/api/identity/logout", async (request, reply) => {
      if (!allowIdentityRequest(request.headers) || request.headers["x-steam-top-action"] !== "logout") return reply.code(403).send({ error: "IDENTITY_ACTION_REJECTED" });
      if (request.headers["content-length"] && request.headers["content-length"] !== "0") return reply.code(413).send({ error: "IDENTITY_BODY_FORBIDDEN" });
      try { await identityResolver.revoke(request.cookies[COOKIE_NAME]); }
      catch (error) { if (error instanceof IdentityStoreUnavailableError) return reply.code(503).send({ error: error.message }); throw error; }
      reply.clearCookie(COOKIE_NAME, { path: "/", httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" });
      return reply.code(204).send();
    });
  }
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
      const stored = options.designRepository
        ? designs.hydrate(session.id, await options.designRepository.saveBattleEligible(session.identityId, request.body))
        : designs.register(session.id, request.body);
      return reply.code(201).send(designUploadResponseSchema.parse({
        designId: stored.designId,
        massG: stored.massG,
        performance: stored.performance,
      }));
    } catch (error) {
      if (error instanceof DesignRegistryError) {
        return reply.code(error.code === "DESIGN_QUOTA_EXCEEDED" ? 429 : 422).send({ error: error.code });
      }
      if (error instanceof DesignPersistenceError) return reply.code(422).send({ error: error.code });
      throw error;
    }
  });

  const intervalMs = config.sweepIntervalMs;
  const timer = intervalMs > 0 ? setInterval(() => { void gateway.pump().catch(reportBackgroundError); }, intervalMs) : undefined;
  const nonceTimer = intervalMs > 0 && options.webClipTokens ? setInterval(() => { void options.webClipTokens!.pruneExpired().catch(() => undefined); }, Math.max(60_000, intervalMs)) : undefined;
  const adminMaintenanceIntervalMs = options.adminMaintenanceIntervalMs ?? 60_000;
  if (!Number.isFinite(adminMaintenanceIntervalMs) || adminMaintenanceIntervalMs < 1) throw new TypeError("adminMaintenanceIntervalMs must be a finite positive number");
  let adminMaintenance: Promise<void> | undefined;
  const runAdminMaintenance = () => {
    if (!options.adminAuth || adminMaintenance) return;
    adminMaintenance = Promise.all([options.adminAuth.pruneExpiredSessions(), options.adminAuth.store.pumpAuditOutbox?.() ?? Promise.resolve(0)])
      .then(() => undefined)
      .catch((error) => options.adminAuth!.report("admin.maintenance", error))
      .finally(() => { adminMaintenance = undefined; });
  };
  const adminMaintenanceTimer = options.adminAuth ? setInterval(runAdminMaintenance, adminMaintenanceIntervalMs) : undefined;
  const analyticsRefreshIntervalMs = options.analyticsRefreshIntervalMs ?? 24 * 60 * 60_000;
  if (!Number.isFinite(analyticsRefreshIntervalMs) || analyticsRefreshIntervalMs < 60_000) throw new TypeError("analyticsRefreshIntervalMs must be at least one minute");
  const analyticsRefreshTimer = options.analyticsService ? setInterval(() => { void options.analyticsService!.refreshDefaultWindow().catch(reportBackgroundError); }, analyticsRefreshIntervalMs) : undefined;
  timer?.unref();
  nonceTimer?.unref();
  adminMaintenanceTimer?.unref();
  analyticsRefreshTimer?.unref();
  if (options.webClipTokens) void options.webClipTokens.pruneExpired().catch(() => undefined);
  let leaseHealthTimer: ReturnType<typeof setInterval> | undefined;
  let supervisedShutdown: Promise<void> | undefined;
  app.addHook("onReady", async () => {
    // We intentionally fail closed rather than attempting to resume battles whose
    // in-memory timing/physics state cannot be reconstructed after a process exit.
    if (process.env.NODE_ENV === "production" || options.requireAuthorityLease) await options.roomRecordRepository?.acquireStartupLease?.();
    await options.roomRecordRepository?.reconcileOrphanedActiveRooms?.(new Date());
    if ((process.env.NODE_ENV === "production" || options.requireAuthorityLease) && options.roomRecordRepository?.verifyStartupLease) {
      leaseHealthTimer = setInterval(() => { void options.roomRecordRepository!.verifyStartupLease!().catch((error) => {
        if (!authorityHealthy) return;
        authorityHealthy = false; reportBackgroundError(error);
        supervisedShutdown ??= app.close(); void supervisedShutdown.catch(reportBackgroundError);
      }); }, 5_000);
      leaseHealthTimer.unref();
    }
  });
  app.addHook("preClose", async () => {
    authorityHealthy = false;
    retryPumpClosing = true;
    if (leaseHealthTimer) clearInterval(leaseHealthTimer);
    if (timer) clearInterval(timer);
    if (nonceTimer) clearInterval(nonceTimer);
    if (adminMaintenanceTimer) clearInterval(adminMaintenanceTimer);
    if (analyticsRefreshTimer) clearInterval(analyticsRefreshTimer);
    const failures: unknown[] = [];
    const stage = async (operations: readonly Promise<unknown>[]) => { const results = await Promise.allSettled(operations); for (const result of results) if (result.status === "rejected") failures.push(result.reason); };
    const drainRetryWorkers = async () => { await retryClaimPump; while (retryWorkers.size) await Promise.allSettled([...retryWorkers.values()]); };
    await stage([gateway.close()]);
    await stage([adminMaintenance ?? Promise.resolve(), drainRetryWorkers()]);
    await stage([battleEngine.shutdown?.() ?? Promise.resolve()]);
    if (gateway.definitivelyStopped) await stage([options.roomRecordRepository?.releaseStartupLease?.() ?? Promise.resolve()]);
    else failures.push(new Error("REALTIME_GATEWAY_STOP_UNCONFIRMED"));
    if (failures.length) throw new AggregateError(failures, "APP_PRECLOSE_FAILED");
  });
  return app as unknown as BuiltApp;
}
