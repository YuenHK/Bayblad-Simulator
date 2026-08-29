import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { DatabaseClient } from "@steam-top/db";
import { adminAudit, adminLoginLimits, adminReauthGrants, adminSessions, adminUsers } from "@steam-top/db/schema";
import type { AdminSession, AdminStore, AdminUser, AuditInput } from "./admin-auth";
import { ADMIN_IDLE_MS } from "./admin-session";

type Db = DatabaseClient["db"];
const user = (row: typeof adminUsers.$inferSelect): AdminUser => ({ id: row.id, username: row.username, passwordHash: row.passwordHash, active: row.active });
const session = (row: typeof adminSessions.$inferSelect): AdminSession => ({ id: row.id, adminUserId: row.adminUserId, tokenHash: row.tokenHash, csrfTokenHash: row.csrfTokenHash, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, absoluteExpiresAt: row.expiresAt, ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}), ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}), ...(row.lastIp ? { lastIp: row.lastIp } : {}), ...(row.userAgent ? { userAgent: row.userAgent } : {}) });

export class PostgresAdminStore implements AdminStore {
  constructor(readonly db: Db) {}
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
  async createSession(input: Omit<AdminSession, "id">) { return this.db.transaction(async (tx) => { const [row] = await tx.insert(adminSessions).values({ adminUserId: input.adminUserId, tokenHash: input.tokenHash, csrfTokenHash: input.csrfTokenHash, createdAt: input.createdAt, lastSeenAt: input.lastSeenAt, expiresAt: input.absoluteExpiresAt, revokedAt: input.revokedAt ?? null, archivedAt: input.archivedAt ?? null, lastIp: input.lastIp ?? null, userAgent: input.userAgent ?? null }).returning(); if (!row) throw new Error("ADMIN_SESSION_CREATE_FAILED"); await tx.update(adminUsers).set({ lastLoginAt: input.createdAt, updatedAt: input.createdAt }).where(and(eq(adminUsers.id, input.adminUserId), eq(adminUsers.active, true))); return session(row); }); }
  async findSession(value: string) { const [row] = await this.db.select({ session: adminSessions, user: adminUsers }).from(adminSessions).innerJoin(adminUsers, eq(adminSessions.adminUserId, adminUsers.id)).where(and(eq(adminSessions.tokenHash, value), isNull(adminSessions.archivedAt), eq(adminUsers.active, true))).limit(1); return row ? { session: session(row.session), user: user(row.user) } : null; }
  async touchSession(value: string, now: Date) {
    return this.db.transaction(async (tx) => {
      const idleAfter = new Date(now.getTime() - ADMIN_IDLE_MS);
      const [updated] = await tx.update(adminSessions).set({ lastSeenAt: now, updatedAt: now }).where(and(eq(adminSessions.tokenHash, value), isNull(adminSessions.revokedAt), isNull(adminSessions.archivedAt), gt(adminSessions.expiresAt, now), gt(adminSessions.lastSeenAt, idleAfter))).returning();
      if (!updated) { await tx.update(adminSessions).set({ revokedAt: now, updatedAt: now }).where(and(eq(adminSessions.tokenHash, value), isNull(adminSessions.revokedAt), sql`(${adminSessions.expiresAt} <= ${now} or ${adminSessions.lastSeenAt} <= ${idleAfter})`)); return null; }
      const [owner] = await tx.select().from(adminUsers).where(and(eq(adminUsers.id, updated.adminUserId), eq(adminUsers.active, true))).limit(1);
      return owner ? { session: session(updated), user: user(owner) } : null;
    });
  }
  async revokeSession(value: string, now: Date) { const rows = await this.db.update(adminSessions).set({ revokedAt: now, archivedAt: now, tokenHash: sql`encode(digest(${adminSessions.tokenHash} || ${now.toISOString()}, 'sha256'),'hex')`, csrfTokenHash: sql`encode(digest(${adminSessions.csrfTokenHash} || ${now.toISOString()}, 'sha256'),'hex')`, updatedAt: now }).where(and(eq(adminSessions.tokenHash, value), isNull(adminSessions.revokedAt))).returning({ id: adminSessions.id }); return rows.length === 1; }
  async audit(input: AuditInput) { await this.db.insert(adminAudit).values({ adminUserId: input.adminUserId ?? null, adminSessionId: input.adminSessionId ?? null, action: input.action, outcome: input.outcome, requestIp: input.ip ?? null, userAgent: input.userAgent?.slice(0, 512) ?? null, details: input.details ?? {} }); }
  async reserveLoginAttempt(keys: { accountHash: string; clientHash: string }, now: Date) {
    return this.db.transaction(async (tx) => {
      const rows = [{ scope: "account" as const, keyHash: keys.accountHash, max: 5 }, { scope: "client" as const, keyHash: keys.clientHash, max: 20 }, { scope: "global" as const, keyHash: "0".repeat(64), max: 200 }].sort((a, b) => `${a.scope}:${a.keyHash}`.localeCompare(`${b.scope}:${b.keyHash}`));
      await tx.delete(adminLoginLimits).where(lt(adminLoginLimits.updatedAt, new Date(now.getTime() - 30 * 60_000)));
      for (const item of rows) {
        await tx.insert(adminLoginLimits).values({ scope: item.scope, keyHash: item.keyHash, windowStart: now, updatedAt: now }).onConflictDoNothing();
        const [row] = await tx.select().from(adminLoginLimits).where(and(eq(adminLoginLimits.scope, item.scope), eq(adminLoginLimits.keyHash, item.keyHash))).for("update").limit(1); if (!row) throw new Error("ADMIN_LOGIN_LIMIT_MISSING");
        const expired = now.getTime() - row.windowStart.getTime() >= 15 * 60_000; const count = expired ? 0 : row.failureCount; const locked = !expired && row.lockedUntil && row.lockedUntil.getTime() > now.getTime(); if (locked || count >= item.max) return false;
        const next = count + 1; await tx.update(adminLoginLimits).set({ failureCount: next, windowStart: expired ? now : row.windowStart, lockedUntil: next >= item.max ? new Date(now.getTime() + 15 * 60_000) : null, updatedAt: now }).where(and(eq(adminLoginLimits.scope, item.scope), eq(adminLoginLimits.keyHash, item.keyHash)));
      }
      return true;
    });
  }
  async resetLoginFailures(keys: { accountHash: string; clientHash: string }, now: Date) { await this.db.update(adminLoginLimits).set({ failureCount: 0, lockedUntil: null, windowStart: now, updatedAt: now }).where(sql`${adminLoginLimits.scope} in ('account','client') and ${adminLoginLimits.keyHash} in (${keys.accountHash},${keys.clientHash})`); }
  async setUserActive(adminUserId: string, active: boolean, now: Date) { await this.db.transaction(async (tx) => { await tx.update(adminUsers).set({ active, updatedAt: now }).where(eq(adminUsers.id, adminUserId)); if (!active) await tx.update(adminSessions).set({ revokedAt: now, archivedAt: now, tokenHash: sql`encode(digest(${adminSessions.tokenHash} || ${now.toISOString()}, 'sha256'),'hex')`, csrfTokenHash: sql`encode(digest(${adminSessions.csrfTokenHash} || ${now.toISOString()}, 'sha256'),'hex')`, updatedAt: now }).where(and(eq(adminSessions.adminUserId, adminUserId), isNull(adminSessions.archivedAt))); }); }
  async pruneExpiredSessions(now: Date, limit: number) { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new TypeError("INVALID_PRUNE_LIMIT"); const idle = new Date(now.getTime() - ADMIN_IDLE_MS); const rows = await this.db.execute(sql`with expired as (select id from admin_sessions where archived_at is null and (expires_at <= ${now} or last_seen_at <= ${idle}) order by expires_at limit ${limit} for update skip locked) update admin_sessions s set revoked_at=${now}, archived_at=${now}, updated_at=${now}, token_hash=encode(digest(s.token_hash || ${now.toISOString()},'sha256'),'hex'), csrf_token_hash=encode(digest(s.csrf_token_hash || ${now.toISOString()},'sha256'),'hex') from expired where s.id=expired.id returning s.id`); return rows.length; }
  async createReauthGrant(input: { tokenHash: string; adminUserId: string; adminSessionId: string; purpose: string; expiresAt: Date }) { if (!Number.isFinite(input.expiresAt.getTime())) throw new TypeError("INVALID_REAUTH_EXPIRY"); await this.db.transaction(async (tx) => { const [owner] = await tx.select().from(adminUsers).where(and(eq(adminUsers.id, input.adminUserId), eq(adminUsers.active, true))).for("update").limit(1); const [activeSession] = await tx.select({ id: adminSessions.id }).from(adminSessions).where(and(eq(adminSessions.id, input.adminSessionId), isNull(adminSessions.revokedAt), isNull(adminSessions.archivedAt))).limit(1); if (!owner || !activeSession) throw new Error("ADMIN_INACTIVE"); const [row] = await tx.insert(adminReauthGrants).values(input).returning({ id: adminReauthGrants.id }); if (!row) throw new Error("REAUTH_GRANT_CREATE_FAILED"); await tx.insert(adminAudit).values({ adminUserId: input.adminUserId, adminSessionId: input.adminSessionId, action: "admin.reauth.issued", outcome: "success", details: { purpose: input.purpose } }); }); }
  async consumeReauthGrant(input: { tokenHash: string; adminUserId: string; adminSessionId: string; purpose: string; now: Date }) {
    if (!Number.isFinite(input.now.getTime())) throw new TypeError("INVALID_REAUTH_NOW"); return this.db.transaction(async (tx) => { const [row] = await tx.update(adminReauthGrants).set({ consumedAt: input.now }).where(and(eq(adminReauthGrants.tokenHash, input.tokenHash), eq(adminReauthGrants.adminUserId, input.adminUserId), eq(adminReauthGrants.adminSessionId, input.adminSessionId), eq(adminReauthGrants.purpose, input.purpose), isNull(adminReauthGrants.consumedAt), gt(adminReauthGrants.expiresAt, input.now), sql`exists(select 1 from admin_users u where u.id=${input.adminUserId} and u.active=true)`)).returning({ id: adminReauthGrants.id }); if (!row) return false; await tx.insert(adminAudit).values({ adminUserId: input.adminUserId, adminSessionId: input.adminSessionId, action: "admin.reauth.consumed", outcome: "success", details: { purpose: input.purpose } }); return true; });
  }
}
