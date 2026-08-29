import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ADMIN_ABSOLUTE_MS, ADMIN_COOKIE_NAME, ADMIN_IDLE_MS, constantTokenEqual, csrfForSession, opaqueToken, tokenHash } from "./admin-session";
import { AdminLoginLimiter } from "./rate-limit";

export type AdminUser = Readonly<{ id: string; username: string; passwordHash: string; active: boolean }>;
export type AdminSession = Readonly<{ id: string; adminUserId: string; tokenHash: string; csrfTokenHash: string; createdAt: Date; lastSeenAt: Date; absoluteExpiresAt: Date; revokedAt?: Date }>;
export type AuditInput = Readonly<{ adminUserId?: string; adminSessionId?: string; action: string; outcome: "success" | "failure" | "denied"; ip?: string; userAgent?: string; details?: Readonly<Record<string, unknown>> }>;
export interface AdminStore {
  findUser(username: string): Promise<AdminUser | null>;
  createUserIfAbsent(input: Readonly<{ username: string; passwordHash: string }>): Promise<AdminUser>;
  createSession(input: Omit<AdminSession, "id">): Promise<AdminSession>;
  findSession(hash: string): Promise<Readonly<{ session: AdminSession; user: AdminUser }> | null>;
  touchSession(hash: string, now: Date): Promise<Readonly<{ session: AdminSession; user: AdminUser }> | null>;
  revokeSession(hash: string, now: Date): Promise<boolean>;
  audit(input: AuditInput): Promise<void>;
  loginAllowed?(keys: Readonly<{ accountHash: string; clientHash: string }>, now: Date): Promise<boolean>;
}

