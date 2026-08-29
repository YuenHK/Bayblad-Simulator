import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { checkDatabaseReadiness, registerHealthRoutes } from "./readiness";

describe("production readiness", () => {
  it("checks database connectivity and the baseline migration", async () => {
    const sql = vi.fn(async () => [{ database_ok: 1, migration_ok: true }]);
    await expect(checkDatabaseReadiness({ unsafe: sql } as never)).resolves.toEqual({ database: "ok", migration: "ok" });
    expect(sql).toHaveBeenCalledOnce();
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
});
