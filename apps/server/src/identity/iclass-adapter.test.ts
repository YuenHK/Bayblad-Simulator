import { describe, expect, it, vi } from "vitest";
import { ApiIClassAdapter, FallbackIClassAdapter, ImportedDeviceMapAdapter } from "./iclass-adapter";
import { InMemoryTokenNonceStore, WebClipTokenService } from "./webclip-token";

const row = { externalDeviceId: "ipad-001", deviceName: "1A-iPad-01", studentName: "陳同學", className: "1A", studentNumber: "01" };
const secret = new Uint8Array(32).fill(7);

describe("Web Clip token", () => {
  it("requires a durable atomic nonce store in production", () => {
    expect(() => new WebClipTokenService({ keys: { k1: secret }, activeKeyId: "k1", audience: "steam-top", nonceStore: new InMemoryTokenNonceStore(), production: true })).toThrow("WEBCLIP_DURABLE_NONCE_STORE_REQUIRED");
  });
  it("accepts a short-lived opaque token once, including concurrent consumption", async () => {
    const store = new InMemoryTokenNonceStore();
    const service = new WebClipTokenService({ keys: { k1: secret }, activeKeyId: "k1", audience: "steam-top", nonceStore: store, now: () => 1_000_000 });
    const token = await service.issue("ipad-001", 300_000);
    expect(token).not.toContain("ipad-001");
    const results = await Promise.allSettled([service.consume(token), service.consume(token)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "fulfilled")).toMatchObject({ value: "ipad-001" });
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: "DEVICE_TOKEN_REPLAYED" }) });
  });

  it("rejects tampering, expiry, future issue time, wrong audience and oversized tokens", async () => {
    const store = new InMemoryTokenNonceStore();
    let now = 10_000;
    const service = new WebClipTokenService({ keys: { k1: secret }, activeKeyId: "k1", audience: "steam-top", nonceStore: store, now: () => now });
    const token = await service.issue("ipad-001", 1_000);
    await expect(service.consume(`${token.slice(0, -1)}x`)).rejects.toThrow("INVALID_DEVICE_TOKEN");
    now = 12_000;
    await expect(service.consume(token)).rejects.toThrow("DEVICE_TOKEN_EXPIRED");
    await expect(service.consume("x".repeat(5_000))).rejects.toThrow("INVALID_DEVICE_TOKEN");
  });

  it("supports secret rotation while rejecting algorithm confusion and non-canonical base64url", async () => {
    const store = new InMemoryTokenNonceStore();
    const old = new WebClipTokenService({ keys: { old: secret }, activeKeyId: "old", audience: "steam-top", nonceStore: store, now: () => 1_000 });
    const token = await old.issue("ipad-001", 1_000);
    const rotated = new WebClipTokenService({ keys: { old: secret, next: new Uint8Array(32).fill(9) }, activeKeyId: "next", audience: "steam-top", nonceStore: store, now: () => 1_500 });
    await expect(rotated.consume(token)).resolves.toBe("ipad-001");
    const parts = token.split(".");
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", kid: "old", typ: "JWT", v: 1 })).toString("base64url");
    await expect(rotated.consume(`${noneHeader}.${parts[1]}.${parts[2]}`)).rejects.toThrow("INVALID_DEVICE_TOKEN");
    await expect(rotated.consume(`${parts[0]}=.${parts[1]}.${parts[2]}`)).rejects.toThrow("INVALID_DEVICE_TOKEN");
  });
});

describe("ImportedDeviceMapAdapter", () => {
  it("parses BOM and quoted commas then atomically replaces an immutable snapshot", async () => {
    const adapter = new ImportedDeviceMapAdapter();
    await adapter.replaceFromCsv(`\uFEFFexternalDeviceId,deviceName,studentName,className,studentNumber\r\nipad-001,"iPad, 01",陳同學,1A,01`);
    await expect(adapter.resolveDevice("ipad-001")).resolves.toEqual({ ...row, deviceName: "iPad, 01" });
    const pending = adapter.replaceFromCsv("bad,headers\nx,y");
    await expect(pending).rejects.toThrow("INVALID_DEVICE_MAP_HEADERS");
    await expect(adapter.resolveDevice("ipad-001")).resolves.toEqual({ ...row, deviceName: "iPad, 01" });
  });

  it("rejects duplicate ids, injection, controls and excessive input", async () => {
    const adapter = new ImportedDeviceMapAdapter({ maxBytes: 200 });
    const header = "externalDeviceId,deviceName,studentName,className,studentNumber\n";
    await expect(adapter.replaceFromCsv(`${header}x,d,a,1A,1\nx,d,b,1A,2`)).rejects.toThrow("DUPLICATE_EXTERNAL_DEVICE_ID");
    await expect(adapter.replaceFromCsv(`${header}x,d,=IMPORTXML(\"x\"),1A,1`)).rejects.toThrow("CSV_FORMULA_FORBIDDEN");
    await expect(adapter.replaceFromCsv(`${header}x,d\u0000,a,1A,1`)).rejects.toThrow();
    await expect(adapter.replaceFromCsv("x".repeat(201))).rejects.toThrow("DEVICE_MAP_TOO_LARGE");
  });
});

