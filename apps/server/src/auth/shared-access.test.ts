import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { expect, it } from "vitest";
import { AdminAuthService, InMemoryAdminStore, registerAdminAuthRoutes } from "./admin-auth";
import { InMemoryDeletionStore, registerDeleteRecordRoutes } from "../admin/delete-records";

const headers = { host: "school.test", origin: "https://school.test", "sec-fetch-site": "same-origin" };
it("admits only the shared phrase, retains session protections and exposes no deletion/password routes", async () => {
  let now = new Date("2026-09-28T00:00:00Z");
  const store = new InMemoryAdminStore();
  const auth = new AdminAuthService(store, { allowedOrigins: [headers.origin], secureCookies: true, sharedAccess: true, now: () => now });
  await auth.bootstrap("admin", "old-private-password");
  const app = Fastify();
  await app.register(cookie);
  registerAdminAuthRoutes(app, auth);
  const records = new InMemoryDeletionStore();
  registerDeleteRecordRoutes(app, auth, records);
  try {
    const login = (payload: object, extra = {}) => app.inject({ method: "POST", url: "/api/admin/login", headers: { ...headers, ...extra }, payload });
    expect((await login({ passphrase: "wrong" })).statusCode).toBe(401);
    expect((await login({ username: "admin", password: "old-private-password" })).statusCode).toBe(400);
    expect((await login({ passphrase: "admin" }, { origin: "https://evil.test" })).statusCode).toBe(403);
    const response = await login({ passphrase: "admin" });
    expect(response.statusCode).toBe(204);
    expect(response.cookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });
    const sessionHeaders = { ...headers, cookie: `${response.cookies[0]!.name}=${response.cookies[0]!.value}` };
    const session = await app.inject({ url: "/api/admin/session", headers: sessionHeaders });
    expect(session.statusCode).toBe(200);
    expect(session.json().username).toBe("共用控制台");
    expect((await app.inject({ method: "POST", url: "/api/admin/logout", headers: sessionHeaders, payload: {} })).statusCode).toBe(403);
    for (const url of ["/api/admin/password", "/api/admin/records/deletion-preview"]) {
      expect((await app.inject({ method: "POST", url, headers: { ...sessionHeaders, "x-csrf-token": session.json().csrfToken }, payload: {} })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "DELETE", url: "/api/admin/records", headers: sessionHeaders, payload: {} })).statusCode).toBe(404);
    expect(await auth.verifyPassword("admin", "old-private-password")).toBe(true);
    now = new Date(now.getTime() + 31 * 60_000);
    expect((await app.inject({ url: "/api/admin/session", headers: sessionHeaders })).statusCode).toBe(401);
    for (let n = 0; n < 8; n++) await login({ passphrase: "incorrect" });
    expect((await login({ passphrase: "admin" })).statusCode).toBe(429);
  } finally { await app.close(); }
});
