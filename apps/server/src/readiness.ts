import type { DatabaseClient } from "@steam-top/db";
import type { FastifyInstance } from "fastify";

export type ReadinessResult = Readonly<{ database: "ok"; migration: "ok" }>;

export async function checkDatabaseReadiness(sql: DatabaseClient["sql"]): Promise<ReadinessResult> {
  const rows = await sql.unsafe(`
    select 1 as database_ok,
      to_regclass('public.identities') is not null
      and to_regclass('public.matches') is not null
      and to_regclass('public.admin_users') is not null
      and to_regclass('restore_control.deployment_environment') is not null
      as migration_ok
  `) as readonly Record<string, unknown>[];
  if (Number(rows[0]?.database_ok) !== 1) throw new Error("DATABASE_NOT_READY");
  if (rows[0]?.migration_ok !== true) throw new Error("MIGRATION_NOT_READY");
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
