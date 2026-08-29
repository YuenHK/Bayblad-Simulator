import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { createGuestDisplayName } from "./guest";
import { hashIdentityToken, IDENTITY_COOKIE_LIFETIME_MS, isIdentityToken, issueIdentityToken } from "./cookie";
import { z } from "zod";

export type Identity = Readonly<{
  id: string;
  status: "iclass" | "cookie" | "guest";
  displayName: string;
  studentName?: string;
  className?: string;
  studentNumber?: string;
  deviceName?: string;
  externalId?: string;
}>;
export type IdentitySession = Readonly<{
  identity: Identity;
  tokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  archivedAt?: Date;
  lastIp?: string;
  userAgent?: string;
}>;
export type SessionDiagnostics = Readonly<{ ip?: string; userAgent?: string }>;

export interface IdentityStore {
  findSession(tokenHash: string, now?: Date): Promise<IdentitySession | null>;
  touchSession(tokenHash: string, now: Date, diagnostics: SessionDiagnostics, rollingExpiresAt: Date): Promise<IdentitySession | null>;
  createGuestSession(input: Readonly<{ tokenHash: string; displayName: string; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics }>): Promise<IdentitySession>;
  upsertLiveSession(input: Readonly<{ tokenHash: string; previousTokenHash?: string; identity: TrustedLiveIdentity; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics; cachedIdentityId?: string }>): Promise<IdentitySession>;
  revokeSession(tokenHash: string, now: Date): Promise<boolean>;
}
export type TrustedLiveIdentity = Readonly<{
  externalId: string;
  displayName: string;
  studentName: string;
  className: string;
  studentNumber: string;
  deviceName?: string;
}>;
const trustedLiveValues = new WeakSet<object>();
const clean = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "control characters forbidden");
const liveSchema = z.strictObject({ externalId: clean(128), displayName: clean(80), studentName: clean(80), className: clean(30), studentNumber: clean(30), deviceName: clean(128).optional() });
export type LiveIdentityAdapter = Readonly<{ resolve(): Promise<unknown> }>;
export function createValidatedLiveIdentityProvider(adapter: LiveIdentityAdapter): Readonly<{ resolve(): Promise<TrustedLiveIdentity | null> }> {
  return Object.freeze({ resolve: async () => {
    const raw = await adapter.resolve(); if (raw === null || raw === undefined) return null;
    const parsed = liveSchema.parse(raw);
    const value: TrustedLiveIdentity = Object.freeze({ externalId: parsed.externalId, displayName: parsed.displayName, studentName: parsed.studentName, className: parsed.className, studentNumber: parsed.studentNumber, ...(parsed.deviceName ? { deviceName: parsed.deviceName } : {}) });
    trustedLiveValues.add(value); return value;
  } });
}

function diagnostics(input: Readonly<{ ip?: string; userAgent?: string }>): SessionDiagnostics {
  let ip = input.ip?.trim();
  if (ip?.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  if (!ip || isIP(ip) === 0) ip = undefined;
  const userAgent = input.userAgent?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 512) || undefined;
  return { ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) };
}

export class IdentityStoreUnavailableError extends Error {
  constructor() { super("IDENTITY_STORE_UNAVAILABLE"); this.name = "IdentityStoreUnavailableError"; }
}

export class SessionTokenUnavailableError extends Error {}
export class IdentityCapacityError extends Error { constructor() { super("IDENTITY_CAPACITY_REACHED"); } }
export class IdentityAdmissionError extends Error { constructor() { super("IDENTITY_CREATION_RATE_LIMITED"); } }

