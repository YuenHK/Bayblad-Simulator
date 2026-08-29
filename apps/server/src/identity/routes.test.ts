import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BattleEnginePort } from "../app";
import { IdentityResolver, InMemoryIdentityStore } from "./resolver";
import { PostgresIdentityStore } from "./postgres-store";
import { hashIdentityToken } from "./cookie";
import { ImportedDeviceMapAdapter } from "./iclass-adapter";
import { InMemoryTokenNonceStore, WebClipTokenService } from "./webclip-token";

const battleEngine: BattleEnginePort = { simulationCount: 0, simulateOnceAsync: async () => { throw new Error("unused"); }, cleanup: () => false };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("identity routes", () => {
  it("exchanges an opaque Web Clip token and immediately redirects to a clean URL", async () => {
    const adapter = new ImportedDeviceMapAdapter();
    await adapter.replaceFromCsv("externalDeviceId,deviceName,studentName,className,studentNumber\nipad-001,1A-iPad-01,陳同學,1A,01");
    const tokens = new WebClipTokenService({ keys: { k1: new Uint8Array(32).fill(1) }, activeKeyId: "k1", audience: "steam-top", nonceStore: new InMemoryTokenNonceStore() });
    const token = await tokens.issue("ipad-001");
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), iClassAdapter: adapter, webClipTokens: tokens, sweepIntervalMs: 0 }); apps.push(app);
    const response = await app.inject({ method: "GET", url: `/start?t=${encodeURIComponent(token)}` });
    expect(response).toMatchObject({ statusCode: 303, headers: { location: "/", "referrer-policy": "no-referrer", "cache-control": "no-store" } });
    const cookie = response.cookies[0]!;
    const identity = await app.inject({ method: "GET", url: "/api/identity", headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(identity.json()).toMatchObject({ status: "cookie", displayName: "陳同學" });
    expect(response.body).not.toContain(token);
    const replay = await app.inject({ method: "GET", url: `/start?t=${encodeURIComponent(token)}` });
    expect(replay.statusCode).toBe(303);
    expect(replay.cookies[0]).toBeDefined();
  });
  it("automatically creates and then reuses an identity without collecting a name", async () => {
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), sweepIntervalMs: 0 }); apps.push(app);
    const first = await app.inject({ method: "GET", url: "/api/identity" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "guest", displayName: expect.stringMatching(/^訪客-/) });
    expect(first.json()).not.toHaveProperty("cookieToken");
    expect(Object.keys(first.json()).sort()).toEqual(["displayName", "id", "status"]);
    const cookie = first.cookies.find((item) => item.name === "steam_top_identity")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
    const second = await app.inject({ method: "GET", url: "/api/identity", headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(second.json()).toEqual(first.json());
  });

  it("revokes and clears the current cookie", async () => {
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), sweepIntervalMs: 0 }); apps.push(app);
    const first = await app.inject({ method: "GET", url: "/api/identity" });
    const cookie = first.cookies[0]!;
    const logout = await app.inject({ method: "POST", url: "/api/identity/logout", headers: { cookie: `${cookie.name}=${cookie.value}`, "x-steam-top-action": "logout" } });
    expect(logout.statusCode).toBe(204);
    expect(logout.cookies[0]).toMatchObject({ name: "steam_top_identity", value: "", maxAge: 0 });
  });

  it("derives Max-Age from the resolver expiry instead of a fixed lifetime", async () => {
    const fixed = new Date("2026-08-29T00:00:00Z");
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore(), { now: () => fixed, lifetimeMs: 86_412_345 }), now: () => fixed.getTime(), sweepIntervalMs: 0 }); apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/identity" });
    expect(response.cookies[0]).toMatchObject({ maxAge: 86_412, expires: new Date(fixed.getTime() + 86_412_000) });
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

  it("bounds no-cookie creation churn while preserving the normal school NAT burst", async () => {
    let clock = 0;
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore({ maxSessions: 700 })), now: () => clock, sweepIntervalMs: 0 }); apps.push(app);
    const responses = [];
    for (let index = 0; index < 601; index += 1) responses.push(await app.inject({ method: "GET", url: "/api/identity" }));
    expect(responses.slice(0, 600).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[600]?.statusCode).toBe(429);
    clock += 100_000;
    expect((await app.inject({ method: "GET", url: "/api/identity" })).statusCode).toBe(200);
  });

  it("rejects cross-site identity writes and logout without action header", async () => {
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), sweepIntervalMs: 0 }); apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/identity", headers: { "sec-fetch-site": "cross-site" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/identity", headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/identity/logout" })).statusCode).toBe(403);
  });

  it("writes only a validated address from the dedicated trusted proxy resolver", async () => {
    const store = new InMemoryIdentityStore();
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(store), behindProxy: true, clientKeyResolver: () => "device-key", identityIpResolver: () => "not-an-ip-device-id", sweepIntervalMs: 0 }); apps.push(app);
    const invalid = await app.inject({ method: "GET", url: "/api/identity" });
    const invalidSession = await store.findSession(hashIdentityToken(invalid.cookies[0]!.value));
    expect(invalidSession?.lastIp).toBeUndefined();
    await app.close(); apps.splice(apps.indexOf(app), 1);

    const validStore = new InMemoryIdentityStore();
    const validApp = buildApp({ battleEngine, identityResolver: new IdentityResolver(validStore), behindProxy: true, clientKeyResolver: () => "device-key", identityIpResolver: () => "2001:db8::7", sweepIntervalMs: 0 }); apps.push(validApp);
    const valid = await validApp.inject({ method: "GET", url: "/api/identity" });
    const validSession = await validStore.findSession(hashIdentityToken(valid.cookies[0]!.value));
    expect(validSession?.lastIp).toBe("2001:db8::7");
  });
});
