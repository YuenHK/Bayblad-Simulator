import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BattleEnginePort } from "../app";
import { IdentityResolver, InMemoryIdentityStore } from "./resolver";
import { PostgresIdentityStore } from "./postgres-store";

const battleEngine: BattleEnginePort = { simulationCount: 0, simulateOnceAsync: async () => { throw new Error("unused"); }, cleanup: () => false };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("identity routes", () => {
  it("automatically creates and then reuses an identity without collecting a name", async () => {
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), sweepIntervalMs: 0 }); apps.push(app);
    const first = await app.inject({ method: "GET", url: "/api/identity" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "guest", displayName: expect.stringMatching(/^訪客-/) });
    expect(first.json()).not.toHaveProperty("cookieToken");
    const cookie = first.cookies.find((item) => item.name === "steam_top_identity")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
    const second = await app.inject({ method: "GET", url: "/api/identity", headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(second.json()).toEqual(first.json());
  });

  it("revokes and clears the current cookie", async () => {
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), sweepIntervalMs: 0 }); apps.push(app);
    const first = await app.inject({ method: "GET", url: "/api/identity" });
    const cookie = first.cookies[0]!;
    const logout = await app.inject({ method: "POST", url: "/api/identity/logout", headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(logout.statusCode).toBe(204);
    expect(logout.cookies[0]).toMatchObject({ name: "steam_top_identity", value: "", maxAge: 0 });
  });

  it("derives Max-Age from the resolver expiry instead of a fixed lifetime", async () => {
    const fixed = new Date("2026-08-29T00:00:00Z");
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore(), { now: () => fixed, lifetimeMs: 12_345 }), now: () => fixed.getTime(), sweepIntervalMs: 0 }); apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/identity" });
    expect(response.cookies[0]).toMatchObject({ maxAge: 12, expires: new Date(fixed.getTime() + 12_000) });
  });

  it("rejects absent or memory identity stores in production", () => {
    const previous = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try {
      expect(() => buildApp({ battleEngine, allowedOrigins: ["https://school.example"] })).toThrow(/persistent identityResolver/);
      expect(() => buildApp({ battleEngine, allowedOrigins: ["https://school.example"], identityResolver: new IdentityResolver(new InMemoryIdentityStore()) })).toThrow(/persistent identityResolver/);
    } finally { process.env.NODE_ENV = previous; }
  });

  it("accepts the branded durable Postgres adapter in production", async () => {
    const previous = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try {
      const durable = new PostgresIdentityStore(null as never);
      const app = buildApp({ battleEngine, allowedOrigins: ["https://school.example"], identityResolver: new IdentityResolver(durable), sweepIntervalMs: 0 });
      apps.push(app);
      expect(app).toBeDefined();
    } finally { process.env.NODE_ENV = previous; }
  });
});
