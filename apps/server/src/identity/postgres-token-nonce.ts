import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { DatabaseClient } from "@steam-top/db";
import { webClipTokenNonces } from "@steam-top/db/schema";
import type { TokenNonceStore } from "./webclip-token";

export class PostgresTokenNonceStore implements TokenNonceStore {
  readonly durable = true;
  readonly #db: DatabaseClient["db"];
  constructor(db: DatabaseClient["db"]) { this.#db = db; }
  async issue(input: Readonly<{ jtiHash: string; deviceId: string; issuedAt: Date; expiresAt: Date }>): Promise<void> {
    await this.#db.insert(webClipTokenNonces).values(input);
  }
  async lookup(jtiHash: string, now: Date): Promise<string | null> {
    const [record] = await this.#db.select({ deviceId: webClipTokenNonces.deviceId }).from(webClipTokenNonces).where(and(eq(webClipTokenNonces.jtiHash, jtiHash), isNull(webClipTokenNonces.usedAt), gt(webClipTokenNonces.expiresAt, now))).limit(1);
    return record?.deviceId ?? null;
  }
  async reserve(jtiHash: string, reservationHash: string, now: Date, leaseUntil: Date): Promise<"acquired" | "in-progress" | "missing"> {
    const [reserved] = await this.#db.update(webClipTokenNonces).set({ reservationHash, reservedUntil: leaseUntil }).where(and(eq(webClipTokenNonces.jtiHash, jtiHash), isNull(webClipTokenNonces.usedAt), gt(webClipTokenNonces.expiresAt, now), or(isNull(webClipTokenNonces.reservationHash), lte(webClipTokenNonces.reservedUntil, now), eq(webClipTokenNonces.reservationHash, reservationHash)))).returning({ deviceId: webClipTokenNonces.deviceId });
    if (reserved) return "acquired";
    const [existing] = await this.#db.select({ usedAt: webClipTokenNonces.usedAt, expiresAt: webClipTokenNonces.expiresAt, reservedUntil: webClipTokenNonces.reservedUntil }).from(webClipTokenNonces).where(eq(webClipTokenNonces.jtiHash, jtiHash)).limit(1);
    return existing && !existing.usedAt && existing.expiresAt > now && existing.reservedUntil && existing.reservedUntil > now ? "in-progress" : "missing";
  }
  async commit(jtiHash: string, reservationHash: string, usedAt: Date): Promise<string | null> {
    const [committed] = await this.#db.update(webClipTokenNonces).set({ usedAt }).where(and(eq(webClipTokenNonces.jtiHash, jtiHash), eq(webClipTokenNonces.reservationHash, reservationHash), isNull(webClipTokenNonces.usedAt), gt(webClipTokenNonces.reservedUntil, usedAt))).returning({ deviceId: webClipTokenNonces.deviceId });
    if (committed) return committed.deviceId;
    const [idempotent] = await this.#db.select({ deviceId: webClipTokenNonces.deviceId }).from(webClipTokenNonces).where(and(eq(webClipTokenNonces.jtiHash, jtiHash), eq(webClipTokenNonces.reservationHash, reservationHash), gt(webClipTokenNonces.usedAt, new Date(0)))).limit(1);
    return idempotent?.deviceId ?? null;
  }
  async release(jtiHash: string, reservationHash: string): Promise<boolean> {
    const rows = await this.#db.update(webClipTokenNonces).set({ reservationHash: null, reservedUntil: null }).where(and(eq(webClipTokenNonces.jtiHash, jtiHash), eq(webClipTokenNonces.reservationHash, reservationHash), isNull(webClipTokenNonces.usedAt))).returning({ jtiHash: webClipTokenNonces.jtiHash }); return rows.length === 1;
  }
  async pruneExpired(before: Date, batchSize: number): Promise<number> {
    const rows = await this.#db.select({ jtiHash: webClipTokenNonces.jtiHash }).from(webClipTokenNonces).where(lte(webClipTokenNonces.expiresAt, before)).limit(batchSize);
    if (!rows.length) return 0; const deleted = await this.#db.delete(webClipTokenNonces).where(inArray(webClipTokenNonces.jtiHash, rows.map(({ jtiHash }) => jtiHash))).returning({ jtiHash: webClipTokenNonces.jtiHash }); return deleted.length;
  }
}
