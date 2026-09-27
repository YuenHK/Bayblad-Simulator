import { describe, expect, it, vi } from "vitest";
import { adminRecordTimestamp, PostgresAdminRecordsSource, registerAdminRecordRoutes } from "./records-routes";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { AdminAuthService, InMemoryAdminStore } from "../auth/admin-auth";
import type { DatabaseClient } from "@steam-top/db";
import { readFileSync } from "node:fs";

describe("adminRecordTimestamp", () => {
  it("protects high-scoring designs with admin read auth and validates filters", async () => {
    const app = Fastify(), auth = new AdminAuthService(new InMemoryAdminStore(), { allowedOrigins: ["https://tops.example.edu.hk"], secureCookies: false });
    await auth.bootstrap("admin", "test-password-2026");
    const login = await auth.login("admin", "test-password-2026", { clientKey: "design-test" });
    if (login.status !== "ok") throw new Error("login failed");
    await app.register(fastifyCookie);
    const queryHighScoringDesigns = vi.fn(async (filters) => ({ rows: [], total: 0, page: filters.page, pageSize: filters.pageSize }));
    registerAdminRecordRoutes(app, auth, { query: async () => ({ rows: [], total: 0, page: 1, pageSize: 25 }), queryHighScoringDesigns });
    const headers = { host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", cookie: `steam_top_admin=${login.token}` };
    try {
      expect((await app.inject({ url: "/api/admin/high-scoring-designs", headers: { host: headers.host, "sec-fetch-site": "same-origin" } })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/admin/high-scoring-designs", headers: { ...headers, "sec-fetch-site": "cross-site" } })).statusCode).toBe(403);
      expect(queryHighScoringDesigns).not.toHaveBeenCalled();
      expect((await app.inject({ url: "/api/admin/high-scoring-designs?page=0", headers })).statusCode).toBe(400);
      const response = await app.inject({ url: "/api/admin/high-scoring-designs?from=2026-08-01&to=2026-08-03&className=1A&identity=Ada&device=Mac&parameter=custom&page=2&pageSize=10", headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(queryHighScoringDesigns).toHaveBeenCalledWith({ from: "2026-08-01", to: "2026-08-03", className: "1A", identity: "Ada", device: "Mac", parameter: "custom", page: 2, pageSize: 10 });
      queryHighScoringDesigns.mockRejectedValueOnce(new Error("offline"));
      expect((await app.inject({ url: "/api/admin/high-scoring-designs", headers })).statusCode).toBe(503);
    } finally { await app.close(); }
  });
  it("returns the true design count for an empty high-scoring page", async () => {
    const source = new PostgresAdminRecordsSource({ unsafe: async () => [{ designId: null, total: 12 }] } as unknown as DatabaseClient["sql"]);
    expect(typeof source.queryHighScoringDesigns).toBe("function");
    expect(await source.queryHighScoringDesigns({ page: 3, pageSize: 10 })).toEqual({ rows: [], total: 12, page: 3, pageSize: 10 });
  });
  it("preserves custom outlines in the teacher projection and omits meaningless point counts", () => {
    const source = readFileSync(new URL("./records-routes.ts", import.meta.url), "utf8");
    expect(source).toContain("'points',case when l.shape::text='custom' then null else l.points end");
    expect(source).toContain("jsonb_build_object('outline',l.outline)");
  });
  it("normalizes postgres timestamp strings to the protocol ISO form", () => {
    expect(adminRecordTimestamp("2026-08-31 15:24:42+00")).toBe("2026-08-31T15:24:42.000Z");
    expect(adminRecordTimestamp(new Date("2026-08-31T15:24:42Z"))).toBe("2026-08-31T15:24:42.000Z");
  });

  it("rejects invalid database timestamps", () => {
    expect(() => adminRecordTimestamp("not-a-date")).toThrow("INVALID_ADMIN_RECORD_TIMESTAMP");
  });
});