describe("ApiIClassAdapter", () => {
  it("retries transient 5xx/timeouts, opens its circuit, and enforces the streamed body cap", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("down", { status: 503 }));
    const adapter = new ApiIClassAdapter({ baseUrl: "https://iclass.example", bearerToken: "secret", fetcher, maxAttempts: 2, timeoutMs: 100 });
    await expect(adapter.resolveDevice("ipad-001")).rejects.toThrow("ICLASS_UNAVAILABLE");
    await expect(adapter.resolveDevice("ipad-001")).rejects.toThrow("ICLASS_UNAVAILABLE");
    await expect(adapter.resolveDevice("ipad-001")).rejects.toThrow("ICLASS_UNAVAILABLE");
    const attempts = fetcher.mock.calls.length;
    await expect(adapter.resolveDevice("ipad-001")).rejects.toThrow("ICLASS_UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(attempts);
    const oversized = new ApiIClassAdapter({ baseUrl: "https://iclass.example", bearerToken: "secret", fetcher: async () => new Response("x".repeat(65_537), { headers: { "content-type": "application/json" } }), maxAttempts: 1 });
    await expect(oversized.resolveDevice("ipad-001")).rejects.toThrow("ICLASS_INVALID_RESPONSE");
    const timeoutFetch = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const timeout = new ApiIClassAdapter({ baseUrl: "https://iclass.example", bearerToken: "secret", fetcher: timeoutFetch, maxAttempts: 2, timeoutMs: 100 });
    await expect(timeout.resolveDevice("ipad-001")).rejects.toThrow("ICLASS_UNAVAILABLE");
    expect(timeoutFetch).toHaveBeenCalledTimes(2);
  });

  it("uses CSV fallback only for API 404/transient failures", async () => {
    const csv = new ImportedDeviceMapAdapter(); await csv.replaceFromCsv("externalDeviceId,deviceName,studentName,className,studentNumber\nipad-001,d,陳同學,1A,01");
    const transient = new FallbackIClassAdapter({ resolveDevice: async () => { throw new Error("ICLASS_UNAVAILABLE"); } }, csv);
    await expect(transient.resolveDevice("ipad-001")).resolves.toMatchObject({ studentName: "陳同學" });
    const missing = new FallbackIClassAdapter({ resolveDevice: async () => null }, csv);
    await expect(missing.resolveDevice("ipad-001")).resolves.toMatchObject({ studentName: "陳同學" });
    const permanent = new FallbackIClassAdapter({ resolveDevice: async () => { throw new Error("ICLASS_UNAUTHORIZED"); } }, csv);
    await expect(permanent.resolveDevice("ipad-001")).rejects.toThrow("ICLASS_UNAUTHORIZED");
  });
  it("uses a secret bearer, validates JSON and maps 404 to null", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(row), { status: 200, headers: { "content-type": "application/json" } })).mockResolvedValueOnce(new Response(null, { status: 404 }));
    const adapter = new ApiIClassAdapter({ baseUrl: "https://iclass.example/api", bearerToken: "secret-token", fetcher, timeoutMs: 1_000, maxAttempts: 1 });
    await expect(adapter.resolveDevice("ipad-001")).resolves.toEqual(row);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer secret-token" });
    await expect(adapter.resolveDevice("missing")).resolves.toBeNull();
  });

  it("rejects insecure production URLs, wrong content types, oversized and malformed bodies", async () => {
    expect(() => new ApiIClassAdapter({ baseUrl: "http://iclass.example", bearerToken: "secret", production: true })).toThrow("ICLASS_HTTPS_REQUIRED");
    const wrong = new ApiIClassAdapter({ baseUrl: "https://iclass.example", bearerToken: "secret", fetcher: async () => new Response("x", { headers: { "content-type": "text/plain" } }), maxAttempts: 1 });
    await expect(wrong.resolveDevice("ipad-001")).rejects.toThrow("ICLASS_INVALID_RESPONSE");
  });
});