export class InMemoryAdminStore implements AdminStore {
  readonly #users = new Map<string, AdminUser>(); readonly #sessions = new Map<string, AdminSession>(); readonly auditEntries: AuditInput[] = [];
  get sessionCount() { return this.#sessions.size; }
  async findUser(username: string) { return this.#users.get(username.toLocaleLowerCase("en-US")) ?? null; }
  async createUserIfAbsent(input: { username: string; passwordHash: string }) { const key = input.username.toLocaleLowerCase("en-US"); const prior = this.#users.get(key); if (prior) return prior; const user = { id: crypto.randomUUID(), username: input.username, passwordHash: input.passwordHash, active: true } as const; this.#users.set(key, user); return user; }
  async createSession(input: Omit<AdminSession, "id">) { if (this.#sessions.has(input.tokenHash)) throw new Error("ADMIN_SESSION_TOKEN_CONFLICT"); const row = { ...input, id: crypto.randomUUID() }; this.#sessions.set(row.tokenHash, row); return row; }
  async findSession(value: string) { const session = this.#sessions.get(value); if (!session) return null; const user = [...this.#users.values()].find((candidate) => candidate.id === session.adminUserId); return user ? { session, user } : null; }
  async touchSession(value: string, now: Date) { const found = await this.findSession(value); if (!found || found.session.revokedAt || now.getTime() >= found.session.absoluteExpiresAt.getTime() || now.getTime() - found.session.lastSeenAt.getTime() >= ADMIN_IDLE_MS) return null; const session = { ...found.session, lastSeenAt: now }; this.#sessions.set(value, session); return { session, user: found.user }; }
  async revokeSession(value: string, now: Date) { const prior = this.#sessions.get(value); if (!prior || prior.revokedAt) return false; this.#sessions.set(value, { ...prior, revokedAt: now }); return true; }
  async audit(input: AuditInput) { this.auditEntries.push(structuredClone(input)); }
}

const ARGON = Object.freeze({ algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });
const loginSchema = z.object({ username: z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]+$/u), password: z.string().min(8).max(1024).regex(/^[^\p{Cc}]+$/u) }).strict();
export class AdminStoreUnavailableError extends Error { constructor() { super("ADMIN_STORE_UNAVAILABLE"); } }

export class AdminAuthService {
  readonly #limiter = new AdminLoginLimiter(); readonly #now: () => Date; readonly #origins: Set<string>; readonly #secure: boolean; readonly #tokens: () => string; readonly #csrfSecret: Buffer;
  readonly #dummyHash: Promise<string>;
  #argonActive = 0; readonly #argonWaiters: Array<() => void> = [];
  constructor(readonly store: AdminStore, options: Readonly<{ now?: () => Date; allowedOrigins: readonly string[]; secureCookies?: boolean; tokenFactory?: () => string; csrfSecret?: Buffer }>) {
    this.#now = options.now ?? (() => new Date()); this.#origins = new Set(options.allowedOrigins); this.#secure = options.secureCookies ?? process.env.NODE_ENV === "production"; this.#tokens = options.tokenFactory ?? opaqueToken; this.#csrfSecret = options.csrfSecret ?? randomBytes(32);
    this.#dummyHash = hash(randomBytes(32), ARGON);
  }
  get secureCookies() { return this.#secure; }
  async #withArgon<T>(operation: () => Promise<T>): Promise<T> { if (this.#argonActive >= 4) await new Promise<void>((resolve) => this.#argonWaiters.push(resolve)); this.#argonActive++; try { return await operation(); } finally { this.#argonActive--; this.#argonWaiters.shift()?.(); } }
  allows(request: FastifyRequest): boolean { return request.headers["sec-fetch-site"] !== "cross-site" && typeof request.headers.origin === "string" && this.#origins.has(request.headers.origin); }
  async bootstrap(username: string, password: string) { const parsed = loginSchema.parse({ username, password }); const existing = await this.store.findUser(parsed.username); if (existing) return existing; return this.store.createUserIfAbsent({ username: parsed.username, passwordHash: await this.#withArgon(() => hash(parsed.password, ARGON)) }); }
  async verifyPassword(username: string, password: string): Promise<boolean> { const user = await this.store.findUser(username.trim()); const target = user?.passwordHash ?? await this.#dummyHash; let valid = false; try { valid = await this.#withArgon(() => verify(target, password)); } catch { valid = false; } return Boolean(user?.active && valid); }
  async login(username: string, password: string, diagnostics: { clientKey: string; ip?: string; userAgent?: string }) {
    const now = this.#now(); const account = username.trim().toLocaleLowerCase("en-US");
    const accountHash = tokenHash(account); const clientHash = tokenHash(diagnostics.clientKey);
    const auditDiagnostics = { ...(diagnostics.ip ? { ip: diagnostics.ip } : {}), ...(diagnostics.userAgent ? { userAgent: diagnostics.userAgent } : {}) };
    if (this.#limiter.isLocked(account, diagnostics.clientKey, now.getTime()) || (this.store.loginAllowed && !await this.store.loginAllowed({ accountHash, clientHash }, now))) { await this.store.audit({ action: "admin.login.locked", outcome: "denied", ...auditDiagnostics, details: { accountHash, clientHash } }); return { status: "locked" as const }; }
    const user = await this.store.findUser(username.trim()); const valid = await this.verifyPassword(username, password);
    if (!user || !valid) { this.#limiter.fail(account, diagnostics.clientKey, now.getTime()); await this.store.audit({ ...(user ? { adminUserId: user.id } : {}), action: "admin.login", outcome: "failure", ...auditDiagnostics, details: { accountHash, clientHash, ...(!user ? { unknownAccount: true } : {}) } }); return { status: "invalid" as const }; }
    this.#limiter.success(account, diagnostics.clientKey); const raw = this.#tokens(); if (Buffer.from(raw, "base64url").length < 32) throw new Error("ADMIN_TOKEN_FACTORY_TOO_SHORT"); const csrf = csrfForSession(this.#csrfSecret, raw);
    const session = await this.store.createSession({ adminUserId: user.id, tokenHash: tokenHash(raw), csrfTokenHash: tokenHash(csrf), createdAt: now, lastSeenAt: now, absoluteExpiresAt: new Date(now.getTime() + ADMIN_ABSOLUTE_MS) });
    await this.store.audit({ adminUserId: user.id, adminSessionId: session.id, action: "admin.login", outcome: "success", ...auditDiagnostics, details: { accountHash, clientHash } }); return { status: "ok" as const, token: raw, session, user };
  }
  async authenticate(raw: string | undefined, touch = true) { if (!raw) return null; const hashed = tokenHash(raw); const now = this.#now(); const existing = await this.store.findSession(hashed); if (!existing || existing.session.revokedAt) return null; if (now.getTime() >= existing.session.absoluteExpiresAt.getTime() || now.getTime() - existing.session.lastSeenAt.getTime() >= ADMIN_IDLE_MS) { await this.store.revokeSession(hashed, now); await this.store.audit({ adminUserId: existing.user.id, adminSessionId: existing.session.id, action: "admin.session.expired", outcome: "denied" }); return null; } const found = touch ? await this.store.touchSession(hashed, now) : existing; if (!found) return null; return { ...found, csrfToken: csrfForSession(this.#csrfSecret, raw) }; }
  csrfMatches(raw: string, supplied: string | undefined, session: AdminSession): boolean { if (!supplied) return false; const expected = csrfForSession(this.#csrfSecret, raw); return constantTokenEqual(expected, supplied) && constantTokenEqual(tokenHash(supplied), session.csrfTokenHash); }
  async reauthenticate(username: string, password: string, diagnostics: { clientKey: string; ip?: string; userAgent?: string }) { const account = `reauth:${username.trim().toLocaleLowerCase("en-US")}`; const now = this.#now().getTime(); const user = await this.store.findUser(username); const common = { ...(user ? { adminUserId: user.id } : {}), action: "admin.reauthenticate", ...(diagnostics.ip ? { ip: diagnostics.ip } : {}), ...(diagnostics.userAgent ? { userAgent: diagnostics.userAgent } : {}) }; if (this.#limiter.isLocked(account, diagnostics.clientKey, now)) { await this.store.audit({ ...common, outcome: "denied" }); return false; } const valid = await this.verifyPassword(username, password); if (valid) this.#limiter.success(account, diagnostics.clientKey); else this.#limiter.fail(account, diagnostics.clientKey, now); await this.store.audit({ ...common, outcome: valid ? "success" : "failure" }); return valid; }
}

function diagnostics(request: FastifyRequest) { const value = request.ip; return { clientKey: value, ip: value, ...(typeof request.headers["user-agent"] === "string" ? { userAgent: request.headers["user-agent"].slice(0, 512) } : {}) }; }
function setCookie(reply: FastifyReply, auth: AdminAuthService, value: string, expires: Date) { reply.setCookie(ADMIN_COOKIE_NAME, value, { path: "/api/admin", httpOnly: true, secure: auth.secureCookies, sameSite: "strict", maxAge: ADMIN_ABSOLUTE_MS / 1000, expires }); }
export async function authenticateAdminRequest(request: FastifyRequest, reply: FastifyReply, auth: AdminAuthService, options: Readonly<{ csrf?: boolean }> = {}) {
  if (!auth.allows(request)) { reply.code(403).send({ error: "FORBIDDEN" }); return null; }
  try {
    const raw = request.cookies[ADMIN_COOKIE_NAME]; const current = await auth.authenticate(raw);
    if (!current) { reply.code(401).send({ error: "UNAUTHORIZED" }); return null; }
    const supplied = typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : undefined;
    if (options.csrf && (!raw || !auth.csrfMatches(raw, supplied, current.session))) { await auth.store.audit({ adminUserId: current.user.id, adminSessionId: current.session.id, action: "admin.csrf", outcome: "denied", ...diagnostics(request) }); reply.code(403).send({ error: "CSRF_REJECTED" }); return null; }
    return current;
  } catch { reply.code(503).send({ error: "ADMIN_STORE_UNAVAILABLE" }); return null; }
}
export function registerAdminAuthRoutes(app: FastifyInstance, auth: AdminAuthService): void {
  app.post("/api/admin/login", { preValidation: async (request, reply) => { if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) return reply.code(415).send({ error: "UNSUPPORTED_MEDIA_TYPE" }); }, schema: { body: { type: "object", additionalProperties: false, required: ["username", "password"], properties: { username: { type: "string", minLength: 1, maxLength: 80 }, password: { type: "string", minLength: 8, maxLength: 1024 } } } } }, async (request, reply) => {
    if (!auth.allows(request)) return reply.code(403).send({ error: "FORBIDDEN" });
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) return reply.code(415).send({ error: "UNSUPPORTED_MEDIA_TYPE" });
    const parsed = loginSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { const result = await auth.login(parsed.data.username, parsed.data.password, diagnostics(request)); if (result.status === "locked") return reply.code(429).send({ error: "LOGIN_UNAVAILABLE" }); if (result.status === "invalid") return reply.code(401).send({ error: "INVALID_CREDENTIALS" }); setCookie(reply, auth, result.token, result.session.absoluteExpiresAt); return reply.code(204).send(); } catch { return reply.code(503).send({ error: "ADMIN_STORE_UNAVAILABLE" }); }
  });
  app.get("/api/admin/session", async (request, reply) => { if (!auth.allows(request)) return reply.code(403).send({ error: "FORBIDDEN" }); try { const session = await auth.authenticate(request.cookies[ADMIN_COOKIE_NAME]); if (!session) return reply.code(401).send({ error: "UNAUTHORIZED" }); reply.header("Cache-Control", "no-store"); return { username: session.user.username, expiresAt: session.session.absoluteExpiresAt.toISOString(), csrfToken: session.csrfToken }; } catch { return reply.code(503).send({ error: "ADMIN_STORE_UNAVAILABLE" }); } });
  app.post("/api/admin/logout", async (request, reply) => { if (!auth.allows(request)) return reply.code(403).send({ error: "FORBIDDEN" }); const raw = request.cookies[ADMIN_COOKIE_NAME]; try { const current = await auth.authenticate(raw); if (!current) return reply.code(401).send({ error: "UNAUTHORIZED" }); if (!raw || !auth.csrfMatches(raw, typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : undefined, current.session)) { await auth.store.audit({ adminUserId: current.user.id, adminSessionId: current.session.id, action: "admin.csrf", outcome: "denied" }); return reply.code(403).send({ error: "CSRF_REJECTED" }); } await auth.store.revokeSession(current.session.tokenHash, new Date()); await auth.store.audit({ adminUserId: current.user.id, adminSessionId: current.session.id, action: "admin.logout", outcome: "success" }); reply.clearCookie(ADMIN_COOKIE_NAME, { path: "/api/admin", httpOnly: true, secure: auth.secureCookies, sameSite: "strict" }); return reply.code(204).send(); } catch { return reply.code(503).send({ error: "ADMIN_STORE_UNAVAILABLE" }); } });
}
