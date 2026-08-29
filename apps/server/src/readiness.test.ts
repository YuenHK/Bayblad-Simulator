import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { checkDatabaseReadiness, registerHealthRoutes, startFailStopReadinessMonitor, withReadinessDeadline } from "./readiness";
import { EXPECTED_MIGRATION_ID, EXPECTED_MIGRATION_SHA256 } from "./migration-runner";

describe("production readiness", () => {
  it("checks database connectivity and the baseline migration", async () => {
    const sql = vi.fn(async () => [{ database_ok: 1, migration_ok: true, migration_id: EXPECTED_MIGRATION_ID, migration_sha256: EXPECTED_MIGRATION_SHA256 }]);
    await expect(checkDatabaseReadiness({ unsafe: sql } as never)).resolves.toEqual({ database: "ok", migration: "ok" });
    expect(sql).toHaveBeenCalledOnce();
  });

  it("rejects a stale migration hash even when required tables exist", async () => {
    const sql = vi.fn(async () => [{ database_ok: 1, migration_ok: true, migration_id: EXPECTED_MIGRATION_ID, migration_sha256: "0".repeat(64) }]);
    await expect(checkDatabaseReadiness({ unsafe: sql } as never)).rejects.toThrow("MIGRATION_NOT_READY");
  });

  it("returns 503 without leaking the database error until the database and migration are ready", async () => {
    const app = Fastify();
    registerHealthRoutes(app, async () => { throw new Error("postgresql://user:secret@db/private"); });
    await app.ready();
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "not-ready" });
    expect(ready.body).not.toContain("secret");
    await app.close();
  });

  it("fails stop exactly once after readiness is lost", async () => {
    vi.useFakeTimers();
    const markUnhealthy = vi.fn(), stop = vi.fn(async () => undefined), report = vi.fn();
    const cancel = startFailStopReadinessMonitor({ check: async () => { throw new Error("db lost"); }, markUnhealthy, stop, reportStopFailure: report, intervalMs: 100, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(300);
    expect(markUnhealthy).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
    cancel();
    vi.useRealTimers();
  });

  it("keeps at most one pending check and fail-stops a never-resolving query at its deadline", async () => {
    vi.useFakeTimers();
    let pending = 0, calls = 0;
    const stop = vi.fn(async () => undefined), mark = vi.fn();
    const cancel = startFailStopReadinessMonitor({
      check: async () => { calls++; pending++; return new Promise<never>(() => undefined); },
      markUnhealthy: mark,
      stop,
      reportStopFailure: vi.fn(),
      intervalMs: 20,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect({ calls, pending }).toEqual({ calls: 1, pending: 1 });
    expect(mark).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    cancel();
    vi.useRealTimers();
  });

  it("aborts startup readiness at the same bounded deadline", async () => {
    vi.useFakeTimers();
    const operation = withReadinessDeadline(async (signal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })), 100);
    const assertion = expect(operation).rejects.toThrow(/READINESS_TIMEOUT|cancelled/u);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    vi.useRealTimers();
  });
});
