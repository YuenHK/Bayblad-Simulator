import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { ADMIN_ABSOLUTE_MS, ADMIN_COOKIE_NAME, ADMIN_IDLE_MS, constantTokenEqual, csrfForSession, opaqueToken, tokenHash } from "./admin-session";
import { AdminLoginLimiter } from "./rate-limit";

export type AdminUser = Readonly<{ id: string; username: string; passwordHash: string; active: boolean }>;
export type AdminSession = Readonly<{ id: string; adminUserId: string; tokenHash: string; csrfTokenHash: string; createdAt: Date; lastSeenAt: Date; absoluteExpiresAt: Date; revokedAt?: Date; archivedAt?: Date; lastIp?: string; userAgent?: string }>;
export type AuditInput = Readonly<{ adminUserId?: string; adminSessionId?: string; action: string; outcome: "success" | "failure" | "denied"; ip?: string; userAgent?: string; details?: Readonly<Record<string, unknown>> }>;
export interface AdminStore {
  findUser(username: string): Promise<AdminUser | null>;
  createUserIfAbsent(input: Readonly<{ username: string; passwordHash: string }>): Promise<AdminUser>;
  createSession(input: Omit<AdminSession, "id">): Promise<AdminSession>;
  findSession(hash: string): Promise<Readonly<{ session: AdminSession; user: AdminUser }> | null>;
  touchSession(hash: string, now: Date): Promise<Readonly<{ session: AdminSession; user: AdminUser }> | null>;
  revokeSession(hash: string, now: Date): Promise<boolean>;
  audit(input: AuditInput): Promise<void>;
  reserveLoginAttempt(keys: Readonly<{ accountHash: string; clientHash: string }>, now: Date): Promise<boolean>;
  resetLoginFailures(keys: Readonly<{ accountHash: string; clientHash: string }>, now: Date): Promise<void>;
  setUserActive(adminUserId: string, active: boolean, now: Date): Promise<void>;
  pruneExpiredSessions(now: Date, limit: number): Promise<number>;
  createReauthGrant(input: Readonly<{ tokenHash: string; adminUserId: string; adminSessionId: string; purpose: string; expiresAt: Date }>): Promise<void>;
  consumeReauthGrant(input: Readonly<{ tokenHash: string; adminUserId: string; adminSessionId: string; purpose: string; now: Date }>): Promise<boolean>;
}

