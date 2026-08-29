import { describe, expect, it } from "vitest";
import { analyticsFiltersSchema, hongKongDateBounds, normalizeUsageRows } from "./usage";
import { normalizeParameterRows } from "./parameters";
import { AnalyticsService, canonicalFilterHash, type AnalyticsCache } from "./service";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { AdminAuthService, InMemoryAdminStore, registerAdminAuthRoutes } from "../auth/admin-auth";
import { registerAnalyticsRoutes } from "./routes";

describe("analytics query contracts", () => {
  it("uses Hong Kong midnight while preserving UTC boundaries", () => {
    expect(hongKongDateBounds("2026-08-31", "2026-09-01")).toEqual({
      from: "2026-08-30T16:00:00.000Z",
      toExclusive: "2026-09-01T16:00:00.000Z",
    });
  });

  it("rejects inverted, overlong and unknown filters", () => {
    expect(() => analyticsFiltersSchema.parse({ from: "2026-09-02", to: "2026-09-01" })).toThrow();
    expect(() => analyticsFiltersSchema.parse({ from: "2020-01-01", to: "2026-09-01" })).toThrow();
    expect(() => analyticsFiltersSchema.parse({ from: "2026-09-01", to: "2026-09-01", secret: true })).toThrow();
  });

  it("normalizes usage counters and shape proportions without leaking identity fields", () => {
    expect(normalizeUsageRows([{ localDate: "2026-08-31", activeDevices: "2", designCount: "3", roomCount: "1", completedMatchCount: "4", shape: "star", shapeCount: "6", totalShapeCount: "9" }])).toEqual([{
      date: "2026-08-31", activeDevices: 2, designs: 3, rooms: 1, completedMatches: 4,
      shapes: [{ shape: "star", count: 6, proportion: 2 / 3 }],
    }]);
  });

  it("drops parameter groups below ten completed matches and maps launch distribution", () => {
    const result = normalizeParameterRows([
      { position: "top", shape: "star", points: 8, diameterMm: "70", cornerRoundness: "0.2", screwCount: 6, metalDiscDiameterMm: "30", sampleSize: "10", averageScore: "1.75", winRate: "0.6", opponentAverageStrength: "1.4", perfectCount: "7", greatCount: "6", goodCount: "5", missCount: "2" },
      { position: "top", shape: "circle", points: 16, diameterMm: "60", cornerRoundness: "1", screwCount: 4, metalDiscDiameterMm: "0", sampleSize: "9", averageScore: "2", winRate: "1", opponentAverageStrength: "1", perfectCount: "9", greatCount: "0", goodCount: "0", missCount: "0" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sampleSize: 10, averageScore: 1.75, winRate: 0.6, launchGrades: { Perfect: 7, Great: 6, Good: 5, Miss: 2 } });
    expect(Object.keys(result[0] ?? {})).not.toContain("studentName");
  });
});

describe("analytics summary cache", () => {
  it("uses a stable hash independent of optional property insertion order", () => {
    expect(canonicalFilterHash({ from: "2026-08-01", to: "2026-08-31", className: "1A", identityStatus: "iclass" }))
      .toBe(canonicalFilterHash({ identityStatus: "iclass", className: "1A", to: "2026-08-31", from: "2026-08-01" }));
  });

  it("coalesces refreshes and returns a fresh cached summary", async () => {
    let writes = 0;
    const cache: AnalyticsCache = { read: async () => null, write: async () => { writes += 1; } };
    let usageRuns = 0;
    const service = new AnalyticsService(cache, async () => { usageRuns += 1; return []; }, async () => []);
    await Promise.all([service.refreshDefaultWindow(new Date("2026-08-29T02:00:00Z")), service.refreshDefaultWindow(new Date("2026-08-29T02:00:00Z"))]);
    expect({ writes, usageRuns }).toEqual({ writes: 1, usageRuns: 3 });
  });
});

it("exposes analytics only through an authenticated teacher read endpoint", async () => {
  const origin = "https://tops.example.edu.hk"; const store = new InMemoryAdminStore();
  const auth = new AdminAuthService(store, { allowedOrigins: [origin], secureCookies: true, csrfSecret: Buffer.alloc(32, 9) });
  await auth.bootstrap("admin", "test-password-2026");
  const cache: AnalyticsCache = { read: async () => null, write: async () => undefined };
  const analytics = new AnalyticsService(cache, async () => [], async () => []);
  const app = Fastify(); await app.register(fastifyCookie); registerAdminAuthRoutes(app, auth); registerAnalyticsRoutes(app, auth, analytics); await app.ready();
  const query = "/api/admin/analytics?from=2026-08-01&to=2026-08-31";
  expect((await app.inject({ method: "GET", url: query, headers: { host: "tops.example.edu.hk", "sec-fetch-site": "same-origin" } })).statusCode).toBe(401);
  const login = await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin, host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", "content-type": "application/json" }, payload: { username: "admin", password: "test-password-2026" } });
  const cookie = login.cookies[0]!; const adminHeaders = { host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", cookie: `${cookie.name}=${cookie.value}` };
  const response = await app.inject({ method: "GET", url: query, headers: adminHeaders });
  expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store"); expect(response.body).not.toContain("studentName");
  expect((await app.inject({ method: "GET", url: "/api/admin/analytics?from=2026-09-01&to=2026-08-01", headers: adminHeaders })).statusCode).toBe(400);
  await app.close();
});
