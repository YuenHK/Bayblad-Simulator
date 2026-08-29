import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "@steam-top/db";
import { deviceActivityDays, identities, identityLinks, identitySessions } from "@steam-top/db/schema";
import type { Identity, IdentitySession, IdentityStore, SessionDiagnostics, TrustedLiveIdentity } from "./resolver";
import { IdentityCapacityError, SessionTokenUnavailableError } from "./resolver";

type Db = DatabaseClient["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const mapIdentity = (row: typeof identities.$inferSelect): Identity => ({
  id: row.id, status: row.status, displayName: row.displayName,
  ...(row.studentName ? { studentName: row.studentName } : {}),
  ...(row.className ? { className: row.className } : {}),
  ...(row.studentNumber ? { studentNumber: row.studentNumber } : {}),
  ...(row.deviceName ? { deviceName: row.deviceName } : {}),
  ...(row.iclassExternalId ? { externalId: row.iclassExternalId } : {}),
});
const mapSession = (session: typeof identitySessions.$inferSelect, identity: typeof identities.$inferSelect): IdentitySession => ({
  id: session.id, identity: mapIdentity(identity), tokenHash: session.tokenHash, createdAt: session.createdAt,
  lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt,
  ...(session.revokedAt ? { revokedAt: session.revokedAt } : {}),
  ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
  ...(session.lastIp ? { lastIp: session.lastIp } : {}),
  ...(session.userAgent ? { userAgent: session.userAgent } : {}),
});
const diagnosticColumns = (value: SessionDiagnostics) => ({ lastIp: value.ip ?? null, userAgent: value.userAgent ?? null });
const hongKongDate = (value: Date): string => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};
async function recordActivity(tx: Tx, identity: typeof identities.$inferSelect, at: Date): Promise<void> {
  await tx.insert(deviceActivityDays).values({ activityDate: hongKongDate(at), anonymousDeviceId: identity.anonymousDeviceId, identityId: identity.id, identityStatusSnapshot: identity.status, classNameSnapshot: identity.className, firstActivityAt: at, lastActivityAt: at })
    .onConflictDoUpdate({ target: [deviceActivityDays.activityDate, deviceActivityDays.anonymousDeviceId], set: { lastActivityAt: sql`greatest(${deviceActivityDays.lastActivityAt}, excluded.last_activity_at)` } });
}

