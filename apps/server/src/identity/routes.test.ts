import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BattleEnginePort } from "../app";
import { IdentityResolver, InMemoryIdentityStore } from "./resolver";
import { PostgresIdentityStore } from "./postgres-store";
import { PostgresDesignRepository } from "../records/design-repository";
import { PostgresMatchRepository } from "../records/match-repository";
import { PostgresRoomRecordRepository } from "../records/room-repository";
import { PostgresRoomProjectionStore } from "../records/room-projection-store";
import { PostgresBattleResultRepository } from "../records/battle-result-repository";
import { AdminAuthService } from "../auth/admin-auth";
import { PostgresAdminStore } from "../auth/postgres-admin-store";
import { PostgresPlatformSettingsStore } from "../admin/platform-settings";
import { PostgresAdminCommandStore } from "../admin/command-operations";
import { hashIdentityToken } from "./cookie";
import { ApiIClassAdapter, FallbackIClassAdapter, ImportedDeviceMapAdapter } from "./iclass-adapter";
import { InMemoryTokenNonceStore, WebClipTokenService } from "./webclip-token";
import { StudentCredentialService } from "./student-credential";

const battleEngine: BattleEnginePort = { simulationCount: 0, simulateOnceAsync: async () => { throw new Error("unused"); }, cleanup: () => false };
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
async function exchange(app: ReturnType<typeof buildApp>, token: string, identityCookie?: string) {
  const first = await app.inject({ method:"GET", url:`/start?t=${encodeURIComponent(token)}`, ...(identityCookie ? {headers:{cookie:identityCookie}} : {}) });
  const attempt = first.cookies.find(c=>c.name==="steam_top_webclip_attempt")!;
  return app.inject({ method:"GET", url:`/start?t=${encodeURIComponent(token)}`, headers:{cookie:[identityCookie,`${attempt.name}=${attempt.value}`].filter(Boolean).join("; ")} });
}

