import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const MAX_TOKEN_BYTES = 2_048;
const MAX_LIFETIME_MS = 300_000;
const B64URL = /^[A-Za-z0-9_-]+$/u;
const headerSchema = z.strictObject({ alg: z.literal("HS256"), typ: z.literal("JWT"), kid: z.string().min(1).max(32), v: z.literal(1) });
const claimsSchema = z.strictObject({ v: z.literal(1), iat: z.number().int().nonnegative(), exp: z.number().int().positive(), jti: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), aud: z.string().min(1).max(64) });

export interface TokenNonceStore {
  readonly durable?: boolean;
  issue(input: Readonly<{ jtiHash: string; deviceId: string; issuedAt: Date; expiresAt: Date }>): Promise<void>;
  lookup(jtiHash: string, now: Date): Promise<string | null>;
  reserve(jtiHash: string, reservationHash: string, now: Date, leaseUntil: Date): Promise<"acquired" | "in-progress" | "missing">;
  commit(jtiHash: string, reservationHash: string, usedAt: Date): Promise<string | null>;
  release(jtiHash: string, reservationHash: string): Promise<boolean>;
  pruneExpired(before: Date, batchSize: number): Promise<number>;
}

type NonceRecord = Readonly<{ deviceId: string; issuedAt: Date; expiresAt: Date; usedAt?: Date; reservationHash?: string; reservedUntil?: Date }>;
export class InMemoryTokenNonceStore implements TokenNonceStore {
  readonly durable = false;
  readonly #records = new Map<string, NonceRecord>();
  async issue(input: Readonly<{ jtiHash: string; deviceId: string; issuedAt: Date; expiresAt: Date }>): Promise<void> {
    if (this.#records.has(input.jtiHash)) throw new Error("DEVICE_TOKEN_NONCE_COLLISION");
    this.#records.set(input.jtiHash, Object.freeze({ deviceId: input.deviceId, issuedAt: input.issuedAt, expiresAt: input.expiresAt }));
  }
  async reserve(jtiHash: string, reservationHash: string, now: Date, leaseUntil: Date): Promise<"acquired" | "in-progress" | "missing"> {
    const record = this.#records.get(jtiHash);
    if (!record || record.usedAt || record.expiresAt <= now) return "missing";
    if (record.reservationHash && record.reservedUntil && record.reservedUntil > now && record.reservationHash !== reservationHash) return "in-progress";
    this.#records.set(jtiHash, Object.freeze({ ...record, reservationHash, reservedUntil: leaseUntil })); return "acquired";
  }
  async commit(jtiHash: string, reservationHash: string, usedAt: Date): Promise<string | null> {
    const record = this.#records.get(jtiHash); if (!record || record.reservationHash !== reservationHash) return null;
    if (!record.usedAt && (!record.reservedUntil || record.reservedUntil <= usedAt)) return null;
    if (!record.usedAt) this.#records.set(jtiHash, Object.freeze({ ...record, usedAt }));
    return record.deviceId;
  }
  async release(jtiHash: string, reservationHash: string): Promise<boolean> {
    const record = this.#records.get(jtiHash); if (!record || record.usedAt || record.reservationHash !== reservationHash) return false;
    const { reservationHash: _hash, reservedUntil: _until, ...released } = record; this.#records.set(jtiHash, Object.freeze(released)); return true;
  }
  async pruneExpired(before: Date, batchSize: number): Promise<number> {
    let removed = 0; for (const [hash, record] of this.#records) { if (removed >= batchSize) break; if (record.expiresAt <= before) { this.#records.delete(hash); removed += 1; } } return removed;
  }
  async lookup(jtiHash: string, now: Date): Promise<string | null> {
    const record = this.#records.get(jtiHash);
    return !record || record.usedAt || record.expiresAt <= now ? null : record.deviceId;
  }
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
function decodeCanonical(value: string): unknown {
  if (!B64URL.test(value)) throw new Error("INVALID_DEVICE_TOKEN");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("INVALID_DEVICE_TOKEN");
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("INVALID_DEVICE_TOKEN"); }
}
const jtiHash = (jti: string) => createHash("sha256").update(jti, "ascii").digest("hex");
export type VerifiedWebClipToken = Readonly<{ deviceId: string; expiresAt: Date }>;
export type WebClipReservation = Readonly<{ deviceId: string; expiresAt: Date }>;

export class WebClipTokenService {
  readonly #keys: Readonly<Record<string, Uint8Array>>;
  readonly #activeKeyId: string;
  readonly #audience: string;
  readonly #store: TokenNonceStore;
  readonly #now: () => number;
  readonly #verified = new WeakMap<object, string>();
  readonly #reservations = new WeakMap<object, Readonly<{ jtiHash: string; reservationHash: string }>>();
  constructor(input: Readonly<{ keys: Readonly<Record<string, Uint8Array>>; activeKeyId: string; audience: string; nonceStore: TokenNonceStore; now?: () => number; production?: boolean }>) {
    if (!input.keys[input.activeKeyId]) throw new TypeError("WEBCLIP_ACTIVE_KEY_MISSING");
    for (const secret of Object.values(input.keys)) if (secret.byteLength < 32) throw new TypeError("WEBCLIP_SECRET_TOO_SHORT");
    if ((input.production ?? process.env.NODE_ENV === "production") && input.nonceStore.durable !== true) throw new TypeError("WEBCLIP_DURABLE_NONCE_STORE_REQUIRED");
    this.#keys = Object.freeze(Object.fromEntries(Object.entries(input.keys).map(([key, value]) => [key, Uint8Array.from(value)]))); this.#activeKeyId = input.activeKeyId;
    this.#audience = z.string().min(1).max(64).parse(input.audience); this.#store = input.nonceStore; this.#now = input.now ?? Date.now;
  }
  async issue(deviceId: string, lifetimeMs = MAX_LIFETIME_MS): Promise<string> {
    const cleanDeviceId = z.string().trim().min(1).max(128).refine((v) => !/[\u0000-\u001f\u007f]/u.test(v)).parse(deviceId);
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > MAX_LIFETIME_MS) throw new TypeError("WEBCLIP_LIFETIME_INVALID");
    const iat = this.#now(); const exp = iat + lifetimeMs; const jti = randomBytes(32).toString("base64url");
    await this.#store.issue({ jtiHash: jtiHash(jti), deviceId: cleanDeviceId, issuedAt: new Date(iat), expiresAt: new Date(exp) });
    const head = encode({ alg: "HS256", typ: "JWT", kid: this.#activeKeyId, v: 1 });
    const body = encode({ v: 1, iat, exp, jti, aud: this.#audience });
    const signature = createHmac("sha256", this.#keys[this.#activeKeyId]!).update(`${head}.${body}`, "ascii").digest("base64url");
    return `${head}.${body}.${signature}`;
  }
  async inspect(token: unknown): Promise<VerifiedWebClipToken> {
    if (typeof token !== "string" || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) throw new Error("INVALID_DEVICE_TOKEN");
    const parts = token.split("."); if (parts.length !== 3) throw new Error("INVALID_DEVICE_TOKEN");
    const [head, body, signature] = parts as [string, string, string];
    const header = headerSchema.safeParse(decodeCanonical(head)); const claims = claimsSchema.safeParse(decodeCanonical(body));
    if (!header.success || !claims.success || !B64URL.test(signature)) throw new Error("INVALID_DEVICE_TOKEN");
    const secret = this.#keys[header.data.kid]; if (!secret) throw new Error("INVALID_DEVICE_TOKEN");
    const expected = createHmac("sha256", secret).update(`${head}.${body}`, "ascii").digest();
    const received = Buffer.from(signature, "base64url");
    if (received.toString("base64url") !== signature || received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("INVALID_DEVICE_TOKEN");
    const now = this.#now();
    if (claims.data.aud !== this.#audience || claims.data.exp - claims.data.iat > MAX_LIFETIME_MS || claims.data.iat > now + 30_000) throw new Error("INVALID_DEVICE_TOKEN");
    if (claims.data.exp <= now) throw new Error("DEVICE_TOKEN_EXPIRED");
    const hash = jtiHash(claims.data.jti);
    const deviceId = await this.#store.lookup(hash, new Date(now));
    if (!deviceId) throw new Error("DEVICE_TOKEN_REPLAYED");
    const verified = Object.freeze({ deviceId, expiresAt: new Date(claims.data.exp) });
    this.#verified.set(verified, hash);
    return verified;
  }
  async reserveVerified(verified: VerifiedWebClipToken, leaseMs = 15_000): Promise<WebClipReservation> {
    const hash = this.#verified.get(verified as object); if (!hash) throw new Error("INVALID_DEVICE_TOKEN_HANDLE");
    if (verified.expiresAt.getTime() <= this.#now()) throw new Error("DEVICE_TOKEN_EXPIRED");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60_000) throw new TypeError("DEVICE_TOKEN_LEASE_INVALID");
    const reservationHash = createHash("sha256").update(randomBytes(32)).digest("hex"); const now = this.#now();
    const status = await this.#store.reserve(hash, reservationHash, new Date(now), new Date(Math.min(verified.expiresAt.getTime(), now + leaseMs)));
    if (status === "in-progress") throw new Error("DEVICE_TOKEN_IN_PROGRESS"); if (status === "missing") throw new Error("DEVICE_TOKEN_REPLAYED");
    const reservation = Object.freeze({ deviceId: verified.deviceId, expiresAt: verified.expiresAt }); this.#reservations.set(reservation, { jtiHash: hash, reservationHash }); return reservation;
  }
  async commitReservation(reservation: WebClipReservation): Promise<string> {
    const owned = this.#reservations.get(reservation as object); if (!owned) throw new Error("INVALID_DEVICE_TOKEN_RESERVATION");
    const deviceId = await this.#store.commit(owned.jtiHash, owned.reservationHash, new Date(this.#now()));
    if (!deviceId || deviceId !== reservation.deviceId) throw new Error("DEVICE_TOKEN_COMMIT_FAILED"); return deviceId;
  }
  async releaseReservation(reservation: WebClipReservation): Promise<boolean> {
    const owned = this.#reservations.get(reservation as object); if (!owned) return false;
    const released = await this.#store.release(owned.jtiHash, owned.reservationHash); this.#reservations.delete(reservation as object); return released;
  }
  async consumeVerified(verified: VerifiedWebClipToken): Promise<string> {
    const reservation = await this.reserveVerified(verified); return this.commitReservation(reservation);
  }
  async consume(token: unknown): Promise<string> { return this.consumeVerified(await this.inspect(token)); }
  async pruneExpired(batchSize = 500): Promise<number> { return this.#store.pruneExpired(new Date(this.#now()), batchSize); }
}