export class PostgresIdentityStore implements IdentityStore {
  readonly #db: Db;
  readonly #maxIdentities: number;
  readonly #maxSessions: number;
  constructor(db: Db, options: Readonly<{ maxIdentities?: number; maxSessions?: number }> = {}) {
    this.#db = db; this.#maxIdentities = options.maxIdentities ?? 1_000_000; this.#maxSessions = options.maxSessions ?? 5_000_000;
    if (!Number.isSafeInteger(this.#maxIdentities) || this.#maxIdentities < 1) throw new TypeError("maxIdentities must be a positive integer");
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1) throw new TypeError("maxSessions must be a positive integer");
  }
  async #assertSessionCapacity(tx: Tx, now: Date): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(1937002745)`);
    const [row] = await tx.select({ value: count() }).from(identitySessions).where(and(isNull(identitySessions.revokedAt), gt(identitySessions.expiresAt, now)));
    if ((row?.value ?? 0) >= this.#maxSessions) throw new IdentityCapacityError();
  }

  async #assertIdentityCapacity(tx: Tx): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(1937002744)`);
    const [row] = await tx.select({ value: count() }).from(identities);
    if ((row?.value ?? 0) >= this.#maxIdentities) throw new IdentityCapacityError();
  }

  async findSession(tokenHash: string, now = new Date()): Promise<IdentitySession | null> {
    const rows = await this.#db.select({ session: identitySessions, identity: identities }).from(identitySessions)
      .innerJoin(identities, eq(identitySessions.identityId, identities.id))
      .where(and(eq(identitySessions.tokenHash, tokenHash), isNull(identitySessions.revokedAt), gt(identitySessions.expiresAt, now))).limit(1);
    return rows[0] ? mapSession(rows[0].session, rows[0].identity) : null;
  }

  async touchSession(tokenHash: string, now: Date, diagnostic: SessionDiagnostics, rollingExpiresAt: Date): Promise<IdentitySession | null> {
    return this.#db.transaction(async (tx) => {
      const [updated] = await tx.update(identitySessions).set({ lastSeenAt: now, expiresAt: rollingExpiresAt, ...diagnosticColumns(diagnostic) })
        .where(and(eq(identitySessions.tokenHash, tokenHash), isNull(identitySessions.revokedAt), gt(identitySessions.expiresAt, now))).returning();
      if (!updated) return null;
      const [identity] = await tx.select().from(identities).where(eq(identities.id, updated.identityId)).limit(1);
      if (!identity) return null;
      await tx.update(identities).set({ lastSeenAt: now, updatedAt: now }).where(eq(identities.id, identity.id));
      await recordActivity(tx, identity, now);
      return mapSession(updated, identity);
    });
  }

  async createGuestSession(input: Readonly<{ tokenHash: string; displayName: string; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics }>): Promise<IdentitySession> {
    try {
      return await this.#db.transaction(async (tx) => {
        await this.#assertIdentityCapacity(tx);
        await this.#assertSessionCapacity(tx, input.now);
        const [identity] = await tx.insert(identities).values({ status: "guest", displayName: input.displayName, createdAt: input.now, updatedAt: input.now, lastSeenAt: input.now }).returning();
        const [session] = await tx.insert(identitySessions).values({ identityId: identity!.id, tokenHash: input.tokenHash, createdAt: input.now, lastSeenAt: input.now, expiresAt: input.expiresAt, ...diagnosticColumns(input.diagnostics) }).returning();
        await recordActivity(tx, identity!, input.now);
        return mapSession(session!, identity!);
      });
    } catch (error) { if ((error as { code?: string }).code === "23505") throw new SessionTokenUnavailableError(); throw error; }
  }

  async upsertLiveSession(input: Readonly<{ tokenHash: string; previousTokenHash?: string; identity: TrustedLiveIdentity; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics; cachedIdentityId?: string }>, transaction?: unknown): Promise<IdentitySession> {
    const operation = async (tx: Tx) => {
      let [existing] = await tx.select().from(identities).where(eq(identities.iclassExternalId, input.identity.externalId)).limit(1);
      if (!existing) {
        await this.#assertIdentityCapacity(tx);
        [existing] = await tx.insert(identities).values({ status: "iclass", displayName: input.identity.displayName, studentName: input.identity.studentName, className: input.identity.className, studentNumber: input.identity.studentNumber, deviceName: input.identity.deviceName, iclassExternalId: input.identity.externalId, createdAt: input.now, updatedAt: input.now, lastSeenAt: input.now }).returning();
      }
      if (!existing) throw new Error("IDENTITY_UPSERT_FAILED");
      let [identity] = await tx.update(identities).set({ displayName: input.identity.displayName, studentName: input.identity.studentName, className: input.identity.className, studentNumber: input.identity.studentNumber, deviceName: input.identity.deviceName ?? null, updatedAt: input.now, lastSeenAt: input.now }).where(eq(identities.id, existing.id)).returning();
      if (input.previousTokenHash) {
        const [previous] = await tx.select({ session: identitySessions, identity: identities }).from(identitySessions).innerJoin(identities, eq(identitySessions.identityId, identities.id))
          .where(and(eq(identitySessions.tokenHash, input.previousTokenHash), isNull(identitySessions.revokedAt), gt(identitySessions.expiresAt, input.now))).limit(1);
        if (!previous) throw new SessionTokenUnavailableError();
        const revoked = await tx.update(identitySessions).set({ revokedAt: input.now, archivedAt: input.now }).where(and(eq(identitySessions.id, previous.session.id), isNull(identitySessions.revokedAt))).returning();
        if (revoked.length !== 1) throw new SessionTokenUnavailableError();
        if (previous.identity.status === "guest" && previous.identity.id !== identity!.id) {
          const [guestRow] = await tx.select().from(identities).where(eq(identities.id, previous.identity.id)).limit(1);
          if (guestRow) {
            const oldLiveDevice = identity!.anonymousDeviceId;
            await tx.update(identities).set({ anonymousDeviceId: randomUUID() }).where(eq(identities.id, guestRow.id));
            [identity] = await tx.update(identities).set({ anonymousDeviceId: guestRow.anonymousDeviceId }).where(eq(identities.id, identity!.id)).returning();
            await tx.update(identities).set({ anonymousDeviceId: oldLiveDevice }).where(eq(identities.id, guestRow.id));
          }
          await tx.update(identities).set({ mergedIntoIdentityId: identity!.id, mergedAt: input.now, updatedAt: input.now }).where(eq(identities.id, previous.identity.id));
          await tx.insert(identityLinks).values({ sourceIdentityId: previous.identity.id, targetIdentityId: identity!.id, reason: "verified_cookie_and_iclass", verificationFingerprint: createHash("sha256").update(`${input.identity.externalId}:${previous.identity.id}:${identity!.id}`).digest("hex"), linkedAt: input.now }).onConflictDoNothing();
        }
      }
      await this.#assertSessionCapacity(tx, input.now);
      const [session] = await tx.insert(identitySessions).values({ identityId: identity!.id, tokenHash: input.tokenHash, createdAt: input.now, lastSeenAt: input.now, expiresAt: input.expiresAt, ...diagnosticColumns(input.diagnostics) }).returning();
      await recordActivity(tx, identity!, input.now);
      return mapSession(session!, identity!);
    };
    try { return transaction ? await operation(transaction as Tx) : await this.#db.transaction(operation); } catch (error) {
      if (error instanceof SessionTokenUnavailableError || (error as { code?: string }).code === "23505") throw new SessionTokenUnavailableError();
      throw error;
    }
  }

  async revokeSession(tokenHash: string, now: Date): Promise<boolean> {
    const rows = await this.#db.update(identitySessions).set({ revokedAt: now, archivedAt: now }).where(and(eq(identitySessions.tokenHash, tokenHash), isNull(identitySessions.revokedAt))).returning({ id: identitySessions.id });
    return rows.length > 0;
  }
}
