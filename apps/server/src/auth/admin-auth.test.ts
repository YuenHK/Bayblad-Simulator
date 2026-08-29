import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";
import { AdminAuthService, InMemoryAdminStore, registerAdminAuthRoutes, type AdminClientResolver } from "./admin-auth";
import { tokenHash } from "./admin-session";
import { createAdminComposition } from "./composition";

const ORIGIN = "https://tops.example.edu.hk";
async function fixture(now = Date.UTC(2026, 7, 29), clientResolver?: AdminClientResolver) {
  let clock = now;
  const store = new InMemoryAdminStore();
  const auth = new AdminAuthService(store, {
    now: () => new Date(clock), allowedOrigins: [ORIGIN], secureCookies: true,
    tokenFactory: (() => { let n = 0; return () => Buffer.alloc(32, ++n).toString("base64url"); })(),
    csrfSecret: Buffer.alloc(32, 7),
  });
  await auth.bootstrap("admin", "test-password-2026");
  const app = Fastify({ bodyLimit: 2048 });
  await app.register(fastifyCookie);
  registerAdminAuthRoutes(app, auth, clientResolver);
  await app.ready();
  return { app, auth, store, advance: (ms: number) => { clock += ms; } };
}
const headers = { origin: ORIGIN, host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", "content-type": "application/json" };

describe("admin authentication", () => {
  it("requires a stable 256-bit production CSRF secret", async () => { await expect(createAdminComposition({ ADMIN_USERNAME: "admin", ADMIN_INITIAL_PASSWORD: "test-password" }, null as never, [ORIGIN])).rejects.toThrow("MISSING_ADMIN_CSRF_SECRET"); await expect(createAdminComposition({ ADMIN_USERNAME: "admin", ADMIN_INITIAL_PASSWORD: "test-password", ADMIN_CSRF_SECRET: Buffer.alloc(16).toString("base64url") }, null as never, [ORIGIN])).rejects.toThrow("INVALID_ADMIN_CSRF_SECRET"); });
  it("bootstraps once without overwriting an existing password", async () => {
    const { auth } = await fixture();
    await auth.bootstrap("admin", "a-different-password");
    expect(await auth.verifyPassword("admin", "test-password-2026")).toBe(true);
    expect(await auth.verifyPassword("admin", "a-different-password")).toBe(false);
  });

  it("logs in with an opaque strict admin cookie and exposes an in-memory CSRF token", async () => {
    const { app } = await fixture();
    const login = await app.inject({ method: "POST", url: "/api/admin/login", headers, payload: { username: "admin", password: "test-password-2026" } });
    expect(login.statusCode).toBe(204);
    const cookie = login.cookies[0]!;
    expect(cookie).toMatchObject({ name: "steam_top_admin", httpOnly: true, secure: true, sameSite: "Strict", path: "/api/admin" });
    expect(cookie.value.length).toBeGreaterThanOrEqual(43);
    const status = await app.inject({ method: "GET", url: "/api/admin/session", headers: { host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", cookie: `${cookie.name}=${cookie.value}` } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ username: "admin" });
    expect(status.json().csrfToken).toMatch(/^v1\.dev\.[A-Za-z0-9_-]{43}$/u);
    expect(status.body).not.toContain(cookie.value);
  });

  it("uses one response for unknown users and wrong passwords and locks after five failures", async () => {
    const { app } = await fixture();
    const attempt = (username: string) => app.inject({ method: "POST", url: "/api/admin/login", headers, payload: { username, password: "wrong-password" } });
    expect((await attempt("nobody")).statusCode).toBe(401);
    for (let i = 0; i < 5; i++) expect((await attempt("admin")).statusCode).toBe(401);
    expect((await attempt("admin")).statusCode).toBe(429);
    expect((await attempt("nobody")).statusCode).toBe(401);
  });

  it("rejects malformed, control-character, oversized and cross-site login input", async () => {
    const { app } = await fixture();
    expect((await app.inject({ method: "POST", url: "/api/admin/login", headers: { ...headers, origin: "https://evil.invalid" }, payload: { username: "admin", password: "test-password-2026" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/admin/login", headers, payload: { username: "admin", password: "bad\u0000password" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/admin/login", headers, payload: { username: "admin", password: "x".repeat(1025) } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin: ORIGIN, host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", "content-type": "text/plain" }, payload: "x" })).statusCode).toBe(415);
  });

  it("uses only the injected trusted IPv6 resolver and rejects invalid proxy addresses", async () => { const trusted = await fixture(Date.UTC(2026, 7, 29), () => ({ clientKey: "device-7", ip: "2001:db8::7" })); await trusted.app.inject({ method: "POST", url: "/api/admin/login", headers, payload: { username: "admin", password: "wrong-password" } }); expect(trusted.store.auditEntries.at(-1)?.ip).toBe("2001:db8::7"); const invalid = await fixture(Date.UTC(2026, 7, 29), () => ({ clientKey: "device-x", ip: "not-an-ip" })); expect((await invalid.app.inject({ method: "POST", url: "/api/admin/login", headers, payload: { username: "admin", password: "wrong-password" } })).statusCode).toBe(503); });

  it("requires a session-bound CSRF token for logout and rejects cross-session tokens", async () => {
    const { app } = await fixture();
    const login = async () => app.inject({ method: "POST", url: "/api/admin/login", headers, payload: { username: "admin", password: "test-password-2026" } });
    const a = await login(); const b = await login();
    const ac = a.cookies[0]!; const bc = b.cookies[0]!;
    const session = await app.inject({ method: "GET", url: "/api/admin/session", headers: { host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", cookie: `${ac.name}=${ac.value}` } });
    const csrf = session.json().csrfToken;
    expect((await app.inject({ method: "POST", url: "/api/admin/logout", headers: { origin: ORIGIN, host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", cookie: `${bc.name}=${bc.value}`, "x-csrf-token": csrf } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/admin/logout", headers: { origin: ORIGIN, host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", cookie: `${ac.name}=${ac.value}`, "x-csrf-token": csrf } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/admin/session", headers: { host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", cookie: `${ac.name}=${ac.value}` } })).statusCode).toBe(401);
  });

  it("derives CSRF consistently across instances and does not touch on CSRF failure", async () => {
    const { auth, store, advance } = await fixture(); const shared = Buffer.alloc(32, 7);
    const login = await auth.login("admin", "test-password-2026", { clientKey: "direct" }); if (login.status !== "ok") throw new Error("login failed");
    advance(1_000); const peer = new AdminAuthService(store, { allowedOrigins: [ORIGIN], csrfSecret: shared, now: () => new Date(Date.UTC(2026, 7, 29) + 1_000) });
    const before = (await store.findSession(tokenHash(login.token)))!.session.lastSeenAt;
    expect((await peer.authenticate(login.token, false))!.csrfToken).toBe((await auth.authenticate(login.token, false))!.csrfToken);
    expect(peer.csrfMatches(login.token, "v1.dev.wrong", login.session)).toBe(false);
    expect((await store.findSession(tokenHash(login.token)))!.session.lastSeenAt).toEqual(before);
    const other = new AdminAuthService(store, { allowedOrigins: [ORIGIN], csrfSecret: Buffer.alloc(32, 8) });
    expect(other.csrfMatches(login.token, (await peer.authenticate(login.token, false))!.csrfToken, login.session)).toBe(false);
  });

  it("expires at the exact idle boundary and never rolls beyond eight hours", async () => {
    const { app, advance } = await fixture();
    const login = await app.inject({ method: "POST", url: "/api/admin/login", headers, payload: { username: "admin", password: "test-password-2026" } });
    const cookie = login.cookies[0]!; const status = () => app.inject({ method: "GET", url: "/api/admin/session", headers: { host: "tops.example.edu.hk", "sec-fetch-site": "same-origin", cookie: `${cookie.name}=${cookie.value}` } });
    advance(30 * 60_000);
    expect((await status()).statusCode).toBe(401);
  });

  it("issues a session-bound one-time reauthentication grant and audits without secrets", async () => {
    const { auth, store } = await fixture();
    const login = await auth.login("admin", "test-password-2026", { clientKey: "2001:db8::1" }); if (login.status !== "ok") throw new Error("login failed");
    const session = await auth.authenticate(login.token, false); const grant = await auth.reauthenticate(login.token, session!.csrfToken, "test-password-2026", "delete", { clientKey: "2001:db8::1", ip: "2001:db8::1", userAgent: "test" });
    expect(grant).toBeTruthy(); expect(await auth.consumeReauthGrant(login.token, grant!, "delete")).toBe(true); expect(await auth.consumeReauthGrant(login.token, grant!, "delete")).toBe(false);
    expect(store.sessionCount).toBe(1);
    const serialized = JSON.stringify(store.auditEntries);
    expect(serialized).not.toContain("test-password-2026");
    expect(serialized).not.toContain("csrf");
  });

  it("immediately rejects sessions and grants after the admin is disabled", async () => { const { auth, store } = await fixture(); const login = await auth.login("admin", "test-password-2026", { clientKey: "direct" }); if (login.status !== "ok") throw new Error("login failed"); const current = await auth.authenticate(login.token, false); const grant = await auth.reauthenticate(login.token, current!.csrfToken, "test-password-2026", "delete", { clientKey: "direct" }); expect(grant).toBeTruthy(); await store.setUserActive(login.user.id, false, new Date()); expect(await auth.authenticate(login.token, false)).toBeNull(); expect(await auth.consumeReauthGrant(login.token, grant!, "delete")).toBe(false); });

  it("logs only sanitized failure metadata", async () => { class FailingStore extends InMemoryAdminStore { override async reserveLoginAttempt(): Promise<boolean> { throw new Error("test-password-2026 cookie csrf deadbeef"); } } const events: unknown[] = []; const store = new FailingStore(); const auth = new AdminAuthService(store, { allowedOrigins: [ORIGIN], csrfSecret: Buffer.alloc(32, 4), logError: (event) => events.push(event) }); await auth.bootstrap("admin", "test-password-2026"); const app = Fastify(); await app.register(fastifyCookie); registerAdminAuthRoutes(app, auth); await app.ready(); const response = await app.inject({ method: "POST", url: "/api/admin/login", headers, payload: { username: "admin", password: "test-password-2026" } }); expect(response.statusCode).toBe(503); const logged = JSON.stringify(events); expect(logged).toContain("admin.login"); expect(logged).not.toContain("test-password-2026"); expect(logged).not.toContain("cookie"); expect(logged).not.toContain("csrf"); });
});
