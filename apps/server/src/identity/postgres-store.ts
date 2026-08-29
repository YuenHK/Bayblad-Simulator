import { and, eq, gt, isNull } from "drizzle-orm";
import type { DatabaseClient } from "@steam-top/db";
import { identities, identitySessions } from "@steam-top/db/schema";
import type { Identity, IdentitySession, IdentityStore, SessionDiagnostics, TrustedLiveIdentity } from "./resolver";
import { GuestDisplayCollisionError } from "./resolver";

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
  identity: mapIdentity(identity), tokenHash: session.tokenHash, createdAt: session.createdAt,
  lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt,
  ...(session.revokedAt ? { revokedAt: session.revokedAt } : {}),
  ...(session.lastIp ? { lastIp: session.lastIp } : {}),
  ...(session.userAgent ? { userAgent: session.userAgent } : {}),
});
const diagnosticColumns = (value: SessionDiagnostics) => ({ lastIp: value.ip ?? null, userAgent: value.userAgent ?? null });

export class PostgresIdentityStore implements IdentityStore {
  readonly persistent = true;
  readonly #db: Db;
  constructor(db: Db) { this.#db = db; }

  async findSession(tokenHash: string, now = new Date(), diagnostic: SessionDiagnostics = {}, rollingExpiresAt?: Date): Promise<IdentitySession | null> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx.select({ session: identitySessions, identity: identities }).from(identitySessions)
        .innerJoin(identities, eq(identitySessions.identityId, identities.id))
        .where(and(eq(identitySessions.tokenHash, tokenHash), isNull(identitySessions.revokedAt), gt(identitySessions.expiresAt, now))).limit(1);
      const found = rows[0]; if (!found) return null;
      const [updated] = await tx.update(identitySessions).set({ lastSeenAt: now, ...(rollingExpiresAt ? { expiresAt: rollingExpiresAt } : {}), ...diagnosticColumns(diagnostic) })
        .where(eq(identitySessions.id, found.session.id)).returning();
      await tx.update(identities).set({ lastSeenAt: now, updatedAt: now }).where(eq(identities.id, found.identity.id));
      return mapSession(updated!, found.identity);
    });
  }

  async createGuestSession(input: Readonly<{ tokenHash: string; displayName: string; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics }>): Promise<IdentitySession> {
    try {
      return await this.#db.transaction(async (tx) => {
        const [identity] = await tx.insert(identities).values({ status: "guest", displayName: input.displayName, createdAt: input.now, updatedAt: input.now, lastSeenAt: input.now }).returning();
        const [session] = await tx.insert(identitySessions).values({ identityId: identity!.id, tokenHash: input.tokenHash, createdAt: input.now, lastSeenAt: input.now, expiresAt: input.expiresAt, ...diagnosticColumns(input.diagnostics) }).returning();
        return mapSession(session!, identity!);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new GuestDisplayCollisionError();
      throw error;
    }
  }

  async upsertLiveSession(input: Readonly<{ tokenHash: string; identity: TrustedLiveIdentity; now: Date; expiresAt: Date; diagnostics: SessionDiagnostics; cachedIdentityId?: string }>): Promise<IdentitySession> {
    return this.#db.transaction(async (tx: Tx) => {
      await tx.insert(identities).values({ status: "iclass", displayName: input.identity.displayName, studentName: input.identity.studentName, className: input.identity.className, studentNumber: input.identity.studentNumber, deviceName: input.identity.deviceName, iclassExternalId: input.identity.externalId, createdAt: input.now, updatedAt: input.now, lastSeenAt: input.now }).onConflictDoNothing();
      const [existing] = await tx.select().from(identities).where(eq(identities.iclassExternalId, input.identity.externalId)).limit(1);
      if (!existing) throw new Error("IDENTITY_UPSERT_FAILED");
      const [identity] = await tx.update(identities).set({ displayName: input.identity.displayName, studentName: input.identity.studentName, className: input.identity.className, studentNumber: input.identity.studentNumber, deviceName: input.identity.deviceName ?? null, updatedAt: input.now, lastSeenAt: input.now }).where(eq(identities.id, existing.id)).returning();
      const [session] = await tx.insert(identitySessions).values({ identityId: identity!.id, tokenHash: input.tokenHash, createdAt: input.now, lastSeenAt: input.now, expiresAt: input.expiresAt, ...diagnosticColumns(input.diagnostics) })
        .onConflictDoUpdate({ target: identitySessions.tokenHash, set: { identityId: identity!.id, lastSeenAt: input.now, expiresAt: input.expiresAt, revokedAt: null, ...diagnosticColumns(input.diagnostics) } }).returning();
      return mapSession(session!, identity!);
    });
  }

  async revokeSession(tokenHash: string, now: Date): Promise<boolean> {
    const rows = await this.#db.update(identitySessions).set({ revokedAt: now }).where(and(eq(identitySessions.tokenHash, tokenHash), isNull(identitySessions.revokedAt))).returning({ id: identitySessions.id });
    return rows.length > 0;
  }
}
