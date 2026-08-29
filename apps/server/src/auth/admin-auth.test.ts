import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";
import { AdminAuthService, InMemoryAdminStore, registerAdminAuthRoutes } from "./admin-auth";

const ORIGIN = "https://tops.example.edu.hk";
async function fixture(now = Date.UTC(2026, 7, 29)) {
  let clock = now;
  const store = new InMemoryAdminStore();
  const auth = new AdminAuthService(store, {
    now: () => new Date(clock), allowedOrigins: [ORIGIN], secureCookies: true,
    tokenFactory: (() => { let n = 0; return () => Buffer.alloc(32, ++n).toString("base64url"); })(),
  });
  await auth.bootstrap("admin", "test-password-2026");
  const app = Fastify({ bodyLimit: 2048 });
  await app.register(fastifyCookie);
  registerAdminAuthRoutes(app, auth);
  await app.ready();
  return { app, auth, store, advance: (ms: number) => { clock += ms; } };
}
const headers = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" };

describe("admin authentication", () => {
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
    const status = await app.inject({ method: "GET", url: "/api/admin/session", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${cookie.name}=${cookie.value}` } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ username: "admin" });
    expect(status.json().csrfToken).toHaveLength(43);
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
    expect((await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "text/plain" }, payload: "x" })).statusCode).toBe(415);
  });

  it("requires a session-bound CSRF token for logout and rejects cross-session tokens", async () => {
    const { app } = await fixture();
    const login = async () => app.inject({ method: "POST", url: "/api/admin/login", headers, payload: { username: "admin", password: "test-password-2026" } });
    const a = await login(); const b = await login();
    const ac = a.cookies[0]!; const bc = b.cookies[0]!;
    const session = await app.inject({ method: "GET", url: "/api/admin/session", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${ac.name}=${ac.value}` } });
    const csrf = session.json().csrfToken;
    expect((await app.inject({ method: "POST", url: "/api/admin/logout", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${bc.name}=${bc.value}`, "x-csrf-token": csrf } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/admin/logout", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${ac.name}=${ac.value}`, "x-csrf-token": csrf } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/admin/session", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${ac.name}=${ac.value}` } })).statusCode).toBe(401);
  });

  it("expires at the exact idle boundary and never rolls beyond eight hours", async () => {
    const { app, advance } = await fixture();
    const login = await app.inject({ method: "POST", url: "/api/admin/login", headers, payload: { username: "admin", password: "test-password-2026" } });
    const cookie = login.cookies[0]!; const status = () => app.inject({ method: "GET", url: "/api/admin/session", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${cookie.name}=${cookie.value}` } });
    advance(30 * 60_000);
    expect((await status()).statusCode).toBe(401);
  });

  it("reauthenticates without creating a new session and audits without secrets", async () => {
    const { auth, store } = await fixture();
    expect(await auth.reauthenticate("admin", "test-password-2026", { clientKey: "2001:db8::1", ip: "2001:db8::1", userAgent: "test" })).toBe(true);
    expect(store.sessionCount).toBe(0);
    const serialized = JSON.stringify(store.auditEntries);
    expect(serialized).not.toContain("test-password-2026");
    expect(serialized).not.toContain("csrf");
  });
});
