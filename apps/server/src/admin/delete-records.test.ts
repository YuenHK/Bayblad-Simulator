import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";
import { AdminAuthService, InMemoryAdminStore, registerAdminAuthRoutes } from "../auth/admin-auth";
import { InMemoryDeletionStore, registerDeleteRecordRoutes } from "./delete-records";

const origin = "https://teacher.test";

async function fixture() {
  const adminStore = new InMemoryAdminStore();
  const auth = new AdminAuthService(adminStore, {
    allowedOrigins: [origin],
    csrfSecret: Buffer.alloc(32, 4),
    secureCookies: false,
  });
  await auth.bootstrap("admin", "correct-password-2026");
  const deletion = new InMemoryDeletionStore([
    { identityId: "10000000-0000-4000-8000-000000000001", className: "1A", occurredAt: new Date("2026-08-01T00:00:00Z"), designs: 2, matches: 3 },
    { identityId: "10000000-0000-4000-8000-000000000002", className: "1B", occurredAt: new Date("2026-08-02T00:00:00Z"), designs: 1, matches: 1 },
  ]);
  const app = Fastify();
  await app.register(fastifyCookie);
  registerAdminAuthRoutes(app, auth);
  registerDeleteRecordRoutes(app, auth, deletion);
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin, host: "teacher.test", "sec-fetch-site": "same-origin", "content-type": "application/json" }, payload: { username: "admin", password: "correct-password-2026" } });
  const rawCookie = login.headers["set-cookie"]!;
  const cookie = (Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie).split(";", 1)[0]!;
  const session = await app.inject({ method: "GET", url: "/api/admin/session", headers: { origin, host: "teacher.test", cookie } });
  const csrf = session.json().csrfToken as string;
  return { app, deletion, cookie, csrf };
}

const mutationHeaders = (cookie: string, csrf: string) => ({ origin, host: "teacher.test", "sec-fetch-site": "same-origin", "content-type": "application/json", cookie, "x-csrf-token": csrf });

describe("audited record deletion routes", () => {
  it("requires an active admin session and same-origin CSRF before previewing", async () => {
    const { app, cookie } = await fixture();
    expect((await app.inject({ method: "POST", url: "/api/admin/records/deletion-preview", headers: { origin, host: "teacher.test", "sec-fetch-site": "same-origin", "content-type": "application/json" }, payload: { scope: "all" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/records/deletion-preview", headers: { origin, host: "teacher.test", "sec-fetch-site": "same-origin", "content-type": "application/json", cookie }, payload: { scope: "all" } })).statusCode).toBe(403);
    await app.close();
  });

  it("previews exact counts and returns an opaque session-bound expiring token and canonical filter hash", async () => {
    const { app, cookie, csrf } = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/admin/records/deletion-preview", headers: mutationHeaders(cookie, csrf), payload: { scope: "class", className: "1A" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ counts: { identities: 1, designs: 2, matches: 3 }, filterHash: expect.stringMatching(/^[a-f0-9]{64}$/u), expiresAt: expect.any(String) });
    expect(response.json().previewToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(response.json())).not.toContain("10000000-0000");
    await app.close();
  });

  it.each([
    [{ password: "correct-password-2026", confirmation: "" }, "CONFIRMATION_REQUIRED"],
    [{ password: "wrong-password", confirmation: "DELETE" }, "REAUTHENTICATION_FAILED"],
  ])("rejects missing exact confirmation or invalid current password", async (override, error) => {
    const { app, deletion, cookie, csrf } = await fixture();
    const preview = (await app.inject({ method: "POST", url: "/api/admin/records/deletion-preview", headers: mutationHeaders(cookie, csrf), payload: { scope: "identity", identityId: "10000000-0000-4000-8000-000000000001" } })).json();
    const response = await app.inject({ method: "DELETE", url: "/api/admin/records", headers: mutationHeaders(cookie, csrf), payload: { previewToken: preview.previewToken, filterHash: preview.filterHash, ...override } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error });
    expect(deletion.remainingIdentities).toBe(2);
    await app.close();
  });

  it("deletes atomically, retains content-free immutable audit metadata, and rejects replay", async () => {
    const { app, deletion, cookie, csrf } = await fixture();
    const preview = (await app.inject({ method: "POST", url: "/api/admin/records/deletion-preview", headers: mutationHeaders(cookie, csrf), payload: { scope: "date_range", from: "2026-08-01", to: "2026-08-01" } })).json();
    const payload = { previewToken: preview.previewToken, filterHash: preview.filterHash, password: "correct-password-2026", confirmation: "DELETE" };
    const response = await app.inject({ method: "DELETE", url: "/api/admin/records", headers: mutationHeaders(cookie, csrf), payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ auditId: expect.stringMatching(/^[0-9a-f-]{36}$/u), counts: { identities: 1, designs: 2, matches: 3 } });
    expect(deletion.remainingIdentities).toBe(1);
    expect(deletion.audits).toHaveLength(1);
    expect(deletion.audits[0]).toEqual({ auditId: response.json().auditId, adminUserId: expect.any(String), scope: "date_range", filterHash: preview.filterHash, previewCount: 6, deletedIdentityCount: 1, deletedDesignCount: 2, deletedMatchCount: 3 });
    expect(JSON.stringify(deletion.audits[0])).not.toContain("1A");
    const replay = await app.inject({ method: "DELETE", url: "/api/admin/records", headers: mutationHeaders(cookie, csrf), payload });
    expect(replay.statusCode).toBe(409);
    expect(deletion.audits).toHaveLength(1);
    await app.close();
  });

  it("rejects a changed filter hash before reauthentication and leaves all records intact", async () => {
    const { app, deletion, cookie, csrf } = await fixture();
    const preview = (await app.inject({ method: "POST", url: "/api/admin/records/deletion-preview", headers: mutationHeaders(cookie, csrf), payload: { scope: "all" } })).json();
    const response = await app.inject({ method: "DELETE", url: "/api/admin/records", headers: mutationHeaders(cookie, csrf), payload: { previewToken: preview.previewToken, filterHash: "f".repeat(64), password: "correct-password-2026", confirmation: "DELETE" } });
    expect(response.statusCode).toBe(409);
    expect(deletion.remainingIdentities).toBe(2);
    await app.close();
  });
});
