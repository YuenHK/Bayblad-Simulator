import { and, asc, eq, gt, isNull, lt, lte, sql } from "drizzle-orm";
import type { DatabaseClient } from "@steam-top/db";
import { adminAudit, adminAuditOutbox, adminLoginLimits, adminReauthGrants, adminSessions, adminUsers } from "@steam-top/db/schema";
import { auditInputSchema, type AdminSession, type AdminStore, type AdminUser, type AuditInput } from "./admin-auth";
import { ADMIN_IDLE_MS } from "./admin-session";

type Db = DatabaseClient["db"];
const user = (row: typeof adminUsers.$inferSelect): AdminUser => ({ id: row.id, username: row.username, passwordHash: row.passwordHash, active: row.active });
const session = (row: typeof adminSessions.$inferSelect): AdminSession => ({ id: row.id, adminUserId: row.adminUserId, tokenHash: row.tokenHash, csrfTokenHash: row.csrfTokenHash, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, absoluteExpiresAt: row.expiresAt, ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}), ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}), ...(row.lastIp ? { lastIp: row.lastIp } : {}), ...(row.userAgent ? { userAgent: row.userAgent } : {}) });
const auditValues = (input: AuditInput) => ({ adminUserId: input.adminUserId ?? null, adminSessionId: input.adminSessionId ?? null, action: input.action, outcome: input.outcome, requestIp: input.ip ?? null, userAgent: input.userAgent?.slice(0, 512) ?? null, details: input.details ?? {} });

