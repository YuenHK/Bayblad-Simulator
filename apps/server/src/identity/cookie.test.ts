import { describe, expect, it } from "vitest";
import { InMemoryIdentityStore, IdentityResolver, trustedLiveIdentity } from "./resolver";
import { COOKIE_NAME, hashIdentityToken, issueIdentityToken, serializeIdentityCookie } from "./cookie";

const now = new Date("2026-08-29T00:00:00.000Z");
const request = (cookieToken?: string, ip = "203.0.113.2") => ({ ...(cookieToken ? { cookieToken } : {}), ip, userAgent: "iPad Safari" });

describe("identity cookie", () => {
  it("uses an opaque 256-bit token and stores only its SHA-256 hash", () => {
    const token = issueIdentityToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashIdentityToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashIdentityToken(token)).not.toContain(token);
  });

  it("sets safe fixed-lifetime flags without PII", () => {
    const token = "A".repeat(43);
    const value = serializeIdentityCookie(token, now, true);
    expect(value).toContain(`${COOKIE_NAME}=${token}`);
    expect(value).toContain("HttpOnly");
    expect(value).toContain("Secure");
    expect(value).toContain("SameSite=Strict");
    expect(value).toContain("Path=/");
    expect(value).toContain("Max-Age=15552000");
    expect(value).not.toMatch(/student|class|陳|1A/i);
  });
});

describe("IdentityResolver", () => {
  it("prefers trusted live identity over cookie and guest", async () => {
    const store = new InMemoryIdentityStore();
    const resolver = new IdentityResolver(store, { now: () => now });
    const cached = await resolver.resolve(request());
    const live = trustedLiveIdentity({ externalId: "dev-1", displayName: "1A 陳同學", studentName: "陳同學", className: "1A", studentNumber: "07", deviceName: "1A07 iPad" });
    const result = await resolver.resolve(request(cached.cookieToken), live);
    expect(result.identity).toMatchObject({ status: "iclass", displayName: "1A 陳同學", className: "1A", studentNumber: "07" });
  });

  it("creates a unique guest and reuses it across IP changes", async () => {
    const resolver = new IdentityResolver(new InMemoryIdentityStore(), { now: () => now });
    const first = await resolver.resolve(request());
    expect(first.identity).toMatchObject({ status: "guest" });
    expect(first.identity.displayName).toMatch(/^訪客-[A-F0-9]{4}$/);
    const again = await resolver.resolve(request(first.cookieToken, "2001:db8::8"));
    expect(again.identity.id).toBe(first.identity.id);
    expect(again.cookieToken).toBe(first.cookieToken);
  });

  it("does not merge two cookies merely because IP is the same", async () => {
    const resolver = new IdentityResolver(new InMemoryIdentityStore(), { now: () => now });
    const [a, b] = await Promise.all([resolver.resolve(request()), resolver.resolve(request())]);
    expect(a.identity.id).not.toBe(b.identity.id);
    expect(a.cookieToken).not.toBe(b.cookieToken);
  });

  it.each(["bad", "x".repeat(500), "../cookie", "😀"].map((token) => [token]))("rotates malformed or tampered token %s", async (token) => {
    const resolver = new IdentityResolver(new InMemoryIdentityStore(), { now: () => now });
    const result = await resolver.resolve(request(token));
    expect(result.cookieToken).not.toBe(token);
    expect(result.identity.status).toBe("guest");
  });

  it("rotates an expired or revoked session", async () => {
    let time = now;
    const store = new InMemoryIdentityStore();
    const resolver = new IdentityResolver(store, { now: () => time, lifetimeMs: 1000 });
    const expired = await resolver.resolve(request());
    time = new Date(now.getTime() + 1001);
    const rotated = await resolver.resolve(request(expired.cookieToken));
    expect(rotated.identity.id).not.toBe(expired.identity.id);
    await store.revokeSession(hashIdentityToken(rotated.cookieToken), time);
    const revoked = await resolver.resolve(request(rotated.cookieToken));
    expect(revoked.identity.id).not.toBe(rotated.identity.id);
  });

  it("deduplicates concurrent lookup of the same cookie", async () => {
    const resolver = new IdentityResolver(new InMemoryIdentityStore(), { now: () => now });
    const initial = await resolver.resolve(request());
    const results = await Promise.all(Array.from({ length: 20 }, () => resolver.resolve(request(initial.cookieToken))));
    expect(new Set(results.map((item) => item.identity.id))).toEqual(new Set([initial.identity.id]));
  });

  it("normalizes diagnostics but never uses them as lookup keys", async () => {
    const store = new InMemoryIdentityStore();
    const resolver = new IdentityResolver(store, { now: () => now });
    const result = await resolver.resolve({ ip: "::ffff:192.0.2.12", userAgent: "x".repeat(900) });
    const session = await store.findSession(hashIdentityToken(result.cookieToken));
    expect(session?.lastIp).toBe("192.0.2.12");
    expect(session?.userAgent).toHaveLength(512);
  });

  it("fails closed without leaking token or PII when storage fails", async () => {
    const resolver = new IdentityResolver({
      persistent: false,
      findSession: async () => { throw new Error("db unavailable"); },
      createGuestSession: async () => { throw new Error("db unavailable"); },
      upsertLiveSession: async () => { throw new Error("db unavailable"); },
      revokeSession: async () => false,
    });
    await expect(resolver.resolve(request("A".repeat(43)))).rejects.toThrow("IDENTITY_STORE_UNAVAILABLE");
  });
});
