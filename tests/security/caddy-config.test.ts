import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const caddy = readFileSync(new URL("Caddyfile", root), "utf8");
const compose = readFileSync(new URL("compose.yaml", root), "utf8");

describe("public edge proxy contract", () => {
  it("publishes only Caddy on HTTP and HTTPS", () => {
    expect(compose).toContain('ports: ["80:80", "443:443", "443:443/udp"]');
    expect(compose.match(/\n\s+ports:/g)).toHaveLength(1);
    expect(compose).toMatch(/server:[\s\S]*networks: \[backend, database\]/);
    expect(compose).toMatch(/backend:\n\s+internal: true/);
  });

  it("routes only explicit server endpoints and keeps the frontend fallback", () => {
    expect(caddy).toMatch(/@api path \/api\/\*[\s\S]*handle @api/);
    expect(caddy).toMatch(/@socket path \/socket\.io\/\*[\s\S]*handle @socket/);
    expect(caddy).toMatch(/handle \/start/);
    expect(caddy).toMatch(/reverse_proxy server:3000/);
    expect(caddy).toMatch(/handle \{\s+reverse_proxy web:8080/);
  });

  it("removes spoofable identity and forwarding headers before setting trusted values", () => {
    expect(caddy).toContain("request_header -X-Forwarded-*");
    expect(caddy).toContain("request_header -X-Real-IP");
    expect(caddy).toContain("request_header -X-Student-*");
    expect(caddy).toContain("request_header -X-Device-*");
    expect(caddy).toContain("request_header -X-IClass-*");
  });

  it("sets the required browser isolation and content policy without unsafe eval", () => {
    expect(caddy).toContain("Strict-Transport-Security");
    expect(caddy).toContain("default-src 'self'");
    expect(caddy).toContain("connect-src 'self' https: wss:");
    expect(caddy).toContain("frame-ancestors 'none'");
    expect(caddy).toContain("X-Content-Type-Options nosniff");
    expect(caddy).toContain("Referrer-Policy no-referrer");
    expect(caddy).toContain("Permissions-Policy");
    expect(caddy).toContain("Cross-Origin-Opener-Policy same-origin");
    expect(caddy).toContain("Cross-Origin-Resource-Policy same-origin");
    expect(caddy).not.toContain("unsafe-eval");
  });

  it("bounds request resources while preserving long-lived Socket.IO battles", () => {
    expect(caddy).toMatch(/request_body\s*\{\s*max_size 3MB/);
    expect(caddy).toContain("stream_timeout 45m");
    expect(caddy).toContain("read_body 30s");
    expect(caddy).toContain("read_header 10s");
    expect(caddy).toContain("max_header_size 32KB");
    expect(caddy).toContain("encode @compressible zstd gzip");
  });

  it("uses safe structured logging and excludes token or PII-bearing routes", () => {
    expect(caddy).toContain("format json");
    expect(caddy).toMatch(/@sensitive_log[\s\S]*path \/start \/api\/admin\/\* \/socket\.io\/\*/);
    expect(caddy).toContain("log_skip @sensitive_log");
    expect(caddy).toContain("header -Server");
  });
});