export class PostgresAdminStore implements AdminStore {
  constructor(readonly db: Db, readonly report: (event: Readonly<{ event: "admin_audit_dead"; outboxId: string }>) => void = () => undefined) {}
  async findUser(username: string) { const [row] = await this.db.select().from(adminUsers).where(sql`lower(${adminUsers.username}) = lower(${username.trim()})`).limit(1); return row ? user(row) : null; }
  async createUserIfAbsent(input: { username: string; passwordHash: string }) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1937002746)`);
      const [prior] = await tx.select().from(adminUsers).where(sql`lower(${adminUsers.username}) = lower(${input.username})`).limit(1);
      if (prior) return user(prior);
      const [created] = await tx.insert(adminUsers).values({ username: input.username, passwordHash: input.passwordHash }).returning();
      if (!created) throw new Error("ADMIN_BOOTSTRAP_FAILED"); return user(created);
    });
  }
  async createSession(input: Omit<AdminSession, "id">) { return this.db.transaction(async (tx) => { const [owner] = await tx.select({ id: adminUsers.id }).from(adminUsers).where(and(eq(adminUsers.id, input.adminUserId), eq(adminUsers.active, true))).for("update").limit(1); if (!owner) throw new Error("ADMIN_INACTIVE"); const [row] = await tx.insert(adminSessions).values({ adminUserId: input.adminUserId, tokenHash: input.tokenHash, csrfTokenHash: input.csrfTokenHash, createdAt: input.createdAt, lastSeenAt: input.lastSeenAt, expiresAt: input.absoluteExpiresAt, revokedAt: input.revokedAt ?? null, archivedAt: input.archivedAt ?? null, lastIp: input.lastIp ?? null, userAgent: input.userAgent ?? null }).returning(); if (!row) throw new Error("ADMIN_SESSION_CREATE_FAILED"); await tx.update(adminUsers).set({ lastLoginAt: input.createdAt, updatedAt: input.createdAt }).where(eq(adminUsers.id, input.adminUserId)); return session(row); }); }
  async findSession(value: string) { const [row] = await this.db.select({ session: adminSessions, user: adminUsers }).from(adminSessions).innerJoin(adminUsers, eq(adminSessions.adminUserId, adminUsers.id)).where(and(eq(adminSessions.tokenHash, value), isNull(adminSessions.archivedAt), eq(adminUsers.active, true))).limit(1); return row ? { session: session(row.session), user: user(row.user) } : null; }
  async touchSession(value: string, now: Date) {
    return this.db.transaction(async (tx) => {
      const idleAfter = new Date(now.getTime() - ADMIN_IDLE_MS);
      const [candidate] = await tx.select().from(adminSessions).where(eq(adminSessions.tokenHash, value)).limit(1); if (!candidate) return null;
      const [owner] = await tx.select().from(adminUsers).where(and(eq(adminUsers.id, candidate.adminUserId), eq(adminUsers.active, true))).for("update").limit(1); if (!owner) return null;
      const [locked] = await tx.select().from(adminSessions).where(eq(adminSessions.id, candidate.id)).for("update").limit(1); if (!locked || locked.revokedAt || locked.archivedAt || locked.expiresAt.getTime() <= now.getTime() || locked.lastSeenAt.getTime() <= idleAfter.getTime()) return null;
      const [updated] = await tx.update(adminSessions).set({ lastSeenAt: now, updatedAt: now }).where(eq(adminSessions.id, locked.id)).returning(); return updated ? { session: session(updated), user: user(owner) } : null;
    });
  }
  async revokeSession(value: string, now: Date) { return this.db.transaction(async (tx) => { const [candidate] = await tx.select().from(adminSessions).where(eq(adminSessions.tokenHash, value)).limit(1); if (!candidate) return false; await tx.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.id, candidate.adminUserId)).for("update").limit(1); const [locked] = await tx.select().from(adminSessions).where(eq(adminSessions.id, candidate.id)).for("update").limit(1); if (!locked || locked.revokedAt || locked.archivedAt) return false; const rows = await tx.update(adminSessions).set({ revokedAt: now, archivedAt: now, tokenHash: sql`encode(digest(${adminSessions.tokenHash} || ${now.toISOString()}, 'sha256'),'hex')`, csrfTokenHash: sql`encode(digest(${adminSessions.csrfTokenHash} || ${now.toISOString()}, 'sha256'),'hex')`, updatedAt: now }).where(eq(adminSessions.id, locked.id)).returning({ id: adminSessions.id }); return rows.length === 1; }); }
  async audit(input: AuditInput) { await this.db.insert(adminAudit).values(auditValues(auditInputSchema.parse(input) as AuditInput)); }
  async queueAudit(input: AuditInput) { await this.db.insert(adminAuditOutbox).values({ payload: structuredClone(auditInputSchema.parse(input)) }); }
  async pumpAuditOutbox(now = new Date(), limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError("INVALID_AUDIT_PUMP_LIMIT");
    return this.db.transaction(async (tx) => {
      const jobs = await tx.select().from(adminAuditOutbox).where(lte(adminAuditOutbox.nextAttemptAt, now)).orderBy(asc(adminAuditOutbox.nextAttemptAt), asc(adminAuditOutbox.createdAt)).limit(limit).for("update", { skipLocked: true });
      for (const job of jobs) {
        try {
          const input = auditInputSchema.parse(job.payload) as AuditInput;
          await tx.transaction(async (savepoint) => {
            await savepoint.insert(adminAudit).values({ ...auditValues(input), sourceOutboxId: job.id }).onConflictDoNothing();
            await savepoint.delete(adminAuditOutbox).where(eq(adminAuditOutbox.id, job.id));
          });
        } catch (error) {
          const attempt = job.attemptCount + 1;
          const exhausted = attempt >= 10;
          await tx.update(adminAuditOutbox).set({ attemptCount: attempt, nextAttemptAt: exhausted ? new Date(8_640_000_000_000_000) : new Date(now.getTime() + Math.min(300_000, 1_000 * 2 ** Math.min(8, attempt - 1))), lastError: exhausted ? "ADMIN_AUDIT_DEAD" : "ADMIN_AUDIT_WRITE_FAILED" }).where(eq(adminAuditOutbox.id, job.id));
          if (exhausted) this.report({ event: "admin_audit_dead", outboxId: job.id });
        }
      }
      return jobs.length;
    });
  }
  async admitLoginAttempt(keys: { accountHash: string; clientHash: string }, now: Date) { const rows = await this.db.select().from(adminLoginLimits).where(sql`(${adminLoginLimits.scope}='account' and ${adminLoginLimits.keyHash}=${keys.accountHash}) or (${adminLoginLimits.scope}='client' and ${adminLoginLimits.keyHash}=${keys.clientHash}) or (${adminLoginLimits.scope}='global' and ${adminLoginLimits.keyHash}=${"0".repeat(64)})`); return !rows.some((row) => row.lockedUntil && row.lockedUntil.getTime() > now.getTime()); }
  async recordLoginFailureAndStatus(keys: { accountHash: string; clientHash: string }, now: Date) {
    return this.db.transaction(async (tx) => {
      const rows = [{ scope: "account" as const, keyHash: keys.accountHash, max: 5 }, { scope: "client" as const, keyHash: keys.clientHash, max: 20 }, { scope: "global" as const, keyHash: "0".repeat(64), max: 200 }].sort((a, b) => `${a.scope}:${a.keyHash}`.localeCompare(`${b.scope}:${b.keyHash}`));
      await tx.delete(adminLoginLimits).where(lt(adminLoginLimits.updatedAt, new Date(now.getTime() - 30 * 60_000)));
      for (const item of rows) {
        await tx.insert(adminLoginLimits).values({ scope: item.scope, keyHash: item.keyHash, windowStart: now, updatedAt: now }).onConflictDoNothing();
        const [row] = await tx.select().from(adminLoginLimits).where(and(eq(adminLoginLimits.scope, item.scope), eq(adminLoginLimits.keyHash, item.keyHash))).for("update").limit(1); if (!row) throw new Error("ADMIN_LOGIN_LIMIT_MISSING");
        const expired = now.getTime() - row.windowStart.getTime() >= 15 * 60_000; const count = expired ? 0 : row.failureCount; const locked = !expired && row.lockedUntil && row.lockedUntil.getTime() > now.getTime(); if (locked || count >= item.max) return true;
        const next = count + 1; await tx.update(adminLoginLimits).set({ failureCount: next, windowStart: expired ? now : row.windowStart, lockedUntil: next >= item.max ? new Date(now.getTime() + 15 * 60_000) : null, updatedAt: now }).where(and(eq(adminLoginLimits.scope, item.scope), eq(adminLoginLimits.keyHash, item.keyHash)));
      }
      return false;
    });
  }
  async resetLoginFailures(keys: { accountHash: string; clientHash: string }, now: Date) { await this.db.update(adminLoginLimits).set({ failureCount: 0, lockedUntil: null, windowStart: now, updatedAt: now }).where(sql`(${adminLoginLimits.scope}='account' and ${adminLoginLimits.keyHash}=${keys.accountHash}) or (${adminLoginLimits.scope}='client' and ${adminLoginLimits.keyHash}=${keys.clientHash})`); }
  async setUserActive(adminUserId: string, active: boolean, now: Date) { await this.db.transaction(async (tx) => { await tx.update(adminUsers).set({ active, updatedAt: now }).where(eq(adminUsers.id, adminUserId)); if (!active) await tx.update(adminSessions).set({ revokedAt: now, archivedAt: now, tokenHash: sql`encode(digest(${adminSessions.tokenHash} || ${now.toISOString()}, 'sha256'),'hex')`, csrfTokenHash: sql`encode(digest(${adminSessions.csrfTokenHash} || ${now.toISOString()}, 'sha256'),'hex')`, updatedAt: now }).where(and(eq(adminSessions.adminUserId, adminUserId), isNull(adminSessions.archivedAt))); }); }
  async pruneExpiredSessions(now: Date, limit: number) { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new TypeError("INVALID_PRUNE_LIMIT"); const idle = new Date(now.getTime() - ADMIN_IDLE_MS); const rows = await this.db.execute(sql`with expired as (select id from admin_sessions where archived_at is null and (expires_at <= ${now} or last_seen_at <= ${idle}) order by expires_at limit ${limit} for update skip locked) update admin_sessions s set revoked_at=${now}, archived_at=${now}, updated_at=${now}, token_hash=encode(digest(s.token_hash || ${now.toISOString()},'sha256'),'hex'), csrf_token_hash=encode(digest(s.csrf_token_hash || ${now.toISOString()},'sha256'),'hex') from expired where s.id=expired.id returning s.id`); await this.db.delete(adminReauthGrants).where(lt(adminReauthGrants.expiresAt, new Date(now.getTime()-7*86_400_000))); await this.db.delete(adminLoginLimits).where(lt(adminLoginLimits.updatedAt,new Date(now.getTime()-30*60_000))); await this.db.delete(adminSessions).where(and(lt(adminSessions.archivedAt,new Date(now.getTime()-30*86_400_000)),sql`${adminSessions.archivedAt} is not null`)); return rows.length; }
  async createReauthGrant(input: { tokenHash: string; adminUserId: string; adminSessionId: string; purpose: string; expiresAt: Date }) { if (!Number.isFinite(input.expiresAt.getTime())) throw new TypeError("INVALID_REAUTH_EXPIRY"); const now = new Date(input.expiresAt.getTime() - 5 * 60_000); await this.db.transaction(async (tx) => { const [owner] = await tx.select().from(adminUsers).where(and(eq(adminUsers.id, input.adminUserId), eq(adminUsers.active, true))).for("update").limit(1); const [activeSession] = await tx.select().from(adminSessions).where(and(eq(adminSessions.id, input.adminSessionId), eq(adminSessions.adminUserId, input.adminUserId), isNull(adminSessions.revokedAt), isNull(adminSessions.archivedAt), gt(adminSessions.expiresAt, now), gt(adminSessions.lastSeenAt, new Date(now.getTime() - ADMIN_IDLE_MS)))).for("update").limit(1); if (!owner || !activeSession) throw new Error("ADMIN_INACTIVE"); const [row] = await tx.insert(adminReauthGrants).values(input).returning({ id: adminReauthGrants.id }); if (!row) throw new Error("REAUTH_GRANT_CREATE_FAILED"); await tx.insert(adminAudit).values({ adminUserId: input.adminUserId, adminSessionId: input.adminSessionId, action: "admin.reauth.issued", outcome: "success", details: { purpose: input.purpose } }); }); }
  async consumeReauthGrant(input: { tokenHash: string; adminUserId: string; adminSessionId: string; purpose: string; now: Date }) {
    if (!Number.isFinite(input.now.getTime())) throw new TypeError("INVALID_REAUTH_NOW"); return this.db.transaction(async (tx) => { const [owner] = await tx.select().from(adminUsers).where(and(eq(adminUsers.id, input.adminUserId), eq(adminUsers.active, true))).for("update").limit(1); if (!owner) return false; const [activeSession] = await tx.select().from(adminSessions).where(and(eq(adminSessions.id, input.adminSessionId), eq(adminSessions.adminUserId, input.adminUserId), isNull(adminSessions.revokedAt), isNull(adminSessions.archivedAt), gt(adminSessions.expiresAt, input.now), gt(adminSessions.lastSeenAt, new Date(input.now.getTime() - ADMIN_IDLE_MS)))).for("update").limit(1); if (!activeSession) return false; const [row] = await tx.update(adminReauthGrants).set({ consumedAt: input.now }).where(and(eq(adminReauthGrants.tokenHash, input.tokenHash), eq(adminReauthGrants.adminUserId, input.adminUserId), eq(adminReauthGrants.adminSessionId, input.adminSessionId), eq(adminReauthGrants.purpose, input.purpose), isNull(adminReauthGrants.consumedAt), gt(adminReauthGrants.expiresAt, input.now))).returning({ id: adminReauthGrants.id }); if (!row) return false; await tx.insert(adminAudit).values({ adminUserId: input.adminUserId, adminSessionId: input.adminSessionId, action: "admin.reauth.consumed", outcome: "success", details: { purpose: input.purpose } }); return true; });
  }
}
