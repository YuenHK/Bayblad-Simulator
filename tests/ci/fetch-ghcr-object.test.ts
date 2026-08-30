import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fetchGhcrObject } from "../../scripts/fetch-ghcr-object.mjs";

const raw = Buffer.from('{"schemaVersion":2}');
const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
describe("GHCR content-address fetcher", () => {
  it("follows only an exact pull challenge and verifies returned bytes", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:school/top/steam-top/server:pull"' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "a".repeat(32) }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(raw, { status: 200 }));
    await expect(fetchGhcrObject({ repository: "school/top/steam-top/server", digest, kind: "manifest", actor: "actor", token: "secret", fetcher })).resolves.toEqual(raw);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { authorization: expect.stringMatching(/^Basic /), accept: expect.stringContaining("application/vnd.oci.image.index.v1+json") } });
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ redirect: "error", headers: { authorization: `Bearer ${"a".repeat(32)}` } });
  });
  it("accepts a direct authenticated response", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(raw, { status: 200 }));
    await expect(fetchGhcrObject({ repository: "school/top/steam-top/server", digest, kind: "blob", actor: "actor", token: "secret", fetcher })).resolves.toEqual(raw);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("accepts a standards-compatible reordered challenge and access_token", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401, headers: { "www-authenticate": 'bearer scope="repository:school/top/steam-top/server:pull", realm="https://ghcr.io/token", service="ghcr.io"' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "b".repeat(32) }), { status: 200 }))
      .mockResolvedValueOnce(new Response(raw, { status: 200 }));
    await expect(fetchGhcrObject({ repository: "school/top/steam-top/server", digest, kind: "blob", actor: "actor", token: "secret", fetcher })).resolves.toEqual(raw);
  });
  it("rejects bytes that do not match the requested digest", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("wrong", { status: 200 }));
    await expect(fetchGhcrObject({ repository: "school/top/steam-top/server", digest, kind: "blob", actor: "actor", token: "secret", fetcher })).rejects.toThrow("digest mismatch");
  });
  it("rejects a challenge that expands repository scope", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://evil.example/token",service="ghcr.io",scope="repository:other/repo:pull"' } }));
    await expect(fetchGhcrObject({ repository: "school/top/steam-top/server", digest, kind: "blob", actor: "actor", token: "secret", fetcher })).rejects.toThrow("scope invalid");
  });
  it("rejects a challenge for another token service", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="evil.example",scope="repository:school/top/steam-top/server:pull"' } }));
    await expect(fetchGhcrObject({ repository: "school/top/steam-top/server", digest, kind: "blob", actor: "actor", token: "secret", fetcher })).rejects.toThrow("scope invalid");
  });
  it.each([302, 403, 404])("rejects registry status %s", async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
    await expect(fetchGhcrObject({ repository: "school/top/steam-top/server", digest, kind: "blob", actor: "actor", token: "secret", fetcher })).rejects.toThrow();
  });
  it("rejects an oversized token response before JSON parsing", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:school/top/steam-top/server:pull"' } }))
      .mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-length": String(64 * 1024 * 1024 + 1) } }));
    await expect(fetchGhcrObject({ repository: "school/top/steam-top/server", digest, kind: "blob", actor: "actor", token: "secret", fetcher })).rejects.toThrow("too large");
  });
  it("rejects an oversized registry object", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(raw, { status: 200, headers: { "content-length": String(64 * 1024 * 1024 + 1) } }));
    await expect(fetchGhcrObject({ repository: "school/top/steam-top/server", digest, kind: "blob", actor: "actor", token: "secret", fetcher })).rejects.toThrow("too large");
  });
});
