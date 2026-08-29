import { and, count, eq, gt, gte, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "@steam-top/db";
import { adminAudit, adminSessions, adminUsers } from "@steam-top/db/schema";
import type { AdminSession, AdminStore, AdminUser, AuditInput } from "./admin-auth";
import { ADMIN_IDLE_MS } from "./admin-session";

type Db = DatabaseClient["db"];
const user = (row: typeof adminUsers.$inferSelect): AdminUser => ({ id: row.id, username: row.username, passwordHash: row.passwordHash, active: row.active });
const session = (row: typeof adminSessions.$inferSelect): AdminSession => ({ id: row.id, adminUserId: row.adminUserId, tokenHash: row.tokenHash, csrfTokenHash: row.csrfTokenHash, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, absoluteExpiresAt: row.expiresAt, ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}) });

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
  async createSession(input: Omit<AdminSession, "id">) { const [row] = await this.db.insert(adminSessions).values({ adminUserId: input.adminUserId, tokenHash: input.tokenHash, csrfTokenHash: input.csrfTokenHash, createdAt: input.createdAt, lastSeenAt: input.lastSeenAt, expiresAt: input.absoluteExpiresAt, revokedAt: input.revokedAt ?? null }).returning(); if (!row) throw new Error("ADMIN_SESSION_CREATE_FAILED"); return session(row); }
  async findSession(value: string) { const [row] = await this.db.select({ session: adminSessions, user: adminUsers }).from(adminSessions).innerJoin(adminUsers, eq(adminSessions.adminUserId, adminUsers.id)).where(eq(adminSessions.tokenHash, value)).limit(1); return row ? { session: session(row.session), user: user(row.user) } : null; }
  async touchSession(value: string, now: Date) {
    return this.db.transaction(async (tx) => {
      const idleAfter = new Date(now.getTime() - ADMIN_IDLE_MS);
      const [updated] = await tx.update(adminSessions).set({ lastSeenAt: now, updatedAt: now }).where(and(eq(adminSessions.tokenHash, value), isNull(adminSessions.revokedAt), gt(adminSessions.expiresAt, now), gt(adminSessions.lastSeenAt, idleAfter))).returning();
      if (!updated) { await tx.update(adminSessions).set({ revokedAt: now, updatedAt: now }).where(and(eq(adminSessions.tokenHash, value), isNull(adminSessions.revokedAt), sql`(${adminSessions.expiresAt} <= ${now} or ${adminSessions.lastSeenAt} <= ${idleAfter})`)); return null; }
      const [owner] = await tx.select().from(adminUsers).where(and(eq(adminUsers.id, updated.adminUserId), eq(adminUsers.active, true))).limit(1);
      return owner ? { session: session(updated), user: user(owner) } : null;
    });
  }
  async revokeSession(value: string, now: Date) { const rows = await this.db.update(adminSessions).set({ revokedAt: now, updatedAt: now }).where(and(eq(adminSessions.tokenHash, value), isNull(adminSessions.revokedAt))).returning({ id: adminSessions.id }); return rows.length === 1; }
  async audit(input: AuditInput) { await this.db.insert(adminAudit).values({ adminUserId: input.adminUserId ?? null, adminSessionId: input.adminSessionId ?? null, action: input.action, outcome: input.outcome, requestIp: input.ip ?? null, userAgent: input.userAgent?.slice(0, 512) ?? null, details: input.details ?? {} }); }
  async loginAllowed(keys: { accountHash: string; clientHash: string }, now: Date) {
    const lockStart = new Date(now.getTime() - 15 * 60_000); const globalStart = new Date(now.getTime() - 60_000);
    const [row] = await this.db.select({ account: count(sql`case when ${adminAudit.outcome} = 'failure' and ${adminAudit.details}->>'accountHash' = ${keys.accountHash} and ${adminAudit.createdAt} >= ${lockStart} then 1 end`), client: count(sql`case when ${adminAudit.outcome} = 'failure' and ${adminAudit.details}->>'clientHash' = ${keys.clientHash} and ${adminAudit.createdAt} >= ${lockStart} then 1 end`), global: count(sql`case when ${adminAudit.createdAt} >= ${globalStart} and ${adminAudit.action} in ('admin.login','admin.login.locked') then 1 end`) }).from(adminAudit).where(gte(adminAudit.createdAt, lockStart));
    return (row?.account ?? 0) < 5 && (row?.client ?? 0) < 20 && (row?.global ?? 0) < 200;
  }
}
