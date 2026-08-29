import type { DatabaseClient } from "@steam-top/db";
import type { FastifyInstance } from "fastify";
import { EXPECTED_MIGRATION_ID, EXPECTED_MIGRATION_SHA256 } from "./migration-runner";

export type ReadinessResult = Readonly<{ database: "ok"; migration: "ok" }>;
export const READINESS_DEADLINE_MS = 3_000;

const readinessSql = `
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
`;

export async function checkDatabaseReadiness(sql: DatabaseClient["sql"], signal?: AbortSignal): Promise<ReadinessResult> {
  if (signal?.aborted) throw new Error("READINESS_ABORTED");
  const runQuery = async (runner: Pick<DatabaseClient["sql"], "unsafe">) => {
    const query = runner.unsafe(readinessSql);
    const cancel = () => { const cancellable = query as unknown as { cancel?: () => Promise<unknown> | undefined }; const cancellation = cancellable.cancel?.(); if (cancellation) void cancellation.catch(() => undefined); };
    signal?.addEventListener("abort", cancel, { once: true });
    try { return await query as readonly Record<string, unknown>[]; }
    finally { signal?.removeEventListener("abort", cancel); }
  };
  const transaction = (sql as unknown as { begin?: <T>(operation: (runner: DatabaseClient["sql"]) => Promise<T>) => Promise<T> }).begin;
  const rows = (transaction
    ? await transaction.call(sql, async (runner) => { await runner.unsafe(`set local statement_timeout = '${READINESS_DEADLINE_MS}ms'`); return runQuery(runner); })
    : await runQuery(sql)) as readonly Record<string, unknown>[];
  if (Number(rows[0]?.database_ok) !== 1) throw new Error("DATABASE_NOT_READY");
  if (rows[0]?.migration_ok !== true || rows[0]?.migration_id !== EXPECTED_MIGRATION_ID || rows[0]?.migration_sha256 !== EXPECTED_MIGRATION_SHA256) throw new Error("MIGRATION_NOT_READY");
  return Object.freeze({ database: "ok", migration: "ok" });
}

export async function withReadinessDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = READINESS_DEADLINE_MS): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("INVALID_READINESS_DEADLINE");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("READINESS_TIMEOUT")); }, timeoutMs); });
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]); }
  finally { if (timer) clearTimeout(timer); }
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
  check: (signal: AbortSignal) => Promise<ReadinessResult>;
  markUnhealthy: (error: unknown) => void;
  stop: () => Promise<void>;
  reportStopFailure: (error: unknown) => void;
  intervalMs?: number;
  timeoutMs?: number;
}>): () => void {
  let stopped = false, inFlight = false, timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { if (stopped) return; timer = setTimeout(() => { void run(); }, input.intervalMs ?? 5_000); timer.unref(); };
  const run = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try { await withReadinessDeadline(input.check, input.timeoutMs); if (!stopped) schedule(); }
    catch (error) { if (!stopped) { stopped = true; input.markUnhealthy(error); try { await input.stop(); } catch (stopError) { input.reportStopFailure(stopError); } } }
    finally { inFlight = false; }
  };
  schedule();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
