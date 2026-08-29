import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { designUploadResponseSchema } from "@steam-top/domain";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
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
  if (process.env.NODE_ENV === "production" && options.testIdentityResolver) throw new TypeError("testIdentityResolver is forbidden in production");
  if (process.env.NODE_ENV === "production" && !options.allowedOrigins?.length) {
    throw new TypeError("Production composition requires allowedOrigins");
  }
  if (process.env.NODE_ENV === "production" && options.behindProxy && !options.clientKeyResolver) {
    throw new TypeError("Production behindProxy composition requires clientKeyResolver");
  }
  if (process.env.NODE_ENV === "production" && options.behindProxy && !options.identityIpResolver) throw new TypeError("Production behindProxy composition requires identityIpResolver");
  if (options.identityIpResolver && !options.behindProxy) throw new TypeError("identityIpResolver requires behindProxy trusted boundary");
  if (options.clientKeyResolver && !options.behindProxy) {
    throw new TypeError("clientKeyResolver requires behindProxy trusted boundary");
  }
  if (process.env.NODE_ENV === "production" && (!options.identityResolver || !options.identityResolver.isBackedBy(PostgresIdentityStore))) {
    throw new TypeError("Production composition requires a persistent identityResolver");
  }
  if (process.env.NODE_ENV === "production" && !options.iClassStatus) throw new TypeError("Production composition requires explicit iClassStatus");
  if (options.iClassStatus === "disabled" && (options.iClassAdapter || options.webClipTokens)) throw new TypeError("Disabled iClass composition cannot include adapters");
  if (options.iClassStatus && options.iClassStatus !== "disabled" && (!options.iClassAdapter || !options.webClipTokens)) throw new TypeError("Enabled iClass composition requires adapter and tokens");
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
  const app = Fastify({
    logger: false,
    forceCloseConnections: true,
    bodyLimit: config.bodyLimit,
  });
  void app.register(fastifyCookie);
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
        const identity = await options.identityResolver!.authenticate(cookieFromRequest(request));
        return identity ? { identityId: identity.id, displayName: identity.displayName } : null;
      }
    : options.testIdentityResolver ?? (process.env.NODE_ENV === "test"
      ? async (_request: IncomingMessage, auth?: Record<string, unknown>) => {
          const displayName = typeof auth?.displayName === "string" ? auth.displayName : "";
          return displayName ? { identityId: `test:${displayName}`, displayName } : null;
        }
      : async () => null);
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
    authenticateIdentity: options.testIdentityResolver ?? authenticateIdentity,
    maxRooms: config.maxRooms,
    maxOwnedRoomsPerSession: config.maxOwnedRoomsPerSession,
    maxMatchAttempts: config.maxMatchAttempts,
    terminalResultTtlMs: config.terminalResultTtlMs,
    maxTerminalResults: config.maxTerminalResults,
    lobbyDebounceMs: config.lobbyDebounceMs,
    maintenance: () => { designLimiter.pruneExpired(); designClientLimiter.pruneExpired(); identityCreationLimiter.pruneExpired(); identityGlobalCreationLimiter.pruneExpired(); },
    ...(options.logError ? { logError: options.logError } : {}),
  });
  app.decorate("realtimeGateway", gateway);
  app.decorate("battleEngine", battleEngine);

  app.get("/health", async () => ({ status: "ok", identity: { iclass: options.iClassStatus ?? (options.iClassAdapter ? "api" : "disabled") } }));
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
      let resolved;
      if (!allowIdentityRequest(request.headers) || (request.headers["content-length"] && request.headers["content-length"] !== "0")) return reply.redirect("/", 303);
      try {
        if (!options.webClipTokens || !options.iClassAdapter || typeof token !== "string") throw new Error("INVALID_DEVICE_TOKEN");
        const verified = await options.webClipTokens.inspect(token);
        let device;
        try { device = await options.iClassAdapter.resolveDevice(verified.deviceId); }
        catch { throw new Error("ICLASS_LOOKUP_RETRYABLE"); }
        if (!device) { await options.webClipTokens.consumeVerified(verified); throw new Error("ICLASS_DEVICE_NOT_FOUND"); }
        await options.webClipTokens.consumeVerified(verified);
        const live = await createValidatedLiveIdentityProvider({ resolve: async () => ({ externalId: device.externalDeviceId, displayName: device.studentName, studentName: device.studentName, className: device.className, studentNumber: device.studentNumber, deviceName: device.deviceName }) }).resolve();
        resolved = await resolveIdentityRequest(request, live ?? undefined);
      } catch {
        try { resolved = await resolveIdentityRequest(request); } catch { /* identity API can retry later */ }
      }
      if (resolved) setIdentityCookie(reply, resolved);
      return reply.redirect("/", 303);
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
      const stored = designs.register(session.id, request.body);
      return reply.code(201).send(designUploadResponseSchema.parse({
        designId: stored.designId,
        massG: stored.massG,
        performance: stored.performance,
      }));
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
