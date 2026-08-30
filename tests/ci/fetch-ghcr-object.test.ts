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
  });
  it("rejects bytes that do not match the requested digest", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("wrong", { status: 200 }));
    await expect(fetchGhcrObject({ repository: "school/top/steam-top/server", digest, kind: "blob", actor: "actor", token: "secret", fetcher })).rejects.toThrow("digest mismatch");
  });
  it("rejects a challenge that expands repository scope", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://evil.example/token",service="ghcr.io",scope="repository:other/repo:pull"' } }));
    await expect(fetchGhcrObject({ repository: "school/top/steam-top/server", digest, kind: "blob", actor: "actor", token: "secret", fetcher })).rejects.toThrow("scope invalid");
  });
});
