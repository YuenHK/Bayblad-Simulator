import type { DatabaseClient } from "@steam-top/db";
import type { FastifyInstance } from "fastify";
import { EXPECTED_MIGRATION_ID, EXPECTED_MIGRATION_SHA256 } from "./migration-runner";

export type ReadinessResult = Readonly<{ database: "ok"; migration: "ok" }>;

export async function checkDatabaseReadiness(sql: DatabaseClient["sql"]): Promise<ReadinessResult> {
  const rows = await sql.unsafe(`
    select 1 as database_ok,
      to_regclass('public.identities') is not null
      and to_regclass('public.identity_sessions') is not null
      and to_regclass('public.designs') is not null
      and to_regclass('public.design_layers') is not null
      and to_regclass('public.rooms') is not null
      and to_regclass('public.room_participants') is not null
      and to_regclass('public.matches') is not null
      and to_regclass('public.rounds') is not null
      and to_regclass('public.admin_users') is not null
      and to_regclass('public.admin_sessions') is not null
      and to_regclass('public.admin_audit') is not null
      and to_regclass('public.analytics_daily_summaries') is not null
      and to_regclass('public.deletion_operations') is not null
      and to_regclass('restore_control.deployment_environment') is not null as migration_ok,
      migration.id as migration_id, migration.sha256 as migration_sha256
    from (select 1) probe
    left join public.app_schema_migrations migration on migration.id = '${EXPECTED_MIGRATION_ID.replaceAll("'", "''")}'
  `) as readonly Record<string, unknown>[];
  if (Number(rows[0]?.database_ok) !== 1) throw new Error("DATABASE_NOT_READY");
  if (rows[0]?.migration_ok !== true || rows[0]?.migration_id !== EXPECTED_MIGRATION_ID || rows[0]?.migration_sha256 !== EXPECTED_MIGRATION_SHA256) throw new Error("MIGRATION_NOT_READY");
  return Object.freeze({ database: "ok", migration: "ok" });
}

export function registerHealthRoutes(app: FastifyInstance, check: () => Promise<ReadinessResult>): void {
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      const detail = await check();
      return { status: "ready", ...detail };
    } catch {
      return reply.code(503).send({ status: "not-ready" });
    }
  });
}

export function startFailStopReadinessMonitor(input: Readonly<{
  check: () => Promise<ReadinessResult>;
  markUnhealthy: (error: unknown) => void;
  stop: () => Promise<void>;
  reportStopFailure: (error: unknown) => void;
  intervalMs?: number;
}>): () => void {
  let failed = false;
  const timer = setInterval(() => {
    void input.check().catch((error) => {
      if (failed) return;
      failed = true;
      input.markUnhealthy(error);
      void input.stop().catch(input.reportStopFailure);
    });
  }, input.intervalMs ?? 5_000);
  timer.unref();
  return () => clearInterval(timer);
}