export class IdentityResolver {
  readonly #store: IdentityStore;
  readonly #now: () => Date;
  readonly #lifetimeMs: number;
  readonly #liveRotations = new Map<string, Promise<Readonly<{ identity: Identity; cookieToken: string; issuedAt: Date; expiresAt: Date; isNew: boolean }>>>();
  constructor(store: IdentityStore, options: Readonly<{ now?: () => Date; lifetimeMs?: number }> = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    const lifetime = options.lifetimeMs ?? IDENTITY_COOKIE_LIFETIME_MS;
    if (!Number.isSafeInteger(lifetime) || lifetime < 86_400_000 || lifetime > 365 * 86_400_000) throw new TypeError("lifetimeMs must be an integer from 1 to 365 days");
    this.#lifetimeMs = lifetime;
  }
  isBackedBy<T extends IdentityStore>(constructor: abstract new (...args: never[]) => T): boolean { return this.#store instanceof constructor; }

  async resolve(request: Readonly<{ cookieToken?: string; ip?: string; userAgent?: string; admitCreation?: () => boolean }>, live?: TrustedLiveIdentity): Promise<Readonly<{ identity: Identity; cookieToken: string; issuedAt: Date; expiresAt: Date; isNew: boolean }>> {
    const now = this.#now();
    const maxAgeSeconds = Math.floor(this.#lifetimeMs / 1_000);
    const expiresAt = new Date(now.getTime() + maxAgeSeconds * 1_000);
    const diagnostic = diagnostics(request);
    try {
      const validToken = isIdentityToken(request.cookieToken) ? request.cookieToken : undefined;
      const cached = validToken ? await this.#store.findSession(hashIdentityToken(validToken), now) : null;
      if (live) {
        if (!trustedLiveValues.has(live as object)) throw new TypeError("UNTRUSTED_LIVE_IDENTITY");
        const compatible = cached?.identity.status === "guest" || (cached?.identity.status === "iclass" && cached.identity.externalId === live.externalId);
        const rotationKey = compatible && validToken ? hashIdentityToken(validToken) : undefined;
        const rotate = async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const token = issueIdentityToken();
            try {
              const session = await this.#store.upsertLiveSession({ tokenHash: hashIdentityToken(token), ...(attempt === 0 && rotationKey && cached ? { previousTokenHash: rotationKey, cachedIdentityId: cached.identity.id } : {}), identity: live, now, expiresAt, diagnostics: diagnostic });
              return { identity: session.identity, cookieToken: token, issuedAt: now, expiresAt, isNew: true } as const;
            } catch (error) { if (error instanceof SessionTokenUnavailableError) continue; throw error; }
          }
          throw new Error("IDENTITY_TOKEN_EXHAUSTED");
        };
        if (!rotationKey) return await rotate();
        const pending = this.#liveRotations.get(rotationKey); if (pending) return await pending;
        const operation = rotate(); this.#liveRotations.set(rotationKey, operation);
        try { return await operation; } finally { if (this.#liveRotations.get(rotationKey) === operation) this.#liveRotations.delete(rotationKey); }
      }
      if (cached && !cached.revokedAt && cached.expiresAt > now) {
        const touched = await this.#store.touchSession(hashIdentityToken(validToken!), now, diagnostic, expiresAt);
        if (touched) {
          const identity = touched.identity.status === "iclass" ? { ...touched.identity, status: "cookie" as const } : touched.identity;
          return { identity, cookieToken: validToken!, issuedAt: now, expiresAt, isNew: false };
        }
      }
      if (request.admitCreation && !request.admitCreation()) throw new IdentityAdmissionError();
      const token = issueIdentityToken();
      const session = await this.#store.createGuestSession({ tokenHash: hashIdentityToken(token), displayName: createGuestDisplayName(), now, expiresAt, diagnostics: diagnostic });
      return { identity: session.identity, cookieToken: token, issuedAt: now, expiresAt, isNew: true };
    } catch (error) {
      if (error instanceof IdentityStoreUnavailableError || error instanceof IdentityAdmissionError || error instanceof IdentityCapacityError || error instanceof TypeError || (error instanceof Error && error.message === "IDENTITY_TOKEN_EXHAUSTED")) throw error;
      throw new IdentityStoreUnavailableError();
    }
  }

  async revoke(cookieToken: unknown): Promise<boolean> {
    if (!isIdentityToken(cookieToken)) return false;
    try { return await this.#store.revokeSession(hashIdentityToken(cookieToken), this.#now()); }
    catch { throw new IdentityStoreUnavailableError(); }
  }
}

export class InMemoryIdentityStore implements IdentityStore {
  readonly #sessions = new Map<string, IdentitySession>();
  readonly #liveByExternal = new Map<string, string>();
  readonly #maxSessions: number;
  #nextPruneAt = Number.NEGATIVE_INFINITY;
  constructor(options: Readonly<{ maxSessions?: number }> = {}) { this.#maxSessions = options.maxSessions ?? 10_000; }

  async findSession(tokenHash: string, now = new Date()): Promise<IdentitySession | null> {
    const found = this.#sessions.get(tokenHash);
    if (!found || found.revokedAt || found.expiresAt <= now) return null;
    return found;
  }
  async touchSession(tokenHash: string, now: Date, diagnostic: SessionDiagnostics, rollingExpiresAt: Date): Promise<IdentitySession | null> {
    const found = await this.findSession(tokenHash, now); if (!found) return null;
    const updated: IdentitySession = { ...found, lastSeenAt: now, expiresAt: rollingExpiresAt, ...(diagnostic.ip ? { lastIp: diagnostic.ip } : {}), ...(diagnostic.userAgent ? { userAgent: diagnostic.userAgent } : {}) };
    this.#sessions.set(tokenHash, updated);
    return updated;
  }
  async createGuestSession(input: Readonly<{ tokenHash: string; displayName: string; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics }>): Promise<IdentitySession> {
    if (input.now.getTime() >= this.#nextPruneAt) {
      for (const [hash, session] of this.#sessions) if (session.revokedAt || session.expiresAt <= input.now) this.#sessions.delete(hash);
      this.#nextPruneAt = input.now.getTime() + 60_000;
    }
    if (this.#sessions.size >= this.#maxSessions) throw new IdentityCapacityError();
    if (this.#sessions.has(input.tokenHash)) return this.#sessions.get(input.tokenHash)!;
    const identity: Identity = Object.freeze({ id: randomUUID(), status: "guest", displayName: input.displayName });
    const session: IdentitySession = Object.freeze({ identity, tokenHash: input.tokenHash, createdAt: input.now, lastSeenAt: input.now, expiresAt: input.expiresAt, ...(input.diagnostics.ip ? { lastIp: input.diagnostics.ip } : {}), ...(input.diagnostics.userAgent ? { userAgent: input.diagnostics.userAgent } : {}) });
    this.#sessions.set(input.tokenHash, session);
    return session;
  }
  async upsertLiveSession(input: Readonly<{ tokenHash: string; previousTokenHash?: string; identity: TrustedLiveIdentity; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics; cachedIdentityId?: string }>): Promise<IdentitySession> {
    const existing = this.#sessions.get(input.tokenHash);
    if (existing) throw new SessionTokenUnavailableError();
    if (input.previousTokenHash && !await this.findSession(input.previousTokenHash, input.now)) throw new SessionTokenUnavailableError();
    if (this.#sessions.size >= this.#maxSessions && !input.previousTokenHash) throw new IdentityCapacityError();
    let id = this.#liveByExternal.get(input.identity.externalId);
    if (!id) {
      if (this.#liveByExternal.size >= this.#maxSessions) throw new IdentityCapacityError();
      id = randomUUID(); this.#liveByExternal.set(input.identity.externalId, id);
    }
    const identity: Identity = Object.freeze({ id, status: "iclass", displayName: input.identity.displayName, externalId: input.identity.externalId, studentName: input.identity.studentName, className: input.identity.className, studentNumber: input.identity.studentNumber, ...(input.identity.deviceName ? { deviceName: input.identity.deviceName } : {}) });
    const session: IdentitySession = Object.freeze({ identity, tokenHash: input.tokenHash, createdAt: input.now, lastSeenAt: input.now, expiresAt: input.expiresAt, ...(input.diagnostics.ip ? { lastIp: input.diagnostics.ip } : {}), ...(input.diagnostics.userAgent ? { userAgent: input.diagnostics.userAgent } : {}) });
    this.#sessions.set(input.tokenHash, session);
    if (input.previousTokenHash) {
      this.#sessions.delete(input.previousTokenHash);
    }
    return session;
  }
  async revokeSession(tokenHash: string, now: Date): Promise<boolean> {
    const session = this.#sessions.get(tokenHash); if (!session) return false;
    this.#sessions.set(tokenHash, Object.freeze({ ...session, revokedAt: now, archivedAt: now })); return true;
  }
}
