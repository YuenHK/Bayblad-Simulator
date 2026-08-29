import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { createGuestDisplayName } from "./guest";
import { hashIdentityToken, IDENTITY_COOKIE_LIFETIME_MS, isIdentityToken, issueIdentityToken } from "./cookie";

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
  lastIp?: string;
  userAgent?: string;
}>;
export type SessionDiagnostics = Readonly<{ ip?: string; userAgent?: string }>;

export interface IdentityStore {
  readonly persistent: boolean;
  findSession(tokenHash: string, now?: Date, diagnostics?: SessionDiagnostics, rollingExpiresAt?: Date): Promise<IdentitySession | null>;
  createGuestSession(input: Readonly<{ tokenHash: string; displayName: string; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics }>): Promise<IdentitySession>;
  upsertLiveSession(input: Readonly<{ tokenHash: string; identity: TrustedLiveIdentity; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics; cachedIdentityId?: string }>): Promise<IdentitySession>;
  revokeSession(tokenHash: string, now: Date): Promise<boolean>;
}

const trustedIdentityBrand: unique symbol = Symbol("trustedLiveIdentity");
export type TrustedLiveIdentity = Readonly<{
  [trustedIdentityBrand]: true;
  externalId: string;
  displayName: string;
  studentName: string;
  className: string;
  studentNumber: string;
  deviceName?: string;
}>;