describe("identity routes", () => {
  it("exchanges an opaque Web Clip token and immediately redirects to a clean URL", async () => {
    const adapter = new ImportedDeviceMapAdapter();
    await adapter.replaceFromCsv("externalDeviceId,deviceName,studentName,className,studentNumber\nipad-001,1A-iPad-01,陳同學,1A,01");
    const tokens = new WebClipTokenService({ keys: { k1: new Uint8Array(32).fill(1) }, activeKeyId: "k1", audience: "steam-top", nonceStore: new InMemoryTokenNonceStore() });
    const token = await tokens.issue("ipad-001");
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), iClassAdapter: adapter, webClipTokens: tokens, sweepIntervalMs: 0 }); apps.push(app);
    const response = await exchange(app, token);
    expect(response).toMatchObject({ statusCode: 303, headers: { location: "/", "referrer-policy": "no-referrer", "cache-control": "no-store" } });
    const cookie = response.cookies[0]!;
    const identity = await app.inject({ method: "GET", url: "/api/identity", headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(identity.json()).toMatchObject({ status: "cookie", displayName: "陳同學" });
    expect(response.body).not.toContain(token);
    const replay = await exchange(app, token);
    expect(replay.statusCode).toBe(303);
    expect(replay.cookies.find(c=>c.name==="steam_top_identity")).toBeUndefined();
  });

  it("recovers a lost successful response without calling the adapter again", async () => {
    let calls=0, fail=false; const adapter={resolveDevice:async()=>{calls++;if(fail)throw new Error("adapter must not run");return{externalDeviceId:"ipad-lost",deviceName:"d",studentName:"陳同學",className:"1A",studentNumber:"01"};}};
    const tokens=new WebClipTokenService({keys:{k1:new Uint8Array(32).fill(11)},activeKeyId:"k1",audience:"steam-top",nonceStore:new InMemoryTokenNonceStore(),exchangeKey:new Uint8Array(32).fill(12)});const token=await tokens.issue("ipad-lost");
    const app=buildApp({battleEngine,identityResolver:new IdentityResolver(new InMemoryIdentityStore()),iClassAdapter:adapter,webClipTokens:tokens,sweepIntervalMs:0});apps.push(app);
    const stage=await app.inject({method:"GET",url:`/start?t=${token}`}),attempt=stage.cookies.find(c=>c.name==="steam_top_webclip_attempt")!,attemptCookie=`${attempt.name}=${attempt.value}`;
    const committed=await app.inject({method:"GET",url:`/start?t=${token}`,headers:{cookie:attemptCookie}}),firstIdentity=committed.cookies.find(c=>c.name==="steam_top_identity")!;expect(calls).toBe(1);
    fail=true;const recovered=await app.inject({method:"GET",url:`/start?t=${token}`,headers:{cookie:attemptCookie}}),secondIdentity=recovered.cookies.find(c=>c.name==="steam_top_identity")!;
    expect(calls).toBe(1);expect(secondIdentity.value).toBe(firstIdentity.value);
    const different=Buffer.alloc(32,99).toString("base64url");const replay=await app.inject({method:"GET",url:`/start?t=${token}`,headers:{cookie:`steam_top_webclip_attempt=${different}`}});expect(calls).toBe(1);expect(replay.cookies.find(c=>c.name==="steam_top_identity")).toBeUndefined();
  });

  it("does not consume a token on transient lookup failure, then upgrades the same guest cookie on retry", async () => {
    const store = new InMemoryIdentityStore(); let available = false;
    const adapter = { resolveDevice: async () => { if (!available) throw new Error("ICLASS_UNAVAILABLE"); return { externalDeviceId: "ipad-retry", deviceName: "d", studentName: "李同學", className: "1B", studentNumber: "02" }; } };
    const tokens = new WebClipTokenService({ keys: { k1: new Uint8Array(32).fill(2) }, activeKeyId: "k1", audience: "steam-top", nonceStore: new InMemoryTokenNonceStore() });
    const token = await tokens.issue("ipad-retry");
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(store), iClassAdapter: adapter, webClipTokens: tokens, sweepIntervalMs: 0 }); apps.push(app);
    const first = await app.inject({ method: "GET", url: `/start?t=${token}` }); const guestCookie = first.cookies[0]!;
    const guest = await app.inject({ method: "GET", url: "/api/identity", headers: { cookie: `${guestCookie.name}=${guestCookie.value}` } }); expect(guest.json().status).toBe("guest");
    available = true;
    const retry = await app.inject({ method: "GET", url: `/start?t=${token}`, headers: { cookie: `${guestCookie.name}=${guestCookie.value}` } }); const liveCookie = retry.cookies[0]!;
    expect(liveCookie.value).not.toBe(guestCookie.value);
    const upgraded = await app.inject({ method: "GET", url: "/api/identity", headers: { cookie: `${liveCookie.name}=${liveCookie.value}` } });
    expect(upgraded.json()).toMatchObject({ status: "cookie", displayName: "李同學" });
    expect(await store.findSession(hashIdentityToken(guestCookie.value))).toBeNull();
  });

  it("releases a reservation when identity persistence fails so the same token can retry", async () => {
    class FailOnceStore extends InMemoryIdentityStore { failed = false; override async upsertLiveSession(input: Parameters<InMemoryIdentityStore["upsertLiveSession"]>[0]) { if (!this.failed) { this.failed = true; throw new Error("database unavailable"); } return super.upsertLiveSession(input); } }
    const store = new FailOnceStore(); const resolver = new IdentityResolver(store); const guest = await resolver.resolve({});
    const tokens = new WebClipTokenService({ keys: { k1: new Uint8Array(32).fill(8) }, activeKeyId: "k1", audience: "steam-top", nonceStore: new InMemoryTokenNonceStore() }); const token = await tokens.issue("ipad-db-retry");
    const adapter = { resolveDevice: async () => ({ externalDeviceId: "ipad-db-retry", deviceName: "d", studentName: "吳同學", className: "1D", studentNumber: "04" }) };
    const app = buildApp({ battleEngine, identityResolver: resolver, iClassAdapter: adapter, webClipTokens: tokens, sweepIntervalMs: 0 }); apps.push(app);
    const firstStage = await app.inject({ method:"GET",url:`/start?t=${token}`,headers:{cookie:`steam_top_identity=${guest.cookieToken}`}}); const attempt=firstStage.cookies.find(c=>c.name==="steam_top_webclip_attempt")!;
    const combined=`steam_top_identity=${guest.cookieToken}; ${attempt.name}=${attempt.value}`;
    const failed = await app.inject({ method: "GET", url: `/start?t=${token}`, headers: { cookie:combined } }); expect(failed.statusCode).toBe(303);
    const retried = await app.inject({ method: "GET", url: `/start?t=${token}`, headers: { cookie:combined } }); const cookie = retried.cookies.find(c=>c.name==="steam_top_identity")!;
    const identity = await app.inject({ method: "GET", url: "/api/identity", headers: { cookie: `${cookie.name}=${cookie.value}` } }); expect(identity.json().displayName).toBe("吳同學");
  });

  it("does not create a guest for an unknown device and permits a later mapped retry", async () => {
    const tokens = new WebClipTokenService({ keys: { k1: new Uint8Array(32).fill(3) }, activeKeyId: "k1", audience: "steam-top", nonceStore: new InMemoryTokenNonceStore() });
    const token = await tokens.issue("unknown"); let known = false;
    const adapter = { resolveDevice: async () => known ? { externalDeviceId: "unknown", deviceName: "d", studentName: "X", className: "1A", studentNumber: "1" } : null };
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), iClassAdapter: adapter, webClipTokens: tokens, sweepIntervalMs: 0 }); apps.push(app);
    const first = await app.inject({ method: "GET", url: `/start?t=${token}` }); expect(first.cookies[0]).toBeDefined();
    known = true;
    const replay = await app.inject({ method: "GET", url: `/start?t=${token}`, headers: { cookie: `${first.cookies[0]!.name}=${first.cookies[0]!.value}` } });
    const identity = await app.inject({ method: "GET", url: "/api/identity", headers: { cookie: `${replay.cookies[0]!.name}=${replay.cookies[0]!.value}` } });
    expect(identity.json()).toMatchObject({status:"cookie",displayName:"X"});
  });

  it("upgrades through API-to-CSV fallback and permits only one winner after concurrent adapter lookups", async () => {
    const csv = new ImportedDeviceMapAdapter(); await csv.replaceFromCsv("externalDeviceId,deviceName,studentName,className,studentNumber\nipad-race,d,黃同學,1C,03");
    const api = new ApiIClassAdapter({ baseUrl: "https://iclass.example", bearerToken: "secret", fetcher: async () => new Response("down", { status: 503 }), maxAttempts: 1 });
    const fallback = new FallbackIClassAdapter(api, csv);
    const tokens = new WebClipTokenService({ keys: { k1: new Uint8Array(32).fill(5) }, activeKeyId: "k1", audience: "steam-top", nonceStore: new InMemoryTokenNonceStore() });
    const fallbackToken = await tokens.issue("ipad-race");
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), iClassAdapter: fallback, webClipTokens: tokens, sweepIntervalMs: 0 }); apps.push(app);
    const viaCsv = await exchange(app, fallbackToken);
    const csvIdentity = await app.inject({ method: "GET", url: "/api/identity", headers: { cookie: `${viaCsv.cookies[0]!.name}=${viaCsv.cookies[0]!.value}` } });
    expect(csvIdentity.json().displayName).toBe("黃同學");

    const raceToken = await tokens.issue("ipad-race");
    const stage=await app.inject({method:"GET",url:`/start?t=${raceToken}`});const attempt=stage.cookies.find(c=>c.name==="steam_top_webclip_attempt")!;const attemptCookie=`${attempt.name}=${attempt.value}`;
    const raced = await Promise.all([app.inject({ method: "GET", url: `/start?t=${raceToken}`,headers:{cookie:attemptCookie} }), app.inject({ method: "GET", url: `/start?t=${raceToken}`,headers:{cookie:attemptCookie} })]);
    expect(raced.filter((response) => response.cookies.some(c=>c.name==="steam_top_identity"))).toHaveLength(2);
    const winner = raced[0]!; const identityCookie=winner.cookies.find(c=>c.name==="steam_top_identity")!; const identity = await app.inject({ method: "GET", url: "/api/identity", headers: { cookie: `${identityCookie.name}=${identityCookie.value}` } }); expect(identity.json().displayName).toBe("黃同學");
  });

  it("does not create guest identities from invalid start tokens", async () => {
    const store = new InMemoryIdentityStore({ maxSessions: 700 }); let clock = 0;
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(store), behindProxy: true, clientKeyResolver: () => "managed-nat", identityIpResolver: () => "203.0.113.9", identityCreationBurst: 2, identityGlobalCreationBurst: 2, now: () => clock, sweepIntervalMs: 0 }); apps.push(app);
    const first = await app.inject({ method: "GET", url: "/start?t=invalid", headers: { "user-agent": "Managed iPad\u0000" } });
    const second = await app.inject({ method: "GET", url: "/start?t=invalid" });
    const blocked = await app.inject({ method: "GET", url: "/start?t=invalid" });
    expect([first, second, blocked].every((response) => response.statusCode === 303)).toBe(true);
    expect(first.cookies).toHaveLength(0); expect(second.cookies).toHaveLength(0); expect(blocked.cookies).toHaveLength(0);
    clock += 100_000;
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

  it("issues and resumes an opaque credential only for the exact student origin", async () => {
    const studentOrigin = "https://school.github.io";
    const studentCredentials = new StudentCredentialService({ keys: { primary: Buffer.alloc(32, 7) }, activeKeyId: "primary", origin: studentOrigin });
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new InMemoryIdentityStore()), allowedOrigins: ["https://api.example", studentOrigin], studentOrigin, studentCredentials, sweepIntervalMs: 0 }); apps.push(app);
    const first = await app.inject({ method: "GET", url: "/api/identity", headers: { origin: studentOrigin, "sec-fetch-site": "cross-site" } });
    expect(first.statusCode).toBe(200);
    expect(first.headers["access-control-allow-origin"]).toBe(studentOrigin);
    expect(first.headers.vary).toContain("Origin");
    expect(first.json()).toMatchObject({ status: "guest", studentCredential: expect.stringMatching(/^[A-Za-z0-9_.-]{80,2048}$/u) });
    expect(first.cookies).toHaveLength(0);
    const credential = first.json().studentCredential as string;
    const resumed = await app.inject({ method: "GET", url: "/api/identity", headers: { origin: studentOrigin, "sec-fetch-site": "cross-site", authorization: `Bearer ${credential}` } });
    expect(resumed.json()).toMatchObject({ id: first.json().id, studentCredential: credential });
    expect((await app.inject({ method: "GET", url: "/api/identity", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", authorization: `Bearer ${credential}` } })).statusCode).toBe(403);
    const preflight = await app.inject({ method: "OPTIONS", url: "/api/designs", headers: { origin: studentOrigin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    expect(preflight).toMatchObject({ statusCode: 204, headers: { "access-control-allow-origin": studentOrigin, "access-control-allow-methods": "POST", "access-control-allow-headers": "Authorization, Content-Type" } });
    const unauthorizedDesign = await app.inject({ method: "POST", url: "/api/designs", headers: { origin: studentOrigin, "content-type": "application/json", authorization: `Bearer ${credential}` }, payload: {} });
    expect(unauthorizedDesign.headers["access-control-allow-origin"]).toBe(studentOrigin);
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

  it("reports the original identity-store failure while keeping the public 503 generic", async () => {
    const failure = Object.assign(new Error("private database detail"), { code: "42703" });
    class FailingStore extends InMemoryIdentityStore {
      override async createGuestSession(): Promise<never> { throw failure; }
    }
    const logged: unknown[] = [];
    const app = buildApp({ battleEngine, identityResolver: new IdentityResolver(new FailingStore()), logError: (error) => logged.push(error), sweepIntervalMs: 0 }); apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/identity" });
    expect(response).toMatchObject({ statusCode: 503 });
    expect(response.json()).toEqual({ error: "IDENTITY_STORE_UNAVAILABLE" });
    expect(logged).toEqual([failure]);
    expect(response.body).not.toContain("private database detail");
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
      const adminAuth = new AdminAuthService(new PostgresAdminStore(null as never), { allowedOrigins: ["https://school.example"], csrfSecret: Buffer.alloc(32, 1), logError: () => undefined });
      const db = null as never;
      expect(() => buildApp({ battleEngine, adminAuth, allowedOrigins: ["https://school.example"] })).toThrow(/PostgreSQL stores/u);
      const app = buildApp({ battleEngine, resultRepository: new PostgresBattleResultRepository(db), designRepository: new PostgresDesignRepository(db), matchRepository: new PostgresMatchRepository(db), roomRecordRepository: new PostgresRoomRecordRepository(db), roomProjectionStore: new PostgresRoomProjectionStore(db), platformSettingsStore:new PostgresPlatformSettingsStore(db),adminCommandStore:new PostgresAdminCommandStore(db), allowedOrigins: ["https://school.example"], identityResolver: new IdentityResolver(durable), adminAuth, iClassStatus: "disabled", sweepIntervalMs: 0 });
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