export class InMemoryAdminStore implements AdminStore {
  readonly #users = new Map<string, AdminUser>(); readonly #sessions = new Map<string, AdminSession>(); readonly auditEntries: AuditInput[] = [];
  readonly #grants = new Map<string, { adminUserId: string; adminSessionId: string; purpose: string; expiresAt: Date; consumed: boolean }>(); readonly #loginLimits = new AdminLoginLimiter();
  get sessionCount() { return this.#sessions.size; }
  async findUser(username: string) { return this.#users.get(username.toLocaleLowerCase("en-US")) ?? null; }
  async createUserIfAbsent(input: { username: string; passwordHash: string }) { const key = input.username.toLocaleLowerCase("en-US"); const prior = this.#users.get(key); if (prior) return prior; const user = { id: crypto.randomUUID(), username: input.username, passwordHash: input.passwordHash, active: true } as const; this.#users.set(key, user); return user; }
  async createSession(input: Omit<AdminSession, "id">) { if (this.#sessions.has(input.tokenHash)) throw new Error("ADMIN_SESSION_TOKEN_CONFLICT"); const row = { ...input, id: crypto.randomUUID() }; this.#sessions.set(row.tokenHash, row); return row; }
  async findSession(value: string) { const session = this.#sessions.get(value); if (!session || session.archivedAt) return null; const user = [...this.#users.values()].find((candidate) => candidate.id === session.adminUserId && candidate.active); return user ? { session, user } : null; }
  async touchSession(value: string, now: Date) { const found = await this.findSession(value); if (!found || found.session.revokedAt || now.getTime() >= found.session.absoluteExpiresAt.getTime() || now.getTime() - found.session.lastSeenAt.getTime() >= ADMIN_IDLE_MS) return null; const session = { ...found.session, lastSeenAt: now }; this.#sessions.set(value, session); return { session, user: found.user }; }
  async revokeSession(value: string, now: Date) { const prior = this.#sessions.get(value); if (!prior || prior.revokedAt) return false; this.#sessions.set(value, { ...prior, revokedAt: now, archivedAt: now }); return true; }
  async audit(input: AuditInput) { this.auditEntries.push(structuredClone(input)); }
  async reserveLoginAttempt(keys: { accountHash: string; clientHash: string }, now: Date) { return this.#loginLimits.reserve(keys.accountHash, keys.clientHash, now.getTime()); }
  async resetLoginFailures(keys: { accountHash: string; clientHash: string }) { this.#loginLimits.success(keys.accountHash, keys.clientHash); }
  async setUserActive(adminUserId: string, active: boolean, now: Date) { for (const [key, user] of this.#users) if (user.id === adminUserId) this.#users.set(key, { ...user, active }); if (!active) for (const [key, session] of this.#sessions) if (session.adminUserId === adminUserId && !session.revokedAt) this.#sessions.set(key, { ...session, revokedAt: now, archivedAt: now }); }
  async pruneExpiredSessions(now: Date, limit: number) { let count = 0; for (const [key, row] of this.#sessions) { if (count >= limit) break; if (!row.archivedAt && (now.getTime() >= row.absoluteExpiresAt.getTime() || now.getTime() - row.lastSeenAt.getTime() >= ADMIN_IDLE_MS)) { this.#sessions.set(key, { ...row, revokedAt: now, archivedAt: now }); count++; } } return count; }
  async createReauthGrant(input: { tokenHash: string; adminUserId: string; adminSessionId: string; purpose: string; expiresAt: Date }) { this.#grants.set(input.tokenHash, { ...input, consumed: false }); }
  async consumeReauthGrant(input: { tokenHash: string; adminUserId: string; adminSessionId: string; purpose: string; now: Date }) { const row = this.#grants.get(input.tokenHash); const active = [...this.#users.values()].some((user) => user.id === input.adminUserId && user.active); if (!active || !row || row.consumed || input.now.getTime() >= row.expiresAt.getTime() || row.adminUserId !== input.adminUserId || row.adminSessionId !== input.adminSessionId || row.purpose !== input.purpose) return false; row.consumed = true; return true; }
}

const ARGON = Object.freeze({ algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });
const loginSchema = z.object({ username: z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]+$/u), password: z.string().min(8).max(1024).regex(/^[^\p{Cc}]+$/u) }).strict();
export class AdminStoreUnavailableError extends Error { constructor() { super("ADMIN_STORE_UNAVAILABLE"); } }
export class AdminAuthBusyError extends Error { constructor() { super("ADMIN_AUTH_BUSY"); } }
export type AdminAuthLogEvent = Readonly<{ operation: string; errorClass: string; requestId?: string }>;

export class AdminAuthService {
  readonly #limiter = new AdminLoginLimiter(); readonly #now: () => Date; readonly #origins: Set<string>; readonly #hosts: Set<string>; readonly #secure: boolean; readonly #tokens: () => string; readonly #csrfSecret: Buffer; readonly #csrfKeyId: string;
  readonly #dummyHash: Promise<string>;
  readonly #logError: (event: AdminAuthLogEvent) => void;
  #argonActive = 0; readonly #argonWaiters: Array<() => void> = [];
  constructor(readonly store: AdminStore, options: Readonly<{ now?: () => Date; allowedOrigins: readonly string[]; secureCookies?: boolean; tokenFactory?: () => string; csrfSecret?: Buffer; csrfKeyId?: string; logError?: (event: AdminAuthLogEvent) => void }>) {
    if (process.env.NODE_ENV === "production" && !options.csrfSecret) throw new TypeError("Production admin authentication requires csrfSecret");
    if (options.csrfSecret && options.csrfSecret.length < 32) throw new TypeError("csrfSecret must contain at least 32 bytes");
    this.#now = options.now ?? (() => new Date()); this.#origins = new Set(options.allowedOrigins); this.#hosts = new Set(options.allowedOrigins.map((value) => new URL(value).host)); this.#secure = options.secureCookies ?? process.env.NODE_ENV === "production"; this.#tokens = options.tokenFactory ?? opaqueToken; this.#csrfSecret = options.csrfSecret ?? randomBytes(32); this.#csrfKeyId = options.csrfKeyId ?? "dev"; if (!/^[A-Za-z0-9_-]{1,32}$/u.test(this.#csrfKeyId)) throw new TypeError("INVALID_CSRF_KEY_ID");
    this.#logError = options.logError ?? (() => undefined); this.#dummyHash = this.#withArgon(() => hash(randomBytes(32), ARGON));
  }
  get secureCookies() { return this.#secure; }
  report(operation: string, error: unknown, requestId?: string): void { this.#logError({ operation, errorClass: error instanceof Error ? error.constructor.name : "UnknownError", ...(requestId ? { requestId } : {}) }); }
  async #withArgon<T>(operation: () => Promise<T>): Promise<T> { if (this.#argonActive >= 4) { if (this.#argonWaiters.length >= 32) throw new AdminAuthBusyError(); await new Promise<void>((resolve, reject) => { const waiter = () => { clearTimeout(timer); resolve(); }; const timer = setTimeout(() => { const index = this.#argonWaiters.indexOf(waiter); if (index >= 0) this.#argonWaiters.splice(index, 1); reject(new AdminAuthBusyError()); }, 2_000); timer.unref(); this.#argonWaiters.push(waiter); }); } this.#argonActive++; try { return await operation(); } finally { this.#argonActive--; this.#argonWaiters.shift()?.(); } }
  allowsRead(request: FastifyRequest): boolean { const site = request.headers["sec-fetch-site"]; if (site === "cross-site" || (site && !["same-origin", "same-site", "none"].includes(site))) return false; if (!this.#hosts.has(request.headers.host ?? "")) return false; const origin = request.headers.origin; return origin === undefined || (typeof origin === "string" && this.#origins.has(origin)); }
  allowsMutation(request: FastifyRequest): boolean { const origin = request.headers.origin; return request.headers["sec-fetch-site"] === "same-origin" && typeof origin === "string" && this.#origins.has(origin) && new URL(origin).host === request.headers.host; }
  async bootstrap(username: string, password: string) { const parsed = loginSchema.parse({ username, password }); const existing = await this.store.findUser(parsed.username); if (existing) return existing; return this.store.createUserIfAbsent({ username: parsed.username, passwordHash: await this.#withArgon(() => hash(parsed.password, ARGON)) }); }
  async verifyPassword(username: string, password: string): Promise<boolean> { const user = await this.store.findUser(username.trim()); const target = user?.passwordHash ?? await this.#dummyHash; let valid = false; try { valid = await this.#withArgon(() => verify(target, password)); } catch (error) { this.report("argon.verify", error); if (error instanceof AdminAuthBusyError) throw error; valid = false; } return Boolean(user?.active && valid); }
  async login(username: string, password: string, diagnostics: { clientKey: string; ip?: string; userAgent?: string }) {
    const now = this.#now(); const account = username.trim().toLocaleLowerCase("en-US");
    const accountHash = tokenHash(account); const clientHash = tokenHash(diagnostics.clientKey);
    const auditDiagnostics = { ...(diagnostics.ip ? { ip: diagnostics.ip } : {}), ...(diagnostics.userAgent ? { userAgent: diagnostics.userAgent } : {}) };
    if (!await this.store.reserveLoginAttempt({ accountHash, clientHash }, now)) { await this.store.audit({ action: "admin.login.locked", outcome: "denied", ...auditDiagnostics, details: { accountHash, clientHash } }); return { status: "locked" as const }; }
    const user = await this.store.findUser(username.trim()); const valid = await this.verifyPassword(username, password);
    if (!user || !valid) { await this.store.audit({ ...(user ? { adminUserId: user.id } : {}), action: "admin.login", outcome: "failure", ...auditDiagnostics, details: { accountHash, clientHash, ...(!user ? { unknownAccount: true } : {}) } }); return { status: "invalid" as const }; }
    await this.store.resetLoginFailures({ accountHash, clientHash }, now); const raw = this.#tokens(); if (Buffer.from(raw, "base64url").length < 32) throw new Error("ADMIN_TOKEN_FACTORY_TOO_SHORT"); const csrf = csrfForSession(this.#csrfSecret, raw, this.#csrfKeyId);
    const session = await this.store.createSession({ adminUserId: user.id, tokenHash: tokenHash(raw), csrfTokenHash: tokenHash(csrf), createdAt: now, lastSeenAt: now, absoluteExpiresAt: new Date(now.getTime() + ADMIN_ABSOLUTE_MS), ...(diagnostics.ip ? { lastIp: diagnostics.ip } : {}), ...(diagnostics.userAgent ? { userAgent: diagnostics.userAgent.slice(0, 512) } : {}) });
    await this.store.audit({ adminUserId: user.id, adminSessionId: session.id, action: "admin.login", outcome: "success", ...auditDiagnostics, details: { accountHash, clientHash } }); return { status: "ok" as const, token: raw, session, user };
  }
  async authenticate(raw: string | undefined, touch = true) { if (!raw) return null; const hashed = tokenHash(raw); const now = this.#now(); const existing = await this.store.findSession(hashed); if (!existing || existing.session.revokedAt) return null; if (now.getTime() >= existing.session.absoluteExpiresAt.getTime() || now.getTime() - existing.session.lastSeenAt.getTime() >= ADMIN_IDLE_MS) { await this.store.revokeSession(hashed, now); await this.store.audit({ adminUserId: existing.user.id, adminSessionId: existing.session.id, action: "admin.session.expired", outcome: "denied" }); return null; } const found = touch ? await this.store.touchSession(hashed, now) : existing; if (!found) return null; return { ...found, csrfToken: csrfForSession(this.#csrfSecret, raw, this.#csrfKeyId) }; }
  csrfMatches(raw: string, supplied: string | undefined, session: AdminSession): boolean { if (!supplied) return false; const expected = csrfForSession(this.#csrfSecret, raw, this.#csrfKeyId); return constantTokenEqual(expected, supplied) && constantTokenEqual(tokenHash(supplied), session.csrfTokenHash); }
  async reauthenticate(rawSession: string, csrf: string, password: string, purpose: string, diagnostics: { clientKey: string; ip?: string; userAgent?: string }) { const current = await this.authenticate(rawSession, false); if (!current || !this.csrfMatches(rawSession, csrf, current.session)) return null; const account = `reauth:${current.user.id}`; const now = this.#now(); const common = { adminUserId: current.user.id, adminSessionId: current.session.id, action: "admin.reauthenticate", ...(diagnostics.ip ? { ip: diagnostics.ip } : {}), ...(diagnostics.userAgent ? { userAgent: diagnostics.userAgent } : {}) }; if (this.#limiter.isLocked(account, diagnostics.clientKey, now.getTime())) { await this.store.audit({ ...common, outcome: "denied" }); return null; } let valid = false; try { valid = await this.#withArgon(() => verify(current.user.passwordHash, password)); } catch { valid = false; } if (!valid) { this.#limiter.fail(account, diagnostics.clientKey, now.getTime()); await this.store.audit({ ...common, outcome: "failure" }); return null; } this.#limiter.success(account, diagnostics.clientKey); const grant = this.#tokens(); await this.store.createReauthGrant({ tokenHash: tokenHash(grant), adminUserId: current.user.id, adminSessionId: current.session.id, purpose, expiresAt: new Date(now.getTime() + 5 * 60_000) }); await this.store.audit({ ...common, outcome: "success", details: { purpose } }); return grant; }
  async consumeReauthGrant(rawSession: string, rawGrant: string, purpose: string) { const current = await this.authenticate(rawSession, false); if (!current) return false; return this.store.consumeReauthGrant({ tokenHash: tokenHash(rawGrant), adminUserId: current.user.id, adminSessionId: current.session.id, purpose, now: this.#now() }); }
  async pruneExpiredSessions(limit = 500) { return this.store.pruneExpiredSessions(this.#now(), limit); }
}

export type AdminClientResolver = (request: IncomingMessage) => Readonly<{ clientKey: string; ip?: string }>;
const directClient: AdminClientResolver = (request) => { const value = request.socket.remoteAddress ?? "unknown"; return { clientKey: value, ...(isIP(value) ? { ip: value } : {}) }; };
function diagnostics(request: FastifyRequest, resolver: AdminClientResolver) { const value = resolver(request.raw); if (!value.clientKey || value.clientKey.length > 256 || (value.ip && !isIP(value.ip))) throw new TypeError("INVALID_ADMIN_CLIENT"); return { ...value, ...(typeof request.headers["user-agent"] === "string" ? { userAgent: request.headers["user-agent"].slice(0, 512) } : {}) }; }
function setCookie(reply: FastifyReply, auth: AdminAuthService, value: string, expires: Date) { reply.setCookie(ADMIN_COOKIE_NAME, value, { path: "/api/admin", httpOnly: true, secure: auth.secureCookies, sameSite: "strict", maxAge: ADMIN_ABSOLUTE_MS / 1000, expires }); }
export async function authenticateAdminRead(request: FastifyRequest, reply: FastifyReply, auth: AdminAuthService) {
  if (!auth.allowsRead(request)) { reply.code(403).send({ error: "FORBIDDEN" }); return null; }
  try { const current = await auth.authenticate(request.cookies[ADMIN_COOKIE_NAME]); if (!current) reply.code(401).send({ error: "UNAUTHORIZED" }); return current; } catch (error) { auth.report("admin.read", error, request.id); reply.code(503).send({ error: "ADMIN_STORE_UNAVAILABLE" }); return null; }
}
export async function authenticateAdminMutation(request: FastifyRequest, reply: FastifyReply, auth: AdminAuthService, resolver: AdminClientResolver = directClient) {
  if (!auth.allowsMutation(request)) { reply.code(403).send({ error: "FORBIDDEN" }); return null; }
  try {
    const raw = request.cookies[ADMIN_COOKIE_NAME]; const current = await auth.authenticate(raw, false);
    if (!current) { reply.code(401).send({ error: "UNAUTHORIZED" }); return null; }
    const supplied = typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : undefined;
    if (!raw || !auth.csrfMatches(raw, supplied, current.session)) { await auth.store.audit({ adminUserId: current.user.id, adminSessionId: current.session.id, action: "admin.csrf", outcome: "denied", ...diagnostics(request, resolver) }); reply.code(403).send({ error: "CSRF_REJECTED" }); return null; }
    const touched = await auth.authenticate(raw, true); if (!touched) { reply.code(401).send({ error: "UNAUTHORIZED" }); return null; } return touched;
  } catch (error) { auth.report("admin.mutation", error, request.id); reply.code(503).send({ error: "ADMIN_STORE_UNAVAILABLE" }); return null; }
}
export function registerAdminAuthRoutes(app: FastifyInstance, auth: AdminAuthService, clientResolver: AdminClientResolver = directClient): void {
  app.post("/api/admin/login", { preValidation: async (request, reply) => { if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) return reply.code(415).send({ error: "UNSUPPORTED_MEDIA_TYPE" }); }, schema: { body: { type: "object", additionalProperties: false, required: ["username", "password"], properties: { username: { type: "string", minLength: 1, maxLength: 80 }, password: { type: "string", minLength: 8, maxLength: 1024 } } } } }, async (request, reply) => {
    if (!auth.allowsMutation(request)) return reply.code(403).send({ error: "FORBIDDEN" });
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) return reply.code(415).send({ error: "UNSUPPORTED_MEDIA_TYPE" });
    const parsed = loginSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { const result = await auth.login(parsed.data.username, parsed.data.password, diagnostics(request, clientResolver)); if (result.status === "locked") return reply.code(429).send({ error: "LOGIN_UNAVAILABLE" }); if (result.status === "invalid") return reply.code(401).send({ error: "INVALID_CREDENTIALS" }); setCookie(reply, auth, result.token, result.session.absoluteExpiresAt); return reply.code(204).send(); } catch (error) { auth.report("admin.login", error, request.id); return reply.code(503).send({ error: "ADMIN_STORE_UNAVAILABLE" }); }
  });
  app.get("/api/admin/session", async (request, reply) => { const session = await authenticateAdminRead(request, reply, auth); if (!session) return; reply.header("Cache-Control", "no-store"); return { username: session.user.username, expiresAt: session.session.absoluteExpiresAt.toISOString(), csrfToken: session.csrfToken }; });
  app.post("/api/admin/logout", async (request, reply) => { const current = await authenticateAdminMutation(request, reply, auth, clientResolver); if (!current) return; try { await auth.store.revokeSession(current.session.tokenHash, new Date()); await auth.store.audit({ adminUserId: current.user.id, adminSessionId: current.session.id, action: "admin.logout", outcome: "success" }); reply.clearCookie(ADMIN_COOKIE_NAME, { path: "/api/admin", httpOnly: true, secure: auth.secureCookies, sameSite: "strict" }); return reply.code(204).send(); } catch (error) { auth.report("admin.logout", error, request.id); return reply.code(503).send({ error: "ADMIN_STORE_UNAVAILABLE" }); } });
}