/** Task 3 adapters are the only production callers allowed to construct this value. */
export function trustedLiveIdentity(value: Omit<TrustedLiveIdentity, typeof trustedIdentityBrand>): TrustedLiveIdentity {
  return Object.freeze({ ...value, [trustedIdentityBrand]: true }) as TrustedLiveIdentity;
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

export class GuestDisplayCollisionError extends Error {}

export class IdentityResolver {
  readonly #store: IdentityStore;
  readonly #now: () => Date;
  readonly #lifetimeMs: number;
  constructor(store: IdentityStore, options: Readonly<{ now?: () => Date; lifetimeMs?: number }> = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#lifetimeMs = options.lifetimeMs ?? IDENTITY_COOKIE_LIFETIME_MS;
  }
  get persistent(): boolean { return this.#store.persistent; }

  async resolve(request: Readonly<{ cookieToken?: string; ip?: string; userAgent?: string }>, live?: TrustedLiveIdentity): Promise<Readonly<{ identity: Identity; cookieToken: string; expiresAt: Date; isNew: boolean }>> {
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#lifetimeMs);
    const diagnostic = diagnostics(request);
    try {
      const validToken = isIdentityToken(request.cookieToken) ? request.cookieToken : undefined;
      const cached = validToken
        ? await this.#store.findSession(hashIdentityToken(validToken), now, diagnostic, expiresAt)
        : null;
      if (live) {
        const token = validToken ?? issueIdentityToken();
        const session = await this.#store.upsertLiveSession({ tokenHash: hashIdentityToken(token), identity: live, now, expiresAt, diagnostics: diagnostic, ...(cached ? { cachedIdentityId: cached.identity.id } : {}) });
        return { identity: session.identity, cookieToken: token, expiresAt, isNew: !cached };
      }
      if (cached && !cached.revokedAt && cached.expiresAt > now) {
        return { identity: cached.identity, cookieToken: validToken!, expiresAt, isNew: false };
      }
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const token = issueIdentityToken();
        try {
          const session = await this.#store.createGuestSession({ tokenHash: hashIdentityToken(token), displayName: createGuestDisplayName(), now, expiresAt, diagnostics: diagnostic });
          return { identity: session.identity, cookieToken: token, expiresAt, isNew: true };
        } catch (error) {
          if (error instanceof GuestDisplayCollisionError) continue;
          throw error;
        }
      }
      throw new Error("GUEST_CODE_EXHAUSTED");
    } catch (error) {
      if (error instanceof IdentityStoreUnavailableError || (error instanceof Error && error.message === "GUEST_CODE_EXHAUSTED")) throw error;
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
  readonly persistent = false;
  readonly #sessions = new Map<string, IdentitySession>();
  readonly #liveByExternal = new Map<string, string>();
  readonly #guestNames = new Set<string>();
  readonly #maxSessions: number;
  constructor(options: Readonly<{ maxSessions?: number }> = {}) { this.#maxSessions = options.maxSessions ?? 10_000; }

  async findSession(tokenHash: string, now?: Date, diagnostic?: SessionDiagnostics, rollingExpiresAt?: Date): Promise<IdentitySession | null> {
    const found = this.#sessions.get(tokenHash);
    if (!found || found.revokedAt || (now && found.expiresAt <= now)) return null;
    const updated: IdentitySession = { ...found, ...(now ? { lastSeenAt: now } : {}), ...(rollingExpiresAt ? { expiresAt: rollingExpiresAt } : {}), ...(diagnostic?.ip ? { lastIp: diagnostic.ip } : {}), ...(diagnostic?.userAgent ? { userAgent: diagnostic.userAgent } : {}) };
    this.#sessions.set(tokenHash, updated);
    return updated;
  }
  async createGuestSession(input: Readonly<{ tokenHash: string; displayName: string; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics }>): Promise<IdentitySession> {
    for (const [hash, session] of this.#sessions) {
      if (session.revokedAt || session.expiresAt <= input.now) {
        this.#sessions.delete(hash);
        if (session.identity.status === "guest") this.#guestNames.delete(session.identity.displayName);
      }
    }
    if (this.#sessions.size >= this.#maxSessions) throw new Error("IDENTITY_STORE_CAPACITY");
    if (this.#guestNames.has(input.displayName)) throw new GuestDisplayCollisionError();
    if (this.#sessions.has(input.tokenHash)) return this.#sessions.get(input.tokenHash)!;
    const identity: Identity = Object.freeze({ id: randomUUID(), status: "guest", displayName: input.displayName });
    const session: IdentitySession = Object.freeze({ identity, tokenHash: input.tokenHash, createdAt: input.now, lastSeenAt: input.now, expiresAt: input.expiresAt, ...(input.diagnostics.ip ? { lastIp: input.diagnostics.ip } : {}), ...(input.diagnostics.userAgent ? { userAgent: input.diagnostics.userAgent } : {}) });
    this.#guestNames.add(input.displayName); this.#sessions.set(input.tokenHash, session);
    return session;
  }
  async upsertLiveSession(input: Readonly<{ tokenHash: string; identity: TrustedLiveIdentity; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics; cachedIdentityId?: string }>): Promise<IdentitySession> {
    if (!this.#sessions.has(input.tokenHash) && this.#sessions.size >= this.#maxSessions) throw new Error("IDENTITY_STORE_CAPACITY");
    let id = this.#liveByExternal.get(input.identity.externalId);
    if (!id) {
      if (this.#liveByExternal.size >= this.#maxSessions) throw new Error("IDENTITY_STORE_CAPACITY");
      id = randomUUID(); this.#liveByExternal.set(input.identity.externalId, id);
    }
    const identity: Identity = Object.freeze({ id, status: "iclass", displayName: input.identity.displayName, externalId: input.identity.externalId, studentName: input.identity.studentName, className: input.identity.className, studentNumber: input.identity.studentNumber, ...(input.identity.deviceName ? { deviceName: input.identity.deviceName } : {}) });
    const session: IdentitySession = Object.freeze({ identity, tokenHash: input.tokenHash, createdAt: input.now, lastSeenAt: input.now, expiresAt: input.expiresAt, ...(input.diagnostics.ip ? { lastIp: input.diagnostics.ip } : {}), ...(input.diagnostics.userAgent ? { userAgent: input.diagnostics.userAgent } : {}) });
    this.#sessions.set(input.tokenHash, session); return session;
  }
  async revokeSession(tokenHash: string, now: Date): Promise<boolean> {
    const session = this.#sessions.get(tokenHash); if (!session) return false;
    this.#sessions.set(tokenHash, Object.freeze({ ...session, revokedAt: now })); return true;
  }
}
