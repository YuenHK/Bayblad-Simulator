import { describe, expect, it } from "vitest";
import { InMemoryIdentityStore, IdentityResolver, createValidatedLiveIdentityProvider } from "./resolver";
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
  it("allows duplicate four-character guest display codes because UUID is the identity key", async () => {
    const store = new InMemoryIdentityStore();
    const common = { displayName: "訪客-AAAA", now, expiresAt: new Date(now.getTime() + 86_400_000), diagnostics: {} };
    const [a, b] = await Promise.all([
      store.createGuestSession({ ...common, tokenHash: hashIdentityToken("C".repeat(43)) }),
      store.createGuestSession({ ...common, tokenHash: hashIdentityToken("D".repeat(43)) }),
    ]);
    expect(a.identity.displayName).toBe(b.identity.displayName);
    expect(a.identity.id).not.toBe(b.identity.id);
  });

  it("validates live adapter output and rejects plain or unsafe objects", async () => {
    const resolver = new IdentityResolver(new InMemoryIdentityStore(), { now: () => now });
    const plain = { externalId: "dev", displayName: "Name", studentName: "Name", className: "1A", studentNumber: "1" };
    await expect(resolver.resolve(request(), plain as never)).rejects.toThrow("UNTRUSTED_LIVE_IDENTITY");
    await expect(createValidatedLiveIdentityProvider({ resolve: async () => ({ ...plain, displayName: "x".repeat(81) }) }).resolve()).rejects.toThrow();
    await expect(createValidatedLiveIdentityProvider({ resolve: async () => ({ ...plain, className: "1A\nInjected" }) }).resolve()).rejects.toThrow();
  });

  it.each([0, 1.5, 86_399_999, 365 * 86_400_000 + 1, Number.POSITIVE_INFINITY])("rejects unsafe cookie lifetime %s", (lifetimeMs) => {
    expect(() => new IdentityResolver(new InMemoryIdentityStore(), { lifetimeMs })).toThrow(/lifetimeMs/);
  });
  it("prefers trusted live identity over cookie and guest", async () => {
    const store = new InMemoryIdentityStore();
    const resolver = new IdentityResolver(store, { now: () => now });
    const cached = await resolver.resolve(request());
    const live = await createValidatedLiveIdentityProvider({ resolve: async () => ({ externalId: "dev-1", displayName: "1A 陳同學", studentName: "陳同學", className: "1A", studentNumber: "07", deviceName: "1A07 iPad" }) }).resolve();
    const result = await resolver.resolve(request(cached.cookieToken), live!);
    expect(result.identity).toMatchObject({ status: "iclass", displayName: "1A 陳同學", className: "1A", studentNumber: "07" });
    const replay = await resolver.resolve(request(result.cookieToken));
    expect(replay.identity).toMatchObject({ status: "cookie", displayName: "1A 陳同學", className: "1A", studentNumber: "07", deviceName: "1A07 iPad" });
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
    const resolver = new IdentityResolver(store, { now: () => time, lifetimeMs: 86_400_000 });
    const expired = await resolver.resolve(request());
    time = new Date(now.getTime() + 86_400_001);
    const rotated = await resolver.resolve(request(expired.cookieToken));
    expect(rotated.identity.id).not.toBe(expired.identity.id);
    await store.revokeSession(hashIdentityToken(rotated.cookieToken), time);
    const revoked = await resolver.resolve(request(rotated.cookieToken));
    expect(revoked.identity.id).not.toBe(rotated.identity.id);
  });

  it.each(["unknown", "expired", "revoked"] as const)("never revives a %s token when live identity is present", async (state) => {
    let time = now;
    const store = new InMemoryIdentityStore();
    const resolver = new IdentityResolver(store, { now: () => time, lifetimeMs: 86_400_000 });
    const live = await createValidatedLiveIdentityProvider({ resolve: async () => ({ externalId: "device-secure", displayName: "1A 07", studentName: "陳同學", className: "1A", studentNumber: "07" }) }).resolve();
    let oldToken = "B".repeat(43);
    if (state !== "unknown") {
      const issued = await resolver.resolve(request(), live!); oldToken = issued.cookieToken;
      if (state === "expired") time = new Date(now.getTime() + 86_400_001);
      else await store.revokeSession(hashIdentityToken(oldToken), time);
    }
    const result = await resolver.resolve(request(oldToken), live!);
    expect(result.cookieToken).not.toBe(oldToken);
    expect(result.identity.status).toBe("iclass");
    expect((await resolver.resolve(request(oldToken))).cookieToken).not.toBe(oldToken);
    expect((await resolver.resolve(request(result.cookieToken))).identity.status).toBe("cookie");
  });

  it("deduplicates concurrent lookup of the same cookie", async () => {
    const resolver = new IdentityResolver(new InMemoryIdentityStore(), { now: () => now });
    const initial = await resolver.resolve(request());
    const results = await Promise.all(Array.from({ length: 20 }, () => resolver.resolve(request(initial.cookieToken))));
    expect(new Set(results.map((item) => item.identity.id))).toEqual(new Set([initial.identity.id]));
  });

  it("rotates a valid live session under concurrent resolution without splitting identity", async () => {
    const store = new InMemoryIdentityStore();
    const resolver = new IdentityResolver(store, { now: () => now });
    const live = await createValidatedLiveIdentityProvider({ resolve: async () => ({ externalId: "device-concurrent", displayName: "1B 11", studentName: "李同學", className: "1B", studentNumber: "11" }) }).resolve();
    const initial = await resolver.resolve(request(), live!);
    const results = await Promise.all(Array.from({ length: 20 }, () => resolver.resolve(request(initial.cookieToken), live!)));
    expect(new Set(results.map((item) => item.cookieToken)).size).toBe(1);
    expect(results.every((item) => item.cookieToken !== initial.cookieToken)).toBe(true);
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

  it("keeps lookup read-only until the cached session is adopted", async () => {
    const store = new InMemoryIdentityStore();
    const resolver = new IdentityResolver(store, { now: () => now });
    const issued = await resolver.resolve(request());
    const before = await store.findSession(hashIdentityToken(issued.cookieToken), now);
    await store.findSession(hashIdentityToken(issued.cookieToken), new Date(now.getTime() + 100));
    const after = await store.findSession(hashIdentityToken(issued.cookieToken), now);
    expect(after?.lastSeenAt).toEqual(before?.lastSeenAt);
    expect(after?.expiresAt).toEqual(before?.expiresAt);
  });

  it("fails closed without leaking token or PII when storage fails", async () => {
    const resolver = new IdentityResolver({
      findSession: async () => { throw new Error("db unavailable"); },
      touchSession: async () => { throw new Error("db unavailable"); },
      createGuestSession: async () => { throw new Error("db unavailable"); },
      upsertLiveSession: async () => { throw new Error("db unavailable"); },
      revokeSession: async () => false,
    });
    await expect(resolver.resolve(request("A".repeat(43)))).rejects.toThrow("IDENTITY_STORE_UNAVAILABLE");
  });
});
